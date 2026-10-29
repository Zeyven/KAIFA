/**
 * 钟房 model (spec §9.3) — pure derivation from three live reads:
 * GET /technicians · GET /scheduling/queue · GET /service-sessions?today=1.
 * No figure is invented: anything without a live source stays null.
 */
import type { TechnicianRow } from './api';

export interface QueueItem {
  id: string;
  technician_id: string;
  technician_no: string;
  position_key: string;
  priority_delta: number;
  effective_key: string;
  eligible_since: string;
  state: 'ACTIVE' | 'ASSIGNED' | 'REMOVED';
  technician_status: string;
}

export interface SessionItem {
  id: string;
  technician_id: string | null;
  assignment_type: string;
  status: string;
}

export interface ClockRow {
  technicianId: string;
  technicianNo: string;
  stateLabel: string;
  status: string;
  /** 1-based queue position when ACTIVE in the rotation, else null. */
  position: number | null;
  /** Sessions created on the store business day (server-filtered today). */
  today: number;
  /** Of today's sessions, how many were REQUESTED (点钟). */
  requests: number;
  /** Idle minutes from the queue's eligible_since (null when not queued). */
  idleMinutes: number | null;
  queueEntryId: string | null;
  queueState: QueueItem['state'] | null;
  priorityDelta: number;
}

export function idleMinutesFrom(eligibleSince: string, now: Date): number | null {
  const t = Date.parse(eligibleSince);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 60_000));
}

export function clockBoardRows(
  techs: TechnicianRow[],
  queue: QueueItem[],
  todaySessions: SessionItem[],
  now: Date,
  labels: Record<string, string>,
): ClockRow[] {
  const active = queue
    .filter((q) => q.state === 'ACTIVE')
    .sort((a, b) => Number(a.effective_key) - Number(b.effective_key));
  const byTechQueue = new Map(queue.map((q) => [q.technician_id, q]));

  return techs.map((t) => {
    const q = byTechQueue.get(t.id) ?? null;
    const position = q && q.state === 'ACTIVE' ? active.findIndex((a) => a.id === q.id) + 1 : null;
    const sessions = todaySessions.filter((s) => s.technician_id === t.id);
    return {
      technicianId: t.id,
      technicianNo: t.technician_no,
      stateLabel: labels[t.status] ?? t.status,
      status: t.status,
      position: position !== null && position > 0 ? position : null,
      today: sessions.length,
      requests: sessions.filter((s) => s.assignment_type === 'REQUESTED').length,
      idleMinutes: q && q.state === 'ACTIVE' ? idleMinutesFrom(q.eligible_since, now) : null,
      queueEntryId: q?.id ?? null,
      queueState: q?.state ?? null,
      priorityDelta: q ? Number(q.priority_delta) : 0,
    };
  });
}

export interface RecommendSelected {
  technicianId: string;
  technicianNo: string;
  queuePosition: number;
  idleMinutes: number;
  score: number;
}

export interface RecommendExcluded {
  technicianId: string;
  technicianNo: string;
  reason: string;
}

export interface RecommendResult {
  selected?: RecommendSelected;
  excluded: RecommendExcluded[];
  weights: Record<string, number>;
  policy: string;
}
