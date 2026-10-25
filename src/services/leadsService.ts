import { LEAD_STATUSES, WEBSITE_STATUSES, type LeadStatus, type WebsiteStatus } from '../config.js';
import { query } from '../db/pool.js';
import { conflict, notFound } from '../lib/errors.js';
import {
  computeScore,
  DEFAULT_WEIGHTS,
  sanitizeWeights,
  type ScoreReason,
  type ScoreWeights,
} from '../lib/scoring.js';
import {
  normalizeAddress,
  normalizeDomain,
  normalizeName,
  normalizePhone,
  normalizeWebsiteUrl,
} from '../lib/normalize.js';

export function publicSourceName(source: string): string {
  if (source === 'apify_google_maps' || source === 'google_places') return 'Pesquisa de empresas';
  if (source === 'website_enrichment') return 'Enriquecimento do site';
  if (source === 'website_check') return 'Verificacao do site';
  return 'Origem registrada';
}

export interface LeadRow {
  id: string;
  user_id: string;
  search_id: string | null;
  place_id: string | null;
  name: string;
  normalized_name: string;
  segment: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  address: string | null;
  normalized_address: string;
  phone: string | null;
  normalized_phone: string;
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
  score_override: number | null;
  score_reasons: ScoreReason[];
  website_status: WebsiteStatus;
  website_http_status: number | null;
  site_has_https: boolean | null;
  site_response_ms: number | null;
  redirect_count: number | null;
  website_last_checked_at: Date | null;
  status: LeadStatus;
  do_not_contact: boolean;
  last_contacted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function mapLead(row: LeadRow) {
  return {
    id: row.id,
    searchId: row.search_id,
    placeId: row.place_id,
    name: row.name,
    segment: row.segment,
    city: row.city,
    state: row.state,
    country: row.country,
    address: row.address,
    phone: row.phone,
    email: row.email,
    website: row.website,
    googleMapsUrl: row.google_maps_url,
    rating: row.rating === null ? null : Number(row.rating),
    reviewsCount: row.reviews_count,
    businessStatus: row.business_status,
    latitude: row.latitude,
    longitude: row.longitude,
    score: row.score,
    scoreOverride: row.score_override,
    effectiveScore: row.score_override ?? row.score,
    scoreReasons: Array.isArray(row.score_reasons) ? row.score_reasons : [],
    websiteStatus: row.website_status,
    websiteHttpStatus: row.website_http_status,
    siteHasHttps: row.site_has_https,
    siteResponseMs: row.site_response_ms,
    redirectCount: row.redirect_count,
    websiteLastCheckedAt: iso(row.website_last_checked_at),
    status: row.status,
    doNotContact: row.do_not_contact,
    lastContactedAt: iso(row.last_contacted_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function scoreForLead(
  row: LeadRow,
  weights: Partial<ScoreWeights> | null,
): { score: number; reasons: ScoreReason[] } {
  return computeScore(
    {
      websiteStatus: row.website_status,
      hasWebsite: Boolean(row.website),
      hasHttps: row.site_has_https,
      phone: row.phone,
      email: row.email,
      businessStatus: row.business_status,
      reviewsCount: row.reviews_count,
      segment: row.segment,
      hasAddress: Boolean(row.address),
      hasGoogleCategory: Boolean(row.segment),
    },
    weights ?? DEFAULT_WEIGHTS,
  );
}

export async function loadScoreWeights(userId: string): Promise<Partial<ScoreWeights> | null> {
  const result = await query<{ score_weights: Record<string, number> | null }>(
    'SELECT score_weights FROM user_settings WHERE user_id = $1',
    [userId],
  );
  const weights = result.rows[0]?.score_weights;
  return weights ? sanitizeWeights(weights) : null;
}

export async function getLeadRow(userId: string, leadId: string): Promise<LeadRow> {
  const result = await query<LeadRow>('SELECT * FROM leads WHERE id = $1 AND user_id = $2 LIMIT 1', [
    leadId,
    userId,
  ]);
  const row = result.rows[0];
  if (!row) throw notFound('Lead nao encontrado.');
  return row;
}

export async function getLeadDetail(userId: string, leadId: string) {
  const lead = await getLeadRow(userId, leadId);
  const [activities, sources, contacts] = await Promise.all([
    query<{
      id: string;
      type: string;
      from_status: string | null;
      to_status: string | null;
      note: string | null;
      next_action: string | null;
      next_action_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, type, from_status, to_status, note, next_action, next_action_at, created_at
       FROM lead_activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [leadId],
    ),
    query<{ id: string; source: string; source_url: string | null; collected_at: Date; metadata: unknown }>(
      `SELECT id, source, source_url, collected_at, metadata
       FROM lead_sources WHERE lead_id = $1 ORDER BY collected_at DESC LIMIT 100`,
      [leadId],
    ),
    query<{
      id: string;
      kind: string;
      value: string;
      source_url: string | null;
      source_type: string;
      collected_at: Date;
    }>(
      `SELECT id, kind, value, source_url, source_type, collected_at
       FROM lead_contacts WHERE lead_id = $1 ORDER BY collected_at DESC LIMIT 100`,
      [leadId],
    ),
  ]);

  return {
    ...mapLead(lead),
    activities: activities.rows.map((row) => ({
      id: row.id,
      type: row.type,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      note: row.note,
      nextAction: row.next_action,
      nextActionAt: iso(row.next_action_at),
      createdAt: iso(row.created_at),
    })),
    sources: sources.rows.map((row) => ({
      id: row.id,
      source: publicSourceName(row.source),
      sourceUrl:
        row.source === 'website_enrichment' || row.source === 'website_check' ? row.source_url : null,
      collectedAt: iso(row.collected_at),
    })),
    contacts: contacts.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      value: row.value,
      sourceUrl: row.source_url,
      sourceType: row.source_type,
      collectedAt: iso(row.collected_at),
    })),
  };
}

export interface LeadFilters {
  q?: string;
  status?: LeadStatus;
  websiteStatus?: WebsiteStatus;
  hasWebsite?: 'yes' | 'no';
  minScore?: number;
  maxScore?: number;
  searchId?: string;
  ids?: string[];
  sort?: string;
  order?: 'asc' | 'desc';
}

function buildFilters(userId: string, filters: LeadFilters) {
  const clauses: string[] = ['l.user_id = $1'];
  const values: unknown[] = [userId];

  if (filters.q) {
    values.push(`%${filters.q}%`);
    const index = values.length;
    clauses.push(
      `(l.name ILIKE $${index} OR l.email ILIKE $${index} OR l.phone ILIKE $${index} OR l.website ILIKE $${index} OR l.address ILIKE $${index} OR l.segment ILIKE $${index})`,
    );
  }
  if (filters.status) {
    values.push(filters.status);
    clauses.push(`l.status = $${values.length}`);
  }
  if (filters.websiteStatus) {
    values.push(filters.websiteStatus);
    clauses.push(`l.website_status = $${values.length}`);
  }
  if (filters.hasWebsite === 'yes') {
    clauses.push(`l.website IS NOT NULL AND l.website <> ''`);
  } else if (filters.hasWebsite === 'no') {
    clauses.push(`(l.website IS NULL OR l.website = '')`);
  }
  if (typeof filters.minScore === 'number') {
    values.push(filters.minScore);
    clauses.push(`COALESCE(l.score_override, l.score) >= $${values.length}`);
  }
  if (typeof filters.maxScore === 'number') {
    values.push(filters.maxScore);
    clauses.push(`COALESCE(l.score_override, l.score) <= $${values.length}`);
  }
  if (filters.searchId) {
    values.push(filters.searchId);
    clauses.push(`l.search_id = $${values.length}`);
  }
  if (filters.ids?.length) {
    values.push(filters.ids);
    clauses.push(`l.id = ANY($${values.length}::uuid[])`);
  }
  return { where: clauses.join(' AND '), values };
}

const SORTABLE: Record<string, string> = {
  score: 'COALESCE(l.score_override, l.score)',
  created_at: 'l.created_at',
  updated_at: 'l.updated_at',
  name: 'l.name',
  last_checked_at: 'l.website_last_checked_at',
  status: 'l.status',
};

export async function listLeads(userId: string, filters: LeadFilters, page: number, pageSize: number) {
  const { where, values } = buildFilters(userId, filters);
  const sortColumn = SORTABLE[filters.sort ?? 'created_at'] ?? SORTABLE.created_at;
  const order = filters.order === 'asc' ? 'ASC' : 'DESC';
  const countResult = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM leads l WHERE ${where}`,
    values,
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  const pagedValues = [...values, pageSize, (page - 1) * pageSize];
  const result = await query<LeadRow>(
    `SELECT l.* FROM leads l WHERE ${where}
     ORDER BY ${sortColumn} ${order}, l.created_at DESC
     LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    pagedValues,
  );

