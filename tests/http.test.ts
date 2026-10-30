import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

let app: Express;

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_placeholder';
  process.env.STRIPE_PRICE_STARTER = 'price_starter_placeholder';
  process.env.STRIPE_PRICE_PRO = 'price_pro_placeholder';
  process.env.STRIPE_PRICE_BUSINESS = 'price_business_placeholder';
  const { createApp } = await import('../src/app.js');
  app = createApp();
});

async function csrf(agent: ReturnType<typeof request.agent>) {
  const response = await agent.get('/api/auth/csrf').expect(200);
  return response.body.csrfToken as string;
}

describe('rotas públicas de planos e legal', () => {
  it('lista os três planos com preços e créditos do backend', async () => {
    const response = await request(app).get('/api/billing/plans').expect(200);
    expect(response.body.plans).toHaveLength(3);
    expect(response.body.plans.map((plan: { id: string }) => plan.id)).toEqual([
      'starter',
      'pro',
      'business',
    ]);
    expect(response.body.plans[0]).toMatchObject({ priceCents: 3990, credits: 300 });
    expect(response.body.comparison.length).toBeGreaterThan(0);
    expect(response.body.billing.provider).toBe('stripe');
    expect(JSON.stringify(response.body)).not.toContain('sk_test_placeholder');
    expect(JSON.stringify(response.body)).not.toContain('whsec_test_placeholder');
  });

  it('expõe documentos legais versionados', async () => {
    const response = await request(app).get('/api/legal/documents').expect(200);
    expect(response.body.version).toBe('2026-10-30');
    expect(response.body.contact).toBe('vinjvinj74@gmail.com');
    expect(response.body.documents.length).toBeGreaterThanOrEqual(9);
    const ids = response.body.documents.map((document: { id: string }) => document.id);
    expect(ids).toContain('terms');
    expect(ids).toContain('privacy');
    expect(ids).toContain('refund_policy');
    expect(ids).toContain('data_deletion');
    expect(ids).toContain('contact');
  });

  it('serve a página de vendas em /sales', async () => {
    const response = await request(app).get('/sales').expect(200);
    expect(response.text).toContain('Planos · RADAR');
    expect(response.text).toContain('/js/sales.js');
  });

  it.each(['/terms', '/privacy', '/cookies', '/acceptable-use', '/refund-policy', '/data-deletion', '/contact'])(
    'serve a rota legal %s',
    async (route) => {
      const response = await request(app).get(route).expect(200);
      expect(response.text.toLowerCase()).toContain('radar');
    },
  );
});

describe('proteções de cobrança', () => {
  it('rejeita webhook sem assinatura válida', async () => {
    const response = await request(app)
      .post('/api/billing/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ id: 'evt_test', type: 'checkout.session.completed' }))
      .expect(400);
    expect(response.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('exige autenticação para iniciar checkout', async () => {
    const agent = request.agent(app);
    const token = await csrf(agent);
    const response = await agent
      .post('/api/billing/checkout')
      .set('X-CSRF-Token', token)
      .send({ planId: 'pro' })
      .expect(401);
    expect(response.body.error).toBeTruthy();
  });

  it('rejeita requisição sem token CSRF', async () => {
    const response = await request(app)
      .post('/api/billing/checkout')
      .send({ planId: 'pro' })
      .expect(403);
    expect(response.body.error.code).toBe('CSRF_INVALID');
  });

  it('valida o formulário de contato antes de persistir', async () => {
    const agent = request.agent(app);
    const token = await csrf(agent);
    const response = await agent
      .post('/api/contact')
      .set('X-CSRF-Token', token)
      .send({ kind: 'support', name: 'A', email: 'invalido', message: 'curto', acceptPrivacy: true })
      .expect(400);
    expect(response.body.error).toBeTruthy();
  });
});
