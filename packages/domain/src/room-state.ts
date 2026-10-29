/**
 * Room state machine — Master Prompt §5.1 (normative transition table).
 * Pure: guards arrive as an explicit object; the API layer revalidates guards
 * INSIDE the command transaction (this module never does I/O).
 */

export type RoomOperationalState =
  | 'VACANT_CLEAN'
  | 'RESERVED'
  | 'OCCUPIED_WAITING_SERVICE'
  | 'IN_SERVICE'
  | 'WAITING_CHECKOUT'
  | 'DIRTY'
  | 'CLEANING'
  | 'MAINTENANCE'
  | 'DISABLED';

export type RoomCommand =
  | 'OPEN_VISIT'
  | 'GUEST_ARRIVED'
  | 'SERVICE_STARTED'
  | 'ALL_SERVICES_COMPLETED'
  | 'ORDER_PAID'
  | 'CLEANING_STARTED'
  | 'CLEANING_COMPLETED'
  | 'MAINTENANCE_START'
  | 'MAINTENANCE_END'
  | 'DISABLE'
  | 'ENABLE'
  /** Visit relocated to another room (POST /rooms/:id/move — spec §7.3). */
  | 'VISIT_MOVED';

export interface RoomTransitionGuards {
  /** An active visit row exists for this room (OPEN/GUEST_ARRIVED). */
  hasActiveVisit?: boolean;
  /** At least one service session is active (SERVICE_STARTED). */
  hasActiveSession?: boolean;
  /** No running session remains (ALL_SERVICES_COMPLETED). */
  hasRunningSession?: boolean;
  /** Order balance settled to zero (ORDER_PAID). */
  balanceSettled?: boolean;
  /** Actor holds room.clean permission (server-side, pre-checked). */
  cleanerAuthorized?: boolean;
  /** Cleaning checklist confirmed true (CLEANING_COMPLETED). */
  checklistPassed?: boolean;
  /** Maintenance inspection confirmed (MAINTENANCE_END). */
  inspectionPassed?: boolean;
}

export type RoomTransitionFailure =
  'INVALID_STATE_TRANSITION' | 'ROOM_NOT_ELIGIBLE' | 'ROOM_OCCUPIED';

export type RoomTransitionResult =
  | { ok: true; next: RoomOperationalState }
  | { ok: false; code: RoomTransitionFailure; detail: string };

const OCCUPIED_STATES: ReadonlySet<RoomOperationalState> = new Set([
  'OCCUPIED_WAITING_SERVICE',
  'IN_SERVICE',
  'WAITING_CHECKOUT',
]);

/** Spec §5.1 table. Every non-listed (state, command) pair is INVALID_STATE_TRANSITION. */
const TABLE: Partial<
  Record<RoomOperationalState, Partial<Record<RoomCommand, RoomOperationalState>>>
> = {
  VACANT_CLEAN: {
    OPEN_VISIT: 'OCCUPIED_WAITING_SERVICE',
    MAINTENANCE_START: 'MAINTENANCE',
    DISABLE: 'DISABLED',
  },
  RESERVED: {
    GUEST_ARRIVED: 'OCCUPIED_WAITING_SERVICE',
    VISIT_MOVED: 'VACANT_CLEAN', // reservation vacated without guest arrival
    MAINTENANCE_START: 'MAINTENANCE',
  },
  OCCUPIED_WAITING_SERVICE: {
    SERVICE_STARTED: 'IN_SERVICE',
    VISIT_MOVED: 'DIRTY', // spec gap-fill: vacated room must be cleaned (BUSINESS POLICY)
    // goods-only visits (no session ever ran) — paid bill vacates like any
    // completed visit. BUSINESS POLICY — REQUIRES PILOT VALIDATION (spec §5.1
    // only tabulates ORDER_PAID from WAITING_CHECKOUT).
    ORDER_PAID: 'DIRTY',
    MAINTENANCE_START: 'MAINTENANCE', // occupied-family must not — rejected by guard below
  },
  IN_SERVICE: {
    ALL_SERVICES_COMPLETED: 'WAITING_CHECKOUT',
    MAINTENANCE_START: 'MAINTENANCE', // occupied-family — rejected by non-occupied guard
  },
  WAITING_CHECKOUT: {
    ORDER_PAID: 'DIRTY',
    MAINTENANCE_START: 'MAINTENANCE', // occupied-family — rejected by non-occupied guard
  },
  DIRTY: {
    CLEANING_STARTED: 'CLEANING',
    MAINTENANCE_START: 'MAINTENANCE',
  },
  CLEANING: {
    CLEANING_COMPLETED: 'VACANT_CLEAN',
    MAINTENANCE_START: 'MAINTENANCE', // non-occupied per spec §5.1
  },
  MAINTENANCE: {
    MAINTENANCE_END: 'VACANT_CLEAN',
  },
  DISABLED: {
    ENABLE: 'VACANT_CLEAN',
  },
};

