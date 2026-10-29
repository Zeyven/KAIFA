/**
 * Scheduling algorithm — Master Prompt §6 (hard constraints + soft score +
 * explainability). Pure and deterministic: the API layer loads rows, locks the
 * winner FOR UPDATE (§6.4), revalidates, then persists (this module never I/O).
 *
 * ── BUSINESS POLICY — REQUIRES PILOT VALIDATION ─────────────────────────────
 * Every weight below is a DEVELOPMENT DEFAULT taken from the spec's "初始建议
 * weights" table; the exact functional form of each factor (harmonic rank,
 * idle saturation, fairness inverse) is likewise a dev default. All numbers
 * must be configurable per store before pilot.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface SchedulingWeights {
  queuePosition: number;
  idleDuration: number;
  fairness: number;
  compensation: number;
  skill: number;
  preference: number;
  futureReservation: number;
  overtime: number;
}

/** Spec §6.3 table + documented dev defaults for the two unnamed rows. */
export const DEFAULT_SCHEDULING_WEIGHTS: Readonly<SchedulingWeights> = {
  queuePosition: 1000,
  idleDuration: 100,
  fairness: 50, // dev default — spec names fairness_score but gives no weight
  compensation: 300,
  skill: 30,
  preference: 20, // dev default — spec names preference but gives no weight
  futureReservation: -500,
  overtime: -100,
};

export type HardConstraintReason =
  | 'NOT_SAME_STORE'
  | 'EMPLOYMENT_NOT_ACTIVE'
  | 'NO_ACTIVE_SHIFT'
  | 'STATUS_NOT_AVAILABLE'
  | 'QUEUE_DISABLED'
  | 'LOCKED'
  | 'ACTIVE_SERVICE'
  | 'SKILL_MISSING'
  | 'GENDER_CONSTRAINT'
  | 'FUTURE_RESERVATION_CONFLICT';

export interface HardConstraintFacts {
  sameStore: boolean;
  employmentActive: boolean;
  onShift: boolean;
  status: string;
  queueEnabled: boolean;
  locked: boolean;
  hasActiveService: boolean;
  hasRequiredSkill: boolean;
  genderMatches: boolean;
  reservationConflict: boolean;
}

export interface ScoreableCandidate {
  technicianId: string;
  technicianNo: string;
  /** 1-based position in effective queue order. */
  queuePosition: number;
  idleMinutes: number;
  /** Services already completed today (fairness input). */
  servicesToday: number;
  /** Positive = compensation boost (priority_delta semantics). */
  compensationDelta: number;
  /** 0..1 — matched skill level / max level. */
  skillMatch: number;
  /** 0|1 — explicit customer/staff preference. */
  preference: number;
  /** 0|1 — reservation approaching (soft penalty; conflicts are hard). */
  reservationApproaching: number;
  /** 0|1 — overtime/fatigue risk. */
  overtimeRisk: number;
}

export type RecommendExclusion = {
  technicianId?: string;
  technicianNo: string;
  reason: HardConstraintReason;
};

export interface RecommendResult {
  selected?: {
    technicianId: string;
    technicianNo: string;
    queuePosition: number;
    idleMinutes: number;
    score: number;
  };
  excluded: RecommendExclusion[];
}

/** §6.2 — any failure excludes the candidate outright (never scored). */
export function checkHardConstraints(
  facts: HardConstraintFacts,
): { ok: true } | { ok: false; reason: HardConstraintReason } {
  if (!facts.sameStore) return { ok: false, reason: 'NOT_SAME_STORE' };
  if (!facts.employmentActive) return { ok: false, reason: 'EMPLOYMENT_NOT_ACTIVE' };
  if (!facts.onShift) return { ok: false, reason: 'NO_ACTIVE_SHIFT' };
  if (facts.status !== 'AVAILABLE') {
    if (facts.locked) return { ok: false, reason: 'LOCKED' };
    return { ok: false, reason: 'STATUS_NOT_AVAILABLE' };
  }
  if (!facts.queueEnabled) return { ok: false, reason: 'QUEUE_DISABLED' };
  if (facts.locked) return { ok: false, reason: 'LOCKED' };
  if (facts.hasActiveService) return { ok: false, reason: 'ACTIVE_SERVICE' };
  if (!facts.hasRequiredSkill) return { ok: false, reason: 'SKILL_MISSING' };
  if (!facts.genderMatches) return { ok: false, reason: 'GENDER_CONSTRAINT' };
  if (facts.reservationConflict) return { ok: false, reason: 'FUTURE_RESERVATION_CONFLICT' };
  return { ok: true };
}

/** §6.3 score — higher wins. Documented dev-default functional forms: */
export function scoreCandidate(
  c: ScoreableCandidate,
  weights: SchedulingWeights = DEFAULT_SCHEDULING_WEIGHTS,
): number {
  const queuePositionScore = weights.queuePosition / Math.max(c.queuePosition, 1);
  const idleDurationScore = weights.idleDuration * Math.min(Math.max(c.idleMinutes, 0) / 60, 4); // saturates at 4h
  const fairnessScore = weights.fairness * (1 / (Math.max(c.servicesToday, 0) + 1));
  const compensationScore = weights.compensation * c.compensationDelta;
  const skillScore = weights.skill * clamp01(c.skillMatch);
  const preferenceScore = weights.preference * (c.preference > 0 ? 1 : 0);
  const reservationScore = weights.futureReservation * (c.reservationApproaching > 0 ? 1 : 0);
  const overtimeScore = weights.overtime * (c.overtimeRisk > 0 ? 1 : 0);
  return (
    queuePositionScore +
    idleDurationScore +
    fairnessScore +
    compensationScore +
    skillScore +
    preferenceScore +
    reservationScore +
    overtimeScore
  );
}

function clamp01(n: number): number {
  return Math.min(Math.max(n, 0), 1);
}

/**
 * §6.5 explainability: pick the top scorer among hard-eligible candidates and
 * report every exclusion with its machine-readable reason.
 */
export function recommend(
  candidates: Array<ScoreableCandidate & { facts: HardConstraintFacts }>,
  weights: SchedulingWeights = DEFAULT_SCHEDULING_WEIGHTS,
): RecommendResult {
  const excluded: RecommendExclusion[] = [];
  let best: (ScoreableCandidate & { score: number }) | undefined;

  // stable input order; strict > keeps first-wins on exact ties (deterministic)
  for (const cand of candidates) {
    const gate = checkHardConstraints(cand.facts);
    if (!gate.ok) {
      excluded.push({
        technicianId: cand.technicianId,
        technicianNo: cand.technicianNo,
        reason: gate.reason,
      });
      continue;
    }
    const score = scoreCandidate(cand, weights);
    if (!best || score > best.score) best = { ...cand, score };
  }

  if (!best) return { excluded };
  return {
    selected: {
      technicianId: best.technicianId,
      technicianNo: best.technicianNo,
      queuePosition: best.queuePosition,
      idleMinutes: best.idleMinutes,
      score: best.score,
    },
    excluded,
  };
}
