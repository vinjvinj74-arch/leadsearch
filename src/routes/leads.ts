import { Router } from 'express';
import { z } from 'zod';
import { config, EXPORT_FIELDS, LEAD_STATUSES, WEBSITE_STATUSES } from '../config.js';
import { recordAudit } from '../lib/audit.js';
import { toCsv } from '../lib/csv.js';
import { badRequest } from '../lib/errors.js';
import { asyncHandler, parsePage, parsePageSize } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { exportLimiter } from '../middleware/rateLimit.js';
import { checkAndSaveWebsite } from '../services/siteVerifier.js';
import { enrichLead } from '../services/enrichmentService.js';
import {
  addActivity,
  getLeadDetail,
  listLeads,
  listLeadsForExport,
  mapLead,
  publicSourceName,
  recalculateLead,
  setDoNotContact,
  updateLead,
  type LeadFilters,
} from '../services/leadsService.js';
import { ensureSettings } from '../services/settingsService.js';

export const leadsRouter = Router();
leadsRouter.use(requireAuth);

const emptyToUndefined = (value: unknown) => (value === '' || value === null ? undefined : value);
const optionalString = (max: number) => z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());

const filtersSchema = z.object({
  q: optionalString(200),
  status: z.preprocess(emptyToUndefined, z.enum(LEAD_STATUSES).optional()),
  websiteStatus: z.preprocess(emptyToUndefined, z.enum(WEBSITE_STATUSES).optional()),
  hasWebsite: z.preprocess(emptyToUndefined, z.enum(['yes', 'no']).optional()),
  minScore: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(100).optional()),
  maxScore: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(100).optional()),
  searchId: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
  sort: z.preprocess(
    emptyToUndefined,
    z.enum(['score', 'created_at', 'updated_at', 'name', 'last_checked_at', 'status']).optional(),
  ),
  order: z.preprocess(emptyToUndefined, z.enum(['asc', 'desc']).optional()),
});

function toFilters(parsed: z.infer<typeof filtersSchema>): LeadFilters {
  return {
    q: parsed.q,
    status: parsed.status,
    websiteStatus: parsed.websiteStatus,
    hasWebsite: parsed.hasWebsite,
    minScore: parsed.minScore,
    maxScore: parsed.maxScore,
    searchId: parsed.searchId,
    sort: parsed.sort,
    order: parsed.order,
  };
}

leadsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = filtersSchema.parse(req.query);
    const page = parsePage(req.query.page, 1);
    const pageSize = parsePageSize(req.query.pageSize, 25);
    res.json(await listLeads(req.user!.id, toFilters(parsed), page, pageSize));
  }),
);

const exportQuerySchema = filtersSchema.extend({
  fields: z.preprocess(emptyToUndefined, z.string().max(500).optional()),
  ids: z.preprocess((value) => {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    return value
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  }, z.array(z.string().uuid()).max(500).optional()),
});

const STATUS_LABELS: Record<string, string> = {
  novo: 'Novo',
  qualificado: 'Qualificado',
  contatado: 'Contatado',
  aguardando_resposta: 'Aguardando resposta',
  respondeu: 'Respondeu',
  reuniao_agendada: 'Reuniao agendada',
  proposta_enviada: 'Proposta enviada',
  em_negociacao: 'Em negociacao',
  vendido: 'Vendido',
  perdido: 'Perdido',
  nao_contatar: 'Nao contatar',
};

const WEBSITE_LABELS: Record<string, string> = {
  unknown: 'Nao verificado',
  missing: 'Sem site confirmado',
  online: 'Online',
  offline: 'Offline',
  redirect: 'Redirecionamento',
  error: 'Erro',
};

const FIELD_LABELS: Record<string, string> = {
  name: 'Empresa',
  segment: 'Segmento',
  city: 'Cidade',
  state: 'UF',
  country: 'Pais',
  phone: 'Telefone',
  email: 'E-mail',
  website: 'Site',
  website_status: 'Situacao do site',
  score: 'Pontuacao',
  status: 'Status comercial',
  address: 'Endereco',
  google_maps_url: 'Mapa',
  last_checked_at: 'Ultima verificacao',
  created_at: 'Criado em',
  source: 'Origem',
};

leadsRouter.get(
  '/export.csv',
  exportLimiter,
  asyncHandler(async (req, res) => {
    const parsed = exportQuerySchema.parse(req.query);
    const filters = toFilters(parsed);
    if (parsed.ids?.length) filters.ids = parsed.ids;

    const settings = await ensureSettings(req.user!.id);
    const requestedFields = parsed.fields
      ? parsed.fields
          .split(',')
          .map((field) => field.trim())
          .filter(Boolean)
      : settings.exportFields;
    const fields = requestedFields.filter((field) => (EXPORT_FIELDS as readonly string[]).includes(field));
    if (!fields.length) throw badRequest('Selecione pelo menos um campo valido para exportacao.');

    const rows = await listLeadsForExport(req.user!.id, filters, config.exportMaxRows);
    const columns = fields.map((field) => ({ key: field, label: FIELD_LABELS[field] ?? field }));
    const csvRows = rows.map((row) => {
      const lead = mapLead(row);
      const source = row.place_id ? publicSourceName('apify_google_maps') : 'Manual';
      const values: Record<string, unknown> = {
        Empresa: lead.name,
        Segmento: lead.segment,
        Cidade: lead.city,
        UF: lead.state,
        Pais: lead.country,
        Telefone: lead.phone,
        'E-mail': lead.email,
        Site: lead.website,
        'Situacao do site': WEBSITE_LABELS[lead.websiteStatus] ?? lead.websiteStatus,
        Pontuacao: lead.effectiveScore,
        'Status comercial': STATUS_LABELS[lead.status] ?? lead.status,
        Endereco: lead.address,
        Mapa: lead.googleMapsUrl,
        'Ultima verificacao': lead.websiteLastCheckedAt,
        'Criado em': lead.createdAt,
        Origem: source,
      };
      const record: Record<string, unknown> = {};
      for (const column of columns) record[column.label] = values[column.label] ?? '';
      return record;
    });

    const csv = toCsv(
      columns.map((column) => column.label),
      csvRows,
    );
    recordAudit(req, 'leads_exported', 'lead', null, { count: rows.length, fields });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="leadsearch-leads-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(csv);
  }),
);

