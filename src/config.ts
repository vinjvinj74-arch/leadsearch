import 'dotenv/config';
import { ADMIN_EMAIL } from './plans.js';

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const env = process.env.NODE_ENV ?? 'development';
const sessionSecret = process.env.SESSION_SECRET ?? '';
const sessionTtlDays = Math.max(int(process.env.SESSION_TTL_DAYS, 30), 1);
const sessionIdleDays = Math.min(Math.max(int(process.env.SESSION_IDLE_DAYS, 7), 1), sessionTtlDays);

if (env === 'production' && sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET deve ter no minimo 32 caracteres em producao.');
}

export const config = {
  appName: 'RADAR',
  env,
  isProduction: env === 'production',
  port: int(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  pgSsl: bool(process.env.PGSSL, false),
  sessionSecret: sessionSecret || 'desenvolvimento-apenas-nao-use-este-segredo-em-producao',
  sessionTtlDays,
  sessionIdleDays,
  cookieSecure: bool(process.env.COOKIE_SECURE, env === 'production'),
  appOrigins: (process.env.APP_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean),
  appUrl: (process.env.APP_URL ?? '').replace(/\/$/, ''),
  adminEmail: ADMIN_EMAIL,
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY ?? '',
  apifyApiToken: process.env.APIFY_API_TOKEN ?? '',
  billing: {
    provider: 'stripe' as const,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    prices: {
      starter: process.env.STRIPE_PRICE_STARTER ?? '',
      pro: process.env.STRIPE_PRICE_PRO ?? '',
      business: process.env.STRIPE_PRICE_BUSINESS ?? '',
    },
    portalReturnPath: process.env.STRIPE_PORTAL_RETURN_PATH ?? '/sales',
    webhookToleranceSeconds: Math.min(
      Math.max(int(process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS, 300), 60),
      900,
    ),
  },
  apify: {
    actor: 'compass~crawler-google-places',
    timeoutSeconds: 300,
    maxWaitMs: 330_000,
    maxTotalChargeUsd: 1,
    maxConcurrentRuns: 1,
  },
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? 'RADAR <no-reply@radar.local>',
  },
  maxSearchResults: Math.min(Math.max(int(process.env.MAX_SEARCH_RESULTS, 5), 1), 5),
  exportMaxRows: Math.min(Math.max(int(process.env.EXPORT_MAX_ROWS, 5000), 1), 20000),
  appVersion: process.env.npm_package_version ?? '1.0.0',
};

export const LEAD_STATUSES = [
  'novo',
  'qualificado',
  'contatado',
  'aguardando_resposta',
  'respondeu',
  'reuniao_agendada',
  'proposta_enviada',
  'em_negociacao',
  'vendido',
  'perdido',
  'nao_contatar',
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const WEBSITE_STATUSES = ['unknown', 'missing', 'online', 'offline', 'redirect', 'error'] as const;
export type WebsiteStatus = (typeof WEBSITE_STATUSES)[number];

export const ACTIVITY_TYPES = [
  'note',
  'contact',
  'meeting',
  'proposal',
  'result',
  'site_check',
  'enrichment',
  'do_not_contact',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const THEMES = ['light', 'dark', 'system'] as const;

export const EXPORT_FIELDS = [
  'name',
  'segment',
  'city',
  'state',
  'country',
  'phone',
  'email',
  'website',
  'website_status',
  'score',
  'status',
  'address',
  'google_maps_url',
  'last_checked_at',
  'created_at',
  'source',
] as const;
