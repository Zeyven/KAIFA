import { MachineError, type ServiceSessionState } from './session-state';

/**
 * Order state machine (spec §5.4):
 *
 *   OPEN → IN_SERVICE → PENDING_CHECKOUT → PARTIALLY_PAID → PAID
 *   PAID → REFUND_PENDING → PARTIALLY_REFUNDED / REFUNDED
 *
 * Payments/refunds drive PARTIALLY_PAID…REFUNDED (Phases 12/16); the Order
 * Engine itself owns OPEN → IN_SERVICE → PENDING_CHECKOUT. Clients may never
 * PATCH status — commands validate guards here first.
 */
export const ORDER_STATES = [
  'OPEN',
  'IN_SERVICE',
  'PENDING_CHECKOUT',
  'PARTIALLY_PAID',
  'PAID',
  'REFUND_PENDING',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

const ORDER_TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  OPEN: ['IN_SERVICE', 'PENDING_CHECKOUT'],
  IN_SERVICE: ['PENDING_CHECKOUT'],
  PENDING_CHECKOUT: ['PARTIALLY_PAID', 'PAID'],
  PARTIALLY_PAID: ['PAID', 'PENDING_CHECKOUT'],
  PAID: ['REFUND_PENDING'],
  REFUND_PENDING: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  PARTIALLY_REFUNDED: ['REFUND_PENDING', 'REFUNDED'],
  REFUNDED: [],
};

export function canTransitionOrder(from: OrderState, to: OrderState): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function assertOrderTransition(from: OrderState, to: OrderState): void {
  if (!canTransitionOrder(from, to)) {
    throw new MachineError('INVALID_STATE_TRANSITION', `order cannot move ${from} → ${to}`, 422);
  }
}

/** States whose bill is still live (one per visit — matches partial unique). */
export function isLiveOrderState(s: OrderState): boolean {
  return s === 'OPEN' || s === 'IN_SERVICE' || s === 'PENDING_CHECKOUT' || s === 'PARTIALLY_PAID';
}

/** Checkout may only fire from a settled-service order. */
export function canCheckout(s: OrderState): boolean {
  return s === 'OPEN' || s === 'IN_SERVICE' || s === 'PENDING_CHECKOUT';
}

/**
 * Service states that block checkout — the bill cannot freeze while work is
 * still running (spec §5.4 + golden path 下钟→结账).
 */
export function blocksCheckout(sessionState: ServiceSessionState): boolean {
  return (
    sessionState === 'DRAFT' ||
    sessionState === 'ASSIGNED' ||
    sessionState === 'ACKNOWLEDGED' ||
    sessionState === 'ARRIVED' ||
    sessionState === 'STARTED' ||
    sessionState === 'ENDING_SOON'
  );
}