const leadIdSchema = z.string().uuid();

leadsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = leadIdSchema.parse(req.params.id);
    res.json({ lead: await getLeadDetail(req.user!.id, id) });
  }),
);

const nullableText = (max: number) =>
  z.preprocess(
    (value) => (value === '' || value === null ? null : value),
    z.string().trim().max(max).nullable().optional(),
  );

const patchSchema = z.object({
  name: z.preprocess(emptyToUndefined, z.string().trim().min(2).max(180).optional()),
  segment: nullableText(120),
  city: nullableText(100),
  state: nullableText(100),
  country: nullableText(100),
  address: nullableText(300),
  phone: nullableText(40),
  email: z.preprocess(
    (value) => (value === '' || value === null ? null : value),
    z.string().trim().email().max(254).nullable().optional(),
  ),
  website: nullableText(500),
  status: z.preprocess(emptyToUndefined, z.enum(LEAD_STATUSES).optional()),
  doNotContact: z.boolean().optional(),
  scoreOverride: z.preprocess(
    (value) => (value === '' || value === null ? null : value),
    z.coerce.number().int().min(0).max(100).nullable().optional(),
  ),
  websiteStatus: z.enum(['unknown', 'missing']).optional(),
  note: z.preprocess(emptyToUndefined, z.string().trim().max(1000).optional()),
});

leadsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = leadIdSchema.parse(req.params.id);
    const body = patchSchema.parse(req.body);
    const { note, scoreOverride, ...patch } = body;
    const lead = await updateLead(
      req.user!.id,
      id,
      {
        ...patch,
        ...(Object.prototype.hasOwnProperty.call(body, 'scoreOverride')
          ? { scoreOverride: scoreOverride ?? null }
          : {}),
      },
      note,
    );
    recordAudit(req, 'lead_updated', 'lead', id, { fields: Object.keys(patch) });
    res.json({ lead });
  }),
);

const activitySchema = z.object({
  type: z.enum(['note', 'contact', 'meeting', 'proposal', 'result']),
  note: z.string().trim().min(1, 'Informe a observacao.').max(4000),
  nextAction: z.preprocess(emptyToUndefined, z.string().trim().max(500).optional()),
  nextActionAt: z.preprocess(emptyToUndefined, z.coerce.date().optional()),
});

leadsRouter.get(
  '/:id/activities',
  asyncHandler(async (req, res) => {
    const id = leadIdSchema.parse(req.params.id);
    const detail = await getLeadDetail(req.user!.id, id);
    res.json({ activities: detail.activities });
  }),
);

leadsRouter.post(
  '/:id/activities',
  asyncHandler(async (req, res) => {
    const id = leadIdSchema.parse(req.params.id);
    const body = activitySchema.parse(req.body);
    const activity = await addActivity(req.user!.id, id, {
      type: body.type,
      note: body.note,
      nextAction: body.nextAction ?? null,
      nextActionAt: body.nextActionAt ? body.nextActionAt.toISOString() : null,
    });
    recordAudit(req, 'lead_activity_created', 'lead', id, { type: body.type });
    res.status(201).json({ activity });
  }),
);

const dncSchema = z.object({
  value: z.boolean(),
  note: z.preprocess(emptyToUndefined, z.string().trim().max(1000).optional()),
});

leadsRouter.post(
  '/:id/do-not-contact',
  asyncHandler(async (req, res) => {
    const id = leadIdSchema.parse(req.params.id);
    const body = dncSchema.parse(req.body);
    const result = await setDoNotContact(req.user!.id, id, body.value, body.note);
    recordAudit(req, 'lead_do_not_contact_changed', 'lead', id, { value: body.value });
    res.json(result);
  }),
);

leadsRouter.post(
  '/:id/verify-site',
  asyncHandler(async (req, res) => {
    const id = leadIdSchema.parse(req.params.id);
    const result = await checkAndSaveWebsite(req.user!.id, id);
    recordAudit(req, 'lead_site_checked', 'lead', id, {
      reachable: result.verification.reachable,
      statusCode: result.verification.statusCode,
    });
    res.json(result);
  }),
);

leadsRouter.post(
  '/:id/enrich',
  asyncHandler(async (req, res) => {
    const id = leadIdSchema.parse(req.params.id);
    const result = await enrichLead(req.user!.id, id);
    recordAudit(req, 'lead_enriched', 'lead', id, result.collected);
    res.json(result);
  }),
);

leadsRouter.post(
  '/:id/score',
  asyncHandler(async (req, res) => {
    const id = leadIdSchema.parse(req.params.id);
    const result = await recalculateLead(req.user!.id, id);
    recordAudit(req, 'lead_score_recalculated', 'lead', id);
    res.json(result);
  }),
);
