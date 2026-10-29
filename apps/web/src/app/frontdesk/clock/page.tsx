'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  TECH_STATE_LABEL,
  api,
  loadSession,
  type SessionState,
  type TechnicianRow,
} from '../../../lib/api';
import {
  clockBoardRows,
  type QueueItem,
  type RecommendResult,
  type SessionItem,
} from '../../../lib/clock-board';

interface Variant {
  id: string;
  name: string;
  service_name: string;
  duration_minutes: number;
  base_price_cents: number;
}

/**
 * 钟房 (spec §9.3): technician table with 排位/今日/点钟/空闲, explainable
 * 推荐 (selected + excluded reasons + echoed weights + policy tag), queue
 * skip/compensate, and the full 派单→开服务 flow into an occupied room.
 */
export default function ClockBoardPage() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [techs, setTechs] = useState<TechnicianRow[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [todaySessions, setToday] = useState<SessionItem[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [variantId, setVariantId] = useState('');
  const [recommend, setRecommend] = useState<RecommendResult | null>(null);
  const [roomId, setRoomId] = useState('');
  const [occupiedRooms, setOccupiedRooms] = useState<Array<{ id: string; code: string }>>([]);

  const refresh = useCallback(
    async (s: SessionState) => {
      setLoading(true);
      setError(null);
      try {
        const [t, q, ses, v, r] = await Promise.all([
          api<{ items: TechnicianRow[] }>('/technicians', { session: s }),
          api<{ items: QueueItem[] }>('/scheduling/queue', { session: s }),
          api<{ items: SessionItem[] }>('/service-sessions?today=1&limit=500', { session: s }),
          api<{ items: Variant[] }>('/service-variants', { session: s }),
          api<{ items: Array<{ id: string; code: string; current_visit_id: string | null }> }>(
            '/rooms',
            { session: s },
          ),
        ]);
        setTechs(t.items);
        setQueue(q.items.filter((i) => i.state !== 'REMOVED'));
        setToday(ses.items);
        setVariants(v.items);
        setOccupiedRooms(
          r.items
            .filter((x) => x.current_visit_id !== null)
            .map((x) => ({ id: x.id, code: x.code })),
        );
        if (!variantId && v.items.length > 0) setVariantId(v.items[0]!.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败');
      } finally {
        setLoading(false);
      }
    },
    [variantId],
  );

  useEffect(() => {
    const s = loadSession();
    if (!s) return;
    setSession(s);
    void refresh(s);
  }, [refresh]);

  async function run(
    path: string,
    body: unknown,
    label: string,
  ): Promise<Record<string, unknown> | null> {
    if (!session) return null;
    setNotice(null);
    setError(null);
    try {
      const res = await api<Record<string, unknown>>(path, { method: 'POST', body, session });
      setNotice(`${label}：成功`);
      await refresh(session);
      return res;
    } catch (err) {
      setError(`${label}失败 — ${err instanceof Error ? err.message : '未知错误'}`);
      return null;
    }
  }

  async function onRecommend(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!session) return;
    setNotice(null);
    setError(null);
    try {
      const res = await api<RecommendResult>('/scheduling/recommend', {
        method: 'POST',
        body: variantId ? { serviceVariantId: variantId } : {},
        session,
      });
      setRecommend(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : '推荐失败');
    }
  }

  async function onDispatch(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!session || !recommend?.selected || !roomId || !variantId) return;
    const created = await run(
      '/service-sessions',
      {
        roomId,
        serviceVariantId: variantId,
        technicianId: recommend.selected.technicianId,
        assignmentType: 'ROTATION',
      },
      '派单开服务',
    );
    if (created) {
      setRecommend(null);
      setRoomId('');
    }
  }

  const rows = clockBoardRows(techs, queue, todaySessions, new Date(), TECH_STATE_LABEL);

  return (
    <main className="clock" aria-label="钟房排班大屏">
      <div className="board-toolbar">
        <button type="button" onClick={() => session && void refresh(session)} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
        {notice ? <span role="status">{notice}</span> : null}
        {error ? (
          <span role="alert" className="board-error">
            {error}
          </span>
        ) : null}
      </div>

      <section aria-label="推荐与派单" className="clock-dispatch">
        <form onSubmit={onRecommend} className="clock-form">
          <label>
            服务项目
            <select value={variantId} onChange={(e) => setVariantId(e.target.value)}>
              <option value="">（不限 — 纯排位推荐）</option>
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.service_name} · {v.name}（{v.duration_minutes}m ¥
                  {(v.base_price_cents / 100).toFixed(0)}）
                </option>
              ))}
            </select>
          </label>
          <button type="submit">获取推荐</button>
        </form>

        {recommend ? (
          <div className="recommend-card" aria-live="polite">
            <h2>推荐结果（§6.5 可解释）</h2>
            {recommend.selected ? (
              <p className="recommend-selected">
                <strong>
                  {recommend.selected.technicianNo}（排位 {recommend.selected.queuePosition}，空闲{' '}
                  {recommend.selected.idleMinutes}m）
                </strong>{' '}
                — 综合分 {recommend.selected.score}
              </p>
            ) : (
              <p className="recommend-none">无满足硬性条件的技师（不虚构推荐）</p>
            )}
            {recommend.excluded.length > 0 ? (
              <ul className="recommend-excluded">
                {recommend.excluded.map((x) => (
                  <li key={x.technicianId}>
                    {x.technicianNo}：排除 — <code>{x.reason}</code>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="recommend-weights">
              权重：排位 {recommend.weights.queuePosition} · 空闲 {recommend.weights.idleDuration} ·
              补钟 {recommend.weights.compensation} · 技能 {recommend.weights.skill} · 偏好{' '}
              {recommend.weights.preference} — <em>{recommend.policy}</em>
            </p>

            {recommend.selected && occupiedRooms.length > 0 ? (
              <form onSubmit={onDispatch} className="clock-form">
                <label>
                  开服务房间
                  <select value={roomId} onChange={(e) => setRoomId(e.target.value)} required>
                    <option value="">选择在场拜访房间…</option>
                    {occupiedRooms.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.code}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit">派单并创建服务</button>
              </form>
            ) : null}
          </div>
        ) : null}
      </section>

      <section aria-label="技师钟房表" className="clock-table-wrap">
        <table className="clock-table">
          <thead>
            <tr>
              <th>号码</th>
              <th>状态</th>
              <th>排位</th>
              <th>今日</th>
              <th>点钟</th>
              <th>空闲</th>
              <th>队列</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.technicianId} data-status={r.status}>
                <td>
                  <strong>{r.technicianNo}</strong>
                </td>
                <td>{r.stateLabel}</td>
                <td>{r.position ?? '—'}</td>
                <td>{r.today}</td>
                <td>{r.requests}</td>
                <td>{r.idleMinutes !== null ? `${r.idleMinutes}m` : '—'}</td>
                <td>
                  {r.queueState === 'ACTIVE'
                    ? '排队中'
                    : r.queueState === 'ASSIGNED'
                      ? '已派单'
                      : '—'}
                </td>
                <td className="clock-actions">
                  {r.status === 'OFF_DUTY' ? (
                    <button
                      type="button"
                      onClick={() =>
                        void run(`/technicians/${r.technicianId}/clock-in`, {}, '上班打卡')
                      }
                    >
                      上班
                    </button>
                  ) : null}
                  {r.queueEntryId && r.queueState === 'ACTIVE' ? (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          void run(`/scheduling/skip`, { queueEntryId: r.queueEntryId }, '跳过')
                        }
                      >
                        跳过
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void run(
                            `/scheduling/compensate`,
                            { queueEntryId: r.queueEntryId, delta: 2 },
                            '补钟 +2',
                          )
                        }
                      >
                        补钟
                      </button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8}>暂无技师</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section aria-label="当前队列" className="clock-queue">
        <h2>当前队列</h2>
        <ol>
          {queue
            .slice()
            .sort((a, b) => Number(a.effective_key) - Number(b.effective_key))
            .map((q, i) => (
              <li key={q.id}>
                #{i + 1} <strong>{q.technician_no}</strong>
                <span className="muted">
                  {' '}
                  有效键 {Number(q.effective_key).toFixed(0)}
                  {Number(q.priority_delta) !== 0
                    ? `（补钟 ${q.priority_delta > 0 ? '+' : ''}${q.priority_delta}）`
                    : ''}
                </span>
              </li>
            ))}
          {queue.length === 0 ? <li className="muted">队列为空 — 技师打卡后自动入排</li> : null}
        </ol>
      </section>
    </main>
  );
}
