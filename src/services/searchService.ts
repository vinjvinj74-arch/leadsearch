import type { PoolClient } from 'pg';
import { withTransaction, query } from '../db/pool.js';
import { config } from '../config.js';
import { notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
  normalizeAddress,
  normalizeDomain,
  normalizeName,
  normalizePhone,
  normalizeWebsiteUrl,
} from '../lib/normalize.js';
import { computeScore, type ScoreWeights } from '../lib/scoring.js';
import { searchPlaces, type PlaceResult, type SearchParams } from './placesService.js';
import type { LeadRow } from './leadsService.js';

export interface SearchRow {
  id: string;
  user_id: string;
  niche: string;
  city: string;
  state: string | null;
  country: string;
  radius_km: number | null;
  result_limit: number;
  status: 'pending' | 'running' | 'enriching' | 'completed' | 'failed';
  provider: string;
  provider_request_id: string | null;
  results_count: number;
  error_message: string | null;
  cost_note: string | null;
  created_at: Date;
  completed_at: Date | null;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function mapSearch(row: SearchRow) {
  return {
    id: row.id,
    niche: row.niche,
    city: row.city,
    state: row.state,
    country: row.country,
    radiusKm: row.radius_km,
    resultLimit: row.result_limit,
    status: row.status,
    provider: row.provider,
    providerRequestId: row.provider_request_id,
    resultsCount: row.results_count,
    errorMessage: row.error_message,
    costNote: row.cost_note,
    createdAt: iso(row.created_at),
    completedAt: iso(row.completed_at),
  };
}

async function findExistingLead(
  client: PoolClient,
  userId: string,
  placeId: string | null,
  domain: string,
  phone: string,
  name: string,
  address: string,
): Promise<LeadRow | null> {
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
    [userId, placeId, domain, phone, name, address],
  );
  return result.rows[0] ?? null;
}

function scorePlace(
  place: PlaceResult,
  website: string | null,
  phone: string | null,
  email: string | null,
  websiteStatus: LeadRow['website_status'],
  weights: Partial<ScoreWeights> | null,
) {
  return computeScore(
    {
      websiteStatus,
      hasWebsite: Boolean(website),
      hasHttps: null,
      phone,
      email,
      businessStatus: place.businessStatus,
      reviewsCount: place.reviewsCount,
      segment: place.segment,
      hasAddress: Boolean(place.address),
      hasGoogleCategory: Boolean(place.segment),
    },
    weights ?? undefined,
  );
}