/** MAINTENANCE_START is only allowed from NON-occupied states (spec §5.1 "non-occupied"). */
const MAINTENANCE_ALLOWED_FROM: ReadonlySet<RoomOperationalState> = new Set([
  'VACANT_CLEAN',
  'RESERVED',
  'DIRTY',
  'CLEANING',
]);

export function canTransition(
  state: RoomOperationalState,
  command: RoomCommand,
  guards: RoomTransitionGuards = {},
): RoomTransitionResult {
  const next = TABLE[state]?.[command];
  if (next === undefined) {
    return { ok: false, code: 'INVALID_STATE_TRANSITION', detail: `${state} --${command}--> ∅` };
  }

  // Cross-cutting occupation guard (spec: IN_SERVICE → VACANT_CLEAN etc. forbidden)
  if (command === 'MAINTENANCE_START') {
    if (!MAINTENANCE_ALLOWED_FROM.has(state)) {
      return {
        ok: false,
        code: 'ROOM_NOT_ELIGIBLE',
        detail: `occupied room cannot enter maintenance: ${state}`,
      };
    }
  }
  if (command === 'MAINTENANCE_END' && state !== 'MAINTENANCE') {
    return { ok: false, code: 'INVALID_STATE_TRANSITION', detail: `not in maintenance: ${state}` };
  }

  switch (command) {
    case 'OPEN_VISIT':
    case 'GUEST_ARRIVED':
      if (OCCUPIED_STATES.has(state)) {
        return { ok: false, code: 'ROOM_OCCUPIED', detail: state };
      }
      if (guards.hasActiveVisit === false) {
        return { ok: false, code: 'ROOM_NOT_ELIGIBLE', detail: 'missing active visit' };
      }
      return { ok: true, next };
    case 'SERVICE_STARTED':
      if (guards.hasActiveSession !== true) {
        return { ok: false, code: 'ROOM_NOT_ELIGIBLE', detail: 'no active service session' };
      }
      return { ok: true, next };
    case 'ALL_SERVICES_COMPLETED':
      if (guards.hasRunningSession === true) {
        return { ok: false, code: 'ROOM_NOT_ELIGIBLE', detail: 'sessions still running' };
      }
      return { ok: true, next };
    case 'ORDER_PAID':
      if (guards.balanceSettled !== true) {
        return { ok: false, code: 'ROOM_NOT_ELIGIBLE', detail: 'balance not settled' };
      }
      return { ok: true, next };
    case 'CLEANING_STARTED':
      if (guards.cleanerAuthorized !== true) {
        return { ok: false, code: 'ROOM_NOT_ELIGIBLE', detail: 'cleaner not authorized' };
      }
      return { ok: true, next };
    case 'CLEANING_COMPLETED':
      if (guards.checklistPassed !== true) {
        return { ok: false, code: 'ROOM_NOT_ELIGIBLE', detail: 'checklist not passed' };
      }
      return { ok: true, next };
    case 'MAINTENANCE_END':
      if (guards.inspectionPassed !== true) {
        return { ok: false, code: 'ROOM_NOT_ELIGIBLE', detail: 'inspection not passed' };
      }
      return { ok: true, next };
    default:
      return { ok: true, next };
  }
}

/** Apply with guard evaluation — returns the post-transition state or throws nothing. */
export function transitionRoom(
  state: RoomOperationalState,
  command: RoomCommand,
  guards: RoomTransitionGuards = {},
): RoomTransitionResult {
  return canTransition(state, command, guards);
}

export const ROOM_STATES: readonly RoomOperationalState[] = [
  'VACANT_CLEAN',
  'RESERVED',
  'OCCUPIED_WAITING_SERVICE',
  'IN_SERVICE',
  'WAITING_CHECKOUT',
  'DIRTY',
  'CLEANING',
  'MAINTENANCE',
  'DISABLED',
];

export const ROOM_COMMANDS: readonly RoomCommand[] = [
  'OPEN_VISIT',
  'GUEST_ARRIVED',
  'SERVICE_STARTED',
  'ALL_SERVICES_COMPLETED',
  'ORDER_PAID',
  'CLEANING_STARTED',
  'CLEANING_COMPLETED',
  'MAINTENANCE_START',
  'MAINTENANCE_END',
  'DISABLE',
  'ENABLE',
  'VISIT_MOVED',
];
