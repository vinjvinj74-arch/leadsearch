import { config } from '../config.js';
import { conflict, integrationNotConfigured, upstreamError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { PlaceResult, SearchParams } from './placesService.js';

const APIFY_BASE = 'https://api.apify.com/v2';
const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const POLL_INTERVAL_MS = 3000;

interface ApifyRun {
  id: string;
  status: string;
  defaultDatasetId?: string | null;
  error?: string | null;
}

interface ApifyRunResponse {
  data?: ApifyRun;
  error?: { message?: string; type?: string };
}

interface ApifyPlaceItem {
  title?: string;
  address?: string;
  phone?: string;
  phoneUnformatted?: string;
  website?: string;
  categoryName?: string;
  categories?: string[];
  totalScore?: number;
  reviewsCount?: number;
  permanentlyClosed?: boolean;
  temporarilyClosed?: boolean;
  url?: string;
  location?: { lat?: number; lng?: number };
  placeId?: string;
  fid?: string;
  cid?: string;
  scrapedAt?: string;
  searchString?: string;
}

interface ApifyUserResponse {
  data?: { username?: string; plan?: { id?: string } };
}

interface NominatimResult {
  lat?: string;
  lon?: string;
}

let activeApifyRuns = 0;
const geocodeCache = new Map<string, { latitude: number; longitude: number } | null>();

function requireToken(): string {
  if (!config.apifyApiToken) {
    throw integrationNotConfigured(
      'Apify nao configurado. Defina APIFY_API_TOKEN no ambiente do servidor para habilitar pesquisas reais.',
    );
  }
  return config.apifyApiToken;
}

export function isApifyConfigured(): boolean {
  return Boolean(config.apifyApiToken);
}

export function reserveApifyRun(): () => void {
  if (activeApifyRuns >= config.apify.maxConcurrentRuns) {
    throw conflict('Outra pesquisa de empresas ja esta em andamento. Aguarde a conclusao e tente novamente.');
  }
  activeApifyRuns += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeApifyRuns = Math.max(0, activeApifyRuns - 1);
  };
}

