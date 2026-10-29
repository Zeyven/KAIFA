import { describe, expect, it } from 'vitest';
import { clockBoardRows, idleMinutesFrom, type QueueItem, type SessionItem } from './clock-board';
import type { TechnicianRow } from './api';

const NOW = new Date('2026-10-29T12:00:00Z');
const LABELS = { AVAILABLE: '空闲', SERVING: '服务中', OFF_DUTY: '未上班' } as const;

const tech = (id: string, no: string, status: string): TechnicianRow => ({
  id,
  technician_no: no,
  status,
});

const q = (over: Partial<QueueItem> & Pick<QueueItem, 'id' | 'technician_id'>): QueueItem => ({
  technician_no: 'T1',
  position_key: '1000',
  priority_delta: 0,
  effective_key: '1000',
  eligible_since: '2026-10-29T11:30:00Z',
  state: 'ACTIVE',
  technician_status: 'AVAILABLE',
  ...over,
});

const sess = (
  over: Partial<SessionItem> & Pick<SessionItem, 'id' | 'technician_id'>,
): SessionItem => ({
  assignment_type: 'ROTATION',
  status: 'COMPLETED',
  ...over,
});

describe('clockBoardRows (§9.3 columns)', () => {
  const techs = [
    tech('a', '082', 'AVAILABLE'),
    tech('b', '119', 'SERVING'),
    tech('c', '036', 'OFF_DUTY'),
  ];
  const queue: QueueItem[] = [
    q({ id: 'e2', technician_id: 'b', state: 'ASSIGNED', effective_key: '500' }),
    q({ id: 'e1', technician_id: 'a', effective_key: '1000' }),
  ];
  const sessions: SessionItem[] = [
    sess({ id: 's1', technician_id: 'a' }),
    sess({ id: 's2', technician_id: 'a', assignment_type: 'REQUESTED' }),
    sess({ id: 's3', technician_id: 'b' }),
    sess({ id: 's4', technician_id: 'c' }),
  ];

  it('derives 排位/今日/点钟/空闲/状态 from live reads', () => {
    const rows = clockBoardRows(techs, queue, sessions, NOW, LABELS);
    const byNo = new Map(rows.map((r) => [r.technicianNo, r]));

    const r082 = byNo.get('082')!;
    expect(r082.position).toBe(1); // only ACTIVE entries are ranked
    expect(r082.today).toBe(2);
    expect(r082.requests).toBe(1);
    expect(r082.idleMinutes).toBe(30);
    expect(r082.stateLabel).toBe('空闲');

    const r119 = byNo.get('119')!;
    expect(r119.position).toBeNull(); // ASSIGNED entries are not in rotation
    expect(r119.today).toBe(1);
    expect(r119.idleMinutes).toBeNull();
    expect(r119.stateLabel).toBe('服务中');

    const r036 = byNo.get('036')!;
    expect(r036.position).toBeNull();
    expect(r036.queueEntryId).toBeNull();
    expect(r036.stateLabel).toBe('未上班');
  });

  it('sorts ACTIVE positions by effective key (compensation reorders)', () => {
    const compensated = [
      q({ id: 'x', technician_id: 'a', effective_key: '1998', priority_delta: 2 }),
      q({ id: 'y', technician_id: 'c', state: 'ACTIVE', effective_key: '1000' }),
    ];
    // effective key order: y (1000) ranks before x (1998 = +2 compensation was
    // already baked into priority_delta when effective_key was computed)
    const rows = clockBoardRows(
      [tech('a', '082', 'AVAILABLE'), tech('c', '036', 'AVAILABLE')],
      compensated,
      [],
      NOW,
      LABELS,
    );
    expect(rows.find((r) => r.technicianNo === '082')?.position).toBe(2);
    expect(rows.find((r) => r.technicianNo === '036')?.position).toBe(1);
  });
});

describe('idleMinutesFrom', () => {
  it('floors to whole minutes and clamps at zero', () => {
    expect(idleMinutesFrom('2026-10-29T11:59:30Z', NOW)).toBe(0);
    expect(idleMinutesFrom('2026-10-29T11:30:10Z', NOW)).toBe(29);
    expect(idleMinutesFrom('not-a-date', NOW)).toBeNull();
  });
});
