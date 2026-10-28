import { describe, expect, it } from 'vitest';
import { checkoutTotals, roomStatusLabel, ROOM_STATUS_META } from './index';

describe('ui helpers', () => {
  it('every known room state exposes text + icon (never color alone, spec §9.2)', () => {
    for (const meta of Object.values(ROOM_STATUS_META)) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.icon.length).toBeGreaterThan(0);
      expect(meta.colorToken.length).toBeGreaterThan(0);
    }
    expect(roomStatusLabel('IN_SERVICE').label).toBe('服务中');
    expect(roomStatusLabel('SOMETHING_NEW').label).toBe('SOMETHING_NEW'); // explicit unknown
  });

  it('checkout totals compute remaining from integer cents', () => {
    const t = checkoutTotals({ subtotalCents: 168000n, discountCents: 10000n, paidCents: 100000n });
    expect(t.payable).toBe('¥1,580.00');
    expect(t.remaining).toBe('¥580.00');
  });
});
