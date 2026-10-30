import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { recordAudit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { asyncHandler } from '../lib/http.js';
import { getPlan, isPlanId, type PlanId } from '../plans.js';
import { requireAuth } from '../middleware/auth.js';
import { requireSuperAdmin } from '../middleware/entitlements.js';
import { mutationLimiter } from '../middleware/rateLimit.js';
import {
  adjustCredits,
  getEntitlements,
  grantPlan,
  listCreditHistory,
  loadSubscription,
} from '../services/subscriptionService.js';
import { cancelProviderSubscription } from '../services/billingService.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireSuperAdmin);

interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  created_at: Date;
  email_verified_at: Date | null;
  plan_id: string | null;
  status: string | null;
  credits_used: number | null;
  credits_limit: number | null;
  current_period_end: Date | null;
  provider: string | null;
}

function mapAdminUser(row: AdminUserRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: row.created_at.toISOString(),
    emailVerifiedAt: row.email_verified_at ? row.email_verified_at.toISOString() : null,
    planId: row.plan_id,
    planName: getPlan(row.plan_id)?.name ?? null,
    status: row.status,
    creditsUsed: row.credits_used ?? 0,
    creditsLimit: row.credits_limit ?? 0,
    creditsRemaining: Math.max(0, (row.credits_limit ?? 0) - (row.credits_used ?? 0)),
    currentPeriodEnd: row.current_period_end ? row.current_period_end.toISOString() : null,
    provider: row.provider,
  };
}

const USERS_SELECT = `
  SELECT u.id, u.name, u.email, u.role, u.created_at, u.email_verified_at,
         s.plan_id, s.status, s.credits_used, s.credits_limit, s.current_period_end, s.provider
  FROM users u
  LEFT JOIN user_subscriptions s ON s.user_id = u.id`;

adminRouter.get(
  '/users',
  asyncHandler(async (req, res) => {
    const q = z.preprocess(
      (value) => (typeof value === 'string' ? value.trim().slice(0, 120) : ''),
      z.string().max(120),
    ).parse(req.query.q);
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(
      Math.max(Number.parseInt(String(req.query.pageSize ?? '25'), 10) || 25, 1),
      100,
    );
    const offset = (page - 1) * pageSize;
    const search = q ? `%${q.toLowerCase()}%` : null;

    const [rows, total] = await Promise.all([
      query<AdminUserRow>(
        `${USERS_SELECT}
         WHERE ($1::text IS NULL OR lower(u.name) LIKE $1 OR lower(u.email) LIKE $1)
         ORDER BY u.created_at DESC
         LIMIT $2 OFFSET $3`,
        [search, pageSize, offset],
      ),
      query<{ count: string }>(
        `SELECT count(*)::text AS count FROM users u
         WHERE ($1::text IS NULL OR lower(u.name) LIKE $1 OR lower(u.email) LIKE $1)`,
        [search],
      ),
    ]);

    res.json({
      users: rows.rows.map(mapAdminUser),
      page,
      pageSize,
      total: Number.parseInt(total.rows[0]?.count ?? '0', 10),
    });
  }),
);

adminRouter.get(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const user = await query<AdminUserRow>(`${USERS_SELECT} WHERE u.id = $1 LIMIT 1`, [id]);
    const row = user.rows[0];
    if (!row) throw notFound('Usuário não encontrado.');

    const [credits, events, entitlements] = await Promise.all([
      listCreditHistory(id, 50),
      query<{ type: string; provider: string | null; reference: string | null; created_at: Date; data: Record<string, unknown> }>(
        `SELECT type, provider, reference, created_at, data
         FROM subscription_events WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 30`,
        [id],
      ),
      getEntitlements(id, row.role),
    ]);

    res.json({
      user: mapAdminUser(row),
      entitlements,
      credits,
      events: events.rows.map((event) => ({
        type: event.type,
        provider: event.provider,
        reference: event.reference,
        createdAt: event.created_at.toISOString(),
        data: event.data,
      })),
    });
  }),
);

const planSchema = z.object({
  planId: z.string().trim().min(1).max(40),
  days: z.coerce.number().int().min(1).max(366).optional(),
});

