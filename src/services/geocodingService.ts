import { config } from '../config.js';
import { upstreamError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 1100;

interface NominatimAddress {
  country?: string;
  country_code?: string;
  state?: string;
  region?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  suburb?: string;
  neighbourhood?: string;
  postcode?: string;
}

interface NominatimPlace {
  place_id?: number;
  display_name?: string;
  name?: string;
  lat?: string;
  lon?: string;
  type?: string;
  class?: string;
  address?: NominatimAddress;
  boundingbox?: string[];
}

export interface RadarLocation {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  type: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  countryCode: string | null;
  neighborhood: string | null;
  postalCode: string | null;
  boundingBox: { south: number; north: number; west: number; east: number } | null;
}

interface CacheEntry {
  expiresAt: number;
  value: RadarLocation[];
}

const cache = new Map<string, CacheEntry>();
let requestQueue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

export function countryCodeFor(country: string | null | undefined): string | undefined {
  const normalized = (country ?? '').trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes('brasil') || normalized === 'brazil' || normalized === 'br') return 'br';
  if (normalized.includes('portugal') || normalized === 'pt') return 'pt';
  if (
    normalized.includes('estados unidos') ||
    normalized === 'united states' ||
    normalized === 'usa' ||
    normalized === 'us'
  ) {
    return 'us';
  }
  return /^[a-z]{2}$/.test(normalized) ? normalized : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstText(...values: Array<string | undefined>): string | null {
  const found = values.find((value) => Boolean(value?.trim()));
  return found?.trim() ?? null;
}

function parsePlace(place: NominatimPlace, index: number): RadarLocation | null {
  const latitude = Number(place.lat);
  const longitude = Number(place.lon);
  const label = place.display_name?.trim();
  if (!label || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

  const address = place.address ?? {};
  const box = Array.isArray(place.boundingbox) ? place.boundingbox.map((value) => Number(value)) : [];
  const boundingBox =
    box.length === 4 && box.every((value) => Number.isFinite(value))
      ? { south: box[0]!, north: box[1]!, west: box[2]!, east: box[3]! }
      : null;

  return {
    id: place.place_id ? String(place.place_id) : `${latitude}:${longitude}:${index}`,
    label,
    latitude,
    longitude,
    type: place.type?.trim() || place.class?.trim() || null,
    city: firstText(address.city, address.town, address.village, address.municipality, address.county),
    state: firstText(address.state, address.region),
    country: firstText(address.country),
    countryCode: address.country_code?.toUpperCase() ?? null,
    neighborhood: firstText(address.suburb, address.neighbourhood),
    postalCode: firstText(address.postcode),
    boundingBox,
  };
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = requestQueue.then(async () => {
    const waitMs = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (waitMs) await sleep(waitMs);
    lastRequestAt = Date.now();
    return task();
  });
  requestQueue = run.catch(() => undefined);
  return run;
}

export async function searchLocations(
  query: string,
  country?: string | null,
  limit = 5,
): Promise<RadarLocation[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  const code = countryCodeFor(country);
  const cacheKey = `${code ?? 'any'}:${limit}:${trimmed.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const url = new URL(NOMINATIM_ENDPOINT);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('q', trimmed);
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 8)));
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', 'pt-BR,pt,en');
  if (code) url.searchParams.set('countrycodes', code);

  const places = await enqueue(async () => {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          'User-Agent': `LeadSearch/1.0 (+${config.appUrl || 'https://leadsearch-production.up.railway.app'})`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(12_000),
      });
    } catch (error) {
      logger.warn({ err: error }, 'Falha de rede ao consultar o Nominatim');
      throw upstreamError('Nao foi possivel consultar o servico de localizacao.');
    }
    if (!response.ok) {
      logger.warn({ status: response.status }, 'Nominatim retornou erro HTTP');
      throw upstreamError('O servico de localizacao nao respondeu corretamente.');
    }
    const payload = (await response.json().catch(() => null)) as NominatimPlace[] | null;
    return Array.isArray(payload) ? payload : [];
  });

  const value = places
    .map((place, index) => parsePlace(place, index))
    .filter((place): place is RadarLocation => place !== null);

  cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  if (cache.size > 300) {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= Date.now()) cache.delete(key);
    }
  }
  return value;
}

export async function resolveLocation(query: string, country?: string | null): Promise<RadarLocation | null> {
  const results = await searchLocations(query, country, 1);
  return results[0] ?? null;
}
