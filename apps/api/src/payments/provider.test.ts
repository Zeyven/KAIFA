import { describe, expect, it } from 'vitest';
import {
  FakeOnlinePaymentProvider,
  resolveProvider,
  verifyWebhookSignature,
  webhookSignature,
} from './provider';

describe('payment provider adapters (§13.2)', () => {
  it('fake provider creates a simulator order + verifies the expected amount', async () => {
    const p = new FakeOnlinePaymentProvider();
    const created = await p.createOrder({
      paymentId: 'p1',
      orderId: 'o1',
      amountCents: 5000,
      method: 'WECHAT',
    });
    expect(created.providerOrderId).toMatch(/^fakeord_[0-9a-f]{32}$/);
    expect(created.displayPayload.qr).toContain('amount=5000');
    expect(created.displayPayload.simulator).toBe(true);

    const verified = await p.verify({
      providerOrderId: created.providerOrderId,
      paymentId: 'p1',
      expectedAmountCents: 5000,
    });
    expect(verified.verifiedAmountCents).toBe(5000);
    expect(verified.providerTransactionId).toContain(
      created.providerOrderId.slice('fakeord_'.length),
    );
  });

  it('resolveProvider: fake configured → adapter; real providers honestly unavailable', () => {
    expect(resolveProvider('fake')).toBeInstanceOf(FakeOnlinePaymentProvider);
    expect(resolveProvider('wechat')).toBeNull();
    expect(resolveProvider('alipay')).toBeNull();
    expect(resolveProvider('aggregate')).toBeNull();
  });

  it('webhook signature: HMAC-SHA256, constant-time compare, tamper-proof', () => {
    const secret = 'test-secret-test-secret-1234';
    const parts = {
      providerOrderId: 'fakeord_abc',
      providerTransactionId: 'faketxn_abc',
      amountCents: 1500,
    };
    const sig = webhookSignature(secret, parts);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, { ...parts, signature: sig })).toBe(true);

    // tampered amount / different secret / truncated sig all fail
    expect(verifyWebhookSignature(secret, { ...parts, amountCents: 1, signature: sig })).toBe(
      false,
    );
    expect(
      verifyWebhookSignature('other-secret-other-secret-99', { ...parts, signature: sig }),
    ).toBe(false);
    expect(verifyWebhookSignature(secret, { ...parts, signature: sig.slice(0, 8) })).toBe(false);
  });
});
