/**
 * Technician state machine — Master Prompt §5.2 (normative transition table).
 * Pure: guards arrive as an explicit object; the API layer revalidates guards
 * INSIDE the command transaction (this module never does I/O).
 *
 * Spec note ("服务完成后不得无条件切回 AVAILABLE"): COMPLETE_SERVICE is modeled
 * as a RECOMPUTE, not a fixed edge — caller passes current shift/appointment
 * facts and the machine picks the target state.
 */

export type TechnicianState =
  | 'OFF_DUTY'
  | 'AVAILABLE'
  | 'ASSIGNED'
  | 'GOING_TO_ROOM'
  | 'WAITING_START'
  | 'SERVING'
  | 'BREAK'
  | 'LOCKED';

export type TechnicianCommand =
  | 'CLOCK_IN'
  | 'ASSIGN'
  | 'ACK'
  | 'ARRIVE'
  | 'START_SERVICE'
  | 'COMPLETE_SERVICE'
  | 'BREAK_START'
  | 'BREAK_END'
  | 'LOCK'
  | 'UNLOCK'
  | 'CLOCK_OUT';

export interface TechnicianTransitionGuards {
  /** Employee has a current/valid shift (CLOCK_IN). */
  onShift?: boolean;
  /** Passed §6.2 hard constraints for assignment (ASSIGN). */
  assignable?: boolean;
  /** A service session is running (START_SERVICE). */
  sessionActive?: boolean;
}

export type TechnicianTransitionFailure =
  'INVALID_STATE_TRANSITION' | 'TECHNICIAN_NOT_AVAILABLE' | 'TECHNICIAN_LOCKED' | 'FORBIDDEN';

export type TechnicianTransitionResult =
  | { ok: true; next: TechnicianState }
  | { ok: false; code: TechnicianTransitionFailure; detail: string };

/** Spec §5.2 table. Every non-listed (state, command) pair is INVALID_STATE_TRANSITION. */
const TABLE: Partial<Record<TechnicianState, Partial<Record<TechnicianCommand, TechnicianState>>>> =
  {
    OFF_DUTY: {
      CLOCK_IN: 'AVAILABLE',
    },
    AVAILABLE: {
      ASSIGN: 'ASSIGNED',
      BREAK_START: 'BREAK',
      LOCK: 'LOCKED',
      CLOCK_OUT: 'OFF_DUTY',
    },
    ASSIGNED: {
      ACK: 'GOING_TO_ROOM',
    },
    GOING_TO_ROOM: {
      ARRIVE: 'WAITING_START',
    },
    WAITING_START: {
      START_SERVICE: 'SERVING',
    },
    SERVING: {
      COMPLETE_SERVICE: 'AVAILABLE', // replaced by recompute below
    },
    BREAK: {
      BREAK_END: 'AVAILABLE',
      // spec "eligible | CLOCK_OUT" — break counts as eligible (BUSINESS POLICY)
      CLOCK_OUT: 'OFF_DUTY',
    },
    LOCKED: {
      UNLOCK: 'AVAILABLE',
      CLOCK_OUT: 'OFF_DUTY',
    },
  };

/** States from which clock-out is legal ("eligible" in §5.2 — BUSINESS POLICY:
 *  any non-serving work state; ASSIGNED/GOING/WAITING/SERVING must finish first). */
const CLOCK_OUT_ELIGIBLE: ReadonlySet<TechnicianState> = new Set([
  'OFF_DUTY',
  'AVAILABLE',
  'BREAK',
  'LOCKED',
]);

export const TECHNICIAN_STATES: readonly TechnicianState[] = [
  'OFF_DUTY',
  'AVAILABLE',
  'ASSIGNED',
  'GOING_TO_ROOM',
  'WAITING_START',
  'SERVING',
  'BREAK',
  'LOCKED',
] as const;

export const TECHNICIAN_COMMANDS: readonly TechnicianCommand[] = [
  'CLOCK_IN',
  'ASSIGN',
  'ACK',
  'ARRIVE',
  'START_SERVICE',
  'COMPLETE_SERVICE',
  'BREAK_START',
  'BREAK_END',
  'LOCK',
  'UNLOCK',
  'CLOCK_OUT',
] as const;

/** Target after a completed service: recompute, never unconditional AVAILABLE. */
export function completeServiceTarget(shiftEnded: boolean): TechnicianState {
  return shiftEnded ? 'OFF_DUTY' : 'AVAILABLE';
}

export function canTransitionTechnician(
  state: TechnicianState,
  command: TechnicianCommand,
  guards: TechnicianTransitionGuards = {},
): TechnicianTransitionResult {
  // locked technicians report TECHNICIAN_LOCKED (richer than structural miss)
  if (command === 'ASSIGN' && state === 'LOCKED') {
    return { ok: false, code: 'TECHNICIAN_LOCKED', detail: 'technician is locked' };
  }

  if (command === 'CLOCK_OUT') {
    if (!CLOCK_OUT_ELIGIBLE.has(state)) {
      return {
        ok: false,
        code: 'INVALID_STATE_TRANSITION',
        detail: `busy technician cannot clock out: ${state}`,
      };
    }
    return { ok: true, next: 'OFF_DUTY' };
  }

  if (command === 'COMPLETE_SERVICE') {
    if (state !== 'SERVING') {
      return {
        ok: false,
        code: 'INVALID_STATE_TRANSITION',
        detail: `not serving: ${state}`,
      };
    }
    // recompute happens in the command service (needs shift facts); default
    // AVAILABLE branch here — service passes shiftEnded to completeServiceTarget
    return { ok: true, next: 'AVAILABLE' };
  }

  const next = TABLE[state]?.[command];
  if (next === undefined) {
    return {
      ok: false,
      code: 'INVALID_STATE_TRANSITION',
      detail: `${state} --${command}--> ∅`,
    };
  }

  // guards (spec §5.2 / §6.2)
  if (command === 'CLOCK_IN' && guards.onShift === false) {
    return { ok: false, code: 'FORBIDDEN', detail: 'no active shift' };
  }
  if (command === 'ASSIGN') {
    if (guards.assignable === false) {
      return {
        ok: false,
        code: 'TECHNICIAN_NOT_AVAILABLE',
        detail: 'hard constraints not satisfied',
      };
    }
  }
  if (command === 'START_SERVICE' && guards.sessionActive === false) {
    return {
      ok: false,
      code: 'INVALID_STATE_TRANSITION',
      detail: 'no active session to start',
    };
  }

  return { ok: true, next };
}
