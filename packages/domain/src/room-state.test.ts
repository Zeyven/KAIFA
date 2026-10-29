import { describe, expect, it } from 'vitest';
import {
  ROOM_COMMANDS,
  ROOM_STATES,
  canTransition,
  type RoomCommand,
  type RoomOperationalState,
} from './room-state';

/** Spec §5.1 legal edges (state, command, next). Everything else must be rejected. */
const LEGAL: Array<[RoomOperationalState, RoomCommand, RoomOperationalState]> = [
  ['VACANT_CLEAN', 'OPEN_VISIT', 'OCCUPIED_WAITING_SERVICE'],
  ['RESERVED', 'GUEST_ARRIVED', 'OCCUPIED_WAITING_SERVICE'],
  ['OCCUPIED_WAITING_SERVICE', 'SERVICE_STARTED', 'IN_SERVICE'],
  ['IN_SERVICE', 'ALL_SERVICES_COMPLETED', 'WAITING_CHECKOUT'],
  ['WAITING_CHECKOUT', 'ORDER_PAID', 'DIRTY'],
  ['DIRTY', 'CLEANING_STARTED', 'CLEANING'],
  ['CLEANING', 'CLEANING_COMPLETED', 'VACANT_CLEAN'],
  ['VACANT_CLEAN', 'MAINTENANCE_START', 'MAINTENANCE'],
  // spec §5.1 "non-occupied" includes RESERVED / DIRTY / CLEANING
  ['RESERVED', 'MAINTENANCE_START', 'MAINTENANCE'],
  ['DIRTY', 'MAINTENANCE_START', 'MAINTENANCE'],
  ['CLEANING', 'MAINTENANCE_START', 'MAINTENANCE'],
  ['MAINTENANCE', 'MAINTENANCE_END', 'VACANT_CLEAN'],
  ['VACANT_CLEAN', 'DISABLE', 'DISABLED'],
  ['DISABLED', 'ENABLE', 'VACANT_CLEAN'],
  // spec §7.3 move endpoint; §5.1 table lacks these edges → documented gap-fill
  ['OCCUPIED_WAITING_SERVICE', 'VISIT_MOVED', 'DIRTY'],
  ['RESERVED', 'VISIT_MOVED', 'VACANT_CLEAN'],
];

const ALL_GUARDS = {
  hasActiveVisit: true,
  hasActiveSession: true,
  hasRunningSession: false,
  balanceSettled: true,
  cleanerAuthorized: true,
  checklistPassed: true,
  inspectionPassed: true,
} as const;

const legalKey = (s: string, c: string) => `${s}|${c}`;

describe('room state machine (spec §5.1, invariant I6)', () => {
  it('accepts every legal edge with guards satisfied', () => {
    for (const [from, cmd, to] of LEGAL) {
      const res = canTransition(from, cmd, ALL_GUARDS);
      expect(res, `${from} --${cmd}-->`).toEqual({ ok: true, next: to });
    }
  });

  it('rejects the full cross product of illegal (state, command) pairs', () => {
    const legalKeys = new Set(LEGAL.map(([s, c]) => legalKey(s, c)));
    // maintenance from occupied-family states is reachable-in-table but guarded
    const guardedOnly = new Set(
      (['OCCUPIED_WAITING_SERVICE', 'IN_SERVICE', 'WAITING_CHECKOUT'] as const).map((s) =>
        legalKey(s, 'MAINTENANCE_START'),
      ),
    );
    let checked = 0;
    for (const state of ROOM_STATES) {
      for (const cmd of ROOM_COMMANDS) {
        const key = legalKey(state, cmd);
        if (legalKeys.has(key)) continue;
        const res = canTransition(state, cmd, ALL_GUARDS);
        if (guardedOnly.has(key)) {
          expect(res.ok, key).toBe(false);
          if (!res.ok) expect(res.code).toBe('ROOM_NOT_ELIGIBLE');
        } else {
          expect(res.ok, `expected reject: ${key}`).toBe(false);
          if (!res.ok) expect(res.code).toBe('INVALID_STATE_TRANSITION');
        }
        checked += 1;
      }
    }
    expect(checked).toBe(ROOM_STATES.length * ROOM_COMMANDS.length - LEGAL.length);
  });

  it('IN_SERVICE → VACANT_CLEAN style shortcuts are impossible (spec prohibition)', () => {
    expect(canTransition('IN_SERVICE', 'OPEN_VISIT', ALL_GUARDS).ok).toBe(false);
    expect(canTransition('IN_SERVICE', 'CLEANING_COMPLETED', ALL_GUARDS).ok).toBe(false);
    expect(canTransition('IN_SERVICE', 'ENABLE', ALL_GUARDS).ok).toBe(false);
    expect(canTransition('WAITING_CHECKOUT', 'CLEANING_STARTED', ALL_GUARDS).ok).toBe(false);
    expect(canTransition('OCCUPIED_WAITING_SERVICE', 'OPEN_VISIT', ALL_GUARDS).ok).toBe(false);
  });

  it('guards gate each dependent edge', () => {
    expect(canTransition('VACANT_CLEAN', 'OPEN_VISIT', { hasActiveVisit: false }).ok).toBe(false);
    expect(canTransition('OCCUPIED_WAITING_SERVICE', 'SERVICE_STARTED', {}).ok).toBe(false);
    expect(
      canTransition('IN_SERVICE', 'ALL_SERVICES_COMPLETED', { hasRunningSession: true }).ok,
    ).toBe(false);
    expect(canTransition('WAITING_CHECKOUT', 'ORDER_PAID', { balanceSettled: false }).ok).toBe(
      false,
    );
    expect(canTransition('DIRTY', 'CLEANING_STARTED', { cleanerAuthorized: false }).ok).toBe(false);
    expect(canTransition('CLEANING', 'CLEANING_COMPLETED', { checklistPassed: false }).ok).toBe(
      false,
    );
    expect(canTransition('MAINTENANCE', 'MAINTENANCE_END', { inspectionPassed: false }).ok).toBe(
      false,
    );
  });

  it('maintenance only from non-occupied states', () => {
    for (const occupied of [
      'OCCUPIED_WAITING_SERVICE',
      'IN_SERVICE',
      'WAITING_CHECKOUT',
    ] as const) {
      const res = canTransition(occupied, 'MAINTENANCE_START', ALL_GUARDS);
      expect(res.ok, occupied).toBe(false);
      if (!res.ok) expect(res.code).toBe('ROOM_NOT_ELIGIBLE');
    }
    for (const free of ['VACANT_CLEAN', 'DIRTY', 'RESERVED', 'CLEANING'] as const) {
      expect(canTransition(free, 'MAINTENANCE_START', ALL_GUARDS).ok).toBe(true);
    }
  });

  it('failures carry machine-readable codes, never prose-only', () => {
    const res = canTransition('CLEANING', 'OPEN_VISIT', ALL_GUARDS);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(['INVALID_STATE_TRANSITION', 'ROOM_OCCUPIED', 'ROOM_NOT_ELIGIBLE']).toContain(
        res.code,
      );
    }
  });
});
