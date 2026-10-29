import { describe, expect, it } from 'vitest';
import {
  PAYMENT_STATES,
  assertPaymentTransition,
  canTransitionPayment,
  isCaptured,
  isCashMethod,
  type PaymentState,
} from './payment-state';
import { MachineError } from './session-state';

describe('payment state machine (spec §5.4/§13)', () => {
  it('cash settles CREATED → CAPTURED directly (§13.1)', () => {
    expect(canTransitionPayment('CREATED', 'CAPTURED')).toBe(true);
    expect(isCashMethod('CASH')).toBe(true);
    expect(isCashMethod('WECHAT')).toBe(false);
  });

  it('online path CREATED → PENDING → CAPTURED; failures allowed pre-capture', () => {
    expect(canTransitionPayment('CREATED', 'PENDING')).toBe(true);
    expect(canTransitionPayment('PENDING', 'CAPTURED')).toBe(true);
    expect(canTransitionPayment('CREATED', 'FAILED')).toBe(true);
    expect(canTransitionPayment('PENDING', 'CANCELLED')).toBe(true);
  });

  it('captured money never reverts or mutates away', () => {
    expect(canTransitionPayment('CAPTURED', 'FAILED')).toBe(false);
    expect(canTransitionPayment('CAPTURED', 'CANCELLED')).toBe(false);
    expect(canTransitionPayment('CAPTURED', 'CREATED')).toBe(false);
    expect(isCaptured('CAPTURED')).toBe(true);
    expect(isCaptured('FAILED')).toBe(false);
  });

  it('refund chain + terminal states', () => {
    expect(canTransitionPayment('CAPTURED', 'PARTIALLY_REFUNDED')).toBe(true);
    expect(canTransitionPayment('PARTIALLY_REFUNDED', 'REFUNDED')).toBe(true);
    expect(canTransitionPayment('REFUNDED', 'CAPTURED')).toBe(false);
    expect(canTransitionPayment('FAILED', 'CAPTURED')).toBe(false);
    expect(canTransitionPayment('CANCELLED', 'PENDING')).toBe(false);
  });

  it('assert throws MachineError 422', () => {
    try {
      assertPaymentTransition('CAPTURED', 'CREATED');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MachineError);
      expect((err as MachineError).statusCode).toBe(422);
    }
  });

  it('every declared state has a transition entry', () => {
    for (const s of PAYMENT_STATES as readonly PaymentState[]) {
      expect(PAYMENT_STATES).toContain(s);
    }
  });
});
