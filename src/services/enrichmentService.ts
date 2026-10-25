import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { extractEmails, extractPhones, inspectWebsite } from './siteVerifier.js';
import { safeFetch } from '../lib/urlSafety.js';
import {
  getLeadRow,
  loadScoreWeights,
  mapLead,
  scoreForLead,
  type LeadRow,
} from './leadsService.js';

async function rememberContact(
  leadId: string,
  kind: 'email' | 'phone',
  value: string,
  sourceUrl: string | null,
  sourceType: string,
): Promise<void> {
  const existing = await query(
    'SELECT 1 FROM lead_contacts WHERE lead_id = $1 AND kind = $2 AND value = $3 LIMIT 1',
    [leadId, kind, value],
  );
  if (existing.rowCount) return;
  await query(
    `INSERT INTO lead_contacts (lead_id, kind, value, source_url, source_type)
     VALUES ($1, $2, $3, $4, $5)`,
    [leadId, kind, value, sourceUrl, sourceType],
  );
}

export async function enrichLead(userId: string, leadId: string) {
  const lead = await getLeadRow(userId, leadId);
  if (!lead.website) {
    return {
      lead: mapLead(lead),
      skipped: true,
      reason: 'Lead sem site cadastrado. Nenhuma coleta em site foi executada.',
      collected: { emails: 0, phones: 0 },
    };
  }

  const home = await inspectWebsite(lead.website);
  const emails = new Set(home.emails);
  const phones = new Set(home.phones);
  const emailSources = new Map<string, string>();
  const phoneSources = new Map<string, string>();
  home.emails.forEach((email) => emailSources.set(email, home.finalUrl ?? lead.website!));
  home.phones.forEach((phone) => phoneSources.set(phone, home.finalUrl ?? lead.website!));

  for (const link of home.contactLinks.slice(0, 2)) {
    try {
      const page = await safeFetch(link, { timeoutMs: 6000, maxBytes: 384 * 1024, maxRedirects: 3 });
      if (page.statusCode >= 200 && page.statusCode < 400) {
        extractEmails(page.body).forEach((email) => {
          emails.add(email);
          emailSources.set(email, page.finalUrl);
        });
        extractPhones(page.body).forEach((phone) => {
          phones.add(phone);
          phoneSources.set(phone, page.finalUrl);
        });
      }
    } catch (error) {
      logger.info({ err: error, leadId }, 'Falha ao acessar pagina de contato durante enriquecimento');
    }
  }

  const emailList = [...emails].slice(0, 8);
  const phoneList = [...phones].slice(0, 8);
  for (const email of emailList) {
    await rememberContact(leadId, 'email', email, emailSources.get(email) ?? null, 'website');
  }
  for (const phone of phoneList) {
    await rememberContact(leadId, 'phone', phone, phoneSources.get(phone) ?? null, 'website');
  }

  const nextEmail = lead.email || emailList[0] || null;
  const nextPhone = lead.phone || phoneList[0] || null;
  const merged: LeadRow = {
    ...lead,
    email: nextEmail,
    phone: nextPhone,
    website_status: home.websiteStatus,
    website_http_status: home.statusCode,
    site_has_https: home.https,
    site_response_ms: home.responseTimeMs,
    redirect_count: home.redirectCount,
    website_last_checked_at: new Date(),
  };
  const weights = await loadScoreWeights(userId);
  const scored = scoreForLead(merged, weights);

  const updated = await query<LeadRow>(
    `UPDATE leads SET
      email = $3,
      phone = $4,
      website_status = $5,
      website_http_status = $6,
      site_has_https = $7,
      site_response_ms = $8,
      redirect_count = $9,
      website_last_checked_at = now(),
      score = $10,
      score_reasons = $11,
      updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [
      leadId,
      userId,
      nextEmail,
      nextPhone,
      home.websiteStatus,
      home.statusCode,
      home.https,
      home.responseTimeMs,
      home.redirectCount,
      scored.score,
      JSON.stringify(scored.reasons),
    ],
  );

  await query(
    `INSERT INTO lead_sources (lead_id, source, source_url, metadata)
     VALUES ($1, 'website_enrichment', $2, $3)`,
    [
      leadId,
      lead.website,
      JSON.stringify({
        reachable: home.ok,
        statusCode: home.statusCode,
        emails: emailList.length,
        phones: phoneList.length,
        contactPagesVisited: home.contactLinks.slice(0, 2).length,
      }),
    ],
  );
  await query(
    `INSERT INTO lead_activities (lead_id, user_id, type, note)
     VALUES ($1, $2, 'enrichment', $3)`,
    [
      leadId,
      userId,
      home.ok
        ? `Enriquecimento concluido: ${emailList.length} e-mail(s) e ${phoneList.length} telefone(s) publicados encontrados.`
        : `Enriquecimento tentado, mas o site nao respondeu: ${home.errorMessage ?? `HTTP ${home.statusCode}`}.`,
    ],
  );

  return {
    lead: updated.rows[0] ? mapLead(updated.rows[0]) : null,
    skipped: false,
    collected: { emails: emailList.length, phones: phoneList.length },
    contactPagesVisited: home.contactLinks.slice(0, 2).length,
    websiteStatus: home.websiteStatus,
  };
}

export async function runSearchEnrichment(userId: string, searchId: string): Promise<void> {
  const result = await query<{ id: string }>(
    `SELECT id FROM leads
     WHERE user_id = $1 AND search_id = $2 AND website IS NOT NULL AND website <> ''
     ORDER BY created_at ASC LIMIT 20`,
    [userId, searchId],
  );
  const ids = result.rows.map((row) => row.id);
  let failures = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const id = ids[index];
      if (!id) return;
      try {
        await enrichLead(userId, id);
      } catch (error) {
        failures += 1;
        logger.warn({ err: error, leadId: id, searchId }, 'Falha ao enriquecer lead');
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(3, ids.length) }, () => worker()));

  const count = await query<{ count: string }>('SELECT count(*)::text AS count FROM leads WHERE search_id = $1 AND user_id = $2', [
    searchId,
    userId,
  ]);
  await query(
    `UPDATE searches SET
      status = 'completed',
      completed_at = now(),
      results_count = $3,
      error_message = CASE WHEN $4 > 0 THEN $5 ELSE NULL END
     WHERE id = $1 AND user_id = $2`,
    [
      searchId,
      userId,
      Number(count.rows[0]?.count ?? 0),
      failures,
      failures ? `Enriquecimento concluido com ${failures} falha(s) em sites.` : null,
    ],
  );
  logger.info({ searchId, userId, leads: ids.length, failures }, 'Enriquecimento da pesquisa concluido');
}

export async function completeSearchWithoutEnrichment(userId: string, searchId: string): Promise<void> {
  await query(
    `UPDATE searches SET status = 'completed', completed_at = now(),
      results_count = (SELECT count(*) FROM leads WHERE search_id = $1 AND user_id = $2)
     WHERE id = $1 AND user_id = $2`,
    [searchId, userId],
  );
}
