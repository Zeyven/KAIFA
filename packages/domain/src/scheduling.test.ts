import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULING_WEIGHTS,
  checkHardConstraints,
  recommend,
  scoreCandidate,
  type HardConstraintFacts,
  type ScoreableCandidate,
} from './scheduling';

const OK_FACTS: HardConstraintFacts = {
  sameStore: true,
  employmentActive: true,
  onShift: true,
  status: 'AVAILABLE',
  queueEnabled: true,
  locked: false,
  hasActiveService: false,
  hasRequiredSkill: true,
  genderMatches: true,
  reservationConflict: false,
};

const cand = (
  over: Partial<ScoreableCandidate> & { technicianNo: string; queuePosition: number },
): ScoreableCandidate => ({
  technicianId: `id-${over.technicianNo}`,
  idleMinutes: 0,
  servicesToday: 0,
  compensationDelta: 0,
  skillMatch: 1,
  preference: 0,
  reservationApproaching: 0,
  overtimeRisk: 0,
  ...over,
});

const full = (
  over: Partial<ScoreableCandidate> & { technicianNo: string; queuePosition: number },
  facts: Partial<HardConstraintFacts> = {},
) => ({ ...cand(over), facts: { ...OK_FACTS, ...facts } });

describe('scheduling hard constraints (spec §6.2)', () => {
  it('passes only fully-eligible candidates', () => {
    expect(checkHardConstraints(OK_FACTS)).toEqual({ ok: true });
  });

  it('each violated constraint maps to a machine-readable exclusion reason', () => {
    const cases: Array<[Partial<HardConstraintFacts>, string]> = [
      [{ sameStore: false }, 'NOT_SAME_STORE'],
      [{ employmentActive: false }, 'EMPLOYMENT_NOT_ACTIVE'],
      [{ onShift: false }, 'NO_ACTIVE_SHIFT'],
      [{ status: 'SERVING' }, 'STATUS_NOT_AVAILABLE'],
      [{ status: 'LOCKED', locked: true }, 'LOCKED'],
      [{ queueEnabled: false }, 'QUEUE_DISABLED'],
      [{ hasActiveService: true }, 'ACTIVE_SERVICE'],
      [{ hasRequiredSkill: false }, 'SKILL_MISSING'],
      [{ genderMatches: false }, 'GENDER_CONSTRAINT'],
      [{ reservationConflict: true }, 'FUTURE_RESERVATION_CONFLICT'],
    ];
    for (const [patch, reason] of cases) {
      const res = checkHardConstraints({ ...OK_FACTS, ...patch });
      expect(res, reason).toEqual({ ok: false, reason });
    }
  });
});

describe('scheduling soft score (spec §6.3)', () => {
  it('queue position dominates (weight 1000, harmonic rank)', () => {
    const first = scoreCandidate(cand({ technicianNo: 'A', queuePosition: 1 }));
    const second = scoreCandidate(cand({ technicianNo: 'B', queuePosition: 2 }));
    expect(first).toBeGreaterThan(second);
    // all other factors equal → the gap IS the queue-position factor
    expect(first - second).toBeCloseTo(DEFAULT_SCHEDULING_WEIGHTS.queuePosition * (1 - 1 / 2), 6);
    expect(first).toBeGreaterThanOrEqual(DEFAULT_SCHEDULING_WEIGHTS.queuePosition);
  });

  it('idle duration, fairness, compensation, skill, preference each add their weight', () => {
    const base = scoreCandidate(cand({ technicianNo: 'A', queuePosition: 1 }));
    const idle = scoreCandidate(cand({ technicianNo: 'A', queuePosition: 1, idleMinutes: 60 }));
    expect(idle - base).toBe(DEFAULT_SCHEDULING_WEIGHTS.idleDuration);

    const busy = scoreCandidate(cand({ technicianNo: 'A', queuePosition: 1, servicesToday: 1 }));
    expect(base - busy).toBeCloseTo(DEFAULT_SCHEDULING_WEIGHTS.fairness * 0.5, 6);

    const comp = scoreCandidate(
      cand({ technicianNo: 'A', queuePosition: 1, compensationDelta: 1 }),
    );
    expect(comp - base).toBe(DEFAULT_SCHEDULING_WEIGHTS.compensation);

    const pref = scoreCandidate(cand({ technicianNo: 'A', queuePosition: 1, preference: 1 }));
    expect(pref - base).toBe(DEFAULT_SCHEDULING_WEIGHTS.preference);
  });

  it('penalties subtract (reservation approaching, overtime)', () => {
    const base = scoreCandidate(cand({ technicianNo: 'A', queuePosition: 1 }));
    const near = scoreCandidate(
      cand({ technicianNo: 'A', queuePosition: 1, reservationApproaching: 1 }),
    );
    expect(base - near).toBe(Math.abs(DEFAULT_SCHEDULING_WEIGHTS.futureReservation));
    const tired = scoreCandidate(cand({ technicianNo: 'A', queuePosition: 1, overtimeRisk: 1 }));
    expect(base - tired).toBe(Math.abs(DEFAULT_SCHEDULING_WEIGHTS.overtime));
  });
});

describe('recommend (spec §6.5 explainability)', () => {
  it('selects top eligible scorer and reports every exclusion with a reason', () => {
    const result = recommend([
      full({ technicianNo: '082', queuePosition: 1, idleMinutes: 48 }),
      full({ technicianNo: '091', queuePosition: 2 }, { reservationConflict: true }),
      full({ technicianNo: '077', queuePosition: 3 }, { status: 'SERVING' }),
    ]);
    expect(result.selected).toMatchObject({
      technicianNo: '082',
      queuePosition: 1,
      idleMinutes: 48,
    });
    expect(typeof result.selected!.score).toBe('number');
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        { technicianId: 'id-091', technicianNo: '091', reason: 'FUTURE_RESERVATION_CONFLICT' },
        { technicianId: 'id-077', technicianNo: '077', reason: 'STATUS_NOT_AVAILABLE' },
      ]),
    );
  });

  it('eligible-but-lower-ranked candidates are excluded from `selected` but not flagged', () => {
    const result = recommend([
      full({ technicianNo: '082', queuePosition: 1 }),
      full({ technicianNo: '091', queuePosition: 2 }),
    ]);
    expect(result.selected?.technicianNo).toBe('082');
    expect(result.excluded).toHaveLength(0);
  });

  it('no eligible candidate → no selection (never a fabricated pick)', () => {
    const result = recommend([
      full({ technicianNo: '091', queuePosition: 1 }, { status: 'BREAK' }),
    ]);
    expect(result.selected).toBeUndefined();
    expect(result.excluded[0]?.reason).toBe('STATUS_NOT_AVAILABLE');
  });

  it('weights are inputs — changing them can flip the selection', () => {
    const heavy = { ...DEFAULT_SCHEDULING_WEIGHTS, queuePosition: 0, compensation: 10_000 };
    const result = recommend(
      [
        full({ technicianNo: '082', queuePosition: 1 }),
        full({ technicianNo: '091', queuePosition: 5, compensationDelta: 1 }),
      ],
      heavy,
    );
    expect(result.selected?.technicianNo).toBe('091');
  });
});
