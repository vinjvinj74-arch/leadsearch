import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { recordAudit } from '../lib/audit.js';
import { asyncHandler } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { searchLimiter } from '../middleware/rateLimit.js';
import { completeSearchWithoutEnrichment, runSearchEnrichment } from '../services/enrichmentService.js';
import { createSearch, getSearch, listSearches } from '../services/searchService.js';
import { ensureSettings } from '../services/settingsService.js';

export const searchesRouter = Router();
searchesRouter.use(requireAuth);

const createSchema = z.object({
  niche: z.string().trim().min(2, 'Informe o nicho.').max(100),
  city: z.string().trim().min(2, 'Informe a cidade.').max(100),
  state: z.preprocess((value) => (value === '' ? undefined : value), z.string().trim().max(100).optional()),
  country: z.string().trim().min(2).max(100).default('Brasil'),
  radiusKm: z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    z.coerce.number().int().min(1).max(50).optional(),
  ),
  limit: z.coerce.number().int().min(1).max(config.maxSearchResults).default(20),
});

searchesRouter.post(
  '/',
  searchLimiter,
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const settings = await ensureSettings(req.user!.id);
    const result = await createSearch(
      req.user!.id,
      {
        niche: body.niche,
        city: body.city,
        state: body.state ?? null,
        country: body.country,
        radiusKm: body.radiusKm ?? null,
        limit: body.limit,
      },
      settings.scoreWeights,
      settings.allowEnrichment,
    );

    if (settings.allowEnrichment) {
      void runSearchEnrichment(req.user!.id, result.search.id).catch((error) => {
        logger.error({ err: error, searchId: result.search.id }, 'Falha no enriquecimento em segundo plano');
      });
    } else {
      await completeSearchWithoutEnrichment(req.user!.id, result.search.id);
    }

    recordAudit(req, 'search_created', 'search', result.search.id, {
      niche: body.niche,
      city: body.city,
      country: body.country,
      found: result.stats.found,
    });
    res.status(201).json({
      ...result,
      enrichmentScheduled: settings.allowEnrichment,
      notice:
        'A pesquisa usa a Google Maps Platform e pode gerar cobranca. Nenhum dado ausente e inventado; a origem de cada informacao e registrada.',
    });
  }),
);

searchesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 50);
    res.json({ searches: await listSearches(req.user!.id, limit) });
  }),
);

searchesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    res.json({ search: await getSearch(req.user!.id, id) });
  }),
);
