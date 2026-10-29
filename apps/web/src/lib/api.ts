/**
 * FrontDesk API client (Phase 07) — relative /api/v1 paths, proxied by the
 * Next server (next.config.mjs rewrites) so the browser never needs the API
 * host. The frozen response envelope is unwrapped here: success → T,
 * failure → ApiClientError { code, message } for UI branching (§7.1).
 */

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface StoreRef {
  id: string;
  code: string;
  name: string;
}

export interface SessionState {
  token: string;
  storeId: string;
  stores: StoreRef[];
  username: string;
}

const KEY = 'lanxu.session';

export function loadSession(): SessionState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionState;
    if (!parsed.token || !parsed.storeId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(s: SessionState): void {
  window.localStorage.setItem(KEY, JSON.stringify(s));
}

export function clearSession(): void {
  window.localStorage.removeItem(KEY);
}

export interface ApiOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  session?: SessionState | null;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.session?.token) {
    headers.authorization = `Bearer ${opts.session.token}`;
    headers['x-store-id'] = opts.session.storeId;
  }
  const res = await fetch(`/api/v1${path}`, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  let envelope: { data?: T; error?: { code: string; message: string } };
  try {
    envelope = (await res.json()) as typeof envelope;
  } catch {
    throw new ApiClientError('INTERNAL_ERROR', `Bad response (${res.status})`, res.status);
  }
  if (!res.ok || envelope.error) {
    const e = envelope.error ?? { code: 'INTERNAL_ERROR', message: 'Request failed.' };
    throw new ApiClientError(e.code, e.message, res.status);
  }
  return envelope.data as T;
}

/** Room state → wireframe label (§9.2). Text is mandatory; color is secondary. */
export const ROOM_STATE_LABEL: Record<string, { zh: string; hint: string; tone: string }> = {
  VACANT_CLEAN: { zh: '空净', hint: '可开房', tone: 'vacant' },
  RESERVED: { zh: '已预约', hint: '等客到店', tone: 'reserved' },
  OCCUPIED_WAITING_SERVICE: { zh: '待技师', hint: '客人已到', tone: 'waiting' },
  IN_SERVICE: { zh: '服务中', hint: '技师上钟', tone: 'serving' },
  WAITING_CHECKOUT: { zh: '待结账', hint: '待收银', tone: 'checkout' },
  DIRTY: { zh: '待清', hint: '需清洁', tone: 'dirty' },
  CLEANING: { zh: '清洁中', hint: '打扫中', tone: 'cleaning' },
  MAINTENANCE: { zh: '维保', hint: '暂停使用', tone: 'maintenance' },
  DISABLED: { zh: '停用', hint: '管理停用', tone: 'disabled' },
};

export const TECH_STATE_LABEL: Record<string, string> = {
  OFF_DUTY: '未上班',
  AVAILABLE: '空闲',
  ASSIGNED: '已派单',
  GOING_TO_ROOM: '前往房',
  WAITING_START: '待上钟',
  SERVING: '服务中',
  BREAK: '休息',
  LOCKED: '锁牌',
};

export interface RoomRow {
  id: string;
  code: string;
  name: string;
  capacity: number;
  status: string;
  operational_state: string;
  current_visit_id: string | null;
  version: number;
}

export interface TechnicianRow {
  id: string;
  technician_no: string;
  display_name?: string;
  status: string;
}

/** Board aggregates — every figure traces to a live GET (no fabricated KPIs). */
export function boardStats(rooms: RoomRow[], techs: TechnicianRow[]) {
  const count = (state: string) => rooms.filter((r) => r.operational_state === state).length;
  return {
    visitsOpen: rooms.filter((r) => r.current_visit_id !== null).length,
    vacant: count('VACANT_CLEAN'),
    idleTechs: techs.filter((t) => t.status === 'AVAILABLE').length,
    waiting: count('OCCUPIED_WAITING_SERVICE'),
    revenueCents: null as number | null, // orders/payment API lands in Phase 08
  };
}
