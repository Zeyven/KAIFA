const PHASES = [
  { id: '00', name: 'Repository Foundation', status: 'IN PROGRESS' },
  { id: '01', name: 'Database Foundation', status: 'TODO' },
  { id: '07', name: 'FrontDesk Room Board', status: 'TODO' },
];

export default function HomePage() {
  return (
    <main className="shell">
      <header>
        <h1>澜序 LanXu StoreOS</h1>
        <p className="sub">门店运营操作系统 · V1 — 房间 · 技师 · 服务 · 订单 · 支付 · 会员</p>
      </header>

      <section aria-labelledby="golden-path">
        <h2 id="golden-path">Golden Path</h2>
        <ol className="path">
          <li>到店 / 会员</li>
          <li>开房</li>
          <li>排钟 · 上钟</li>
          <li>服务 · 加钟</li>
          <li>结账 · 支付</li>
          <li>清房 · 空净</li>
        </ol>
      </section>

      <section aria-labelledby="status">
        <h2 id="status">Phase 状态</h2>
        <p className="hint">
          权威状态见仓库 <code>PLANS.md</code> — 此处仅为展示骨架（Phase 00），尚未连接实时 API。
        </p>
        <ul className="phases">
          {PHASES.map((p) => (
            <li key={p.id}>
              <span className="phase-id">Phase {p.id}</span>
              <span>{p.name}</span>
              <span className={`badge ${p.status === 'TODO' ? 'todo' : 'wip'}`}>{p.status}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
