import { config, EXPORT_FIELDS } from '../config.js';
import { checkDatabase, query } from '../db/pool.js';
import { sanitizeWeights } from '../lib/scoring.js';
import type { UserSettingsRecord } from '../types/session.js';
import { isApifyConfigured } from './apifyService.js';
import { isEmailConfigured } from './emailService.js';

interface SettingsRow {
  theme: 'light' | 'dark' | 'system';
  default_city: string | null;
  default_state: string | null;
  default_country: string;
  default_niche: string | null;
  default_limit: number;
  favorite_niches: string[];
  export_fields: string[];
  score_weights: Record<string, number> | null;
  allow_enrichment: boolean;
  retention_days: number;
}

function mapSettings(row: SettingsRow): UserSettingsRecord {
  return {
    theme: row.theme,
    defaultCity: row.default_city,
    defaultState: row.default_state,
    defaultCountry: row.default_country,
    defaultNiche: row.default_niche,
    defaultLimit: Math.min(Math.max(row.default_limit, 1), config.maxSearchResults),
    favoriteNiches: row.favorite_niches ?? [],
    exportFields: row.export_fields ?? [],
    scoreWeights: row.score_weights,
    allowEnrichment: row.allow_enrichment,
    retentionDays: row.retention_days,
  };
}

export async function ensureSettings(userId: string): Promise<UserSettingsRecord> {
  await query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  const result = await query<SettingsRow>('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
  const row = result.rows[0];
  if (!row) {
    return {
      theme: 'system',
      defaultCity: null,
      defaultState: null,
      defaultCountry: 'Brasil',
      defaultNiche: null,
      defaultLimit: config.maxSearchResults,
      favoriteNiches: [],
      exportFields: EXPORT_FIELDS.slice(0, 9),
      scoreWeights: null,
      allowEnrichment: true,
      retentionDays: 365,
    };
  }
  return mapSettings(row);
}

export interface SettingsPatch {
  theme?: 'light' | 'dark' | 'system';
  defaultCity?: string | null;
  defaultState?: string | null;
  defaultCountry?: string;
  defaultNiche?: string | null;
  defaultLimit?: number;
  favoriteNiches?: string[];
  exportFields?: string[];
  scoreWeights?: Record<string, number> | null;
  allowEnrichment?: boolean;
  retentionDays?: number;
}

export async function updateSettings(userId: string, patch: SettingsPatch): Promise<UserSettingsRecord> {
  const current = await ensureSettings(userId);
  const merged = { ...current, ...patch };
  const defaultLimit = Math.min(Math.max(Math.trunc(merged.defaultLimit), 1), config.maxSearchResults);
  const weights =
    patch.scoreWeights === null ? null : sanitizeWeights(patch.scoreWeights ?? current.scoreWeights ?? {});
  const exportFields = (merged.exportFields ?? []).filter((field) =>
    (EXPORT_FIELDS as readonly string[]).includes(field),
  );

  await query(
    `UPDATE user_settings SET
      theme = $2,
      default_city = $3,
      default_state = $4,
      default_country = $5,
      default_niche = $6,
      default_limit = $7,
      favorite_niches = $8,
      export_fields = $9,
      score_weights = $10,
      allow_enrichment = $11,
      retention_days = $12,
      updated_at = now()
     WHERE user_id = $1`,
    [
      userId,
      merged.theme,
      merged.defaultCity || null,
      merged.defaultState || null,
      merged.defaultCountry || 'Brasil',
      merged.defaultNiche || null,
      defaultLimit,
      merged.favoriteNiches ?? [],
      exportFields.length ? exportFields : EXPORT_FIELDS.slice(0, 9),
      weights ? JSON.stringify(weights) : null,
      merged.allowEnrichment,
      merged.retentionDays,
    ],
  );
  return ensureSettings(userId);
}

export interface IntegrationStatus {
  discovery: {
    configured: boolean;
    label: string;
    note: string;
  };
  email: {
    configured: boolean;
    label: string;
    note: string;
  };
  database: {
    configured: boolean;
    label: string;
  };
}

export function getIntegrationStatus(): IntegrationStatus {
  const discoveryConfigured = isApifyConfigured() || Boolean(config.googleMapsApiKey);
  const emailConfigured = isEmailConfigured();

  const discovery: IntegrationStatus['discovery'] = discoveryConfigured
    ? {
        configured: true,
        label: 'Pesquisa de empresas configurada',
        note: 'A pesquisa de empresas esta habilitada no servidor.',
      }
    : {
        configured: false,
        label: 'Pesquisa de empresas nao configurada',
        note: 'A pesquisa de empresas nao esta disponivel no momento.',
      };

  return {
    discovery,
    email: {
      configured: emailConfigured,
      label: emailConfigured ? 'SMTP configurado' : 'SMTP nao configurado',
      note: emailConfigured
        ? 'Recuperacao de senha e verificacao de e-mail habilitadas.'
        : 'Defina SMTP_HOST, SMTP_FROM e credenciais para habilitar e-mails transacionais.',
    },
    database: {
      configured: Boolean(config.databaseUrl),
      label: config.databaseUrl ? 'PostgreSQL configurado' : 'PostgreSQL nao configurado',
    },
  };
}

export async function getSystemDiagnostics(userId: string) {
  const db = await checkDatabase();
  const [migration, leads, searches, activities] = await Promise.all([
    query<{ version: number; applied_at: Date }>(
      'SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 1',
    ),
    query<{ count: string }>('SELECT count(*)::text AS count FROM leads WHERE user_id = $1', [userId]),
    query<{ count: string }>('SELECT count(*)::text AS count FROM searches WHERE user_id = $1', [userId]),
    query<{ count: string }>('SELECT count(*)::text AS count FROM lead_activities WHERE user_id = $1', [
      userId,
    ]),
  ]);

  return {
    app: {
      name: 'LeadSearch',
      version: config.appVersion,
      environment: config.env,
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
    },
    database: {
      ok: db.ok,
      latencyMs: db.latencyMs,
      migrationVersion: migration.rows[0]?.version ?? null,
      migrationAppliedAt: migration.rows[0]?.applied_at?.toISOString() ?? null,
      error: db.ok ? undefined : db.error,
    },
    counts: {
      leads: Number(leads.rows[0]?.count ?? 0),
      searches: Number(searches.rows[0]?.count ?? 0),
      activities: Number(activities.rows[0]?.count ?? 0),
    },
    integrations: getIntegrationStatus(),
    limits: {
      maxSearchResults: config.maxSearchResults,
      exportMaxRows: config.exportMaxRows,
      searchResultHardLimit: config.maxSearchResults,
    },
    timestamp: new Date().toISOString(),
  };
}
