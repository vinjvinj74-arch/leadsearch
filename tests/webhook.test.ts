import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyStripeSignature } from '../src/services/billingService.js';

const SECRET = 'whsec_test_secret';

function sign(payload: string, timestamp: number, secret = SECRET): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

describe('assinatura de webhook Stripe', () => {
  it('aceita assinatura HMAC válida e recente', () => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
    const timestamp = Math.floor(Date.now() / 1000);
    expect(verifyStripeSignature(payload, sign(payload, timestamp), SECRET, 300)).toBe(true);
  });

  it('rejeita payload alterado', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const header = sign('{"id":"evt_1"}', timestamp);
    expect(verifyStripeSignature('{"id":"evt_2"}', header, SECRET, 300)).toBe(false);
  });

  it('rejeita assinatura com segredo diferente', () => {
    const payload = '{"id":"evt_1"}';
    const timestamp = Math.floor(Date.now() / 1000);
    expect(
      verifyStripeSignature(payload, sign(payload, timestamp, 'whsec_outro'), SECRET, 300),
    ).toBe(false);
  });

  it('rejeita timestamp fora da tolerância', () => {
    const payload = '{"id":"evt_1"}';
    const timestamp = Math.floor(Date.now() / 1000) - 4000;
    expect(verifyStripeSignature(payload, sign(payload, timestamp), SECRET, 300)).toBe(false);
  });

  it('rejeita cabeçalho ausente ou malformado', () => {
    expect(verifyStripeSignature('{}', undefined, SECRET)).toBe(false);
    expect(verifyStripeSignature('{}', 'v1=abc', SECRET)).toBe(false);
    expect(verifyStripeSignature('{}', 't=123', SECRET)).toBe(false);
  });

  it('aceita múltiplas assinaturas v1 quando uma confere', () => {
    const payload = '{"id":"evt_1"}';
    const timestamp = Math.floor(Date.now() / 1000);
    const valid = sign(payload, timestamp).split('v1=')[1];
    const header = `t=${timestamp},v1=deadbeef,v1=${valid}`;
    expect(verifyStripeSignature(payload, header, SECRET, 300)).toBe(true);
  });
});
