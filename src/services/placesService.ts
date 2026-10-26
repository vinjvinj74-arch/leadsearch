import { config } from '../config.js';
import { AppError, integrationNotConfigured, upstreamError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const GEOCODE_ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.primaryTypeDisplayName',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.googleMapsUri',
  'places.location',
].join(',');

export interface PlaceResult {
  placeId: string;
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  segment: string | null;
  rating: number | null;
  reviewsCount: number | null;
  businessStatus: string | null;
  googleMapsUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  sourceMetadata?: Record<string, unknown>;
}

interface PlacesApiResponse {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    internationalPhoneNumber?: string;
    websiteUri?: string;
    primaryTypeDisplayName?: { text?: string };
    rating?: number;
    userRatingCount?: number;
    businessStatus?: string;
    googleMapsUri?: string;
    location?: { latitude?: number; longitude?: number };
  }>;
  error?: { code?: number; message?: string; status?: string };
}

function requireKey(): string {
  if (!config.googleMapsApiKey) {
    throw integrationNotConfigured('A pesquisa de empresas nao esta disponivel no momento.');
  }
  return config.googleMapsApiKey;
}

function regionCodeFor(country: string): string | undefined {
  const normalized = country.trim().toLowerCase();
  if (!normalized || normalized.includes('brasil') || normalized === 'brazil' || normalized === 'br')
    return 'BR';
  return normalized.length === 2 ? normalized.toUpperCase() : undefined;
}

export interface SearchParams {
  niche: string;
  city: string;
  state?: string | null;
  country: string;
  radiusKm?: number | null;
  limit: number;
}

export async function geocodeCity(
  city: string,
  state: string | null | undefined,
  country: string,
): Promise<{ latitude: number; longitude: number } | null> {
  const key = requireKey();
  const address = [city, state, country].filter(Boolean).join(', ');
  const url = new URL(GEOCODE_ENDPOINT);
  url.searchParams.set('address', address);
  url.searchParams.set('key', key);
  url.searchParams.set('language', 'pt-BR');
  const region = regionCodeFor(country);
  if (region) url.searchParams.set('region', region.toLowerCase());

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'Geocodificacao externa retornou erro HTTP');
      return null;
    }
    const payload = (await response.json()) as {
      status?: string;
      results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
    };
    const location = payload.results?.[0]?.geometry?.location;
    if (payload.status !== 'OK' || typeof location?.lat !== 'number' || typeof location?.lng !== 'number') {
      logger.warn({ upstreamStatus: payload.status }, 'Geocodificacao externa nao retornou coordenadas');
      return null;
    }
    return { latitude: location.lat, longitude: location.lng };
  } catch (error) {
    logger.warn({ err: error }, 'Falha ao consultar geocodificacao externa');
    return null;
  }
}

export async function searchPlaces(params: SearchParams): Promise<PlaceResult[]> {
  const key = requireKey();
  const queryParts = [params.niche, 'em', params.city, params.state, params.country].filter(Boolean);
  const body: Record<string, unknown> = {
    textQuery: queryParts.join(' '),
    languageCode: 'pt-BR',
    maxResultCount: Math.min(Math.max(params.limit, 1), config.maxSearchResults),
  };
  const region = regionCodeFor(params.country);
  if (region) body.regionCode = region;

  let geocodeUsed = false;
  if (params.radiusKm && params.radiusKm > 0) {
    const coords = await geocodeCity(params.city, params.state, params.country);
    if (coords) {
      geocodeUsed = true;
      body.locationBias = {
        circle: {
          center: { latitude: coords.latitude, longitude: coords.longitude },
          radius: Math.min(Math.max(params.radiusKm, 1), 50) * 1000,
        },
      };
    }
  }

  try {
    const response = await fetch(PLACES_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const payload = (await response.json().catch(() => ({}))) as PlacesApiResponse;
    if (!response.ok || payload.error) {
      logger.warn(
        { status: response.status, upstreamStatus: payload.error?.status, geocodeUsed },
        'Servico de pesquisa externo retornou erro',
      );
      throw upstreamError('Nao foi possivel concluir a pesquisa.');
    }
    return (payload.places ?? []).map((place) => ({
      placeId: place.id ?? '',
      name: place.displayName?.text ?? 'Empresa sem nome',
      address: place.formattedAddress ?? null,
      phone: place.internationalPhoneNumber ?? null,
      website: place.websiteUri ?? null,
      segment: place.primaryTypeDisplayName?.text ?? null,
      rating: typeof place.rating === 'number' ? place.rating : null,
      reviewsCount: typeof place.userRatingCount === 'number' ? place.userRatingCount : null,
      businessStatus: place.businessStatus ?? null,
      googleMapsUrl: place.googleMapsUri ?? null,
      latitude: place.location?.latitude ?? null,
      longitude: place.location?.longitude ?? null,
    }));
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw upstreamError('Tempo limite excedido ao processar a pesquisa.');
    }

    logger.warn({ err: error }, 'Falha de rede ao consultar o servico de pesquisa');
    throw upstreamError('Nao foi possivel processar a pesquisa no momento.');
  }
}

export async function testGooglePlaces(): Promise<{ ok: boolean; latencyMs: number; resultCount: number }> {
  const key = requireKey();
  const started = Date.now();
  const response = await fetch(PLACES_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.id,places.displayName',
    },
    body: JSON.stringify({
      textQuery: 'clinica odontologica em Campinas, SP, Brasil',
      languageCode: 'pt-BR',
      regionCode: 'BR',
      maxResultCount: 1,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const payload = (await response.json().catch(() => ({}))) as PlacesApiResponse;
  if (!response.ok || payload.error) {
    throw upstreamError('Nao foi possivel validar a pesquisa de empresas.');
  }
  return {
    ok: true,
    latencyMs: Date.now() - started,
    resultCount: payload.places?.length ?? 0,
  };
}

export async function searchPlacesFallback(params: SearchParams): Promise<PlaceResult[]> {
  try {
    const queryParts = [params.niche, 'em', params.city, params.state, params.country].filter(Boolean);
    const q = queryParts.join(' ');
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=${Math.min(Math.max(params.limit, 1), config.maxSearchResults)}&accept-language=pt-BR`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'LeadSearch/1.0 (contact@leadsearch.local)',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw upstreamError('Nao foi possivel concluir a pesquisa.');
    const data = (await response.json()) as Array<any>;
    return data.map((item, idx) => ({
      placeId: item.place_id ? String(item.place_id) : `osm-${idx}`,
      name: item.display_name?.split(',')[0] || params.niche,
      address: item.display_name || null,
      phone: null,
      website: null,
      segment: params.niche,
      rating: null,
      reviewsCount: null,
      businessStatus: null,
      googleMapsUrl: null,
      latitude: item.lat ? Number(item.lat) : null,
      longitude: item.lon ? Number(item.lon) : null,
      sourceMetadata: { source: 'osm_nominatim' },
    }));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw upstreamError('Nao foi possivel concluir a pesquisa.');
  }
}
