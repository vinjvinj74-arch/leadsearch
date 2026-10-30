import type { PoolClient } from 'pg';
import { config, type LeadStatus, type WebsiteStatus } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { toCsv } from '../lib/csv.js';
import { conflict, integrationNotConfigured, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
  normalizeAddress,
  normalizeDomain,
  normalizeName,
  normalizePhone,
  normalizeWebsiteUrl,
} from '../lib/normalize.js';
import { computeScore, type ScoreReason, type ScoreWeights } from '../lib/scoring.js';
import {
  abortActorRun,
  fetchRadarResults,
  isApifyConfigured,
  reserveApifyRun,
  startRadarRun,
  waitForSearchRun,
  type RadarApifyPlace,
} from './apifyService.js';
import { resolveLocation, type RadarLocation } from './geocodingService.js';
import { loadScoreWeights, type LeadRow } from './leadsService.js';
import { upsertLeadFromPlace } from './searchService.js';
import { attachCreditToSearch, refundCreditByReference } from './subscriptionService.js';
import type { PlaceResult } from './placesService.js';

export type RadarStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type RadarWebsiteFilter = 'all' | 'with' | 'without';
export type RadarPresenceFilter = 'any' | 'with' | 'without';
export type RadarCrmState = 'all' | 'unsaved' | 'saved' | 'not_contacted' | 'contacted' | 'closed';
export type RadarSort = 'score' | 'name' | 'rating' | 'reviews' | 'recent';

export interface RadarFilters {
  segments: string[];
  keyword: string;
  companyName: string;
  includeKeywords: string[];
  excludeKeywords: string[];
  website: RadarWebsiteFilter;
  minRating: number | null;
  minReviews: number | null;
  activeOnly: boolean;
  phonePresence: RadarPresenceFilter;
  hasAddress: RadarPresenceFilter;
  noEmail: boolean;
  incompleteContact: boolean;
  siteStatus: WebsiteStatus | 'unknown' | null;
  minScore: number | null;
  maxScore: number | null;
  crmState: RadarCrmState;
  crmStatus: LeadStatus | null;
  updatedDays: number | null;
  visibleArea: boolean;
  sort: RadarSort;
}

export interface RadarCreateInput {
  name?: string;
  location: {
    query: string;
    label?: string;
    latitude?: number;
    longitude?: number;
    country?: string;
    countryCode?: string;
  };
  radiusKm?: number | null;
  limit?: number;
  filters: RadarFilters;
}

interface RadarSearchRow {
  id: string;
  user_id: string;
  name: string;
  location_query: string;
  location_label: string;
  location_latitude: number | null;
  location_longitude: number | null;
  radius_km: number | null;
  country_code: string | null;
  filters: Partial<RadarFilters>;
  search_terms: string[];
  result_limit: number;
  provider: string;
  provider_run_id: string | null;
  provider_dataset_id: string | null;
  status: RadarStatus;
  results_count: number;
  error_message: string | null;
  cost_note: string | null;
  is_saved: boolean;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  saved_count?: number;
}

interface RadarResultRow {
  id: string;
  search_id: string;
  user_id: string;
  lead_id: string | null;
  fingerprint: string;
  place_id: string | null;
  name: string;
  category: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postal_code: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  normalized_domain: string;
  google_maps_url: string | null;
  rating: string | number | null;
  reviews_count: number | null;
  business_status: string | null;
  latitude: number | null;
  longitude: number | null;
  score: number;
  score_reasons: ScoreReason[];
  raw: Record<string, unknown>;
  scraped_at: Date | null;
  created_at: Date;
  updated_at: Date;
  lead_status: LeadStatus | null;
  lead_website_status: WebsiteStatus | null;
  lead_email: string | null;
  lead_score: number | null;
  lead_score_override: number | null;
  lead_updated_at: Date | null;
  lead_do_not_contact: boolean | null;
}

