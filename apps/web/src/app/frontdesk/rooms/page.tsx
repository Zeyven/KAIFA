'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  ROOM_STATE_LABEL,
  TECH_STATE_LABEL,
  api,
  boardStats,
  loadSession,
  type RoomRow,
  type SessionState,
  type TechnicianRow,
} from '../../../lib/api';

interface CommandResult {
  message?: string;
}

/**
 * 房态大屏 (spec §9.2): live KPI strip + room grid. Every state shows TEXT
 * plus color — color is never the only signal. Commands post through the
 * authenticated API; the server decides permission (403 shown verbatim).
 */
export default function RoomsBoardPage() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [rooms, setRooms] = useState<RoomRow[]>([]);
  const [techs, setTechs] = useState<TechnicianRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const refresh = useCallback(async (s: SessionState) => {
    setLoading(true);
    setError(null);
    try {
      const [roomRes, techRes] = await Promise.all([
        api<{ items: RoomRow[] }>('/rooms', { session: s }),
        api<{ items: TechnicianRow[] }>('/technicians', { session: s }),
      ]);
      setRooms(roomRes.items);
      setTechs(techRes.items);
      setUpdatedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const s = loadSession();
    if (!s) return;
    setSession(s);
    void refresh(s);
  }, [refresh]);

  async function command(path: string, body: unknown = {}, label: string): Promise<void> {
    if (!session) return;
    setNotice(null);
    setError(null);
    try {
      await api<CommandResult>(path, { method: 'POST', body, session });
      setNotice(`${label}：成功`);
      await refresh(session);
    } catch (err) {
      setError(`${label}失败 — ${err instanceof Error ? err.message : '未知错误'}`);
    }
  }

  const stats = boardStats(rooms, techs);

  return (
    <main className="board" aria-label="房态大屏">
      <section className="kpi" aria-label="门店指标">
        <div>
          <span className="kpi-label">客流（在场）</span>
          <strong>{stats.visitsOpen}</strong>
        </div>
        <div>
          <span className="kpi-label">空房</span>
          <strong>{stats.vacant}</strong>
        </div>
        <div>
          <span className="kpi-label">空闲技师</span>
          <strong>{stats.idleTechs}</strong>
        </div>
        <div>
          <span className="kpi-label">待服务</span>
          <strong>{stats.waiting}</strong>
        </div>
        <div>
          <span className="kpi-label">营业额</span>
          <strong title="订单/支付 API 于 Phase 08 上线">
            {stats.revenueCents === null ? '—' : `¥${(stats.revenueCents / 100).toFixed(2)}`}
          </strong>
        </div>
      </section>

      <div className="board-toolbar">
        <button type="button" onClick={() => session && void refresh(session)} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
        {updatedAt ? (
          <span className="board-updated">
            更新于 {updatedAt.toLocaleTimeString('zh-CN', { hour12: false })}
          </span>
        ) : null}
        {notice ? <span role="status">{notice}</span> : null}
        {error ? (
          <span role="alert" className="board-error">
            {error}
          </span>
        ) : null}
      </div>

      <section className="room-grid" aria-label="房间状态">
        {rooms.map((room) => {
          const meta = ROOM_STATE_LABEL[room.operational_state] ?? {
            zh: room.operational_state,
            hint: '',
            tone: 'unknown',
          };
          const occupied = room.current_visit_id !== null;
          return (
            <article key={room.id} className={`room-card tone-${meta.tone}`}>
              <header>
                <Link href={`/frontdesk/rooms/${room.id}`} className="room-code">
                  {room.code}
                </Link>
                <span className="room-name">{room.name}</span>
              </header>
              <p className="room-state" data-state={room.operational_state}>
                <span aria-hidden="true" className="dot" /> {meta.zh}
                <small>{meta.hint}</small>
              </p>
              <footer>
                <span>{room.capacity}人</span>
                <span>{occupied ? '在场' : '空置'}</span>
              </footer>
              <div className="room-actions">
                {room.operational_state === 'VACANT_CLEAN' && room.status === 'ACTIVE' ? (
                  <button
                    type="button"
                    onClick={() =>
                      void command(`/rooms/${room.id}/open`, { guestCount: 1 }, `开房 ${room.code}`)
                    }
                  >
                    开房
                  </button>
                ) : null}
                {room.operational_state === 'DIRTY' ? (
                  <button
                    type="button"
                    onClick={() =>
                      void command(`/rooms/${room.id}/cleaning/start`, {}, `开始清洁 ${room.code}`)
                    }
                  >
                    开始清洁
                  </button>
                ) : null}
                {room.operational_state === 'CLEANING' ? (
                  <button
                    type="button"
                    onClick={() =>
                      void command(
                        `/rooms/${room.id}/cleaning/complete`,
                        { checklistPassed: true },
                        `清洁完成 ${room.code}`,
                      )
                    }
                  >
                    清洁完成
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
        {rooms.length === 0 && !loading ? <p className="board-empty">该门店暂无房间</p> : null}
      </section>

      <section className="tech-strip" aria-label="技师状态">
        <h2>技师</h2>
        <ul>
          {techs.map((t) => (
            <li key={t.id}>
              <strong>{t.technician_no}</strong>
              <span data-status={t.status}>{TECH_STATE_LABEL[t.status] ?? t.status}</span>
            </li>
          ))}
          {techs.length === 0 ? <li>暂无技师</li> : null}
        </ul>
      </section>
    </main>
  );
}
