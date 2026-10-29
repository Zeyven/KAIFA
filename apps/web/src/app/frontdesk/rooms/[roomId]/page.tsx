'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  ROOM_STATE_LABEL,
  api,
  loadSession,
  type RoomRow,
  type SessionState,
} from '../../../../lib/api';

/**
 * 房间详情 (§9.1 /frontdesk/rooms/:id): full command surface for one room —
 * open, cleaning, maintenance, disable/enable, move. Every POST carries
 * expectedVersion for optimistic-concurrency 409s; failures render verbatim.
 */
export default function RoomDetailPage() {
  const params = useParams<{ roomId: string }>();
  const roomId = params.roomId;
  const [session, setSession] = useState<SessionState | null>(null);
  const [room, setRoom] = useState<RoomRow | null>(null);
  const [targets, setTargets] = useState<RoomRow[]>([]);
  const [moveTo, setMoveTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(
    async (s: SessionState) => {
      try {
        const [r, list] = await Promise.all([
          api<RoomRow>(`/rooms/${roomId}`, { session: s }),
          api<{ items: RoomRow[] }>('/rooms', { session: s }),
        ]);
        setRoom(r);
        setTargets(
          list.items.filter(
            (x) => x.id !== r.id && x.operational_state === 'VACANT_CLEAN' && x.status === 'ACTIVE',
          ),
        );
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败');
      }
    },
    [roomId],
  );

  useEffect(() => {
    const s = loadSession();
    if (!s) return;
    setSession(s);
    void reload(s);
  }, [reload]);

  async function command(path: string, body: unknown, label: string): Promise<void> {
    if (!session || !room) return;
    setNotice(null);
    setError(null);
    try {
      await api(path, {
        method: 'POST',
        body: { ...(body as object), expectedVersion: room.version },
        session,
      });
      setNotice(`${label}：成功`);
      await reload(session);
    } catch (err) {
      setError(`${label}失败 — ${err instanceof Error ? err.message : '未知错误'}`);
    }
  }

  if (!room) {
    return (
      <main className="room-detail">
        <p>{error ?? '加载中…'}</p>
        <Link href="/frontdesk/rooms">← 返回房态大屏</Link>
      </main>
    );
  }

  const meta = ROOM_STATE_LABEL[room.operational_state] ?? {
    zh: room.operational_state,
    hint: '',
    tone: 'unknown',
  };

  return (
    <main className="room-detail">
      <p>
        <Link href="/frontdesk/rooms">← 返回房态大屏</Link>
      </p>
      <header className={`room-detail-head tone-${meta.tone}`}>
        <h1>
          {room.code} · {room.name}
        </h1>
        <p className="room-state" data-state={room.operational_state}>
          <span aria-hidden="true" className="dot" /> {meta.zh}
          <small>{meta.hint}</small>
        </p>
        <p className="room-meta">
          容量 {room.capacity} 人 · 状态 {room.status} · 版本 v{room.version} ·{' '}
          {room.current_visit_id ? '进行中的拜访' : '无拜访'}
        </p>
      </header>

      {notice ? (
        <p role="status" className="room-notice">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="board-error">
          {error}
        </p>
      ) : null}

      <section aria-label="房间命令" className="room-command-list">
        {room.operational_state === 'VACANT_CLEAN' && room.status === 'ACTIVE' ? (
          <button
            type="button"
            onClick={() => void command(`/rooms/${room.id}/open`, { guestCount: 1 }, '开房')}
          >
            开房（空净 → 待服务）
          </button>
        ) : null}

        {room.operational_state === 'DIRTY' ? (
          <button
            type="button"
            onClick={() => void command(`/rooms/${room.id}/cleaning/start`, {}, '开始清洁')}
          >
            开始清洁（待清 → 清洁中）
          </button>
        ) : null}

        {room.operational_state === 'CLEANING' ? (
          <button
            type="button"
            onClick={() =>
              void command(
                `/rooms/${room.id}/cleaning/complete`,
                { checklistPassed: true },
                '清洁完成',
              )
            }
          >
            清洁完成（清洁中 → 空净）
          </button>
        ) : null}

        {['VACANT_CLEAN', 'RESERVED', 'DIRTY', 'CLEANING'].includes(room.operational_state) ? (
          <button
            type="button"
            onClick={() => void command(`/rooms/${room.id}/maintenance/start`, {}, '进入维保')}
          >
            进入维保
          </button>
        ) : null}

        {room.operational_state === 'MAINTENANCE' ? (
          <button
            type="button"
            onClick={() =>
              void command(
                `/rooms/${room.id}/maintenance/end`,
                { inspectionPassed: true },
                '维保完成',
              )
            }
          >
            维保完成（维保 → 空净）
          </button>
        ) : null}

        {room.status === 'ACTIVE' ? (
          <button
            type="button"
            className="danger"
            onClick={() => void command(`/rooms/${room.id}/disable`, {}, '停用房间')}
          >
            停用
          </button>
        ) : null}

        {room.status !== 'ACTIVE' ? (
          <button
            type="button"
            onClick={() => void command(`/rooms/${room.id}/enable`, {}, '启用房间')}
          >
            启用
          </button>
        ) : null}
      </section>

      {room.current_visit_id && targets.length > 0 ? (
        <section aria-label="换房" className="room-move">
          <h2>换房（拜访转移）</h2>
          <label>
            目标房间
            <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              <option value="">选择空净房…</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} · {t.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!moveTo}
            onClick={() =>
              moveTo ? void command(`/rooms/${room.id}/move`, { toRoomId: moveTo }, '换房') : null
            }
          >
            确认换房
          </button>
        </section>
      ) : null}
    </main>
  );
}
