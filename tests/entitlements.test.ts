import { describe, expect, it } from 'vitest';
import { entitlementsFromRow, type SubscriptionRow } from '../src/services/subscriptionService.js';

const NOW = Date.now();
const FUTURE = new Date(NOW + 30 * 24 * 60 * 60 * 1000);
const PAST = new Date(NOW - 24 * 60 * 60 * 1000);

function subscription(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: 'sub_1',
    user_id: 'user_1',
    plan_id: 'starter',
    status: 'active',
    started_at: new Date(NOW - 24 * 60 * 60 * 1000),
    ends_at: FUTURE,
    credits_used: 10,
    credits_limit: 300,
    credits_reset_at: FUTURE,
    current_period_start: new Date(NOW - 24 * 60 * 60 * 1000),
    current_period_end: FUTURE,
    cancel_at_period_end: false,
    provider: 'stripe',
    provider_subscription_id: 'sub_stripe_1',
    provider_customer_id: 'cus_1',
    last_payment_at: new Date(NOW - 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

describe('direitos de acesso (entitlements)', () => {
  it('sem assinatura mantém acesso somente leitura', () => {
    const entitlements = entitlementsFromRow('user_1', 'user', null);
    expect(entitlements.active).toBe(false);
    expect(entitlements.canSearch).toBe(false);
    expect(entitlements.planId).toBeNull();
    expect(entitlements.reason).toBe('no_plan');
    expect(entitlements.creditsRemaining).toBe(0);
  });

  it('plano ativo com saldo libera pesquisas', () => {
    const entitlements = entitlementsFromRow('user_1', 'user', subscription());
    expect(entitlements.active).toBe(true);
    expect(entitlements.canSearch).toBe(true);
    expect(entitlements.planId).toBe('starter');
    expect(entitlements.planName).toBe('Starter');
    expect(entitlements.creditsLimit).toBe(300);
    expect(entitlements.creditsUsed).toBe(10);
    expect(entitlements.creditsRemaining).toBe(290);
    expect(entitlements.reason).toBe('ok');
  });

  it('bloqueia pesquisas quando os créditos acabam, mantendo leitura', () => {
    const entitlements = entitlementsFromRow(
      'user_1',
      'user',
      subscription({ credits_used: 300 }),
    );
    expect(entitlements.active).toBe(true);
    expect(entitlements.canSearch).toBe(false);
    expect(entitlements.creditsRemaining).toBe(0);
    expect(entitlements.reason).toBe('credits_exhausted');
  });

  it('bloqueia plano vencido mesmo com créditos restantes', () => {
    const entitlements = entitlementsFromRow(
      'user_1',
      'user',
      subscription({ current_period_end: PAST, ends_at: PAST, credits_reset_at: PAST }),
    );
    expect(entitlements.active).toBe(false);
    expect(entitlements.canSearch).toBe(false);
    expect(entitlements.reason).toBe('expired');
  });

  it('bloqueia assinatura inativa', () => {
    const entitlements = entitlementsFromRow(
      'user_1',
      'user',
      subscription({ status: 'canceled' }),
    );
    expect(entitlements.active).toBe(false);
    expect(entitlements.canSearch).toBe(false);
    expect(entitlements.reason).toBe('inactive');
  });

  it('não concede acesso a planos legados desconhecidos', () => {
    const entitlements = entitlementsFromRow(
      'user_1',
      'user',
      subscription({ plan_id: 'ilimitado' }),
    );
    expect(entitlements.active).toBe(false);
    expect(entitlements.canSearch).toBe(false);
    expect(entitlements.reason).toBe('plan_inactive');
  });

  it('super admin tem acesso completo e ilimitado', () => {
    const entitlements = entitlementsFromRow('admin_1', 'super_admin', null);
    expect(entitlements.isSuperAdmin).toBe(true);
    expect(entitlements.active).toBe(true);
    expect(entitlements.canSearch).toBe(true);
    expect(entitlements.unlimited).toBe(true);
    expect(entitlements.reason).toBe('super_admin');
    expect(entitlements.planName).toBe('Administrador');
  });

  it('papel admin legado não recebe acesso administrativo', () => {
    const entitlements = entitlementsFromRow('user_1', 'admin', null);
    expect(entitlements.isSuperAdmin).toBe(false);
    expect(entitlements.role).toBe('user');
    expect(entitlements.canSearch).toBe(false);
  });
});