async function insertOrUpdateLead(
  client: PoolClient,
  userId: string,
  searchId: string,
  place: PlaceResult,
  weights: Partial<ScoreWeights> | null,
  location: { city: string; state: string | null; country: string },
): Promise<{ leadId: string; created: boolean }> {
  const normalizedName = normalizeName(place.name);
  const normalizedAddress = normalizeAddress(place.address);
  const normalizedPhone = normalizePhone(place.phone);
  const website = normalizeWebsiteUrl(place.website);
  const normalizedDomain = normalizeDomain(website);
  const existing = await findExistingLead(
    client,
    userId,
    place.placeId || null,
    normalizedDomain,
    normalizedPhone,
    normalizedName,
    normalizedAddress,
  );

  if (existing) {
    const nextWebsite = existing.website || website;
    const nextPhone = existing.phone || place.phone;
    const nextEmail = existing.email;
    const websiteChanged = nextWebsite !== existing.website;
    const nextWebsiteStatus = websiteChanged ? 'unknown' : existing.website_status;
    const scored = scorePlace(place, nextWebsite, nextPhone, nextEmail, nextWebsiteStatus, weights);
    const updated = await client.query<LeadRow>(
      `UPDATE leads SET
        place_id = COALESCE(place_id, $3),
        segment = COALESCE($4, segment),
        city = COALESCE($5, city),
        state = COALESCE($6, state),
        country = COALESCE($7, country),
        address = COALESCE($8, address),
        normalized_address = CASE WHEN $8 IS NOT NULL THEN $9 ELSE normalized_address END,
        phone = CASE WHEN phone IS NULL THEN $10 ELSE phone END,
        normalized_phone = CASE WHEN normalized_phone = '' THEN $11 ELSE normalized_phone END,
        website = CASE WHEN website IS NULL THEN $12 ELSE website END,
        normalized_domain = CASE WHEN normalized_domain = '' THEN $13 ELSE normalized_domain END,
        google_maps_url = COALESCE($14, google_maps_url),
        rating = COALESCE($15, rating),
        reviews_count = COALESCE($16, reviews_count),
        business_status = COALESCE($17, business_status),
        website_status = $18,
        score = $19,
        score_reasons = $20,
        updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [
        existing.id,
        userId,
        place.placeId || null,
        place.segment,
        location.city,
        location.state,
        location.country,
        place.address,
        normalizedAddress,
        place.phone,
        normalizedPhone,
        website,
        normalizedDomain,
        place.googleMapsUrl,
        place.rating,
        place.reviewsCount,
        place.businessStatus,
        nextWebsiteStatus,
        scored.score,
        JSON.stringify(scored.reasons),
      ],
    );
    await client.query(
      `INSERT INTO lead_sources (lead_id, source, source_url, metadata)
       VALUES ($1, 'google_places', $2, $3)`,
      [existing.id, place.googleMapsUrl, JSON.stringify({ placeId: place.placeId, updated: true })],
    );
    if (!updated.rows[0]) throw new Error('Falha ao atualizar lead.');
    return { leadId: existing.id, created: false };
  }

  const scored = scorePlace(place, website, place.phone, null, 'unknown', weights);
  const inserted = await client.query<LeadRow>(
    `INSERT INTO leads (
      user_id, search_id, place_id, name, normalized_name, segment, city, state, country,
      address, normalized_address, phone, normalized_phone, website, normalized_domain,
      google_maps_url, rating, reviews_count, business_status, score, score_reasons,
      website_status, status
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      $10, $11, $12, $13, $14, $15,
      $16, $17, $18, $19, $20, $21,
      'unknown', 'novo'
    )
    RETURNING *`,
    [
      userId,
      searchId,
      place.placeId || null,
      place.name,
      normalizedName,
      place.segment,
      location.city,
      location.state,
      location.country,
      place.address,
      normalizedAddress,
      place.phone,
      normalizedPhone,
      website,
      normalizedDomain,
      place.googleMapsUrl,
      place.rating,
      place.reviewsCount,
      place.businessStatus,
      scored.score,
      JSON.stringify(scored.reasons),
    ],
  );
  const lead = inserted.rows[0];
  if (!lead) throw new Error('Falha ao inserir lead.');
  await client.query(
    `INSERT INTO lead_sources (lead_id, source, source_url, metadata)
     VALUES ($1, 'google_places', $2, $3)`,
    [lead.id, place.googleMapsUrl, JSON.stringify({ placeId: place.placeId, created: true })],
  );
  return { leadId: lead.id, created: true };
}

export async function createSearch(
  userId: string,
  params: SearchParams,
  weights: Partial<ScoreWeights> | null,
  allowEnrichment: boolean,
) {
  const limit = Math.min(Math.max(params.limit, 1), config.maxSearchResults);
  const costNote =
    params.radiusKm && params.radiusKm > 0
      ? 'Consome 1 requisicao de Geocoding e 1 de Places Text Search (New). O Google pode cobrar por requisicao conforme a tabela vigente.'
      : 'Consome 1 requisicao de Places Text Search (New). O Google pode cobrar por requisicao conforme a tabela vigente.';

  const inserted = await query<SearchRow>(
    `INSERT INTO searches (user_id, niche, city, state, country, radius_km, result_limit, status, cost_note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8)
     RETURNING *`,
    [userId, params.niche, params.city, params.state ?? null, params.country, params.radiusKm ?? null, limit, costNote],
  );
  const search = inserted.rows[0];
  if (!search) throw new Error('Falha ao criar pesquisa.');

  let places: PlaceResult[];
  try {
    places = await searchPlaces({ ...params, limit });
  } catch (error) {
    await query(
      `UPDATE searches SET status = 'failed', error_message = $3, completed_at = now()
       WHERE id = $1 AND user_id = $2`,
      [search.id, userId, error instanceof Error ? error.message : 'Falha na pesquisa.'],
    );
    throw error;
  }

  let created = 0;
  let updated = 0;
  await withTransaction(async (client) => {
    for (const place of places) {
      const result = await insertOrUpdateLead(client, userId, search.id, place, weights, {
        city: params.city,
        state: params.state ?? null,
        country: params.country,
      });
      if (result.created) created += 1;
      else updated += 1;
    }
  });

  const status = allowEnrichment ? 'enriching' : 'completed';
  const finalized = await query<SearchRow>(
    `UPDATE searches SET
      status = $3,
      results_count = $4,
      completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE NULL END
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [search.id, userId, status, places.length],
  );

  logger.info({ userId, searchId: search.id, found: places.length, created, updated }, 'Pesquisa executada');
  return {
    search: mapSearch(finalized.rows[0] ?? search),
    stats: { found: places.length, created, updated },
  };
}

export async function listSearches(userId: string, limit = 20) {
  const result = await query<SearchRow>(
    'SELECT * FROM searches WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit],
  );
  return result.rows.map(mapSearch);
}

export async function getSearch(userId: string, searchId: string) {
  const result = await query<SearchRow>('SELECT * FROM searches WHERE id = $1 AND user_id = $2', [
    searchId,
    userId,
  ]);
  const row = result.rows[0];
  if (!row) throw notFound('Pesquisa nao encontrada.');
  return mapSearch(row);
}

export async function recoverStaleSearches(): Promise<void> {
  const result = await query(
    `UPDATE searches SET
      status = 'completed',
      completed_at = now(),
      error_message = COALESCE(error_message, 'Processo de enriquecimento interrompido por reinicio do servidor. Os leads encontrados foram preservados.')
     WHERE status IN ('running', 'enriching') AND created_at < now() - interval '20 minutes'`,
  );
  if (result.rowCount) logger.warn({ count: result.rowCount }, 'Pesquisas antigas marcadas como concluidas');
}