const ACTIVE_STATUSES: RadarStatus[] = ['pending', 'running'];

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function cleanText(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function termsFor(filters: RadarFilters): string[] {
  const keyword = cleanText(filters.keyword);
  const companyName = cleanText(filters.companyName);
  const segments = filters.segments
    .map((segment) => cleanText(segment))
    .filter(Boolean)
    .slice(0, 5);
  const base = companyName ? [companyName] : segments;
  const terms = (base.length ? base : keyword ? [keyword] : [])
    .map((term) => (keyword && !companyName ? `${term} ${keyword}` : term).trim())
    .filter(Boolean);
  return [...new Set(terms)].slice(0, 5);
}

function defaultName(filters: RadarFilters, locationLabel: string): string {
  const subject =
    cleanText(filters.companyName) || filters.segments[0] || cleanText(filters.keyword) || 'Empresas';
  const suffix = filters.segments.length > 1 ? ` +${filters.segments.length - 1}` : '';
  return `${subject}${suffix} em ${locationLabel.split(',')[0] || locationLabel}`.slice(0, 160);
}

function mapSearch(row: RadarSearchRow) {
  const filters = row.filters ?? {};
  return {
    id: row.id,
    name: row.name,
    location: {
      query: row.location_query,
      label: row.location_label,
      latitude: row.location_latitude,
      longitude: row.location_longitude,
      countryCode: row.country_code,
    },
    radiusKm: row.radius_km,
    filters,
    resultLimit: row.result_limit,
    status: row.status,
    resultsCount: row.results_count,
    savedCount: row.saved_count ?? 0,
    errorMessage:
      row.status === 'failed'
        ? 'Nao foi possivel concluir a pesquisa.'
        : row.status === 'cancelled'
          ? 'Pesquisa cancelada.'
          : null,
    isSaved: row.is_saved,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: iso(row.completed_at),
  };
}

function mapResult(row: RadarResultRow) {
  const leadScore = row.lead_score_override ?? row.lead_score;
  return {
    id: row.id,
    searchId: row.search_id,
    leadId: row.lead_id,
    saved: Boolean(row.lead_id),
    name: row.name,
    category: row.category,
    address: row.address,
    city: row.city,
    state: row.state,
    country: row.country,
    postalCode: row.postal_code,
    phone: row.phone,
    email: row.lead_email ?? row.email,
    website: row.website,
    googleMapsUrl: row.google_maps_url,
    rating: row.rating === null ? null : Number(row.rating),
    reviewsCount: row.reviews_count,
    businessStatus: row.business_status,
    latitude: row.latitude,
    longitude: row.longitude,
    score: leadScore ?? row.score,
    sourceScore: row.score,
    scoreReasons: Array.isArray(row.score_reasons) ? row.score_reasons : [],
    websiteStatus: row.lead_website_status,
    crmStatus: row.lead_status,
    doNotContact: Boolean(row.lead_do_not_contact),
    scrapedAt: iso(row.scraped_at),
    updatedAt: iso(row.lead_updated_at ?? row.updated_at),
    createdAt: iso(row.created_at),
  };
}

const RESULT_SELECT = `
  SELECT r.*,
    l.status AS lead_status,
    l.website_status AS lead_website_status,
    l.email AS lead_email,
    l.score AS lead_score,
    l.score_override AS lead_score_override,
    l.updated_at AS lead_updated_at,
    l.do_not_contact AS lead_do_not_contact
  FROM radar_results r
  LEFT JOIN leads l ON l.id = r.lead_id AND l.user_id = r.user_id`;

function placeMinimumStars(minRating: number | null): string | undefined {
  if (minRating === null) return undefined;
  if (minRating >= 4.5) return 'fourAndHalf';
  if (minRating >= 4) return 'four';
  if (minRating >= 3.5) return 'threeAndHalf';
  if (minRating >= 3) return 'three';
  if (minRating >= 2.5) return 'twoAndHalf';
  if (minRating >= 2) return 'two';
  return undefined;
}

function buildActorInput(
  search: RadarSearchRow,
  location: { label: string; latitude: number | null; longitude: number | null; radiusKm: number | null },
): Record<string, unknown> {
  const filters = search.filters ?? {};
  const website = filters.website ?? 'all';
  const terms = search.search_terms;
  const perTerm = Math.max(1, Math.ceil(search.result_limit / Math.max(terms.length, 1)));

  const input: Record<string, unknown> = {
    searchStringsArray: terms,
    maxCrawledPlacesPerSearch: perTerm,
    language: 'pt-BR',
    skipClosedPlaces: filters.activeOnly !== false,
    scrapePlaceDetailPage: false,
    scrapeContacts: false,
    scrapeSocialMediaProfiles: {
      facebooks: false,
      instagrams: false,
      youtubes: false,
      tiktoks: false,
      twitters: false,
    },
    maxReviews: 0,
    maxImages: 0,
    includeWebResults: false,
    scrapeDirectories: false,
    maximumLeadsEnrichmentRecords: 0,
    website: website === 'with' ? 'withWebsite' : website === 'without' ? 'withoutWebsite' : 'allPlaces',
  };

  if (search.country_code) {
    const cc = String(search.country_code).trim().toLowerCase();
    if (cc === 'brasil' || cc === 'brazil' || cc === 'br') {
      input.countryCode = 'br';
    } else if (/^[a-z]{2}$/.test(cc)) {
      input.countryCode = cc;
    }
    // if not valid, omit to avoid Apify validation error
  }
  const stars = placeMinimumStars(filters.minRating ?? null);
  if (stars) input.placeMinimumStars = stars;

  if (location.radiusKm && location.latitude !== null && location.longitude !== null) {
    input.customGeolocation = {
      type: 'Point',
      coordinates: [location.longitude, location.latitude],
      radiusKm: Math.min(Math.max(location.radiusKm, 1), 50),
    };
  } else {
    input.locationQuery = location.label;
  }

  return input;
}

function fingerprintFor(place: RadarApifyPlace): string {
  if (place.placeId) return `place:${place.placeId}`;
  const domain = normalizeDomain(place.website ?? '');
  if (domain) return `domain:${domain}`;
  const phone = normalizePhone(place.phone ?? '');
  if (phone) return `phone:${phone}`;
  const name = normalizeName(place.name);
  const address = normalizeAddress(place.address ?? '');
  const coords =
    place.latitude !== null && place.longitude !== null ? `${place.latitude}:${place.longitude}` : '';
  return `name:${name}|${address}|${coords}`;
}

function dedupeRadarPlaces(
  places: RadarApifyPlace[],
  limit: number,
): Array<{ place: RadarApifyPlace; fingerprint: string }> {
  const seen = new Set<string>();
  const unique: Array<{ place: RadarApifyPlace; fingerprint: string }> = [];

  for (const place of places) {
    const keys = [fingerprintFor(place)];
    const domain = normalizeDomain(place.website ?? '');
    if (domain) keys.push(`domain:${domain}`);
    const phone = normalizePhone(place.phone ?? '');
    if (phone) keys.push(`phone:${phone}`);
    const name = normalizeName(place.name);
    const address = normalizeAddress(place.address ?? '');
    if (name && address) keys.push(`name-address:${name}|${address}`);

    if (keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    unique.push({ place, fingerprint: keys[0]! });
    if (unique.length >= limit) break;
  }
  return unique;
}

function scoreRadarPlace(
  place: RadarApifyPlace,
  existing: LeadRow | null,
  weights: Partial<ScoreWeights> | null,
): { score: number; reasons: ScoreReason[] } {
  return computeScore(
    {
      websiteStatus: existing?.website_status ?? 'unknown',
      hasWebsite: Boolean(place.website),
      hasHttps: null,
      phone: place.phone ?? existing?.phone ?? null,
      email: existing?.email ?? null,
      businessStatus: place.businessStatus,
      reviewsCount: place.reviewsCount,
      segment: place.category,
      hasAddress: Boolean(place.address),
      hasGoogleCategory: Boolean(place.category),
    },
    weights ?? undefined,
  );
}

async function findExistingLeadForRadar(
  client: PoolClient,
  userId: string,
  place: RadarApifyPlace,
): Promise<LeadRow | null> {
  const domain = normalizeDomain(place.website ?? '');
  const phone = normalizePhone(place.phone ?? '');
  const name = normalizeName(place.name);
  const address = normalizeAddress(place.address ?? '');
  const result = await client.query<LeadRow>(
    `SELECT * FROM leads
     WHERE user_id = $1 AND (
       ($2::text IS NOT NULL AND place_id = $2)
       OR ($3::text <> '' AND normalized_domain = $3)
       OR ($4::text <> '' AND normalized_phone = $4)
       OR ($5::text <> '' AND $6::text <> '' AND normalized_name = $5 AND normalized_address = $6)
     )
     ORDER BY CASE
       WHEN $2::text IS NOT NULL AND place_id = $2 THEN 0
       WHEN $3::text <> '' AND normalized_domain = $3 THEN 1
       WHEN $4::text <> '' AND normalized_phone = $4 THEN 2
       ELSE 3
     END
     LIMIT 1`,
    [userId, place.placeId, domain, phone, name, address],
  );
  return result.rows[0] ?? null;
}

async function storeRadarResults(
  userId: string,
  searchId: string,
  places: RadarApifyPlace[],
  weights: Partial<ScoreWeights> | null,
): Promise<number> {
  const unique = dedupeRadarPlaces(places, config.maxSearchResults);
  await withTransaction(async (client) => {
    for (const { place, fingerprint } of unique) {
      const existing = await findExistingLeadForRadar(client, userId, place);
      const scored = scoreRadarPlace(place, existing, weights);
      const scrapedAt =
        place.scrapedAt && !Number.isNaN(Date.parse(place.scrapedAt)) ? new Date(place.scrapedAt) : null;
      await client.query(
        `INSERT INTO radar_results (
          search_id, user_id, lead_id, fingerprint, place_id, name, category, address, city, state,
          country, postal_code, phone, email, website, normalized_domain, google_maps_url, rating,
          reviews_count, business_status, latitude, longitude, score, score_reasons, raw, scraped_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18,
          $19, $20, $21, $22, $23, $24, $25, $26
        )
        ON CONFLICT (search_id, fingerprint) DO UPDATE SET
          place_id = COALESCE(EXCLUDED.place_id, radar_results.place_id),
          name = EXCLUDED.name,
          category = COALESCE(EXCLUDED.category, radar_results.category),
          address = COALESCE(EXCLUDED.address, radar_results.address),
          city = COALESCE(EXCLUDED.city, radar_results.city),
          state = COALESCE(EXCLUDED.state, radar_results.state),
          country = COALESCE(EXCLUDED.country, radar_results.country),
          postal_code = COALESCE(EXCLUDED.postal_code, radar_results.postal_code),
          phone = COALESCE(EXCLUDED.phone, radar_results.phone),
          email = COALESCE(EXCLUDED.email, radar_results.email),
          website = COALESCE(EXCLUDED.website, radar_results.website),
          normalized_domain = COALESCE(NULLIF(EXCLUDED.normalized_domain, ''), radar_results.normalized_domain),
          google_maps_url = COALESCE(EXCLUDED.google_maps_url, radar_results.google_maps_url),
          rating = COALESCE(EXCLUDED.rating, radar_results.rating),
          reviews_count = COALESCE(EXCLUDED.reviews_count, radar_results.reviews_count),
          business_status = COALESCE(EXCLUDED.business_status, radar_results.business_status),
          latitude = COALESCE(EXCLUDED.latitude, radar_results.latitude),
          longitude = COALESCE(EXCLUDED.longitude, radar_results.longitude),
          score = EXCLUDED.score,
          score_reasons = EXCLUDED.score_reasons,
          raw = EXCLUDED.raw,
          scraped_at = COALESCE(EXCLUDED.scraped_at, radar_results.scraped_at),
          updated_at = now()`,
        [
          searchId,
          userId,
          existing?.id ?? null,
          fingerprint,
          place.placeId,
          place.name,
          place.category,
          place.address,
          place.city,
          place.state,
          place.country,
          place.postalCode,
          place.phone,
          null,
          place.website ? normalizeWebsiteUrl(place.website) : null,
          normalizeDomain(place.website ?? ''),
          place.googleMapsUrl,
          place.rating,
          place.reviewsCount,
          place.businessStatus,
          place.latitude,
          place.longitude,
          scored.score,
          JSON.stringify(scored.reasons),
          JSON.stringify(place.raw),
          scrapedAt,
        ],
      );
    }
  });
  return unique.length;
}

async function processRadarSearch(
  userId: string,
  searchId: string,
  runId: string,
  limit: number,
  weights: Partial<ScoreWeights> | null,
  creditReference?: string,
): Promise<void> {
  let resultsImported = false;
  try {
    const run = await waitForSearchRun(runId);
    const current = await query<{ status: RadarStatus }>(
      'SELECT status FROM radar_searches WHERE id = $1 AND user_id = $2',
      [searchId, userId],
    );
    if (current.rows[0]?.status === 'cancelled') return;
    if (!run.defaultDatasetId) throw new Error('Nao foi possivel concluir a pesquisa.');

    const places = await fetchRadarResults(run.defaultDatasetId, limit);
    const afterFetch = await query<{ status: RadarStatus }>(
      'SELECT status FROM radar_searches WHERE id = $1 AND user_id = $2',
      [searchId, userId],
    );
    if (afterFetch.rows[0]?.status === 'cancelled') return;

    const found = await storeRadarResults(userId, searchId, places, weights);
    resultsImported = true;
    await query(
      `UPDATE radar_searches SET
        status = 'completed',
        results_count = $3,
        error_message = NULL,
        completed_at = now(),
        updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status <> 'cancelled'`,
      [searchId, userId, found],
    );
    logger.info({ userId, searchId, runId, found }, 'Pesquisa do Radar importada');
  } catch (error) {
    logger.error({ err: error, userId, searchId, runId }, 'Falha ao processar pesquisa do Radar');
    const failed = await query<{ status: RadarStatus }>(
      `UPDATE radar_searches SET
        status = 'failed',
        error_message = $3,
        completed_at = now(),
        updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status <> 'cancelled'
       RETURNING status`,
      [searchId, userId, 'Nao foi possivel concluir a pesquisa.'],
    );
    // Cancelamento pelo usuario nao gera estorno: o provedor externo ja foi
    // acionado e o custo incorrido nao e reembolsado. Somente falhas antes da
    // importacao de resultados devolvem o credito.
    const cancelled = failed.rows.length === 0;
    if (!resultsImported && !cancelled && creditReference) {
      await refundCreditByReference(
        userId,
        creditReference,
        'Pesquisa do Radar não concluída pelo provedor: crédito devolvido.',
      ).catch((refundError) => {
        logger.error({ err: refundError, userId, searchId }, 'Falha ao devolver credito do Radar');
      });
    }
  }
}

export async function createRadarSearch(
  userId: string,
  input: RadarCreateInput,
  creditReference?: string,
) {
  if (!isApifyConfigured()) {
    throw integrationNotConfigured('A pesquisa de empresas nao esta disponivel no momento.');
  }

  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? config.maxSearchResults), 1),
    config.maxSearchResults,
  );
  const terms = termsFor(input.filters);
  if (!terms.length) {
    throw conflict('Informe ao menos um segmento, nicho, palavra-chave ou nome de empresa.');
  }

  let location: RadarLocation | null = null;
  const hasCoordinates =
    typeof input.location.latitude === 'number' &&
    typeof input.location.longitude === 'number' &&
    Number.isFinite(input.location.latitude) &&
    Number.isFinite(input.location.longitude);
  if (hasCoordinates) {
    location = {
      id: 'selected',
      label: cleanText(input.location.label) || cleanText(input.location.query),
      latitude: input.location.latitude!,
      longitude: input.location.longitude!,
      type: null,
      city: null,
      state: null,
      country: cleanText(input.location.country) || null,
      countryCode: cleanText(input.location.countryCode).toUpperCase() || null,
      neighborhood: null,
      postalCode: null,
      boundingBox: null,
    };
  } else {
    location = await resolveLocation(input.location.query, input.location.country);
  }
  if (!location || !location.label) {
    throw conflict('Localizacao nao encontrada. Selecione uma sugestao valida.');
  }

  const radiusKm =
    input.radiusKm !== undefined && input.radiusKm !== null
      ? Math.min(Math.max(Math.trunc(input.radiusKm), 1), 50)
      : null;
  const filters: RadarFilters = {
    ...input.filters,
    segments: input.filters.segments
      .map((segment) => cleanText(segment))
      .filter(Boolean)
      .slice(0, 5),
    includeKeywords: input.filters.includeKeywords
      .map((word) => cleanText(word))
      .filter(Boolean)
      .slice(0, 20),
    excludeKeywords: input.filters.excludeKeywords
      .map((word) => cleanText(word))
      .filter(Boolean)
      .slice(0, 20),
    keyword: cleanText(input.filters.keyword),
    companyName: cleanText(input.filters.companyName),
  };
  const name = cleanText(input.name).slice(0, 160) || defaultName(filters, location.label);
  const costNote = 'A pesquisa pode consumir creditos e gerar cobranca.';

  const releaseSlot = reserveApifyRun();
  let search: RadarSearchRow | null = null;

  try {
    search = await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`radar:${userId}`]);
      await client.query(
        `UPDATE radar_searches SET
          status = 'failed',
          error_message = 'Pesquisa interrompida por tempo limite.',
          completed_at = now(),
          updated_at = now()
         WHERE user_id = $1 AND status IN ('pending', 'running')
           AND created_at < now() - interval '15 minutes'`,
        [userId],
      );
      const active = await client.query<{ id: string }>(
        `SELECT id FROM radar_searches
         WHERE user_id = $1 AND status IN ('pending', 'running')
           AND created_at > now() - interval '15 minutes'
         ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      if (active.rowCount) {
        throw conflict('Ja existe uma pesquisa do Radar em andamento. Aguarde a conclusao.');
      }

      const inserted = await client.query<RadarSearchRow>(
        `INSERT INTO radar_searches (
          user_id, name, location_query, location_label, location_latitude, location_longitude,
          radius_km, country_code, filters, search_terms, result_limit, status, provider, cost_note
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, 'pending', 'apify_google_maps', $12
        )
        RETURNING *`,
        [
          userId,
          name,
          cleanText(input.location.query) || location!.label,
          location!.label,
          location!.latitude,
          location!.longitude,
          radiusKm,
          location!.countryCode?.toLowerCase() ?? null,
          JSON.stringify(filters),
          terms,
          limit,
          costNote,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('Falha ao criar pesquisa do Radar.');
      return row;
    });

    const actorInput = buildActorInput(search, {
      label: location.label,
      latitude: location.latitude,
      longitude: location.longitude,
      radiusKm,
    });
    const run = await startRadarRun(actorInput, limit);
    const updated = await query<RadarSearchRow>(
      `UPDATE radar_searches SET
        status = 'running',
        provider_run_id = $3,
        provider_dataset_id = $4,
        updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [search.id, userId, run.runId, run.datasetId],
    );
    search = updated.rows[0] ?? search;
    if (creditReference) await attachCreditToSearch(userId, creditReference, search.id);

    const weights = await loadScoreWeights(userId);
    void processRadarSearch(userId, search.id, run.runId, limit, weights, creditReference)
      .catch((error) => {
        logger.error({ err: error, searchId: search?.id, runId: run.runId }, 'Falha nao tratada do Radar');
      })
      .finally(releaseSlot);

    return mapSearch(search);
  } catch (error) {
    releaseSlot();
    if (search) {
      await query(
        `UPDATE radar_searches SET
          status = 'failed',
          error_message = $3,
          completed_at = now(),
          updated_at = now()
         WHERE id = $1 AND user_id = $2 AND status <> 'cancelled'`,
        [search.id, userId, 'Nao foi possivel iniciar a pesquisa.'],
      ).catch(() => undefined);
    }
    throw error;
  }
}

