import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { recordAudit } from '../lib/audit.js';
import { asyncHandler } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { loadEntitlements, requireSearchAccess } from '../middleware/entitlements.js';
import { searchLimiter } from '../middleware/rateLimit.js';
import { completeSearchWithoutEnrichment, runSearchEnrichment } from '../services/enrichmentService.js';
import { createSearch, getSearch, listSearches } from '../services/searchService.js';
import { ensureSettings } from '../services/settingsService.js';
import { consumeCredits, refundCreditByReference } from '../services/subscriptionService.js';

export const searchesRouter = Router();
searchesRouter.use(requireAuth, loadEntitlements);

const createSchema = z.object({
  niche: z.string().trim().min(2, 'Informe o nicho.').max(100),
  city: z.string().trim().min(2, 'Informe a cidade.').max(100),
  state: z.preprocess((value) => (value === '' ? undefined : value), z.string().trim().max(100).optional()),
  country: z.string().trim().min(2).max(100).default('Brasil'),
  radiusKm: z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    z.coerce.number().int().min(1).max(50).optional(),
  ),
  limit: z.coerce.number().int().min(1).max(config.maxSearchResults).default(config.maxSearchResults),
});

searchesRouter.post(
  '/',
  searchLimiter,
  requireSearchAccess,
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const settings = await ensureSettings(req.user!.id);
    const reference = `search:${randomUUID()}`;
    const credit = await consumeCredits(req.user!.id, req.user!.role, {
      reference,
      description: 'Pesquisa de empresas executada.',
    });

    let result;
    try {
      result = await createSearch(
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
        reference,
      );
    } catch (error) {
      await refundCreditByReference(
        req.user!.id,
        reference,
        'Pesquisa não iniciada: crédito devolvido.',
      ).catch((refundError) => {
        logger.error({ err: refundError, userId: req.user!.id }, 'Falha ao devolver credito da pesquisa');
      });
      throw error;
    }

    if (!result.async) {
      if (settings.allowEnrichment) {
        void runSearchEnrichment(req.user!.id, result.search.id).catch((error) => {
          logger.error(
            { err: error, searchId: result.search.id },
            'Falha no enriquecimento em segundo plano',
          );
        });
      } else {
        await completeSearchWithoutEnrichment(req.user!.id, result.search.id);
      }
    }

    recordAudit(req, 'search_created', 'search', result.search.id, {
      niche: body.niche,
      city: body.city,
      country: body.country,
      found: result.stats.found,
      creditsCharged: credit.charged ? 1 : 0,
      creditsRemaining: credit.balanceAfter,
    });
    res.status(201).json({
      ...result,
      enrichmentScheduled: settings.allowEnrichment,
      credits: {
        charged: credit.charged,
        remaining: credit.balanceAfter,
      },
      notice: result.async ? 'A pesquisa foi iniciada e continua em segundo plano.' : 'Pesquisa concluida.',
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
