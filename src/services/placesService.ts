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
    throw integrationNotConfigured(
      'Google Maps Platform nao configurada. Defina GOOGLE_MAPS_API_KEY no servidor para executar pesquisas reais.',
    );
  }
  return config.googleMapsApiKey;
}

function regionCodeFor(country: string): string | undefined {
  const normalized = country.trim().toLowerCase();
  if (!normalized || normalized.includes('brasil') || normalized === 'brazil' || normalized === 'br') return 'BR';
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
      logger.warn({ status: response.status }, 'Geocoding API retornou erro HTTP');
      return null;
    }
    const payload = (await response.json()) as {
      status?: string;
      results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
    };
    const location = payload.results?.[0]?.geometry?.location;
    if (payload.status !== 'OK' || typeof location?.lat !== 'number' || typeof location?.lng !== 'number') {
      logger.warn({ providerStatus: payload.status }, 'Geocoding API nao retornou coordenadas');
      return null;
    }
    return { latitude: location.lat, longitude: location.lng };
  } catch (error) {
    logger.warn({ err: error }, 'Falha ao consultar Geocoding API');
    return null;
  }
}

export async function searchPlaces(params: SearchParams): Promise<PlaceResult[]> {
  const key = requireKey();
  const queryParts = [params.niche, 'em', params.city, params.state, params.country].filter(Boolean);
  const body: Record<string, unknown> = {
    textQuery: queryParts.join(' '),
    languageCode: 'pt-BR',
    maxResultCount: Math.min(Math.max(params.limit, 1), 20),
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
        { status: response.status, providerStatus: payload.error?.status, geocodeUsed },
        'Places API retornou erro',
      );
      throw upstreamError(
        payload.error?.message
          ? `Google Places recusou a consulta: ${payload.error.message}`
          : 'Google Places recusou a consulta.',
        { providerStatus: payload.error?.status ?? null, httpStatus: response.status },
      );
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
      throw upstreamError('Tempo limite excedido ao consultar o Google Places.');
    }
    
    logger.warn({ err: error }, 'Falha de rede ao consultar Places API');
    throw upstreamError('Nao foi possivel conectar ao Google Places.');
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
    throw upstreamError(
      payload.error?.message ?? 'Falha ao testar a Google Maps Platform.',
      { providerStatus: payload.error?.status ?? null, httpStatus: response.status },
    );
  }
  return {
    ok: true,
    latencyMs: Date.now() - started,
    resultCount: payload.places?.length ?? 0,
  };
}