export async function listRadarSearches(userId: string, limit = 20, savedOnly = false) {
  const result = await query<RadarSearchRow>(
    `SELECT s.*,
      (SELECT count(*)::int FROM radar_results r WHERE r.search_id = s.id AND r.lead_id IS NOT NULL) AS saved_count
     FROM radar_searches s
     WHERE s.user_id = $1 AND ($3::boolean = FALSE OR s.is_saved = TRUE)
     ORDER BY s.created_at DESC
     LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 50), savedOnly],
  );
  return result.rows.map(mapSearch);
}

async function getRadarSearchRow(userId: string, searchId: string): Promise<RadarSearchRow> {
  const result = await query<RadarSearchRow>(
    `SELECT s.*,
      (SELECT count(*)::int FROM radar_results r WHERE r.search_id = s.id AND r.lead_id IS NOT NULL) AS saved_count
     FROM radar_searches s
     WHERE s.id = $1 AND s.user_id = $2`,
    [searchId, userId],
  );
  const row = result.rows[0];
  if (!row) throw notFound('Pesquisa do Radar nao encontrada.');
  return row;
}

export async function getRadarSearch(userId: string, searchId: string) {
  const row = await getRadarSearchRow(userId, searchId);
  const results = await query<RadarResultRow>(
    `${RESULT_SELECT}
     WHERE r.search_id = $1 AND r.user_id = $2
     ORDER BY r.score DESC, r.reviews_count DESC NULLS LAST, r.name ASC
     LIMIT 20`,
    [searchId, userId],
  );
  return { search: mapSearch(row), results: results.rows.map(mapResult) };
}

export async function updateRadarSearch(
  userId: string,
  searchId: string,
  patch: { name?: string; isSaved?: boolean },
) {
  const current = await getRadarSearchRow(userId, searchId);
  const name = patch.name !== undefined ? cleanText(patch.name).slice(0, 160) : current.name;
  if (!name) throw conflict('Informe um nome para a pesquisa.');
  const result = await query<RadarSearchRow>(
    `UPDATE radar_searches SET
      name = $3,
      is_saved = COALESCE($4, is_saved),
      updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [searchId, userId, name, patch.isSaved ?? null],
  );
  const row = result.rows[0];
  if (!row) throw notFound('Pesquisa do Radar nao encontrada.');
  row.saved_count = current.saved_count;
  return mapSearch(row);
}

