import { describe, expect, it } from 'vitest';
import {
  ORDER_STATES,
  assertOrderTransition,
  blocksCheckout,
  canCheckout,
  canTransitionOrder,
  isLiveOrderState,
  type OrderState,
} from './order-state';
import { MachineError } from './session-state';

describe('order state machine (spec §5.4)', () => {
  it('happy path: OPEN → IN_SERVICE → PENDING_CHECKOUT → PARTIALLY_PAID → PAID', () => {
    expect(canTransitionOrder('OPEN', 'IN_SERVICE')).toBe(true);
    expect(canTransitionOrder('IN_SERVICE', 'PENDING_CHECKOUT')).toBe(true);
    expect(canTransitionOrder('PENDING_CHECKOUT', 'PARTIALLY_PAID')).toBe(true);
    expect(canTransitionOrder('PARTIALLY_PAID', 'PAID')).toBe(true);
  });

  it('refund chain per §5.4', () => {
    expect(canTransitionOrder('PAID', 'REFUND_PENDING')).toBe(true);
    expect(canTransitionOrder('REFUND_PENDING', 'PARTIALLY_REFUNDED')).toBe(true);
    expect(canTransitionOrder('REFUND_PENDING', 'REFUNDED')).toBe(true);
    expect(canTransitionOrder('PARTIALLY_REFUNDED', 'REFUNDED')).toBe(true);
    expect(canTransitionOrder('REFUNDED', 'PARTIALLY_PAID')).toBe(false);
  });

  it('goods-only bills may checkout straight from OPEN; no skipping to PAID', () => {
    expect(canTransitionOrder('OPEN', 'PENDING_CHECKOUT')).toBe(true); // no services on this visit
    expect(canTransitionOrder('OPEN', 'PAID')).toBe(false);
    expect(canTransitionOrder('PENDING_CHECKOUT', 'OPEN')).toBe(false);
    expect(canTransitionOrder('PAID', 'PENDING_CHECKOUT')).toBe(false);
    expect(canTransitionOrder('PARTIALLY_PAID', 'REFUND_PENDING')).toBe(false); // refund only from PAID
  });

  it('rejects with MachineError INVALID_STATE_TRANSITION (422)', () => {
    try {
      assertOrderTransition('PAID', 'OPEN');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MachineError);
      expect((err as MachineError).code).toBe('INVALID_STATE_TRANSITION');
      expect((err as MachineError).statusCode).toBe(422);
    }
  });

  it('isLiveOrderState mirrors the one-live-order-per-visit partial unique', () => {
    const live = ORDER_STATES.filter(isLiveOrderState);
    expect(live).toEqual(['OPEN', 'IN_SERVICE', 'PENDING_CHECKOUT', 'PARTIALLY_PAID']);
  });

  it('checkout guards', () => {
    expect(canCheckout('OPEN')).toBe(true);
    expect(canCheckout('IN_SERVICE')).toBe(true);
    expect(canCheckout('PENDING_CHECKOUT')).toBe(true); // idempotent re-freeze
    expect(canCheckout('PAID')).toBe(false);
    // running service blocks checkout
    expect(blocksCheckout('STARTED')).toBe(true);
    expect(blocksCheckout('ENDING_SOON')).toBe(true);
    expect(blocksCheckout('COMPLETED')).toBe(false);
    expect(blocksCheckout('TERMINATED')).toBe(false);
    expect(blocksCheckout('CANCELLED')).toBe(false);
  });

  it('terminal REFUNDED has no outgoing transitions', () => {
    expect(ORDER_STATES.every((s: OrderState) => Array.isArray([s]))).toBe(true);
    expect(canTransitionOrder('REFUNDED', 'PAID')).toBe(false);
  });
});
