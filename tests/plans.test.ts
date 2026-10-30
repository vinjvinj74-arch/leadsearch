import { describe, expect, it } from 'vitest';
import {
  ADMIN_EMAIL,
  CREDIT_UNIT_DESCRIPTION,
  PLAN_COMPARISON,
  PLAN_IDS,
  PLAN_LIST,
  PLANS,
  getPlan,
  isPlanId,
  isSuperAdminEmail,
  normalizeRole,
} from '../src/plans.js';

describe('configuração de planos', () => {
  it('expõe exatamente os três planos comerciais na ordem correta', () => {
    expect(PLAN_IDS).toEqual(['starter', 'pro', 'business']);
    expect(PLAN_LIST.map((plan) => plan.name)).toEqual(['Starter', 'Pro', 'Business']);
  });

  it('mantém preços e créditos definidos pela especificação', () => {
    expect(PLANS.starter.priceCents).toBe(3990);
    expect(PLANS.starter.credits).toBe(300);
    expect(PLANS.pro.priceCents).toBe(6700);
    expect(PLANS.pro.credits).toBe(1000);
    expect(PLANS.business.priceCents).toBe(19700);
    expect(PLANS.business.credits).toBe(5000);
  });

  it('formata os preços em BRL', () => {
    expect(PLANS.starter.priceLabel).toContain('39,90');
    expect(PLANS.pro.priceLabel).toContain('67,00');
    expect(PLANS.business.priceLabel).toContain('197,00');
  });

  it('marca apenas o Pro como destaque', () => {
    expect(PLAN_LIST.filter((plan) => plan.highlight).map((plan) => plan.id)).toEqual(['pro']);
  });

  it('valida identificadores de plano sem aceitar valores arbitrários', () => {
    expect(isPlanId('starter')).toBe(true);
    expect(isPlanId('ilimitado')).toBe(false);
    expect(isPlanId('basico')).toBe(false);
    expect(isPlanId(null)).toBe(false);
    expect(getPlan('business')?.credits).toBe(5000);
    expect(getPlan('legacy')).toBeNull();
  });

  it('descreve a unidade de crédito sem ambiguidade', () => {
    expect(CREDIT_UNIT_DESCRIPTION).toMatch(/pesquisa executada consome 1 crédito/i);
    expect(CREDIT_UNIT_DESCRIPTION).toMatch(/não consome créditos/i);
  });

  it('inclui comparativo com valores para todos os planos', () => {
    expect(PLAN_COMPARISON.length).toBeGreaterThan(0);
    for (const row of PLAN_COMPARISON) {
      expect(row.values.starter).toBeTruthy();
      expect(row.values.pro).toBeTruthy();
      expect(row.values.business).toBeTruthy();
    }
  });
});

describe('papéis e administrador', () => {
  it('reconhece somente o e-mail autorizado como super admin', () => {
    expect(isSuperAdminEmail(ADMIN_EMAIL)).toBe(true);
    expect(isSuperAdminEmail(`  ${ADMIN_EMAIL.toUpperCase()}  `)).toBe(true);
    expect(isSuperAdminEmail('outro@example.com')).toBe(false);
    expect(isSuperAdminEmail('')).toBe(false);
    expect(isSuperAdminEmail(null)).toBe(false);
  });

  it('normaliza papéis legados para o modelo atual', () => {
    expect(normalizeRole('super_admin')).toBe('super_admin');
    expect(normalizeRole('admin')).toBe('user');
    expect(normalizeRole('user')).toBe('user');
    expect(normalizeRole(null)).toBe('user');
  });
});
