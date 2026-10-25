import { LEAD_STATUSES, type LeadStatus } from '../config.js';
import { query } from '../db/pool.js';

export async function getDashboard(userId: string) {
  const [stats, funnel, upcoming] = await Promise.all([
    query<{
      total: string;
      without_website: string;
      opportunities: string;
      qualified: string;
      contacted: string;
      responded: string;
      proposals: string;
      sales: string;
      enriched: string;
    }>(
      `SELECT
        count(*)::text AS total,
        count(*) FILTER (WHERE website IS NULL OR website = '')::text AS without_website,
        count(*) FILTER (WHERE website_status IN ('offline', 'error') OR (website_status = 'online' AND site_has_https = false))::text AS opportunities,
        count(*) FILTER (WHERE COALESCE(score_override, score) >= 70 AND status NOT IN ('perdido', 'nao_contatar'))::text AS qualified,
        count(*) FILTER (WHERE last_contacted_at IS NOT NULL)::text AS contacted,
        count(*) FILTER (WHERE status IN ('respondeu','reuniao_agendada','proposta_enviada','em_negociacao','vendido'))::text AS responded,
        count(*) FILTER (WHERE status IN ('proposta_enviada','em_negociacao','vendido'))::text AS proposals,
        count(*) FILTER (WHERE status = 'vendido')::text AS sales,
        count(*) FILTER (WHERE website_last_checked_at IS NOT NULL)::text AS enriched
       FROM leads WHERE user_id = $1`,
      [userId],
    ),
    query<{ status: LeadStatus; count: string }>(
      `SELECT status, count(*)::text AS count FROM leads WHERE user_id = $1 GROUP BY status`,
      [userId],
    ),
    query<{
      id: string;
      lead_id: string;
      lead_name: string;
      type: string;
      note: string | null;
      next_action: string | null;
      next_action_at: Date;
    }>(
      `SELECT a.id, a.lead_id, l.name AS lead_name, a.type, a.note, a.next_action, a.next_action_at
       FROM lead_activities a
       JOIN leads l ON l.id = a.lead_id
       WHERE a.user_id = $1 AND a.next_action_at IS NOT NULL AND a.next_action_at >= now() - interval '1 day'
       ORDER BY a.next_action_at ASC LIMIT 8`,
      [userId],
    ),
  ]);

  const row = stats.rows[0];
  const total = Number(row?.total ?? 0);
  const contacted = Number(row?.contacted ?? 0);
  const sales = Number(row?.sales ?? 0);
  const funnelCounts = new Map(funnel.rows.map((entry) => [entry.status, Number(entry.count)]));

  return {
    totals: {
      total,
      withoutWebsite: Number(row?.without_website ?? 0),
      opportunities: Number(row?.opportunities ?? 0),
      qualified: Number(row?.qualified ?? 0),
      contacted,
      responded: Number(row?.responded ?? 0),
      proposals: Number(row?.proposals ?? 0),
      sales,
      enriched: Number(row?.enriched ?? 0),
    },
    conversionRate: contacted > 0 ? Math.round((sales / contacted) * 1000) / 10 : null,
    funnel: LEAD_STATUSES.map((status) => ({
      status,
      count: funnelCounts.get(status) ?? 0,
    })),
    upcoming: upcoming.rows.map((entry) => ({
      id: entry.id,
      leadId: entry.lead_id,
      leadName: entry.lead_name,
      type: entry.type,
      note: entry.note,
      nextAction: entry.next_action,
      nextActionAt: entry.next_action_at.toISOString(),
    })),
    generatedAt: new Date().toISOString(),
  };
}
