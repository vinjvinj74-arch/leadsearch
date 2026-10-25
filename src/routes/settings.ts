import { Router } from 'express';
import { z } from 'zod';
import { config, EXPORT_FIELDS, THEMES } from '../config.js';
import { recordAudit } from '../lib/audit.js';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { searchLimiter } from '../middleware/rateLimit.js';
import { isApifyConfigured, testApifyConnection } from '../services/apifyService.js';
import { testGooglePlaces } from '../services/placesService.js';
import { ensureSettings, getIntegrationStatus, updateSettings } from '../services/settingsService.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);
const nullableString = (max: number) =>
  z.preprocess(emptyToUndefined, z.string().trim().max(max).nullable().optional());

const patchSchema = z.object({
  theme: z.enum(THEMES).optional(),
  defaultCity: nullableString(100),
  defaultState: nullableString(100),
  defaultCountry: z.preprocess(emptyToUndefined, z.string().trim().max(100).optional()),
  defaultNiche: nullableString(100),
  defaultLimit: z.coerce.number().int().min(1).max(config.maxSearchResults).optional(),
  favoriteNiches: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  exportFields: z.array(z.enum(EXPORT_FIELDS)).min(1).max(EXPORT_FIELDS.length).optional(),
  scoreWeights: z.record(z.coerce.number().int().min(0).max(50)).nullable().optional(),
  allowEnrichment: z.boolean().optional(),
  retentionDays: z.coerce.number().int().min(30).max(3650).optional(),
});

settingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ settings: await ensureSettings(req.user!.id) });
  }),
);

settingsRouter.patch(
  '/',
  asyncHandler(async (req, res) => {
    const body = patchSchema.parse(req.body);
    const settings = await updateSettings(req.user!.id, body);
    recordAudit(req, 'settings_updated', 'user_settings', req.user!.id, { fields: Object.keys(body) });
    res.json({ settings });
  }),
);

export const integrationsRouter = Router();
integrationsRouter.use(requireAuth);

integrationsRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json({ integrations: getIntegrationStatus() });
  }),
);

integrationsRouter.post(
  '/discovery/test',
  searchLimiter,
  asyncHandler(async (_req, res) => {
    if (isApifyConfigured()) {
      const result = await testApifyConnection();
      res.json({
        ok: result.ok,
        latencyMs: result.latencyMs,
        message: 'Conectividade da pesquisa de empresas confirmada. Nenhuma pesquisa foi iniciada.',
      });
      return;
    }

    const result = await testGooglePlaces();
    res.json({
      ok: result.ok,
      latencyMs: result.latencyMs,
      message: 'Conectividade da pesquisa de empresas confirmada. Nenhuma pesquisa foi iniciada.',
    });
  }),
);
