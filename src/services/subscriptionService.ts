import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import {
  CREDIT_UNIT_DESCRIPTION,
  getPlan,
  normalizeRole,
  SUPER_ADMIN_ROLE,
  type PlanId,
  type UserRole,
} from '../plans.js';

export type SubscriptionStatus =
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'pending'
  | 'expired'
  | 'refunded'
  | 'incomplete';

export interface SubscriptionRow {
  id: string;
  user_id: string;
  plan_id: string | null;
  status: SubscriptionStatus;
  started_at: Date;
  ends_at: Date | null;
  credits_used: number;
  credits_limit: number;
  credits_reset_at: Date | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  provider: string | null;
  provider_subscription_id: string | null;
  provider_customer_id: string | null;
  last_payment_at: Date | null;
}

export type AccessReason =
  | 'ok'
  | 'super_admin'
  | 'no_plan'
  | 'plan_inactive'
  | 'inactive'
  | 'expired'
  | 'credits_exhausted';

export interface Entitlements {
  userId: string;
  role: UserRole;
  isSuperAdmin: boolean;
  planId: PlanId | null;
  planName: string | null;
  status: SubscriptionStatus | null;
  active: boolean;
  canSearch: boolean;
  unlimited: boolean;
  reason: AccessReason;
  creditsLimit: number;
  creditsUsed: number;
  creditsRemaining: number;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  renewsAt: string | null;
  cancelAtPeriodEnd: boolean;
  provider: string | null;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  creditUnit: string;
}

const SUBSCRIPTION_COLUMNS = `
  id, user_id, plan_id, status, started_at, ends_at, credits_used, credits_limit,
  credits_reset_at, current_period_start, current_period_end, cancel_at_period_end,
  provider, provider_subscription_id, provider_customer_id, last_payment_at`;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function effectivePeriodEnd(row: SubscriptionRow): Date | null {
  return row.current_period_end ?? row.ends_at ?? row.credits_reset_at ?? null;
}

function isPeriodExpired(row: SubscriptionRow, now = Date.now()): boolean {
  const end = effectivePeriodEnd(row);
  return Boolean(end && end.getTime() <= now);
}

/**
 * Deriva os direitos de acesso a partir do registro persistido.
 * Nunca confia em dados enviados pelo cliente.
 */
export function entitlementsFromRow(
  userId: string,
  role: string | null | undefined,
  row: SubscriptionRow | null | undefined,
): Entitlements {
  const normalizedRole = normalizeRole(role);
  const isSuperAdmin = normalizedRole === SUPER_ADMIN_ROLE;
  const base: Entitlements = {
    userId,
    role: normalizedRole,
    isSuperAdmin,
    planId: null,
    planName: null,
    status: row?.status ?? null,
    active: false,
    canSearch: false,
    unlimited: false,
    reason: 'no_plan',
    creditsLimit: 0,
    creditsUsed: 0,
    creditsRemaining: 0,
    currentPeriodStart: iso(row?.current_period_start ?? null),
    currentPeriodEnd: iso(row ? effectivePeriodEnd(row) : null),
    renewsAt: null,
    cancelAtPeriodEnd: Boolean(row?.cancel_at_period_end),
    provider: row?.provider ?? null,
    providerCustomerId: row?.provider_customer_id ?? null,
    providerSubscriptionId: row?.provider_subscription_id ?? null,
    creditUnit: CREDIT_UNIT_DESCRIPTION,
  };

  if (isSuperAdmin) {
    return {
      ...base,
      active: true,
      canSearch: true,
      unlimited: true,
      reason: 'super_admin',
      planName: 'Administrador',
      creditsLimit: 0,
      creditsRemaining: 0,
    };
  }

  if (!row || !row.plan_id) return base;

  const plan = getPlan(row.plan_id);
  if (!plan) return { ...base, reason: 'plan_inactive' };

  // O limite persistido e a fonte de verdade do periodo. Ajustes manuais
  // feitos pelo administrador alteram esse valor e precisam valer de fato.
  const creditsLimit = Math.max(0, row.credits_limit);
  const creditsUsed = Math.max(0, row.credits_used ?? 0);
  const creditsRemaining = Math.max(0, creditsLimit - creditsUsed);
  const expired = isPeriodExpired(row);
  const statusActive = row.status === 'active';
  const active = statusActive && !expired;
  const reason: AccessReason = !statusActive ? 'inactive' : expired ? 'expired' : 'ok';

  return {
    ...base,
    planId: plan.id,
    planName: plan.name,
    status: row.status,
    active,
    canSearch: active && creditsRemaining > 0,
    reason: active && creditsRemaining <= 0 ? 'credits_exhausted' : reason,
    creditsLimit,
    creditsUsed,
    creditsRemaining,
    currentPeriodEnd: iso(effectivePeriodEnd(row)),
    renewsAt: iso(effectivePeriodEnd(row)),
  };
}