adminRouter.post(
  '/users/:id/plan',
  mutationLimiter,
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = planSchema.parse(req.body);
    if (!isPlanId(body.planId)) throw badRequest('Plano inválido.');
    const planId: PlanId = body.planId;
    const plan = getPlan(planId)!;

    const target = await query<{ id: string; email: string }>(
      'SELECT id, email FROM users WHERE id = $1 LIMIT 1',
      [id],
    );
    if (!target.rows[0]) throw notFound('Usuário não encontrado.');

    const days = body.days ?? 30;
    const now = new Date();
    const result = await grantPlan(id, planId, {
      periodStart: now,
      periodEnd: new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
      reference: `admin:plan:${id}:${Date.now()}`,
      description: `Plano ${plan.name} concedido manualmente pelo administrador.`,
    });

    recordAudit(req, 'admin_plan_granted', 'user', id, {
      planId,
      days,
      credits: plan.credits,
      targetEmail: target.rows[0].email,
    });
    res.json({ ok: true, ...result });
  }),
);

const creditsSchema = z.object({
  delta: z.coerce.number().int().min(-1_000_000).max(1_000_000),
  reason: z.string().trim().min(3).max(500),
});

adminRouter.post(
  '/users/:id/credits',
  mutationLimiter,
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = creditsSchema.parse(req.body);
    if (body.delta === 0) throw badRequest('Informe um ajuste diferente de zero.');

    const result = await adjustCredits(req.user!.id, id, body.delta, body.reason);
    recordAudit(req, 'admin_credits_adjusted', 'user', id, {
      delta: body.delta,
      reason: body.reason,
      ...result,
    });
    res.json({ ok: true, ...result });
  }),
);

const cancelSchema = z.object({
  immediate: z.boolean().optional().default(false),
});

adminRouter.post(
  '/users/:id/cancel',
  mutationLimiter,
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = cancelSchema.parse(req.body);
    const subscription = await loadSubscription(id);
    if (!subscription) throw notFound('Assinatura não encontrada.');

    // Assinaturas gerenciadas pelo Stripe precisam ser canceladas no provedor
    // para não continuar gerando cobranças. Assinaturas manuais são locais.
    if (subscription.provider === 'stripe') {
      await cancelProviderSubscription(
        subscription.provider_subscription_id ?? '',
        body.immediate,
      );
    }

    const immediate = body.immediate || !subscription.provider;
    const updated = await query<{ id: string; status: string; cancel_at_period_end: boolean }>(
      `UPDATE user_subscriptions SET
         status = CASE WHEN $2 THEN 'canceled' ELSE status END,
         cancel_at_period_end = $3,
         current_period_end = CASE WHEN $2 THEN now() ELSE current_period_end END,
         updated_at = now()
       WHERE user_id = $1
       RETURNING id, status, cancel_at_period_end`,
      [id, immediate, !immediate],
    );
    recordAudit(req, 'admin_subscription_canceled', 'subscription', updated.rows[0]?.id ?? null, {
      targetUserId: id,
      immediate,
    });
    res.json({ ok: true, subscription: updated.rows[0] });
  }),
);

adminRouter.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const limit = Math.min(
      Math.max(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 1),
      200,
    );
    const result = await query<{
      id: string;
      action: string;
      entity: string | null;
      entity_id: string | null;
      metadata: Record<string, unknown>;
      created_at: Date;
      user_id: string | null;
      email: string | null;
    }>(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.metadata, a.created_at,
              a.user_id, u.email
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at DESC
       LIMIT $1`,
      [limit],
    );
    res.json({
      events: result.rows.map((row) => ({
        id: row.id,
        action: row.action,
        entity: row.entity,
        entityId: row.entity_id,
        metadata: row.metadata,
        createdAt: row.created_at.toISOString(),
        userId: row.user_id,
        email: row.email,
      })),
    });
  }),
);

adminRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const result = await query<{
      users: string;
      active: string;
      starter: string;
      pro: string;
      business: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM users) AS users,
         (SELECT count(*)::text FROM user_subscriptions WHERE status = 'active') AS active,
         (SELECT count(*)::text FROM user_subscriptions WHERE status = 'active' AND plan_id = 'starter') AS starter,
         (SELECT count(*)::text FROM user_subscriptions WHERE status = 'active' AND plan_id = 'pro') AS pro,
         (SELECT count(*)::text FROM user_subscriptions WHERE status = 'active' AND plan_id = 'business') AS business`,
    );
    const row = result.rows[0];
    res.json({
      users: Number.parseInt(row?.users ?? '0', 10),
      activeSubscriptions: Number.parseInt(row?.active ?? '0', 10),
      byPlan: {
        starter: Number.parseInt(row?.starter ?? '0', 10),
        pro: Number.parseInt(row?.pro ?? '0', 10),
        business: Number.parseInt(row?.business ?? '0', 10),
      },
    });
  }),
);
