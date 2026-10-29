/**
 * ServiceSession state machine (spec §5.3).
 *
 * ```
 * DRAFT → assign → ASSIGNED → acknowledge → ACKNOWLEDGED → arrive → ARRIVED
 *   → start → STARTED → complete → COMPLETED
 *        ├─ extend → STARTED
 *        ├─ change-technician → ASSIGNED
 *        └─ nearing-end → ENDING_SOON
 * ```
 * 异常: DRAFT/ASSIGNED 可 CANCEL; ASSIGNED 可 REJECT; STARTED 之后只能
 * terminate (退款/调整走独立财务流程), 不允许普通 cancel。
 */
/** Domain-level machine violation (API maps code → HTTP status). */
export class MachineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'MachineError';
  }
}

export const SESSION_STATES = [
  'DRAFT',
  'ASSIGNED',
  'ACKNOWLEDGED',
  'ARRIVED',
  'STARTED',
  'ENDING_SOON',
  'COMPLETED',
  'CANCELLED',
  'REJECTED',
  'TERMINATED',
] as const;
export type ServiceSessionState = (typeof SESSION_STATES)[number];

export type ServiceSessionCommand =
  | 'ASSIGN'
  | 'ACKNOWLEDGE'
  | 'ARRIVE'
  | 'START'
  | 'EXTEND'
  | 'NEARING_END'
  | 'COMPLETE'
  | 'CHANGE_TECHNICIAN'
  | 'CHANGE_SERVICE'
  | 'CANCEL'
  | 'REJECT'
  | 'TERMINATE';

/** Session states that count as running (drives room “no running session” guards). */
export const RUNNING_SESSION_STATES: ReadonlySet<ServiceSessionState> = new Set([
  'DRAFT',
  'ASSIGNED',
  'ACKNOWLEDGED',
  'ARRIVED',
  'STARTED',
  'ENDING_SOON',
]);

/** One active session per technician invariant (partial unique index mirror). */
export function isActiveSessionState(status: ServiceSessionState): boolean {
  return RUNNING_SESSION_STATES.has(status);
}

const TRANSITIONS: Readonly<
  Record<ServiceSessionState, Partial<Record<ServiceSessionCommand, ServiceSessionState>>>
> = {
  DRAFT: { ASSIGN: 'ASSIGNED', CANCEL: 'CANCELLED', CHANGE_SERVICE: 'DRAFT' },
  ASSIGNED: {
    ACKNOWLEDGE: 'ACKNOWLEDGED',
    CANCEL: 'CANCELLED',
    REJECT: 'REJECTED',
    CHANGE_TECHNICIAN: 'ASSIGNED',
    CHANGE_SERVICE: 'ASSIGNED',
    TERMINATE: 'TERMINATED',
  },
  ACKNOWLEDGED: {
    ARRIVE: 'ARRIVED',
    CHANGE_TECHNICIAN: 'ASSIGNED',
    CHANGE_SERVICE: 'ACKNOWLEDGED',
    TERMINATE: 'TERMINATED',
  },
  ARRIVED: {
    START: 'STARTED',
    CHANGE_TECHNICIAN: 'ASSIGNED',
    CHANGE_SERVICE: 'ARRIVED',
    TERMINATE: 'TERMINATED',
  },
  STARTED: {
    EXTEND: 'STARTED',
    NEARING_END: 'ENDING_SOON',
    COMPLETE: 'COMPLETED',
    CHANGE_TECHNICIAN: 'ASSIGNED',
    CHANGE_SERVICE: 'STARTED',
    TERMINATE: 'TERMINATED',
  },
  ENDING_SOON: {
    EXTEND: 'ENDING_SOON',
    COMPLETE: 'COMPLETED',
    CHANGE_TECHNICIAN: 'ASSIGNED',
    CHANGE_SERVICE: 'ENDING_SOON',
    TERMINATE: 'TERMINATED',
  },
  COMPLETED: {},
  CANCELLED: {},
  REJECTED: {},
  TERMINATED: {},
};

export type SessionTransitionResult =
  | { ok: true; next: ServiceSessionState }
  | { ok: false; reason: 'NOT_TERMINAL' | 'NOT_ALLOWED'; allowed: ServiceSessionState[] };

export function sessionTransition(
  status: ServiceSessionState,
  command: ServiceSessionCommand,
): SessionTransitionResult {
  const terminal =
    status === 'COMPLETED' ||
    status === 'CANCELLED' ||
    status === 'REJECTED' ||
    status === 'TERMINATED';
  if (terminal) return { ok: false, reason: 'NOT_TERMINAL', allowed: [] };
  const next = TRANSITIONS[status]?.[command];
  if (!next) {
    return {
      ok: false,
      reason: 'NOT_ALLOWED',
      allowed: Object.keys(TRANSITIONS[status] ?? {}) as ServiceSessionState[],
    };
  }
  return { ok: true, next };
}

/** Throws MachineError INVALID_STATE_TRANSITION when the command is illegal. */
export function assertSessionTransition(
  status: ServiceSessionState,
  command: ServiceSessionCommand,
): ServiceSessionState {
  const r = sessionTransition(status, command);
  if (!r.ok) {
    throw new MachineError(
      'INVALID_STATE_TRANSITION',
      `service session in ${status} does not accept ${command}`,
      422,
      { status, command, allowed: r.allowed },
    );
  }
  return r.next;
}

/** Guard facts for session commands (server-verified, never client-asserted). */
export interface SessionCommandFacts {
  /** Linked visit exists and is OPEN for this store. */
  visitOpen: boolean;
  /** Session has a linked technician. */
  hasTechnician: boolean;
  /** Technician linked to the session is in the mirrored technician state. */
  technicianState: string;
  /** Room may enter IN_SERVICE (enabled, not occupied by maintenance etc.). */
  roomEligible: boolean;
  /** Extend minutes > 0 already validated at API edge. */
  extendMinutes?: number;
}

export type SessionGuardFailure =
  'VISIT_NOT_OPEN' | 'NO_TECHNICIAN' | 'TECHNICIAN_NOT_LINKED' | 'ROOM_NOT_ELIGIBLE';

export function checkSessionGuard(
  command: ServiceSessionCommand,
  facts: SessionCommandFacts,
): SessionGuardFailure | null {
  switch (command) {
    case 'ASSIGN':
    case 'CHANGE_TECHNICIAN':
      if (!facts.visitOpen) return 'VISIT_NOT_OPEN';
      return null;
    case 'ACKNOWLEDGE':
    case 'ARRIVE':
    case 'START':
      if (!facts.hasTechnician) return 'NO_TECHNICIAN';
      if (!facts.visitOpen) return 'VISIT_NOT_OPEN';
      return null;
    default:
      return null;
  }
}