export async function loadSubscription(
  userId: string,
  client?: Pick<PoolClient, 'query'>,
): Promise<SubscriptionRow | null> {
  const runner = client ?? { query };
  const result = await runner.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM user_subscriptions WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function getEntitlements(
  userId: string,
  role: string | null | undefined,
): Promise<Entitlements> {
  const row = await loadSubscription(userId);
  return entitlementsFromRow(userId, role, row);
}

function accessError(entitlements: Entitlements): AppError {
  if (entitlements.reason === 'credits_exhausted') {
    return new AppError(
      402,
      'CREDITS_EXHAUSTED',
      'Seus créditos de pesquisa acabaram. Os créditos são renovados no próximo período da assinatura ou ao contratar um plano com mais créditos.',
      { reason: entitlements.reason, renewsAt: entitlements.renewsAt },
    );
  }
  if (entitlements.reason === 'expired') {
    return new AppError(
      402,
      'SUBSCRIPTION_EXPIRED',
      'Sua assinatura expirou. Renove o plano para voltar a executar pesquisas.',
      { reason: entitlements.reason },
    );
  }
  if (entitlements.reason === 'inactive') {
    return new AppError(
      402,
      'SUBSCRIPTION_INACTIVE',
      'Sua assinatura não está ativa. Regularize o pagamento ou contrate um plano para executar pesquisas.',
      { reason: entitlements.reason, status: entitlements.status },
    );
  }
  return new AppError(
    402,
    'SUBSCRIPTION_REQUIRED',
    'É necessário um plano ativo para executar pesquisas. Escolha um plano em /sales.',
    { reason: entitlements.reason },
  );
}

export function assertCanSearch(entitlements: Entitlements): void {
  if (!entitlements.active || !entitlements.canSearch) throw accessError(entitlements);
}

export function assertActiveSubscription(entitlements: Entitlements): void {
  if (!entitlements.active) throw accessError(entitlements);
}

export interface ConsumeOptions {
  amount?: number;
  reference?: string;
  searchId?: string | null;
  description?: string;
}

export interface ConsumeResult {
  charged: boolean;
  alreadyApplied: boolean;
  balanceAfter: number;
  transactionId: string | null;
  reference: string;
  reason?: string;
}

interface ConsumeRow {
  credits_used: number;
  credits_limit: number;
  plan_id: string | null;
}

/**
 * Consome creditos de forma atomica e idempotente.
 *
 * A condicao de saldo esta dentro do proprio UPDATE, portanto duas
 * requisicoes simultaneas nao conseguem ultrapassar o limite. A referencia
 * unica impede cobranca duplicada em retentativas.
 */
export async function consumeCredits(
  userId: string,
  role: string | null | undefined,
  options: ConsumeOptions = {},
): Promise<ConsumeResult> {
  const amount = Math.max(1, Math.trunc(options.amount ?? 1));
  const reference = (options.reference ?? randomUUID()).slice(0, 200);

  if (normalizeRole(role) === SUPER_ADMIN_ROLE) {
    return {
      charged: false,
      alreadyApplied: false,
      balanceAfter: Number.MAX_SAFE_INTEGER,
      transactionId: null,
      reference,
      reason: 'super_admin',
    };
  }

  try {
    return await withTransaction(async (client) => {
      const existing = await client.query<{ id: string; balance_after: number }>(
        `SELECT id, balance_after FROM credit_transactions
         WHERE user_id = $1 AND reference = $2 LIMIT 1`,
        [userId, reference],
      );
      if (existing.rows[0]) {
        return {
          charged: false,
          alreadyApplied: true,
          balanceAfter: existing.rows[0].balance_after,
          transactionId: existing.rows[0].id,
          reference,
        };
      }

      const updated = await client.query<ConsumeRow>(
        `UPDATE user_subscriptions s
         SET credits_used = s.credits_used + $2,
             updated_at = now()
         FROM plans p
         WHERE s.user_id = $1
           AND s.plan_id = p.id
           AND p.is_active = TRUE
           AND s.status = 'active'
           AND (
             COALESCE(s.current_period_end, s.ends_at, s.credits_reset_at) IS NULL
             OR COALESCE(s.current_period_end, s.ends_at, s.credits_reset_at) > now()
           )
           AND s.credits_used + $2 <= s.credits_limit
         RETURNING s.credits_used, s.credits_limit, s.plan_id`,
        [userId, amount],
      );

      const row = updated.rows[0];
      if (!row) {
        const current = await loadSubscription(userId, client);
        const entitlements = entitlementsFromRow(userId, role, current);
        throw accessError(entitlements);
      }

      const balanceAfter = Math.max(0, row.credits_limit - row.credits_used);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO credit_transactions
          (user_id, type, amount, balance_after, plan_id, search_id, reference, description)
         VALUES ($1, 'consume', $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          userId,
          -amount,
          balanceAfter,
          row.plan_id,
          options.searchId ?? null,
          reference,
          options.description ?? CREDIT_UNIT_DESCRIPTION,
        ],
      );

      return {
        charged: true,
        alreadyApplied: false,
        balanceAfter,
        transactionId: inserted.rows[0]?.id ?? null,
        reference,
      };
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '23505') {
      const existing = await query<{ id: string; balance_after: number }>(
        'SELECT id, balance_after FROM credit_transactions WHERE user_id = $1 AND reference = $2 LIMIT 1',
        [userId, reference],
      );
      if (existing.rows[0]) {
        return {
          charged: false,
          alreadyApplied: true,
          balanceAfter: existing.rows[0].balance_after,
          transactionId: existing.rows[0].id,
          reference,
        };
      }
    }
    throw error;
  }
}

export async function attachCreditToSearch(
  userId: string,
  reference: string,
  searchId: string,
): Promise<void> {
  await query(
    `UPDATE credit_transactions SET search_id = $3
     WHERE user_id = $1 AND reference = $2 AND search_id IS NULL`,
    [userId, reference, searchId],
  );
}

interface ConsumeTransactionRow {
  id: string;
  amount: number;
  search_id: string | null;
}

/**
 * Devolve o credito de um consumo que nao chegou a gerar resultados.
 * A referencia e derivada do proprio lancamento, portanto as duas rotas de
 * estorno (por referencia ou por search_id) nunca devolvem em dobro.
 */
async function refundConsumeTransaction(
  userId: string,
  transaction: ConsumeTransactionRow,
  searchId: string | null,
  description: string,
): Promise<boolean> {
  const reference = `refund:consume:${transaction.id}`;

  return withTransaction(async (client) => {
    const exists = await client.query<{ id: string }>(
      'SELECT id FROM credit_transactions WHERE user_id = $1 AND reference = $2 LIMIT 1',
      [userId, reference],
    );
    if (exists.rows[0]) return false;

    const amount = Math.abs(transaction.amount);
    const updated = await client.query<{
      credits_used: number;
      credits_limit: number;
      plan_id: string | null;
    }>(
      `UPDATE user_subscriptions
       SET credits_used = GREATEST(credits_used - $2, 0), updated_at = now()
       WHERE user_id = $1
       RETURNING credits_used, credits_limit, plan_id`,
      [userId, amount],
    );
    const row = updated.rows[0];
    if (!row) return false;

    await client.query(
      `INSERT INTO credit_transactions
        (user_id, type, amount, balance_after, plan_id, search_id, reference, description, metadata)
       VALUES ($1, 'refund', $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId,
        amount,
        Math.max(0, row.credits_limit - row.credits_used),
        row.plan_id,
        searchId ?? transaction.search_id,
        reference,
        description,
        JSON.stringify({ originalTransactionId: transaction.id }),
      ],
    );
    return true;
  });
}

/** Devolve o credito de uma pesquisa que falhou antes de gerar resultados. */
export async function refundSearchCredit(
  userId: string,
  searchId: string,
  description = 'Pesquisa não concluída: crédito devolvido.',
): Promise<boolean> {
  const consume = await query<ConsumeTransactionRow>(
    `SELECT id, amount, search_id FROM credit_transactions
     WHERE user_id = $1 AND search_id = $2 AND type = 'consume'
     ORDER BY created_at ASC LIMIT 1`,
    [userId, searchId],
  );
  const transaction = consume.rows[0];
  if (!transaction) return false;
  return refundConsumeTransaction(userId, transaction, searchId, description);
}

/** Devolve o credito pelo identificador unico usado no consumo. */
export async function refundCreditByReference(
  userId: string,
  reference: string,
  description = 'Pesquisa não concluída: crédito devolvido.',
): Promise<boolean> {
  const consume = await query<ConsumeTransactionRow>(
    `SELECT id, amount, search_id FROM credit_transactions
     WHERE user_id = $1 AND reference = $2 AND type = 'consume'
     LIMIT 1`,
    [userId, reference],
  );
  const transaction = consume.rows[0];
  if (!transaction) return false;
  return refundConsumeTransaction(userId, transaction, transaction.search_id, description);
}

export interface GrantPlanOptions {
  provider?: string | null;
  providerSubscriptionId?: string | null;
  providerCustomerId?: string | null;
  periodStart?: Date;
  periodEnd?: Date;
  reference?: string;
  description?: string;
  cancelAtPeriodEnd?: boolean;
}

export interface GrantPlanResult {
  subscriptionId: string;
  granted: boolean;
  credits: number;
  entitlements: Entitlements;
}

/**
 * Ativa um plano e concede os creditos do periodo de forma idempotente.
 * Usado por webhooks oficiais e por ajustes do administrador.
 */
export async function grantPlan(
  userId: string,
  planId: PlanId,
  options: GrantPlanOptions = {},
): Promise<GrantPlanResult> {
  const plan = getPlan(planId);
  if (!plan) throw new AppError(400, 'INVALID_PLAN', 'Plano inválido.');

  const periodStart = options.periodStart ?? new Date();
  const periodEnd = options.periodEnd ?? new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000);
  const reference = options.reference ? options.reference.slice(0, 200) : null;

  const result = await withTransaction(async (client) => {
    const existing = reference
      ? await client.query<{ id: string }>(
          'SELECT id FROM credit_transactions WHERE user_id = $1 AND reference = $2 LIMIT 1',
          [userId, reference],
        )
      : null;

    if (existing?.rows[0]) {
      // Notificacao repetida do mesmo pagamento: nao renova nem concede de novo.
      const current = await loadSubscription(userId, client);
      return { subscriptionId: current?.id ?? '', granted: false };
    }

    const upserted = await client.query<{ id: string }>(
      `INSERT INTO user_subscriptions (
        user_id, plan_id, status, started_at, ends_at, credits_used, credits_limit,
        credits_reset_at, current_period_start, current_period_end, cancel_at_period_end,
        provider, provider_subscription_id, provider_customer_id, last_payment_at, updated_at
      ) VALUES (
        $1, $2, 'active', $3, $4, 0, $5,
        $4, $3, $4, $6,
        $7, $8, $9, now(), now()
      )
      ON CONFLICT (user_id) DO UPDATE SET
        plan_id = EXCLUDED.plan_id,
        status = 'active',
        credits_used = 0,
        credits_limit = EXCLUDED.credits_limit,
        credits_reset_at = EXCLUDED.credits_reset_at,
        current_period_start = EXCLUDED.current_period_start,
        current_period_end = EXCLUDED.current_period_end,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        provider = COALESCE(EXCLUDED.provider, user_subscriptions.provider),
        provider_subscription_id = COALESCE(EXCLUDED.provider_subscription_id, user_subscriptions.provider_subscription_id),
        provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, user_subscriptions.provider_customer_id),
        last_payment_at = now(),
        updated_at = now()
      RETURNING id`,
      [
        userId,
        plan.id,
        periodStart,
        periodEnd,
        plan.credits,
        Boolean(options.cancelAtPeriodEnd),
        options.provider ?? null,
        options.providerSubscriptionId ?? null,
        options.providerCustomerId ?? null,
      ],
    );

    const subscriptionId = upserted.rows[0]!.id;
    let granted = false;

    if (!existing?.rows[0]) {
      const creditReference =
        reference ?? `grant:${subscriptionId}:${periodEnd.toISOString()}`;
      await client.query(
        `INSERT INTO credit_transactions
          (user_id, type, amount, balance_after, plan_id, reference, description, metadata)
         VALUES ($1, 'grant', $2, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, reference) WHERE reference IS NOT NULL DO NOTHING`,
        [
          userId,
          plan.credits,
          plan.id,
          creditReference,
          options.description ?? `Créditos do plano ${plan.name} concedidos.`,
          JSON.stringify({
            provider: options.provider ?? null,
            providerSubscriptionId: options.providerSubscriptionId ?? null,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
          }),
        ],
      );
      granted = true;
    }

    if (reference) {
      await client.query(
        `INSERT INTO subscription_events (user_id, subscription_id, type, provider, reference, data)
         VALUES ($1, $2, 'plan_granted', $3, $4, $5)
         ON CONFLICT (provider, reference) WHERE reference IS NOT NULL DO NOTHING`,
        [
          userId,
          subscriptionId,
          options.provider ?? 'manual',
          reference,
          JSON.stringify({ planId: plan.id, credits: plan.credits, periodStart, periodEnd }),
        ],
      );
    }

    return { subscriptionId, granted };
  });

  const entitlements = await getEntitlements(userId, 'user');
  return {
    subscriptionId: result.subscriptionId,
    granted: result.granted,
    credits: plan.credits,
    entitlements,
  };
}

export interface ProviderUpdateOptions {
  userId?: string | null;
  provider: string;
  providerSubscriptionId: string;
  providerCustomerId?: string | null;
  planId?: PlanId | null;
  status: SubscriptionStatus;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  reference?: string | null;
  data?: Record<string, unknown>;
}

export async function updateSubscriptionFromProvider(
  options: ProviderUpdateOptions,
): Promise<{ userId: string; subscriptionId: string } | null> {
  const existing = await query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM user_subscriptions
     WHERE provider = $1 AND provider_subscription_id = $2
     LIMIT 1`,
    [options.provider, options.providerSubscriptionId],
  );
  let row = existing.rows[0] ?? null;

  if (!row && options.userId) {
    const byUser = await query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM user_subscriptions WHERE user_id = $1 LIMIT 1`,
      [options.userId],
    );
    row = byUser.rows[0] ?? null;
  }

  if (!row) return null;

  const plan = options.planId ? getPlan(options.planId) : null;
  const updated = await query<{ id: string }>(
    `UPDATE user_subscriptions SET
       plan_id = COALESCE($2, plan_id),
       status = $3,
       credits_limit = COALESCE($4, credits_limit),
       current_period_start = COALESCE($5, current_period_start),
       current_period_end = COALESCE($6, current_period_end),
       credits_reset_at = COALESCE($6, credits_reset_at),
       cancel_at_period_end = $7,
       provider = $8,
       provider_subscription_id = $9,
       provider_customer_id = COALESCE($10, provider_customer_id),
       updated_at = now()
     WHERE id = $1
     RETURNING id`,
    [
      row.id,
      plan?.id ?? null,
      options.status,
      plan?.credits ?? null,
      options.periodStart ?? null,
      options.periodEnd ?? null,
      Boolean(options.cancelAtPeriodEnd),
      options.provider,
      options.providerSubscriptionId,
      options.providerCustomerId ?? null,
    ],
  );

  const reference = options.reference?.slice(0, 200) ?? null;
  if (reference) {
    await query(
      `INSERT INTO subscription_events (user_id, subscription_id, type, provider, reference, data)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider, reference) WHERE reference IS NOT NULL DO NOTHING`,
      [
        row.user_id,
        row.id,
        `status_${options.status}`,
        options.provider,
        reference,
        JSON.stringify(options.data ?? {}),
      ],
    );
  }

  await query(
    `INSERT INTO audit_logs (user_id, action, entity, entity_id, metadata)
     VALUES ($1, 'subscription_updated', 'subscription', $2, $3)`,
    [
      row.user_id,
      row.id,
      JSON.stringify({
        provider: options.provider,
        status: options.status,
        planId: plan?.id ?? row.plan_id,
        cancelAtPeriodEnd: Boolean(options.cancelAtPeriodEnd),
      }),
    ],
  );

  return { userId: row.user_id, subscriptionId: updated.rows[0]?.id ?? row.id };
}

export async function refundSubscriptionByCustomer(
  provider: string,
  providerCustomerId: string,
  reference: string,
  data: Record<string, unknown> = {},
): Promise<boolean> {
  const result = await query<{ id: string; user_id: string }>(
    `UPDATE user_subscriptions SET
       status = 'refunded',
       cancel_at_period_end = FALSE,
       current_period_end = now(),
       updated_at = now()
     WHERE provider = $1 AND provider_customer_id = $2
     RETURNING id, user_id`,
    [provider, providerCustomerId],
  );
  const row = result.rows[0];
  if (!row) return false;

  await query(
    `INSERT INTO subscription_events (user_id, subscription_id, type, provider, reference, data)
     VALUES ($1, $2, 'refunded', $3, $4, $5)
     ON CONFLICT (provider, reference) WHERE reference IS NOT NULL DO NOTHING`,
    [row.user_id, row.id, provider, reference.slice(0, 200), JSON.stringify(data)],
  );
  await query(
    `INSERT INTO audit_logs (user_id, action, entity, entity_id, metadata)
     VALUES ($1, 'subscription_refunded', 'subscription', $2, $3)`,
    [row.user_id, row.id, JSON.stringify({ provider, reference, ...data })],
  );
  return true;
}

export async function adjustCredits(
  actorUserId: string,
  targetUserId: string,
  delta: number,
  reason: string,
): Promise<{ creditsLimit: number; creditsUsed: number; creditsRemaining: number }> {
  const amount = Math.trunc(delta);
  if (!Number.isFinite(amount) || amount === 0) {
    throw new AppError(400, 'INVALID_ADJUSTMENT', 'Informe um ajuste de créditos diferente de zero.');
  }
  if (Math.abs(amount) > 1_000_000) {
    throw new AppError(400, 'INVALID_ADJUSTMENT', 'Ajuste de créditos acima do limite permitido.');
  }

  return withTransaction(async (client) => {
    const current = await client.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM user_subscriptions WHERE user_id = $1 FOR UPDATE`,
      [targetUserId],
    );
    const row = current.rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Assinatura do usuário não encontrada.');

    const newLimit = Math.max(0, row.credits_limit + amount);
    const updated = await client.query<{ credits_limit: number; credits_used: number }>(
      `UPDATE user_subscriptions SET credits_limit = $2, updated_at = now()
       WHERE user_id = $1
       RETURNING credits_limit, credits_used`,
      [targetUserId, newLimit],
    );
    const result = updated.rows[0]!;
    const balance = Math.max(0, result.credits_limit - result.credits_used);

    await client.query(
      `INSERT INTO credit_transactions
        (user_id, type, amount, balance_after, plan_id, reference, description, metadata)
       VALUES ($1, 'adjustment', $2, $3, $4, $5, $6, $7)`,
      [
        targetUserId,
        amount,
        balance,
        row.plan_id,
        `adjustment:${randomUUID()}`,
        reason,
        JSON.stringify({ actorUserId }),
      ],
    );

    return {
      creditsLimit: result.credits_limit,
      creditsUsed: result.credits_used,
      creditsRemaining: balance,
    };
  });
}

