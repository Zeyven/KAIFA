import { formatYuan, type Cents } from '@lanxu/domain';

/**
 * Shared presentation helpers. UI never recomputes money — it formats the
 * integer cents the domain/API produced (ADR-0002).
 */

export { formatYuan };

/** Room board status display: text + icon REQUIRED alongside color (spec §9.2). */
export const ROOM_STATUS_META: Record<string, { label: string; icon: string; colorToken: string }> =
  {
    VACANT_CLEAN: { label: '空净', icon: '✔', colorToken: 'room.vacant' },
    RESERVED: { label: '已预约', icon: '📅', colorToken: 'room.reserved' },
    OCCUPIED_WAITING_SERVICE: { label: '待技师', icon: '⏳', colorToken: 'room.waiting' },
    IN_SERVICE: { label: '服务中', icon: '💆', colorToken: 'room.service' },
    WAITING_CHECKOUT: { label: '待结账', icon: '🧾', colorToken: 'room.checkout' },
    DIRTY: { label: '待清洁', icon: '🧹', colorToken: 'room.dirty' },
    CLEANING: { label: '清洁中', icon: '🧼', colorToken: 'room.cleaning' },
    MAINTENANCE: { label: '维护', icon: '🔧', colorToken: 'room.maintenance' },
    DISABLED: { label: '停用', icon: '⛔', colorToken: 'room.disabled' },
  };

export function roomStatusLabel(state: string): { label: string; icon: string } {
  const meta = ROOM_STATUS_META[state];
  if (!meta) return { label: state, icon: '❓' }; // unknown → explicit, never silent color
  return { label: meta.label, icon: meta.icon };
}

/** Checkout summary lines (spec §9.4) — pure formatting of cents. */
export function checkoutTotals(input: {
  subtotalCents: Cents;
  discountCents: Cents;
  paidCents: Cents;
}): { payable: string; remaining: string } {
  const payable = input.subtotalCents - input.discountCents;
  const remaining = payable - input.paidCents;
  return { payable: formatYuan(payable), remaining: formatYuan(remaining) };
}
