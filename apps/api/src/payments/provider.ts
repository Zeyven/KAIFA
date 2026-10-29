import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Payment provider adapters (spec §13.2).
 *
 * V1 ships the FakeOnlinePaymentProvider only — production boot with
 * PAYMENT_PROVIDER=fake fails closed (env refine §13.2), and real
 * wechat/alipay/aggregate credentials cannot exist in this environment, so
 * requesting them returns an honest SERVICE_UNAVAILABLE rather than a fake.
 *
 * The verify/webhook contract mirrors the real rules the server must keep:
 * provider transaction id + AMOUNT are verified server-side; client "paid"
 * claims never matter (§20 #13).
 */

export interface ProviderCreateResult {
  providerOrderId: string;
  /** QR/payload rendered by the cashier UI (non-authoritative). */
  displayPayload: Record<string, unknown>;
}

export interface ProviderVerifyResult {
  providerTransactionId: string;
  verifiedAmountCents: number;
}

export interface PaymentProvider {
  readonly name: string;
  createOrder(input: {
    paymentId: string;
    orderId: string;
    amountCents: number;
    method: string;
  }): Promise<ProviderCreateResult>;
  verify(input: {
    providerOrderId: string;
    paymentId: string;
    expectedAmountCents: number;
  }): Promise<ProviderVerifyResult>;
}

/** Deterministic local simulator — no network, no money (PREVIEW/TEST). */
export class FakeOnlinePaymentProvider implements PaymentProvider {
  readonly name = 'fake';

  async createOrder(input: {
    paymentId: string;
    orderId: string;
    amountCents: number;
    method: string;
  }): Promise<ProviderCreateResult> {
    const providerOrderId = `fakeord_${randomUUID().replace(/-/g, '')}`;
    return {
      providerOrderId,
      displayPayload: {
        simulator: true,
        qr: `fakepay://pay?order=${providerOrderId}&amount=${input.amountCents}`,
        note: '模拟支付码（FakeOnlinePaymentProvider）— 非真实资金',
      },
    };
  }

  async verify(input: {
    providerOrderId: string;
    paymentId: string;
    expectedAmountCents: number;
  }): Promise<ProviderVerifyResult> {
    return {
      providerTransactionId: `faketxn_${input.providerOrderId.replace(/^fakeord_/, '')}`,
      verifiedAmountCents: input.expectedAmountCents,
    };
  }
}

export function resolveProvider(configured: string): PaymentProvider | null {
  if (configured === 'fake') return new FakeOnlinePaymentProvider();
  // real adapters need merchant credentials + egress — honestly unavailable
  return null;
}

/** §13.2 webhook signature: HMAC-SHA256 over the canonical fact string. */
export function webhookSignature(
  secret: string,
  parts: { providerOrderId: string; providerTransactionId: string; amountCents: number },
): string {
  const canonical = `${parts.providerOrderId}:${parts.providerTransactionId}:${parts.amountCents}`;
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

export function verifyWebhookSignature(
  secret: string,
  parts: {
    providerOrderId: string;
    providerTransactionId: string;
    amountCents: number;
    signature: string;
  },
): boolean {
  const expected = Buffer.from(webhookSignature(secret, parts), 'utf8');
  const got = Buffer.from(parts.signature.toLowerCase(), 'utf8');
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}