async function apifyRequest(
  path: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  const token = requireToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(`${APIFY_BASE}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw upstreamError('Tempo limite excedido ao consultar o Apify.');
    }
    logger.warn({ err: error }, 'Falha de rede ao consultar o Apify');
    throw upstreamError('Nao foi possivel conectar ao Apify.');
  }

  if (!response.ok) {
    let providerMessage = '';
    try {
      const payload = (await response.json()) as ApifyRunResponse;
      providerMessage = payload.error?.message?.trim() ?? '';
    } catch {
      providerMessage = '';
    }

    if (response.status === 401 || response.status === 403) {
      throw upstreamError('O Apify recusou o token configurado. Verifique APIFY_API_TOKEN no servidor.', {
        httpStatus: response.status,
      });
    }
    if (response.status === 402) {
      throw upstreamError('A conta Apify nao possui creditos suficientes para executar a pesquisa.', {
        httpStatus: response.status,
      });
    }
    if (response.status === 429) {
      throw upstreamError('Limite de requisicoes do Apify atingido. Aguarde e tente novamente.', {
        httpStatus: response.status,
      });
    }

    throw upstreamError(
      providerMessage
        ? `O Apify recusou a solicitacao: ${providerMessage}`
        : `O Apify retornou erro HTTP ${response.status}.`,
      { httpStatus: response.status },
    );
  }

  return response;
}

function countryCodeFor(country: string): string | undefined {
  const normalized = country.trim().toLowerCase();
  if (!normalized || normalized.includes('brasil') || normalized === 'brazil' || normalized === 'br') {
    return 'BR';
  }
  return normalized.length === 2 ? normalized.toUpperCase() : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function geocodeForRadius(
  city: string,
  state: string | null | undefined,
  country: string,
): Promise<{ latitude: number; longitude: number } | null> {
  const query = [city, state, country].filter(Boolean).join(', ');
  const cacheKey = query.trim().toLowerCase();
  if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey) ?? null;

  const url = new URL(NOMINATIM_ENDPOINT);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('q', query);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': `LeadSearch/1.0 (+${config.appUrl || 'https://leadsearch-production.up.railway.app'})`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'Geocodificacao gratuita retornou erro HTTP');
      geocodeCache.set(cacheKey, null);
      return null;
    }
    const payload = (await response.json()) as NominatimResult[];
    const first = payload[0];
    const latitude = Number(first?.lat);
    const longitude = Number(first?.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      geocodeCache.set(cacheKey, null);
      return null;
    }
    const coordinates = { latitude, longitude };
    geocodeCache.set(cacheKey, coordinates);
    return coordinates;
  } catch (error) {
    logger.warn({ err: error }, 'Falha ao geocodificar cidade para aplicar o raio');
    geocodeCache.set(cacheKey, null);
    return null;
  }
}

async function buildActorInput(params: SearchParams): Promise<Record<string, unknown>> {
  const input: Record<string, unknown> = {
    searchStringsArray: [params.niche],
    maxCrawledPlacesPerSearch: Math.min(Math.max(params.limit, 1), 20),
    language: 'pt-BR',
    skipClosedPlaces: false,
    scrapePlaceDetailPage: false,
    scrapeContacts: false,
    maxReviews: 0,
    maxImages: 0,
  };

  const countryCode = countryCodeFor(params.country);
  if (countryCode) input.countryCode = countryCode;

  if (params.radiusKm && params.radiusKm > 0) {
    const coordinates = await geocodeForRadius(params.city, params.state, params.country);
    if (coordinates) {
      input.customGeolocation = {
        type: 'Point',
        coordinates: [coordinates.longitude, coordinates.latitude],
        radiusKm: Math.min(Math.max(params.radiusKm, 1), 50),
      };
      return input;
    }
    logger.warn({ city: params.city }, 'Raio ignorado porque a cidade nao foi geocodificada');
  }

  input.locationQuery = [params.city, params.state, params.country].filter(Boolean).join(', ');
  return input;
}

export async function startSearchRun(
  params: SearchParams,
): Promise<{ runId: string; status: string; datasetId: string | null }> {
  const input = await buildActorInput(params);
  const url = new URL(`${APIFY_BASE}/acts/${config.apify.actor}/runs`);
  url.searchParams.set('timeout', String(config.apify.timeoutSeconds));
  url.searchParams.set('maxTotalChargeUsd', String(config.apify.maxTotalChargeUsd));

  const response = await apifyRequest(`${url.pathname}${url.search}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  const payload = (await response.json().catch(() => ({}))) as ApifyRunResponse;
  const run = payload.data;
  if (!run?.id) {
    throw upstreamError('O Apify iniciou a execucao sem retornar um identificador valido.');
  }
  return {
    runId: run.id,
    status: run.status,
    datasetId: run.defaultDatasetId ?? null,
  };
}

async function getRun(runId: string): Promise<ApifyRun> {
  const response = await apifyRequest(`/actor-runs/${encodeURIComponent(runId)}`, {}, 20_000);
  const payload = (await response.json().catch(() => ({}))) as ApifyRunResponse;
  if (!payload.data?.id) {
    throw upstreamError('O Apify retornou uma execucao invalida.');
  }
  return payload.data;
}

async function abortRun(runId: string): Promise<void> {
  try {
    await apifyRequest(`/actor-runs/${encodeURIComponent(runId)}/abort`, { method: 'POST' }, 15_000);
    logger.warn({ runId }, 'Execucao do Apify abortada por tempo limite local');
  } catch (error) {
    logger.warn({ err: error, runId }, 'Falha ao abortar execucao do Apify');
  }
}

export async function waitForSearchRun(runId: string): Promise<ApifyRun> {
  const startedAt = Date.now();
  for (;;) {
    const run = await getRun(runId);

    if (run.status === 'SUCCEEDED') return run;
    if (run.status === 'FAILED' || run.status === 'ABORTED' || run.status === 'TIMED-OUT') {
      throw upstreamError(
        run.error
          ? `A execucao do Apify falhou: ${run.error}`
          : `A execucao do Apify terminou com status ${run.status}.`,
        { providerStatus: run.status },
      );
    }

    if (Date.now() - startedAt > config.apify.maxWaitMs) {
      await abortRun(runId);
      throw upstreamError('Tempo limite excedido aguardando o Apify. A execucao foi interrompida.');
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

function mapPlace(item: ApifyPlaceItem): PlaceResult | null {
  const name = item.title?.trim();
  if (!name) return null;

  const placeId = item.placeId?.trim() || item.fid?.trim() || item.cid?.trim() || '';
  const latitude = typeof item.location?.lat === 'number' ? item.location.lat : null;
  const longitude = typeof item.location?.lng === 'number' ? item.location.lng : null;
  const businessStatus = item.permanentlyClosed
    ? 'CLOSED_PERMANENTLY'
    : item.temporarilyClosed
      ? 'CLOSED_TEMPORARILY'
      : 'OPERATIONAL';

  return {
    placeId,
    name,
    address: item.address?.trim() || null,
    phone: item.phoneUnformatted?.trim() || item.phone?.trim() || null,
    website: item.website?.trim() || null,
    segment: item.categoryName?.trim() || item.categories?.[0]?.trim() || null,
    rating: typeof item.totalScore === 'number' ? item.totalScore : null,
    reviewsCount: typeof item.reviewsCount === 'number' ? item.reviewsCount : null,
    businessStatus,
    googleMapsUrl: item.url?.trim() || null,
    latitude,
    longitude,
    sourceMetadata: {
      actor: config.apify.actor,
      scrapedAt: item.scrapedAt ?? null,
      searchString: item.searchString ?? null,
      categories: Array.isArray(item.categories) ? item.categories.slice(0, 10) : [],
    },
  };
}

export async function fetchSearchResults(datasetId: string, limit: number): Promise<PlaceResult[]> {
  const url = new URL(`${APIFY_BASE}/datasets/${encodeURIComponent(datasetId)}/items`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('clean', 'true');
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 20)));

  const response = await apifyRequest(`${url.pathname}${url.search}`, {}, 30_000);
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!Array.isArray(payload)) {
    throw upstreamError('O Apify retornou resultados em formato invalido.');
  }

  return payload
    .map((item) => mapPlace(item as ApifyPlaceItem))
    .filter((item): item is PlaceResult => item !== null)
    .slice(0, limit);
}

export async function testApifyConnection(): Promise<{
  ok: boolean;
  latencyMs: number;
  provider: 'apify_google_maps';
  actor: string;
  plan: string | null;
}> {
  const started = Date.now();
  const [userResponse, actorResponse] = await Promise.all([
    apifyRequest('/users/me', {}, 15_000),
    apifyRequest(`/acts/${config.apify.actor}`, {}, 15_000),
  ]);
  const user = (await userResponse.json().catch(() => ({}))) as ApifyUserResponse;
  if (!user.data?.username) {
    throw upstreamError('O Apify nao confirmou a conta vinculada ao token.');
  }
  await actorResponse.json().catch(() => null);
  return {
    ok: true,
    latencyMs: Date.now() - started,
    provider: 'apify_google_maps',
    actor: config.apify.actor,
    plan: user.data.plan?.id ?? null,
  };
}
