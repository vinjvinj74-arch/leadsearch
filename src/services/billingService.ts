import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
  CREDIT_UNIT_DESCRIPTION,
  getPlan,
  isPlanId,
  PLAN_LIST,
  type PlanId,
} from '../plans.js';
import {
  grantPlan,
  listCreditHistory,
  refundSubscriptionByCustomer,
  updateSubscriptionFromProvider,
  type SubscriptionStatus,
} from './subscriptionService.js';

const STRIPE_API = 'https://api.stripe.com/v1';
const STRIPE_PROVIDER = 'stripe';

export interface PublicPlan {
  id: PlanId;
  name: string;
  priceCents: number;
  priceLabel: string;
  credits: number;
  creditsLabel: string;
  description: string;
  features: string[];
  highlight: boolean;
  sortOrder: number;
}

export function publicPlans(): PublicPlan[] {
  return PLAN_LIST.map((plan) => ({
    id: plan.id,
    name: plan.name,
    priceCents: plan.priceCents,
    priceLabel: plan.priceLabel,
    credits: plan.credits,
    creditsLabel: plan.creditsLabel,
    description: plan.description,
    features: plan.features,
    highlight: plan.highlight,
    sortOrder: plan.sortOrder,
  }));
}

export function billingConfigStatus(): {
  configured: boolean;
  provider: 'stripe';
  missing: string[];
} {
  const missing: string[] = [];
  if (!config.billing.stripeSecretKey) missing.push('STRIPE_SECRET_KEY');
  if (!config.billing.stripeWebhookSecret) missing.push('STRIPE_WEBHOOK_SECRET');
  for (const plan of PLAN_LIST) {
    if (!config.billing.prices[plan.id]) missing.push(`STRIPE_PRICE_${plan.id.toUpperCase()}`);
  }
  return {
    configured: missing.length === 0,
    provider: STRIPE_PROVIDER,
    missing,
  };
}

export function isBillingConfigured(): boolean {
  return billingConfigStatus().configured;
}

function assertBillingConfigured(): void {
  const status = billingConfigStatus();
  if (!status.configured) {
    throw new AppError(
      503,
      'BILLING_NOT_CONFIGURED',
      'O pagamento online ainda não foi configurado no servidor. Fale com o suporte para contratar um plano.',
      { missing: status.missing },
    );
  }
}

function planPriceId(planId: PlanId): string {
  const price = config.billing.prices[planId];
  if (!price) {
    throw new AppError(503, 'BILLING_NOT_CONFIGURED', 'Preço do plano não configurado no servidor.');
  }
  return price;
}

function planFromPriceId(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  for (const plan of PLAN_LIST) {
    if (config.billing.prices[plan.id] === priceId) return plan.id;
  }
  return null;
}

function metadataValue(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function metadataPlanId(metadata: Record<string, unknown> | null | undefined): PlanId | null {
  const value = metadataValue(metadata, 'planId');
  return isPlanId(value) ? value : null;
}

function unixDate(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000);
}

function defaultPeriodEnd(start: Date): Date {
  return new Date(start.getTime() + 31 * 24 * 60 * 60 * 1000);
}

interface StripeResponse {
  [key: string]: unknown;
}