export async function cancelRadarSearch(userId: string, searchId: string) {
  const row = await getRadarSearchRow(userId, searchId);
  if (!ACTIVE_STATUSES.includes(row.status)) {
    throw conflict('Esta pesquisa nao esta em andamento.');
  }
  if (row.provider_run_id) await abortActorRun(row.provider_run_id);
  const updated = await query<RadarSearchRow>(
    `UPDATE radar_searches SET
      status = 'cancelled',
      error_message = 'Pesquisa cancelada pelo usuario.',
      completed_at = now(),
      updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [searchId, userId],
  );
  const result = updated.rows[0];
  if (!result) throw notFound('Pesquisa do Radar nao encontrada.');
  result.saved_count = row.saved_count;
  return mapSearch(result);
}

function rowToPlace(row: RadarResultRow): PlaceResult {
  const address = row.address;
  const city = row.city;
  const state = row.state;
  return {
    placeId: row.place_id ?? '',
    name: row.name,
    address,
    phone: row.phone,
    website: row.website,
    segment: row.category,
    rating: row.rating === null ? null : Number(row.rating),
    reviewsCount: row.reviews_count,
    businessStatus: row.business_status,
    googleMapsUrl: row.google_maps_url,
    latitude: row.latitude,
    longitude: row.longitude,
    sourceMetadata: {
      radarSearchId: row.search_id,
      city,
      state,
      scrapedAt: iso(row.scraped_at),
    },
  };
}

export async function saveRadarResults(
  userId: string,
  searchId: string,
  resultIds: string[] | undefined,
  saveAll: boolean,
): Promise<{ saved: number; leadIds: string[] }> {
  const search = await getRadarSearchRow(userId, searchId);
  const values: string[] = [];
  const params: unknown[] = [searchId, userId];
  let idClause = '';
  if (resultIds?.length) {
    params.push(resultIds);
    idClause = ` AND r.id = ANY($3::uuid[])`;
  } else if (!saveAll) {
    throw conflict('Selecione ao menos um resultado.');
  }

  const result = await query<RadarResultRow>(
    `${RESULT_SELECT}
     WHERE r.search_id = $1 AND r.user_id = $2 ${idClause}
     ORDER BY r.score DESC
     LIMIT 20`,
    params,
  );
  if (!result.rows.length) throw conflict('Nenhum resultado disponivel para salvar.');

  const weights = await loadScoreWeights(userId);
  const leadIds: string[] = [];
  await withTransaction(async (client) => {
    for (const row of result.rows) {
      const place = rowToPlace(row);
      const location = {
        city: row.city ?? '',
        state: row.state ?? null,
        country: row.country ?? search.country_code?.toUpperCase() ?? '',
      };
      const saved = await upsertLeadFromPlace(client, userId, null, place, weights, location, {
        name: 'apify_google_maps',
        metadata: {
          radarSearchId: searchId,
          radarResultId: row.id,
          source: 'radar',
        },
      });
      leadIds.push(saved.leadId);
      await client.query(
        `UPDATE radar_results SET lead_id = $3, updated_at = now()
         WHERE id = $1 AND user_id = $2`,
        [row.id, userId, saved.leadId],
      );
      values.push(saved.leadId);
    }
  });

  await query(
    `UPDATE radar_searches SET
      results_count = (SELECT count(*)::int FROM radar_results WHERE search_id = $1 AND user_id = $2),
      updated_at = now()
     WHERE id = $1 AND user_id = $2`,
    [searchId, userId],
  );

  return { saved: new Set(values).size, leadIds };
}

export async function exportRadarResults(
  userId: string,
  searchId: string,
  resultIds?: string[],
): Promise<string> {
  const search = await getRadarSearchRow(userId, searchId);
  const params: unknown[] = [searchId, userId];
  let idClause = '';
  if (resultIds?.length) {
    params.push(resultIds);
    idClause = ` AND r.id = ANY($3::uuid[])`;
  }
  const result = await query<RadarResultRow>(
    `${RESULT_SELECT}
     WHERE r.search_id = $1 AND r.user_id = $2 ${idClause}
     ORDER BY r.score DESC, r.name ASC
     LIMIT 20`,
    params,
  );
  const headers = [
    'Empresa',
    'Categoria',
    'Endereco',
    'Cidade',
    'UF',
    'Pais',
    'CEP',
    'Telefone',
    'E-mail',
    'Site',
    'Nota',
    'Avaliacoes',
    'Pontuacao',
    'Status no CRM',
    'Salvo no CRM',
    'Mapa',
    'Latitude',
    'Longitude',
    'Pesquisa',
    'Pesquisado em',
  ];
  const rows = result.rows.map((row) => {
    const mapped = mapResult(row);
    return {
      Empresa: mapped.name,
      Categoria: mapped.category ?? '',
      Endereco: mapped.address ?? '',
      Cidade: mapped.city ?? '',
      UF: mapped.state ?? '',
      Pais: mapped.country ?? '',
      CEP: mapped.postalCode ?? '',
      Telefone: mapped.phone ?? '',
      'E-mail': mapped.email ?? '',
      Site: mapped.website ?? '',
      Nota: mapped.rating ?? '',
      Avaliacoes: mapped.reviewsCount ?? '',
      Pontuacao: mapped.score,
      'Status no CRM': mapped.crmStatus ?? '',
      'Salvo no CRM': mapped.saved ? 'Sim' : 'Nao',
      Mapa: mapped.googleMapsUrl ?? '',
      Latitude: mapped.latitude ?? '',
      Longitude: mapped.longitude ?? '',
      Pesquisa: search.name,
      'Pesquisado em': mapped.scrapedAt ?? '',
    };
  });
  return toCsv(headers, rows);
}

export async function recoverStaleRadarSearches(): Promise<void> {
  const result = await query(
    `UPDATE radar_searches SET
      status = 'failed',
      error_message = COALESCE(error_message, 'Processamento interrompido por reinicio do servidor.'),
      completed_at = now(),
      updated_at = now()
     WHERE status IN ('pending', 'running') AND created_at < now() - interval '20 minutes'`,
  );
  if (result.rowCount)
    logger.warn({ count: result.rowCount }, 'Pesquisas do Radar antigas marcadas como falhas');
}