  return {
    leads: result.rows.map(mapLead),
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}

export async function listLeadsForExport(
  userId: string,
  filters: LeadFilters,
  limit: number,
): Promise<LeadRow[]> {
  const { where, values } = buildFilters(userId, filters);
  const result = await query<LeadRow>(
    `SELECT l.* FROM leads l WHERE ${where} ORDER BY l.created_at DESC LIMIT $${values.length + 1}`,
    [...values, limit],
  );
  return result.rows;
}

const CONTACT_STATUSES: LeadStatus[] = [
  'contatado',
  'aguardando_resposta',
  'respondeu',
  'reuniao_agendada',
  'proposta_enviada',
  'em_negociacao',
  'vendido',
];

export interface LeadPatch {
  name?: string;
  segment?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  status?: LeadStatus;
  doNotContact?: boolean;
  scoreOverride?: number | null;
  websiteStatus?: 'unknown' | 'missing';
}

export async function updateLead(userId: string, leadId: string, patch: LeadPatch, activityNote?: string) {
  const current = await getLeadRow(userId, leadId);
  const weights = await loadScoreWeights(userId);

  if (patch.status && !(LEAD_STATUSES as readonly string[]).includes(patch.status)) {
    throw conflict('Status comercial invalido.');
  }
  const nextDoNotContact = patch.doNotContact ?? current.do_not_contact;
  const nextStatus = patch.status ?? current.status;
  if (nextDoNotContact && nextStatus !== 'nao_contatar') {
    throw conflict('Lead marcado como nao contatar. Remova essa preferencia antes de alterar o status.');
  }

  const name = patch.name?.trim() || current.name;
  const website = patch.website !== undefined ? normalizeWebsiteUrl(patch.website) : current.website;
  const phone = patch.phone !== undefined ? patch.phone?.trim() || null : current.phone;
  const email = patch.email !== undefined ? patch.email?.trim().toLowerCase() || null : current.email;
  const address = patch.address !== undefined ? patch.address?.trim() || null : current.address;
  const status = nextStatus;
  const websiteStatus: WebsiteStatus =
    patch.websiteStatus ??
    (patch.website !== undefined && normalizeWebsiteUrl(patch.website) !== current.website
      ? 'unknown'
      : current.website_status);
  const doNotContact = nextDoNotContact || status === 'nao_contatar';

  const mergedForScore: LeadRow = {
    ...current,
    name,
    website,
    phone,
    email,
    address,
    segment: patch.segment !== undefined ? patch.segment?.trim() || null : current.segment,
    city: patch.city !== undefined ? patch.city?.trim() || null : current.city,
    state: patch.state !== undefined ? patch.state?.trim() || null : current.state,
    country: patch.country !== undefined ? patch.country?.trim() || null : current.country,
    website_status: websiteStatus,
    business_status: current.business_status,
  };
  const scored = scoreForLead(mergedForScore, weights);
  const lastContactedAt =
    status !== current.status && CONTACT_STATUSES.includes(status) ? new Date() : current.last_contacted_at;

  const result = await query<LeadRow>(
    `UPDATE leads SET
      name = $3,
      normalized_name = $4,
      segment = $5,
      city = $6,
      state = $7,
      country = $8,
      address = $9,
      normalized_address = $10,
      phone = $11,
      normalized_phone = $12,
      email = $13,
      website = $14,
      normalized_domain = $15,
      score = $16,
      score_override = $17,
      score_reasons = $18,
      website_status = $19,
      status = $20,
      do_not_contact = $21,
      last_contacted_at = $22,
      updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [
      leadId,
      userId,
      name,
      normalizeName(name),
      mergedForScore.segment,
      mergedForScore.city,
      mergedForScore.state,
      mergedForScore.country,
      address,
      normalizeAddress(address),
      phone,
      normalizePhone(phone),
      email,
      website,
      normalizeDomain(website),
      scored.score,
      patch.scoreOverride !== undefined ? patch.scoreOverride : current.score_override,
      JSON.stringify(scored.reasons),
      websiteStatus,
      status,
      doNotContact,
      lastContactedAt,
    ],
  );
  const updated = result.rows[0];
  if (!updated) throw notFound('Lead nao encontrado.');

  if (status !== current.status) {
    await query(
      `INSERT INTO lead_activities (lead_id, user_id, type, from_status, to_status, note)
       VALUES ($1, $2, 'status_change', $3, $4, $5)`,
      [leadId, userId, current.status, status, activityNote ?? 'Status atualizado manualmente.'],
    );
  }
  if (doNotContact && !current.do_not_contact) {
    await query(
      `INSERT INTO lead_activities (lead_id, user_id, type, note)
       VALUES ($1, $2, 'do_not_contact', $3)`,
      [leadId, userId, activityNote ?? 'Preferencia de nao contato registrada.'],
    );
  }

  return mapLead(updated);
}

export interface ActivityInput {
  type: 'note' | 'contact' | 'meeting' | 'proposal' | 'result';
  note: string;
  nextAction?: string | null;
  nextActionAt?: string | null;
}

export async function addActivity(userId: string, leadId: string, input: ActivityInput) {
  const lead = await getLeadRow(userId, leadId);
  if (lead.do_not_contact && ['contact', 'meeting', 'proposal'].includes(input.type)) {
    throw conflict('Este lead esta marcado como nao contatar. A acao foi bloqueada.');
  }

  const result = await query<{
    id: string;
    type: string;
    note: string;
    next_action: string | null;
    next_action_at: Date | null;
    created_at: Date;
  }>(
    `INSERT INTO lead_activities (lead_id, user_id, type, note, next_action, next_action_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, type, note, next_action, next_action_at, created_at`,
    [leadId, userId, input.type, input.note, input.nextAction ?? null, input.nextActionAt ?? null],
  );

  if (['contact', 'meeting', 'proposal'].includes(input.type)) {
    await query('UPDATE leads SET last_contacted_at = now(), updated_at = now() WHERE id = $1', [leadId]);
  }
  if (input.type === 'contact' && ['novo', 'qualificado'].includes(lead.status)) {
    await query("UPDATE leads SET status = 'contatado', updated_at = now() WHERE id = $1", [leadId]);
    await query(
      `INSERT INTO lead_activities (lead_id, user_id, type, from_status, to_status, note)
       VALUES ($1, $2, 'status_change', $3, 'contatado', 'Status atualizado automaticamente apos contato.')`,
      [leadId, userId, lead.status],
    );
  }

  const row = result.rows[0];
  return {
    id: row?.id,
    type: row?.type,
    note: row?.note,
    nextAction: row?.next_action ?? null,
    nextActionAt: iso(row?.next_action_at),
    createdAt: iso(row?.created_at),
  };
}

export async function setDoNotContact(userId: string, leadId: string, value: boolean, note?: string) {
  const lead = await getLeadRow(userId, leadId);
  const result = await query<LeadRow>(
    `UPDATE leads SET
      do_not_contact = $3,
      status = CASE WHEN $3 THEN 'nao_contatar' ELSE status END,
      updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [leadId, userId, value],
  );
  await query(
    `INSERT INTO lead_activities (lead_id, user_id, type, note)
     VALUES ($1, $2, 'do_not_contact', $3)`,
    [
      leadId,
      userId,
      note ?? (value ? 'Lead marcado como nao contatar.' : 'Preferencia de nao contato removida.'),
    ],
  );
  if (!result.rows[0]) throw notFound('Lead nao encontrado.');
  return {
    lead: mapLead(result.rows[0]),
    previousStatus: lead.status,
  };
}

export async function recalculateLead(userId: string, leadId: string) {
  const row = await getLeadRow(userId, leadId);
  const weights = await loadScoreWeights(userId);
  const scored = scoreForLead(row, weights);
  const result = await query<LeadRow>(
    'UPDATE leads SET score = $3, score_reasons = $4, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *',
    [leadId, userId, scored.score, JSON.stringify(scored.reasons)],
  );
  if (!result.rows[0]) throw notFound('Lead nao encontrado.');
  return { lead: mapLead(result.rows[0]), reasons: scored.reasons };
}
