import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiClientError,
  ROOM_STATE_LABEL,
  TECH_STATE_LABEL,
  api,
  boardStats,
  loadSession,
  type RoomRow,
  type TechnicianRow,
} from './api';

const room = (over: Partial<RoomRow> = {}): RoomRow => ({
  id: 'r1',
  code: '301',
  name: '足浴房',
  capacity: 2,
  status: 'ACTIVE',
  operational_state: 'VACANT_CLEAN',
  current_visit_id: null,
  version: 1,
  ...over,
});

describe('boardStats (live-derived KPIs, §9.2)', () => {
  const rooms: RoomRow[] = [
    room({ id: 'a' }),
    room({ id: 'b', operational_state: 'OCCUPIED_WAITING_SERVICE', current_visit_id: 'v1' }),
    room({ id: 'c', operational_state: 'IN_SERVICE', current_visit_id: 'v2' }),
    room({ id: 'd', operational_state: 'WAITING_CHECKOUT', current_visit_id: 'v3' }),
  ];
  const techs: TechnicianRow[] = [
    { id: 't1', technician_no: 'T001', status: 'AVAILABLE' },
    { id: 't2', technician_no: 'T002', status: 'SERVING' },
    { id: 't3', technician_no: 'T003', status: 'AVAILABLE' },
    { id: 't4', technician_no: 'T004', status: 'OFF_DUTY' },
  ];

  it('counts open visits, vacant rooms, idle technicians, waiting rooms', () => {
    expect(boardStats(rooms, techs)).toEqual({
      visitsOpen: 3,
      vacant: 1,
      idleTechs: 2,
      waiting: 1,
      revenueCents: null, // Phase 08 orders — never fabricated
    });
  });

  it('revenue stays null until the order/payment API exists (no invented KPI)', () => {
    expect(boardStats([], []).revenueCents).toBeNull();
  });
});

describe('room/tech state labels (§9.2: text is mandatory)', () => {
  it('covers every spec room operational state with a Chinese label', () => {
    const states = [
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
    for (const s of states) {
      expect(ROOM_STATE_LABEL[s]?.zh, s).toBeTruthy();
      expect(ROOM_STATE_LABEL[s]?.tone, s).toBeTruthy();
    }
    expect(Object.keys(ROOM_STATE_LABEL).sort()).toEqual([...states].sort());
  });

  it('covers the 8 technician states', () => {
    expect(Object.keys(TECH_STATE_LABEL)).toHaveLength(8);
    expect(TECH_STATE_LABEL.AVAILABLE).toBe('空闲');
    expect(TECH_STATE_LABEL.SERVING).toBe('服务中');
  });
});

describe('api client envelope handling (§7.1)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('unwraps {data} on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { items: [room()] } }),
      }),
    );
    await expect(api<{ items: RoomRow[] }>('/rooms')).resolves.toEqual({ items: [room()] });
  });

  it('throws code+message ApiClientError on failure envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: { code: 'FORBIDDEN', message: 'nope' } }),
      }),
    );
    await expect(api('/rooms')).rejects.toThrowError(ApiClientError);
    await expect(api('/rooms')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('sends auth headers only when a session is present', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: null }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await api('/rooms');
    const anonHeaders = (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> })
      .headers;
    expect(anonHeaders.authorization).toBeUndefined();
    expect(anonHeaders['x-store-id']).toBeUndefined();
    await api('/rooms', {
      session: { token: 'tok', storeId: 's1', stores: [], username: 'u' },
    });
    const headers = (fetchMock.mock.calls[1]![1] as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['x-store-id']).toBe('s1');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/v1/rooms'); // relative path — proxied
  });

  it('never throws on missing storage (SSR-safe)', () => {
    expect(loadSession()).toBeNull();
  });
});
