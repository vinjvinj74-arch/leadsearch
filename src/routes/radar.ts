import { Router } from 'express';
import { z } from 'zod';
import { config, LEAD_STATUSES, WEBSITE_STATUSES } from '../config.js';
import { recordAudit } from '../lib/audit.js';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { exportLimiter, geocodeLimiter, searchLimiter } from '../middleware/rateLimit.js';
import { searchLocations } from '../services/geocodingService.js';
import {
  cancelRadarSearch,
  createRadarSearch,
  exportRadarResults,
  getRadarSearch,
  listRadarSearches,
  saveRadarResults,
  updateRadarSearch,
  type RadarCreateInput,
  type RadarFilters,
} from '../services/radarService.js';

export const radarRouter = Router();
radarRouter.use(requireAuth);

const emptyToUndefined = (value: unknown) => (value === '' || value === null ? undefined : value);

const filtersSchema = z.object({
  segments: z.array(z.string().trim().min(1).max(100)).max(5).default([]),
  keyword: z.string().trim().max(120).default(''),
  companyName: z.string().trim().max(160).default(''),
  includeKeywords: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  excludeKeywords: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  website: z.enum(['all', 'with', 'without']).default('all'),
  minRating: z.number().min(0).max(5).nullable().default(null),
  minReviews: z.number().int().min(0).max(1_000_000).nullable().default(null),
  activeOnly: z.boolean().default(true),
  phonePresence: z.enum(['any', 'with', 'without']).default('any'),
  hasAddress: z.enum(['any', 'with', 'without']).default('any'),
  noEmail: z.boolean().default(false),
  incompleteContact: z.boolean().default(false),
  siteStatus: z
    .enum([...WEBSITE_STATUSES, 'unknown'])
    .nullable()
    .default(null),
  minScore: z.number().int().min(0).max(100).nullable().default(null),
  maxScore: z.number().int().min(0).max(100).nullable().default(null),
  crmState: z.enum(['all', 'unsaved', 'saved', 'not_contacted', 'contacted', 'closed']).default('all'),
  crmStatus: z.preprocess(emptyToUndefined, z.enum(LEAD_STATUSES).nullable().default(null)),
  updatedDays: z.number().int().min(1).max(3650).nullable().default(null),
  visibleArea: z.boolean().default(false),
  sort: z.enum(['score', 'name', 'rating', 'reviews', 'recent']).default('score'),
});

const createSchema = z.object({
  name: z.preprocess(emptyToUndefined, z.string().trim().max(160).optional()),
  location: z.object({
    query: z.string().trim().min(3, 'Informe uma localizacao.').max(240),
    label: z.preprocess(emptyToUndefined, z.string().trim().max(300).optional()),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    country: z.preprocess(emptyToUndefined, z.string().trim().max(100).optional()),
    countryCode: z.preprocess(emptyToUndefined, z.string().trim().min(2).max(60).optional()),
  }),
  radiusKm: z.number().int().min(1).max(50).nullable().optional(),
  limit: z.number().int().min(1).max(config.maxSearchResults).default(config.maxSearchResults),
  filters: filtersSchema,
});

const patchSchema = z.object({
  name: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(160).optional()),
  isSaved: z.boolean().optional(),
});

radarRouter.get(
  '/locations',
  geocodeLimiter,
  asyncHandler(async (req, res) => {
    const query = z.string().trim().min(3).max(240).parse(req.query.q);
    const country = z
      .preprocess(emptyToUndefined, z.string().trim().max(100).optional())
      .parse(req.query.country);
    const locations = await searchLocations(query, country, 5);
    res.json({ locations });
  }),
);

radarRouter.post(
  '/searches',
  searchLimiter,
  asyncHandler(async (req, res) => {
    const { consumeSearchCredit, findUserById } = await import('../services/authService.js');
    const user = await findUserById(req.user!.id);
    if (user) await consumeSearchCredit(user.id, user.role ?? 'user');
    const body = createSchema.parse(req.body);
    const input: RadarCreateInput = {
      name: body.name,
      location: body.location,
      radiusKm: body.radiusKm ?? null,
      limit: body.limit,
      filters: body.filters as RadarFilters,
    };
    const search = await createRadarSearch(req.user!.id, input);
    recordAudit(req, 'radar_search_created', 'radar_search', search.id, {
      name: search.name,
      location: search.location.label,
      limit: search.resultLimit,
    });
    res.status(201).json({ search });
  }),
);

radarRouter.get(
  '/searches',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 50);
    const savedOnly = String(req.query.saved ?? '') === 'true';
    res.json({ searches: await listRadarSearches(req.user!.id, limit, savedOnly) });
  }),
);

radarRouter.get(
  '/searches/:id',
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    res.json(await getRadarSearch(req.user!.id, id));
  }),
);

radarRouter.patch(
  '/searches/:id',
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = patchSchema.parse(req.body);
    const search = await updateRadarSearch(req.user!.id, id, body);
    recordAudit(req, 'radar_search_updated', 'radar_search', id, {
      fields: Object.keys(body),
      isSaved: search.isSaved,
    });
    res.json({ search });
  }),
);

radarRouter.post(
  '/searches/:id/cancel',
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const search = await cancelRadarSearch(req.user!.id, id);
    recordAudit(req, 'radar_search_cancelled', 'radar_search', id);
    res.json({ search });
  }),
);

const saveResultsSchema = z.object({
  resultIds: z.array(z.string().uuid()).max(20).optional(),
  all: z.boolean().default(false),
});

radarRouter.post(
  '/searches/:id/save-results',
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = saveResultsSchema.parse(req.body);
    const result = await saveRadarResults(req.user!.id, id, body.resultIds, body.all);
    recordAudit(req, 'radar_results_saved', 'radar_search', id, {
      count: result.saved,
      all: body.all,
    });
    res.json(result);
  }),
);

const exportQuerySchema = z.object({
  ids: z.preprocess((value) => {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    return value
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  }, z.array(z.string().uuid()).max(20).optional()),
});

radarRouter.get(
  '/searches/:id/export.csv',
  exportLimiter,
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const parsed = exportQuerySchema.parse(req.query);
    const csv = await exportRadarResults(req.user!.id, id, parsed.ids);
    recordAudit(req, 'radar_results_exported', 'radar_search', id, { ids: parsed.ids ?? 'all' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="leadsearch-radar-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(csv);
  }),
);