async function stripeRequest(
  path: string,
  params: URLSearchParams,
  idempotencyKey?: string,
  method: 'POST' | 'DELETE' = 'POST',
): Promise<StripeResponse> {
  assertBillingConfigured();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.billing.stripeSecretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-12-18.acacia',
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const response = await fetch(`${STRIPE_API}${path}`, {
      method,
      headers,
      body: params.toString().replace(/%7BCHECKOUT_SESSION_ID%7D/gi, '{CHECKOUT_SESSION_ID}'),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as StripeResponse;
    if (!response.ok) {
      const error = payload.error as { message?: string; code?: string } | undefined;
      logger.warn(
        { status: response.status, code: error?.code, message: error?.message },
        'Falha na API de cobrança',
      );
      throw new AppError(
        502,
        'PAYMENT_PROVIDER_ERROR',
        'O provedor de pagamento não concluiu a operação. Tente novamente em instantes.',
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.warn({ err: error }, 'Erro de rede na API de cobrança');
    throw new AppError(
      502,
      'PAYMENT_PROVIDER_ERROR',
      'Não foi possível falar com o provedor de pagamento. Tente novamente em instantes.',
    );
  } finally {
    clearTimeout(timeout);
  }
}

export interface CheckoutInput {
  userId: string;
  email: string;
  planId: PlanId;
  baseUrl: string;
  providerCustomerId?: string | null;
}

export interface CheckoutResult {
  url: string;
  sessionId: string;
  planId: PlanId;
}

function normalizeBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
    return url.origin;
  } catch {
    throw new AppError(400, 'INVALID_URL', 'Endereço do aplicativo inválido para o checkout.');
  }
}

export async function createCheckoutSession(input: CheckoutInput): Promise<CheckoutResult> {
  assertBillingConfigured();
  const plan = getPlan(input.planId);
  if (!plan) throw new AppError(400, 'INVALID_PLAN', 'Plano inválido.');

  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const priceId = planPriceId(plan.id);
  const idempotencyKey = `checkout:${input.userId}:${plan.id}:${randomUUID()}`;

  const inserted = await query<{ id: string }>(
    `INSERT INTO checkout_sessions (user_id, plan_id, provider, idempotency_key, status)
     VALUES ($1, $2, $3, $4, 'open')
     RETURNING id`,
    [input.userId, plan.id, STRIPE_PROVIDER, idempotencyKey],
  );
  const localSessionId = inserted.rows[0]?.id;
  if (!localSessionId) throw new AppError(500, 'CHECKOUT_FAILED', 'Não foi possível iniciar o checkout.');

  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('line_items[0][price]', priceId);
  params.set('line_items[0][quantity]', '1');
  params.set('client_reference_id', input.userId);
  params.set('success_url', `${baseUrl}/sales?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  params.set('cancel_url', `${baseUrl}/sales?checkout=cancelled`);
  params.set('allow_promotion_codes', 'true');
  params.set('billing_address_collection', 'auto');
  params.set('locale', 'pt-BR');
  params.set('metadata[userId]', input.userId);
  params.set('metadata[planId]', plan.id);
  params.set('subscription_data[metadata][userId]', input.userId);
  params.set('subscription_data[metadata][planId]', plan.id);
  if (input.providerCustomerId) params.set('customer', input.providerCustomerId);
  else params.set('customer_email', input.email);

  try {
    const session = await stripeRequest('/checkout/sessions', params, idempotencyKey);
    const sessionId = typeof session.id === 'string' ? session.id : '';
    const url = typeof session.url === 'string' ? session.url : '';
    if (!sessionId || !url) throw new AppError(502, 'CHECKOUT_FAILED', 'Checkout sem URL de pagamento.');

    await query(
      `UPDATE checkout_sessions SET
         provider_session_id = $2,
         provider_session_url = $3,
         updated_at = now()
       WHERE id = $1`,
      [localSessionId, sessionId, url],
    );

    return { url, sessionId, planId: plan.id };
  } catch (error) {
    await query(
      `UPDATE checkout_sessions SET status = 'failed', updated_at = now() WHERE id = $1`,
      [localSessionId],
    ).catch(() => undefined);
    throw error;
  }
}

export async function createBillingPortalSession(
  providerCustomerId: string,
  baseUrl: string,
): Promise<{ url: string }> {
  assertBillingConfigured();
  const params = new URLSearchParams();
  params.set('customer', providerCustomerId);
  params.set(
    'return_url',
    `${normalizeBaseUrl(baseUrl)}${config.billing.portalReturnPath || '/sales'}`,
  );
  const session = await stripeRequest('/billing_portal/sessions', params);
  const url = typeof session.url === 'string' ? session.url : '';
  if (!url) throw new AppError(502, 'PORTAL_FAILED', 'Não foi possível abrir o portal de cobrança.');
  return { url };
}

/**
 * Cancela a assinatura no provedor para manter o estado local sincronizado.
 * O cancelamento imediato encerra agora; o agendado mantém o acesso até o
 * fim do período já pago.
 */
export async function cancelProviderSubscription(
  providerSubscriptionId: string,
  immediate: boolean,
): Promise<void> {
  assertBillingConfigured();
  if (!providerSubscriptionId) {
    throw new AppError(
      400,
      'NO_PROVIDER_SUBSCRIPTION',
      'Assinatura sem identificador do provedor de pagamento.',
    );
  }

  const path = `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`;
  if (immediate) {
    await stripeRequest(path, new URLSearchParams(), undefined, 'DELETE');
    return;
  }

  const params = new URLSearchParams();
  params.set('cancel_at_period_end', 'true');
  await stripeRequest(path, params);
}

/**
 * Verifica a assinatura Stripe (`Stripe-Signature`) usando HMAC-SHA256.
 * Rejeita timestamp fora da tolerância e compara em tempo constante.
 */
export function verifyStripeSignature(
  payload: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
  toleranceSeconds = config.billing.webhookToleranceSeconds,
): boolean {
  if (!signatureHeader || !secret) return false;
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  let timestamp = '';
  const signatures: string[] = [];

  for (const part of signatureHeader.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't') timestamp = value ?? '';
    if (key === 'v1' && value) signatures.push(value);
  }
  if (!timestamp || !signatures.length) return false;

  const timestampNumber = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampNumber)) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - timestampNumber);
  if (age > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(payloadBuffer)
    .digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  return signatures.some((signature) => {
    const provided = Buffer.from(signature, 'utf8');
    return provided.length === expectedBuffer.length && timingSafeEqual(provided, expectedBuffer);
  });
}

interface PaymentEventRow {
  id: string;
}

async function beginPaymentEvent(event: Record<string, unknown>): Promise<string | null> {
  const eventId = typeof event.id === 'string' ? event.id : '';
  if (!eventId) throw new AppError(400, 'INVALID_WEBHOOK', 'Evento sem identificador.');
  const type = typeof event.type === 'string' ? event.type : null;
  const inserted = await query<PaymentEventRow>(
    `INSERT INTO payment_events (provider, event_id, type, status, payload)
     VALUES ($1, $2, $3, 'processing', $4)
     ON CONFLICT (provider, event_id) DO UPDATE SET
       type = EXCLUDED.type,
       payload = EXCLUDED.payload,
       status = 'processing',
       error = NULL,
       processed_at = NULL
     WHERE payment_events.status = 'failed'
     RETURNING id`,
    [STRIPE_PROVIDER, eventId, type, JSON.stringify(event)],
  );
  return inserted.rows[0]?.id ?? null;
}

async function finishPaymentEvent(
  id: string,
  status: 'processed' | 'ignored' | 'failed',
  error?: string,
): Promise<void> {
  await query(
    `UPDATE payment_events SET
       status = $2,
       error = $3,
       processed_at = now()
     WHERE id = $1`,
    [id, status, error?.slice(0, 1000) ?? null],
  );
}

function mapStripeStatus(status: unknown): SubscriptionStatus {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    case 'incomplete':
      return 'incomplete';
    case 'incomplete_expired':
      return 'expired';
    case 'paused':
      return 'canceled';
    default:
      return 'expired';
  }
}

interface StripeObject {
  id?: string;
  customer?: string | { id?: string };
  subscription?: string | { id?: string; metadata?: Record<string, unknown> };
  metadata?: Record<string, unknown>;
  status?: string;
  cancel_at_period_end?: boolean;
  current_period_start?: number;
  current_period_end?: number;
  period_start?: number;
  period_end?: number;
  billing_reason?: string;
  client_reference_id?: string;
  subscription_details?: { metadata?: Record<string, unknown> };
  items?: { data?: Array<{ price?: { id?: string } }> };
  lines?: { data?: Array<{ price?: { id?: string }; period?: { start?: number; end?: number } }> };
  amount_refunded?: number;
  payment_intent?: string;
}

function objectId(value: string | { id?: string } | undefined): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value.id === 'string') return value.id;
  return null;
}

function findSubscriptionPrice(object: StripeObject): string | null {
  const fromItems = object.items?.data?.[0]?.price?.id;
  if (fromItems) return fromItems;
  const fromLines = object.lines?.data?.[0]?.price?.id;
  return fromLines ?? null;
}

async function findUserIdByProvider(
  providerSubscriptionId: string | null,
  providerCustomerId: string | null,
): Promise<string | null> {
  if (providerSubscriptionId) {
    const bySubscription = await query<{ user_id: string }>(
      `SELECT user_id FROM user_subscriptions
       WHERE provider = $1 AND provider_subscription_id = $2 LIMIT 1`,
      [STRIPE_PROVIDER, providerSubscriptionId],
    );
    if (bySubscription.rows[0]) return bySubscription.rows[0].user_id;
  }
  if (providerCustomerId) {
    const byCustomer = await query<{ user_id: string }>(
      `SELECT user_id FROM user_subscriptions
       WHERE provider = $1 AND provider_customer_id = $2 LIMIT 1`,
      [STRIPE_PROVIDER, providerCustomerId],
    );
    if (byCustomer.rows[0]) return byCustomer.rows[0].user_id;
  }
  return null;
}

async function markCheckout(
  providerSessionId: string | null,
  status: 'completed' | 'expired' | 'canceled' | 'failed',
): Promise<void> {
  if (!providerSessionId) return;
  await query(
    `UPDATE checkout_sessions SET
       status = $2,
       completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
       updated_at = now()
     WHERE provider_session_id = $1`,
    [providerSessionId, status],
  );
}

async function processCheckoutCompleted(object: StripeObject): Promise<boolean> {
  const sessionId = object.id ?? null;
  await markCheckout(sessionId, 'completed');

  const metadata = object.metadata ?? {};
  const userId =
    metadataValue(metadata, 'userId') ??
    (typeof object.client_reference_id === 'string' ? object.client_reference_id : null);
  const planId = metadataPlanId(metadata);
  const providerSubscriptionId = objectId(object.subscription);
  const providerCustomerId = objectId(object.customer);

  if (!userId || !planId) {
    logger.warn({ sessionId }, 'Checkout concluído sem userId/planId nos metadados');
    return false;
  }

  const now = new Date();
  await grantPlan(userId, planId, {
    provider: STRIPE_PROVIDER,
    providerSubscriptionId,
    providerCustomerId,
    periodStart: now,
    periodEnd: defaultPeriodEnd(now),
    reference: `stripe:checkout:${sessionId}`,
    description: `Plano ${getPlan(planId)?.name ?? planId} ativado via Stripe.`,
  });
  return true;
}

async function processSubscriptionEvent(
  type: string,
  object: StripeObject,
): Promise<boolean> {
  const providerSubscriptionId = object.id ?? null;
  if (!providerSubscriptionId) return false;
  const providerCustomerId = objectId(object.customer);
  const metadata = object.metadata ?? {};
  const planId = metadataPlanId(metadata) ?? planFromPriceId(findSubscriptionPrice(object));
  const userId =
    metadataValue(metadata, 'userId') ??
    (await findUserIdByProvider(providerSubscriptionId, providerCustomerId));

  if (!userId) {
    logger.warn({ type, providerSubscriptionId }, 'Assinatura Stripe sem usuário correspondente');
    return false;
  }

  const periodStart = unixDate(object.current_period_start);
  const periodEnd = unixDate(object.current_period_end);
  const status = type === 'customer.subscription.deleted' ? 'canceled' : mapStripeStatus(object.status);

  await updateSubscriptionFromProvider({
    userId,
    provider: STRIPE_PROVIDER,
    providerSubscriptionId,
    providerCustomerId,
    planId,
    status,
    periodStart,
    periodEnd: type === 'customer.subscription.deleted' ? new Date() : periodEnd,
    cancelAtPeriodEnd: Boolean(object.cancel_at_period_end),
    reference: `stripe:${type}:${providerSubscriptionId}:${String(object.status ?? '')}`,
    data: { type, status: object.status ?? null },
  });
  return true;
}

async function processInvoicePaid(object: StripeObject): Promise<boolean> {
  const invoiceId = object.id ?? null;
  const providerSubscriptionId = objectId(object.subscription);
  const providerCustomerId = objectId(object.customer);
  const metadata =
    object.subscription_details?.metadata ??
    (typeof object.subscription === 'object' ? object.subscription?.metadata : undefined) ??
    {};
  const userId =
    metadataValue(metadata, 'userId') ??
    (await findUserIdByProvider(providerSubscriptionId, providerCustomerId));
  const planId = metadataPlanId(metadata) ?? planFromPriceId(findSubscriptionPrice(object));
  const periodStart =
    unixDate(object.period_start) ?? unixDate(object.lines?.data?.[0]?.period?.start) ?? new Date();
  const periodEnd =
    unixDate(object.period_end) ??
    unixDate(object.lines?.data?.[0]?.period?.end) ??
    defaultPeriodEnd(periodStart);

  if (!userId || !planId) {
    logger.warn({ invoiceId, providerSubscriptionId }, 'Fatura paga sem usuário/plano identificado');
    return false;
  }

  // A primeira fatura é coberta pelo checkout.session.completed. As faturas
  // seguintes renovam os créditos do período.
  if (object.billing_reason === 'subscription_create') {
    await updateSubscriptionFromProvider({
      userId,
      provider: STRIPE_PROVIDER,
      providerSubscriptionId: providerSubscriptionId ?? '',
      providerCustomerId,
      planId,
      status: 'active',
      periodStart,
      periodEnd,
      cancelAtPeriodEnd: false,
      reference: `stripe:invoice:${invoiceId}:activate`,
      data: { invoiceId, billingReason: object.billing_reason },
    }).catch(() => null);
    return true;
  }

  await grantPlan(userId, planId, {
    provider: STRIPE_PROVIDER,
    providerSubscriptionId,
    providerCustomerId,
    periodStart,
    periodEnd,
    reference: `stripe:invoice:${invoiceId}`,
    description: `Renovação do plano ${getPlan(planId)?.name ?? planId} via Stripe.`,
  });
  return true;
}

async function processInvoiceFailed(object: StripeObject): Promise<boolean> {
  const providerSubscriptionId = objectId(object.subscription);
  if (!providerSubscriptionId) return false;
  const providerCustomerId = objectId(object.customer);
  const userId = await findUserIdByProvider(providerSubscriptionId, providerCustomerId);
  if (!userId) return false;
  await updateSubscriptionFromProvider({
    userId,
    provider: STRIPE_PROVIDER,
    providerSubscriptionId,
    providerCustomerId,
    status: 'past_due',
    reference: `stripe:invoice_failed:${object.id ?? providerSubscriptionId}`,
    data: { invoiceId: object.id ?? null },
  });
  return true;
}

async function processRefund(object: StripeObject): Promise<boolean> {
  const providerCustomerId = objectId(object.customer);
  if (!providerCustomerId) return false;
  return refundSubscriptionByCustomer(
    STRIPE_PROVIDER,
    providerCustomerId,
    `stripe:refund:${object.id ?? randomUUID()}`,
    { chargeId: object.id ?? null, amountRefunded: object.amount_refunded ?? null },
  );
}

async function processEvent(type: string, object: StripeObject): Promise<boolean> {
  if (type === 'checkout.session.completed') return processCheckoutCompleted(object);
  if (type === 'checkout.session.expired') {
    await markCheckout(object.id ?? null, 'expired');
    return true;
  }
  if (
    type === 'customer.subscription.created' ||
    type === 'customer.subscription.updated' ||
    type === 'customer.subscription.deleted'
  ) {
    return processSubscriptionEvent(type, object);
  }
  if (type === 'invoice.paid' || type === 'invoice.payment_succeeded') return processInvoicePaid(object);
  if (type === 'invoice.payment_failed') return processInvoiceFailed(object);
  if (type === 'charge.refunded') return processRefund(object);
  return false;
}

export async function handleStripeWebhook(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
): Promise<{ received: true; processed: boolean }> {
  if (!config.billing.stripeWebhookSecret) {
    throw new AppError(503, 'BILLING_NOT_CONFIGURED', 'Webhook de cobrança não configurado.');
  }
  if (!verifyStripeSignature(rawBody, signatureHeader, config.billing.stripeWebhookSecret)) {
    throw new AppError(400, 'INVALID_SIGNATURE', 'Assinatura do webhook inválida.');
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody) as Record<
      string,
      unknown
    >;
  } catch {
    throw new AppError(400, 'INVALID_WEBHOOK', 'Payload do webhook inválido.');
  }

  const eventRowId = await beginPaymentEvent(event);
  if (!eventRowId) return { received: true, processed: false };

  const type = typeof event.type === 'string' ? event.type : '';
  const data = event.data as { object?: StripeObject } | undefined;
  const object = data?.object ?? {};

  try {
    const processed = await processEvent(type, object);
    await finishPaymentEvent(eventRowId, processed ? 'processed' : 'ignored');
    return { received: true, processed };
  } catch (error) {
    logger.error({ err: error, eventId: event.id, type }, 'Falha ao processar webhook de cobrança');
    await finishPaymentEvent(
      eventRowId,
      'failed',
      error instanceof Error ? error.message : 'erro desconhecido',
    ).catch(() => undefined);
    throw new AppError(500, 'WEBHOOK_FAILED', 'Falha ao processar o evento de cobrança.');
  }
}

export async function billingStatusFor(userId: string, role: string) {
  const [credits, events] = await Promise.all([
    listCreditHistory(userId, 25),
    query<{ type: string; provider: string | null; created_at: Date; data: Record<string, unknown> }>(
      `SELECT type, provider, created_at, data
       FROM subscription_events
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [userId],
    ),
  ]);
  return {
    creditUnit: CREDIT_UNIT_DESCRIPTION,
    credits,
    events: events.rows.map((row) => ({
      type: row.type,
      provider: row.provider,
      createdAt: row.created_at.toISOString(),
      data: row.data,
    })),
    role,
  };
}
