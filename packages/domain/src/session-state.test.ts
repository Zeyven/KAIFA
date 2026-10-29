import { describe, expect, it } from 'vitest';
import {
  MachineError,
  SESSION_STATES,
  assertSessionTransition,
  checkSessionGuard,
  isActiveSessionState,
  sessionTransition,
  type ServiceSessionCommand,
  type ServiceSessionState,
} from './session-state';

const TERMINAL: ServiceSessionState[] = ['COMPLETED', 'CANCELLED', 'REJECTED', 'TERMINATED'];

describe('sessionTransition (spec §5.3)', () => {
  it('accepts the happy path chain end to end', () => {
    const chain: Array<[ServiceSessionState, ServiceSessionCommand, ServiceSessionState]> = [
      ['DRAFT', 'ASSIGN', 'ASSIGNED'],
      ['ASSIGNED', 'ACKNOWLEDGE', 'ACKNOWLEDGED'],
      ['ACKNOWLEDGED', 'ARRIVE', 'ARRIVED'],
      ['ARRIVED', 'START', 'STARTED'],
      ['STARTED', 'NEARING_END', 'ENDING_SOON'],
      ['ENDING_SOON', 'COMPLETE', 'COMPLETED'],
    ];
    for (const [from, cmd, to] of chain) {
      const r = sessionTransition(from, cmd);
      expect(r.ok, `${from} --${cmd}-->`).toBe(true);
      if (r.ok) expect(r.next).toBe(to);
    }
  });

  it('extend and nearing-end keep STARTED semantics', () => {
    expect(sessionTransition('STARTED', 'EXTEND')).toEqual({ ok: true, next: 'STARTED' });
    expect(sessionTransition('ENDING_SOON', 'EXTEND')).toEqual({ ok: true, next: 'ENDING_SOON' });
    expect(sessionTransition('STARTED', 'COMPLETE')).toEqual({ ok: true, next: 'COMPLETED' });
  });

  it('change-technician returns to ASSIGNED from running states', () => {
    for (const from of ['ASSIGNED', 'ACKNOWLEDGED', 'ARRIVED', 'STARTED', 'ENDING_SOON'] as const) {
      const r = sessionTransition(from, 'CHANGE_TECHNICIAN');
      expect(r.ok, from).toBe(true);
      if (r.ok) expect(r.next).toBe('ASSIGNED');
    }
    expect(sessionTransition('DRAFT', 'CHANGE_TECHNICIAN').ok).toBe(false);
  });

  it('exception paths: cancel DRAFT/ASSIGNED, reject ASSIGNED, terminate pre-start and post-start', () => {
    expect(sessionTransition('DRAFT', 'CANCEL')).toEqual({ ok: true, next: 'CANCELLED' });
    expect(sessionTransition('ASSIGNED', 'CANCEL')).toEqual({ ok: true, next: 'CANCELLED' });
    expect(sessionTransition('ACKNOWLEDGED', 'CANCEL').ok).toBe(false); // spec: DRAFT/ASSIGNED 可 CANCEL
    expect(sessionTransition('ASSIGNED', 'REJECT')).toEqual({ ok: true, next: 'REJECTED' });
    expect(sessionTransition('STARTED', 'TERMINATE')).toEqual({ ok: true, next: 'TERMINATED' });
    expect(sessionTransition('STARTED', 'CANCEL').ok).toBe(false); // STARTED 后不允许普通 cancel
  });

  it('terminal states accept no commands', () => {
    const commands: ServiceSessionCommand[] = [
      'ASSIGN',
      'ACKNOWLEDGE',
      'ARRIVE',
      'START',
      'EXTEND',
      'COMPLETE',
      'CANCEL',
      'REJECT',
      'TERMINATE',
      'CHANGE_TECHNICIAN',
      'CHANGE_SERVICE',
    ];
    for (const t of TERMINAL) {
      for (const cmd of commands) {
        const r = sessionTransition(t, cmd);
        expect(r.ok, `${t} --${cmd}-->`).toBe(false);
        if (!r.ok) expect(r.reason).toBe('NOT_TERMINAL');
      }
    }
  });

  it('rejects impossible pairs with NOT_ALLOWED (e.g. DRAFT cannot start)', () => {
    const r = sessionTransition('DRAFT', 'START');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('NOT_ALLOWED');
      expect(r.allowed).toContain('ASSIGN');
    }
  });

  it('assertSessionTransition throws MachineError 422 INVALID_STATE_TRANSITION', () => {
    expect(() => assertSessionTransition('COMPLETED', 'COMPLETE')).toThrowError(MachineError);
    try {
      assertSessionTransition('DRAFT', 'COMPLETE');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(MachineError);
      expect((e as MachineError).code).toBe('INVALID_STATE_TRANSITION');
      expect((e as MachineError).statusCode).toBe(422);
    }
  });

  it('isActiveSessionState mirrors one-active-session-per-technician invariant', () => {
    const active = SESSION_STATES.filter((s) => isActiveSessionState(s));
    expect(active).toEqual(
      expect.arrayContaining([
        'DRAFT',
        'ASSIGNED',
        'ACKNOWLEDGED',
        'ARRIVED',
        'STARTED',
        'ENDING_SOON',
      ]),
    );
    for (const t of TERMINAL) expect(isActiveSessionState(t)).toBe(false);
  });
});

describe('checkSessionGuard', () => {
  const base = {
    visitOpen: true,
    hasTechnician: true,
    technicianState: 'ASSIGNED',
    roomEligible: true,
  };

  it('requires an open visit for assign/acknowledge/arrive/start', () => {
    for (const cmd of ['ASSIGN', 'ACKNOWLEDGE', 'ARRIVE', 'START'] as const) {
      expect(checkSessionGuard(cmd, { ...base, visitOpen: false })).toBe('VISIT_NOT_OPEN');
      expect(checkSessionGuard(cmd, base)).toBeNull();
    }
  });

  it('requires a technician for acknowledge/arrive/start but not assign', () => {
    expect(checkSessionGuard('ASSIGN', { ...base, hasTechnician: false })).toBeNull();
    for (const cmd of ['ACKNOWLEDGE', 'ARRIVE', 'START'] as const) {
      expect(checkSessionGuard(cmd, { ...base, hasTechnician: false })).toBe('NO_TECHNICIAN');
    }
  });

  it('complete/terminate/extend/cancel have no guard failures (status machine covers them)', () => {
    for (const cmd of ['COMPLETE', 'TERMINATE', 'EXTEND', 'CANCEL', 'REJECT'] as const) {
      expect(checkSessionGuard(cmd, { ...base, visitOpen: false })).toBeNull();
    }
  });
});
