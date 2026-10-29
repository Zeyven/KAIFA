import { describe, expect, it } from 'vitest';
import {
  TECHNICIAN_COMMANDS,
  TECHNICIAN_STATES,
  canTransitionTechnician,
  completeServiceTarget,
  type TechnicianCommand,
  type TechnicianState,
} from './technician-state';

/** Spec §5.2 legal edges (state, command, next). */
const LEGAL: Array<[TechnicianState, TechnicianCommand, TechnicianState]> = [
  ['OFF_DUTY', 'CLOCK_IN', 'AVAILABLE'],
  ['AVAILABLE', 'ASSIGN', 'ASSIGNED'],
  ['ASSIGNED', 'ACK', 'GOING_TO_ROOM'],
  ['GOING_TO_ROOM', 'ARRIVE', 'WAITING_START'],
  ['WAITING_START', 'START_SERVICE', 'SERVING'],
  ['AVAILABLE', 'BREAK_START', 'BREAK'],
  ['BREAK', 'BREAK_END', 'AVAILABLE'],
  ['AVAILABLE', 'LOCK', 'LOCKED'],
  ['LOCKED', 'UNLOCK', 'AVAILABLE'],
  ['ASSIGNED', 'RELEASE', 'AVAILABLE'],
  ['GOING_TO_ROOM', 'RELEASE', 'AVAILABLE'],
  ['WAITING_START', 'RELEASE', 'AVAILABLE'],
];

const OK_GUARDS = { onShift: true, assignable: true, sessionActive: true } as const;

describe('technician state machine (spec §5.2)', () => {
  it('accepts every legal edge with guards satisfied', () => {
    for (const [from, cmd, to] of LEGAL) {
      expect(canTransitionTechnician(from, cmd, OK_GUARDS), `${from} --${cmd}-->`).toEqual({
        ok: true,
        next: to,
      });
    }
  });

  it('rejects the full cross product of illegal (state, command) pairs', () => {
    const legalKeys = new Set(LEGAL.map(([s, c]) => `${s}|${c}`));
    // modeled-but-guarded / special-cased edges handled separately below
    const special = new Set([
      'SERVING|COMPLETE_SERVICE', // recompute path
      'LOCKED|ASSIGN', // TECHNICIAN_LOCKED (richer code)
      'AVAILABLE|CLOCK_OUT',
      'BREAK|CLOCK_OUT',
      'LOCKED|CLOCK_OUT',
      'OFF_DUTY|CLOCK_OUT',
    ]);
    let checked = 0;
    for (const state of TECHNICIAN_STATES) {
      for (const cmd of TECHNICIAN_COMMANDS) {
        const key = `${state}|${cmd}`;
        if (legalKeys.has(key) || special.has(key)) continue;
        const res = canTransitionTechnician(state, cmd, OK_GUARDS);
        expect(res.ok, `expected reject: ${key}`).toBe(false);
        if (!res.ok) expect(res.code).toBe('INVALID_STATE_TRANSITION');
        checked += 1;
      }
    }
    expect(checked).toBe(
      TECHNICIAN_STATES.length * TECHNICIAN_COMMANDS.length - LEGAL.length - special.size,
    );
  });

  it('COMPLETE_SERVICE never unconditionally returns AVAILABLE (spec §5.2 note)', () => {
    // recompute: shift over → OFF_DUTY; otherwise AVAILABLE
    expect(completeServiceTarget(true)).toBe('OFF_DUTY');
    expect(completeServiceTarget(false)).toBe('AVAILABLE');
    // structurally blocked outside SERVING
    const res = canTransitionTechnician('AVAILABLE', 'COMPLETE_SERVICE');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('RELEASE frees pre-service states back to AVAILABLE (§5.3 change-technician support)', () => {
    for (const from of ['ASSIGNED', 'GOING_TO_ROOM', 'WAITING_START'] as const) {
      const r = canTransitionTechnician(from, 'RELEASE', { onShift: true });
      expect(r.ok, from).toBe(true);
      if (r.ok) expect(r.next).toBe('AVAILABLE');
    }
    expect(canTransitionTechnician('SERVING', 'RELEASE', { onShift: true }).ok).toBe(false);
    expect(canTransitionTechnician('AVAILABLE', 'RELEASE', { onShift: true }).ok).toBe(false);
  });

  it('clock-out only from eligible (non-serving) states', () => {
    for (const state of ['OFF_DUTY', 'AVAILABLE', 'BREAK', 'LOCKED'] as const) {
      const res = canTransitionTechnician(state, 'CLOCK_OUT');
      expect(res, state).toEqual({ ok: true, next: 'OFF_DUTY' });
    }
    for (const busy of ['ASSIGNED', 'GOING_TO_ROOM', 'WAITING_START', 'SERVING'] as const) {
      const res = canTransitionTechnician(busy, 'CLOCK_OUT');
      expect(res.ok, busy).toBe(false);
      if (!res.ok) expect(res.code).toBe('INVALID_STATE_TRANSITION');
    }
  });

  it('guards gate clock-in / assign / start', () => {
    const noShift = canTransitionTechnician('OFF_DUTY', 'CLOCK_IN', { onShift: false });
    expect(noShift.ok).toBe(false);
    if (!noShift.ok) expect(noShift.code).toBe('FORBIDDEN');

    const notAssignable = canTransitionTechnician('AVAILABLE', 'ASSIGN', { assignable: false });
    expect(notAssignable.ok).toBe(false);
    if (!notAssignable.ok) expect(notAssignable.code).toBe('TECHNICIAN_NOT_AVAILABLE');

    const locked = canTransitionTechnician('LOCKED', 'ASSIGN');
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.code).toBe('TECHNICIAN_LOCKED');

    const noSession = canTransitionTechnician('WAITING_START', 'START_SERVICE', {
      sessionActive: false,
    });
    expect(noSession.ok).toBe(false);
    if (!noSession.ok) expect(noSession.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('failures carry machine-readable codes, never prose-only', () => {
    const res = canTransitionTechnician('BREAK', 'ASSIGN');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(['INVALID_STATE_TRANSITION', 'TECHNICIAN_NOT_AVAILABLE']).toContain(res.code);
    }
  });
});
