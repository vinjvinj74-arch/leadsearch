import { Router } from 'express';
import { config } from '../config.js';
import { checkDatabase } from '../db/pool.js';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { getIntegrationStatus, getSystemDiagnostics } from '../services/settingsService.js';

export const healthRouter = Router();

healthRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const db = await checkDatabase();
    const integrations = getIntegrationStatus();
    res.status(db.ok ? 200 : 503).json({
      status: db.ok ? 'ok' : 'degraded',
      app: 'LeadSearch',
      version: config.appVersion,
      environment: config.env,
      database: { ok: db.ok, latencyMs: db.latencyMs, ...(db.ok ? {} : { error: 'Banco indisponivel.' }) },
      integrations: {
        discoveryConfigured: integrations.discovery.configured,
        discoveryProvider: integrations.discovery.provider,
        apifyConfigured: integrations.discovery.provider === 'apify_google_maps',
        googleMapsConfigured: integrations.discovery.provider === 'google_places',
        emailConfigured: integrations.email.configured,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

export const systemRouter = Router();
systemRouter.use(requireAuth);

systemRouter.get(
  '/diagnostics',
  asyncHandler(async (req, res) => {
    res.json({ diagnostics: await getSystemDiagnostics(req.user!.id) });
  }),
);
