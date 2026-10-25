import { query } from '../db/pool.js';
import { AppError, badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { normalizePhone } from '../lib/normalize.js';
import { safeFetch, resolvePublicUrl } from '../lib/urlSafety.js';
import type { WebsiteStatus } from '../config.js';
import { loadScoreWeights, mapLead, scoreForLead, getLeadRow, type LeadRow } from './leadsService.js';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?:\+?55[\s.-]?)?(?:\(?\d{2}\)?[\s.-]?)?(?:9?\d{4})[\s.-]?\d{4}/g;

const BLOCKED_EMAIL_DOMAINS = new Set([
  'example.com',
  'example.org',
  'domain.com',
  'email.com',
  'sentry.io',
  'wixpress.com',
  'sentry-next.wixpress.com',
]);

const BLOCKED_EMAIL_PREFIXES = ['sentry', 'noreply', 'no-reply', 'donotreply', 'wordpress@', 'u003e'];

export interface WebsiteInspection {
  ok: boolean;
  websiteStatus: WebsiteStatus;
  statusCode: number | null;
  finalUrl: string | null;
  https: boolean;
  responseTimeMs: number | null;
  redirectCount: number;
  title: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  emails: string[];
  phones: string[];
  contactLinks: string[];
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

export function extractEmails(html: string): string[] {
  const found = new Set<string>();
  const matches = html.match(EMAIL_RE) ?? [];
  for (const match of matches) {
    const email = match.toLowerCase().replace(/^[.'"<>]+|[.'"<>]+$/g, '');
    const domain = email.split('@')[1] ?? '';
    if (!domain || BLOCKED_EMAIL_DOMAINS.has(domain)) continue;
    if (BLOCKED_EMAIL_PREFIXES.some((prefix) => email.startsWith(prefix))) continue;
    if (/\.(png|jpe?g|gif|webp|svg|css|js|woff2?|ttf)$/i.test(email)) continue;
    if (email.length > 254) continue;
    found.add(email);
    if (found.size >= 8) break;
  }
  return [...found];
}

export function extractPhones(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(PHONE_RE)) {
    const normalized = normalizePhone(match[0]);
    if (normalized.length >= 12 && normalized.length <= 13 && normalized.startsWith('55')) {
      found.add(normalized);
      if (found.size >= 8) break;
    }
  }
  return [...found];
}

export function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) return null;
  return decodeHtml(match[1].replace(/\s+/g, ' ').trim()).slice(0, 180);
}

export function findContactLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const links: string[] = [];
  const seen = new Set<string>();
  const anchorRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of html.matchAll(anchorRe)) {
    const href = decodeHtml(match[1] ?? '').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.origin !== base.origin) continue;
    if (!/contato|contact|fale|atendimento|sobre|about|empresa/i.test(url.pathname)) continue;
    url.hash = '';
    const value = url.toString();
    if (seen.has(value)) continue;
    seen.add(value);
    links.push(value);
    if (links.length >= 3) break;
  }
  return links;
}

export async function inspectWebsite(rawUrl: string): Promise<WebsiteInspection> {
  const empty: WebsiteInspection = {
    ok: false,
    websiteStatus: 'error',
    statusCode: null,
    finalUrl: null,
    https: false,
    responseTimeMs: null,
    redirectCount: 0,
    title: null,
    errorCode: null,
    errorMessage: null,
    emails: [],
    phones: [],
    contactLinks: [],
  };

  try {
    await resolvePublicUrl(rawUrl);
    const response = await safeFetch(rawUrl, { timeoutMs: 8000, maxBytes: 512 * 1024, maxRedirects: 5 });
    const status = response.statusCode;
    const websiteStatus: WebsiteStatus =
      status >= 200 && status < 400 ? 'online' : status >= 400 ? 'offline' : 'error';
    return {
      ok: websiteStatus === 'online',
      websiteStatus,
      statusCode: status,
      finalUrl: response.finalUrl,
      https: response.https,
      responseTimeMs: response.elapsedMs,
      redirectCount: response.redirectCount,
      title: extractTitle(response.body),
      errorCode: null,
      errorMessage: null,
      emails: extractEmails(response.body),
      phones: extractPhones(response.body),
      contactLinks: findContactLinks(response.body, response.finalUrl),
    };
  } catch (error) {
    const appError = error instanceof AppError ? error : null;
    logger.info({ err: error, host: (() => {
      try {
        return new URL(rawUrl).hostname;
      } catch {
        return 'invalid';
      }
    })() }, 'Verificacao de site falhou');
    return {
      ...empty,
      finalUrl: rawUrl,
      errorCode: appError?.code ?? 'NETWORK_ERROR',
      errorMessage: appError?.message ?? 'Nao foi possivel acessar o site.',
    };
  }
}

export async function checkAndSaveWebsite(userId: string, leadId: string) {
  const lead = await getLeadRow(userId, leadId);
  if (!lead.website) throw badRequest('Este lead nao possui site cadastrado para verificar.');
  const inspection = await inspectWebsite(lead.website);
  const weights = await loadScoreWeights(userId);

  const merged: LeadRow = {
    ...lead,
    website_status: inspection.websiteStatus,
    site_has_https: inspection.https,
    website_http_status: inspection.statusCode,
    site_response_ms: inspection.responseTimeMs,
    redirect_count: inspection.redirectCount,
    website_last_checked_at: new Date(),
  };
  const scored = scoreForLead(merged, weights);

  const updated = await query<LeadRow>(
    `UPDATE leads SET
      website_status = $3,
      website_http_status = $4,
      site_has_https = $5,
      site_response_ms = $6,
      redirect_count = $7,
      website_last_checked_at = now(),
      score = $8,
      score_reasons = $9,
      updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [
      leadId,
      userId,
      inspection.websiteStatus,
      inspection.statusCode,
      inspection.https,
      inspection.responseTimeMs,
      inspection.redirectCount,
      scored.score,
      JSON.stringify(scored.reasons),
    ],
  );

  await query(
    `INSERT INTO lead_sources (lead_id, source, source_url, metadata)
     VALUES ($1, 'website_check', $2, $3)`,
    [leadId, lead.website, JSON.stringify({ inspection: { ...inspection, emails: inspection.emails.length, phones: inspection.phones.length } })],
  );
  await query(
    `INSERT INTO lead_activities (lead_id, user_id, type, note)
     VALUES ($1, $2, 'site_check', $3)`,
    [
      leadId,
      userId,
      inspection.ok
        ? `Site verificado: HTTP ${inspection.statusCode}, ${inspection.responseTimeMs} ms, HTTPS ${inspection.https ? 'sim' : 'nao'}.`
        : `Falha na verificacao: ${inspection.errorMessage ?? `HTTP ${inspection.statusCode}`}.`,
    ],
  );

  return {
    verification: {
      reachable: inspection.ok,
      websiteStatus: inspection.websiteStatus,
      statusCode: inspection.statusCode,
      finalUrl: inspection.finalUrl,
      https: inspection.https,
      responseTimeMs: inspection.responseTimeMs,
      redirectCount: inspection.redirectCount,
      title: inspection.title,
      errorCode: inspection.errorCode,
      errorMessage: inspection.errorMessage,
      emailsFound: inspection.emails.length,
      phonesFound: inspection.phones.length,
      checkedAt: new Date().toISOString(),
    },
    lead: updated.rows[0] ? mapLead(updated.rows[0]) : null,
  };
}