export async function listCreditHistory(
  userId: string,
  limit = 25,
): Promise<
  Array<{
    id: string;
    type: string;
    amount: number;
    balanceAfter: number;
    planId: string | null;
    searchId: string | null;
    description: string | null;
    createdAt: string;
  }>
> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const result = await query<{
    id: string;
    type: string;
    amount: number;
    balance_after: number;
    plan_id: string | null;
    search_id: string | null;
    description: string | null;
    created_at: Date;
  }>(
    `SELECT id, type, amount, balance_after, plan_id, search_id, description, created_at
     FROM credit_transactions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, safeLimit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    type: row.type,
    amount: row.amount,
    balanceAfter: row.balance_after,
    planId: row.plan_id,
    searchId: row.search_id,
    description: row.description,
    createdAt: row.created_at.toISOString(),
  }));
}

/**
 * Renova creditos de assinaturas administradas manualmente (sem provedor).
 * Assinaturas do provedor sao renovadas pelo webhook oficial de pagamento.
 */
export async function renewManualSubscriptions(): Promise<number> {
  const due = await query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM user_subscriptions s
     WHERE s.status = 'active'
       AND s.plan_id IN ('starter', 'pro', 'business')
       AND COALESCE(s.provider, 'manual') = 'manual'
       AND COALESCE(s.current_period_end, s.ends_at, s.credits_reset_at) IS NOT NULL
       AND COALESCE(s.current_period_end, s.ends_at, s.credits_reset_at) <= now()
     ORDER BY COALESCE(s.current_period_end, s.ends_at, s.credits_reset_at) ASC
     LIMIT 200`,
  );

  let renewed = 0;
  for (const row of due.rows) {
    const plan = getPlan(row.plan_id);
    if (!plan) continue;
    try {
      await withTransaction(async (client) => {
        const updated = await client.query<{ current_period_end: Date }>(
          `UPDATE user_subscriptions SET
             credits_used = 0,
             credits_limit = $2,
             current_period_start = now(),
             current_period_end = now() + interval '1 month',
             credits_reset_at = now() + interval '1 month',
             updated_at = now()
           WHERE id = $1 AND status = 'active'
           RETURNING current_period_end`,
          [row.id, plan.credits],
        );
        const periodEnd = updated.rows[0]?.current_period_end;
        if (!periodEnd) return;
        await client.query(
          `INSERT INTO credit_transactions
            (user_id, type, amount, balance_after, plan_id, reference, description)
           VALUES ($1, 'grant', $2, $2, $3, $4, $5)
           ON CONFLICT (user_id, reference) WHERE reference IS NOT NULL DO NOTHING`,
          [
            row.user_id,
            plan.credits,
            plan.id,
            `renewal:${row.id}:${periodEnd.toISOString()}`,
            `Renovação mensal do plano ${plan.name}.`,
          ],
        );
        renewed += 1;
      });
    } catch {
      // Uma renovacao com falha nao deve interromper as demais.
    }
  }
  return renewed;
}
