import { MachineError } from './session-state';

/**
 * Payment state machine (spec §5.4 / §13):
 *
 *   CREATED → PENDING → CAPTURED          (online: provider order + verify)
 *   CREATED → CAPTURED                    (cash: cashier confirm, §13.1)
 *            ↘ FAILED / CANCELLED
 *   CAPTURED → PARTIALLY_REFUNDED → REFUNDED
 *
 * CAPTURED only from server-verified state (§13.2); refunds are Phase 16.
 */
export const PAYMENT_STATES = [
  'CREATED',
  'PENDING',
  'CAPTURED',
  'FAILED',
  'CANCELLED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

const PAYMENT_TRANSITIONS: Record<PaymentState, readonly PaymentState[]> = {
  CREATED: ['PENDING', 'CAPTURED', 'FAILED', 'CANCELLED'],
  PENDING: ['CAPTURED', 'FAILED', 'CANCELLED'],
  CAPTURED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  FAILED: [],
  CANCELLED: [],
  PARTIALLY_REFUNDED: ['REFUNDED'],
  REFUNDED: [],
};

export function canTransitionPayment(from: PaymentState, to: PaymentState): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export function assertPaymentTransition(from: PaymentState, to: PaymentState): void {
  if (!canTransitionPayment(from, to)) {
    throw new MachineError('INVALID_STATE_TRANSITION', `payment cannot move ${from} → ${to}`, 422);
  }
}

export function isCaptured(s: PaymentState): boolean {
  return s === 'CAPTURED' || s === 'PARTIALLY_REFUNDED' || s === 'REFUNDED';
}

/** Cash methods settle immediately on cashier confirm (§13.1, no PENDING hop). */
export function isCashMethod(method: string): boolean {
  return method === 'CASH';
}
