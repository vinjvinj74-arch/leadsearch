import { Router, type Request } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { asyncHandler } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { recordAudit } from '../lib/audit.js';
import {
  CREDIT_UNIT_DESCRIPTION,
  PLAN_COMPARISON,
  isPlanId,
  type PlanId,
} from '../plans.js';
import { requireAuth } from '../middleware/auth.js';
import { loadEntitlements, entitlementsFor } from '../middleware/entitlements.js';
import { mutationLimiter } from '../middleware/rateLimit.js';
import {
  billingConfigStatus,
  billingStatusFor,
  createBillingPortalSession,
  createCheckoutSession,
  handleStripeWebhook,
  publicPlans,
} from '../services/billingService.js';

export const billingRouter = Router();

function appBaseUrl(req: Request): string {
  if (config.appUrl) return config.appUrl;
  const host = req.get('host');
  if (!host) throw new AppError(400, 'INVALID_URL', 'Host da requisição não identificado.');
  return `${req.protocol}://${host}`;
}

billingRouter.get('/plans', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({
    plans: publicPlans(),
    comparison: PLAN_COMPARISON,
    billing: billingConfigStatus(),
    creditUnit: CREDIT_UNIT_DESCRIPTION,
  });
});

billingRouter.get(
  '/status',
  requireAuth,
  loadEntitlements,
  asyncHandler(async (req, res) => {
    const entitlements = entitlementsFor(req);
    res.json({
      entitlements,
      billing: billingConfigStatus(),
      ...(await billingStatusFor(req.user!.id, req.user!.role)),
    });
  }),
);

const checkoutSchema = z.object({
  planId: z.string().trim().min(1).max(40),
});

billingRouter.post(
  '/checkout',
  mutationLimiter,
  requireAuth,
  loadEntitlements,
  asyncHandler(async (req, res) => {
    const body = checkoutSchema.parse(req.body);
    if (!isPlanId(body.planId)) throw new AppError(400, 'INVALID_PLAN', 'Plano inválido.');
    const planId: PlanId = body.planId;

    const entitlements = entitlementsFor(req);
    if (entitlements.isSuperAdmin) {
      throw new AppError(400, 'ADMIN_HAS_ACCESS', 'O administrador já possui acesso completo.');
    }

    const result = await createCheckoutSession({
      userId: req.user!.id,
      email: req.user!.email,
      planId,
      baseUrl: appBaseUrl(req),
      providerCustomerId: entitlements.providerCustomerId,
    });

    recordAudit(req, 'billing_checkout_created', 'plan', planId, { sessionId: result.sessionId });
    res.status(201).json({ checkoutUrl: result.url, sessionId: result.sessionId, planId: result.planId });
  }),
);

billingRouter.post(
  '/portal',
  mutationLimiter,
  requireAuth,
  loadEntitlements,
  asyncHandler(async (req, res) => {
    const entitlements = entitlementsFor(req);
    if (!entitlements.providerCustomerId) {
      throw new AppError(
        400,
        'NO_BILLING_CUSTOMER',
        'Nenhuma assinatura gerenciada pelo provedor foi encontrada para esta conta.',
      );
    }
    const result = await createBillingPortalSession(
      entitlements.providerCustomerId,
      appBaseUrl(req),
    );
    recordAudit(req, 'billing_portal_opened', 'subscription', entitlements.providerSubscriptionId);
    res.json({ portalUrl: result.url });
  }),
);

/**
 * Webhook cru do Stripe. A rota e montada em app.ts antes do parser JSON,
 * portanto a assinatura e validada sobre os bytes exatos enviados.
 */
export async function stripeWebhookHandler(
  req: Request,
  res: import('express').Response,
): Promise<void> {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const signature = req.get('stripe-signature');
    const result = await handleStripeWebhook(rawBody, signature);
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof AppError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    res.status(500).json({
      error: { code: 'WEBHOOK_FAILED', message: 'Falha ao processar o evento de cobrança.' },
    });
  }
}
