# Product Brief — 澜序 LanXu StoreOS V1

Status: frozen baseline (from Codex One-Shot Master Prompt V1.0, 2026-10-28).
Full normative spec: [`lanxu-storeos-v1-master-spec.md`](./lanxu-storeos-v1-master-spec.md).

## Positioning

LanXu StoreOS targets foot-bath / SPA / massage / wellness / leisure service stores. It is not a
generic POS: it is an operations OS built around rooms, technicians, service sessions, orders,
payments, members, devices, and live store state.

## V1 Golden Path (acceptance spine)

```
顾客到店 → 搜索会员/散客 → 人数与房型 → 分配房间/开房 → 选择服务项目
→ 点钟/轮钟/排钟 → 技师收到任务/确认/到房 → 上钟/服务计时
→ 商品/呼叫/加钟/换技师 → 下钟 → 待结账/优惠 → 支付/完成订单
→ 房间待清洁 → 保洁完成 → 空净
```

Every phase that claims business value must connect to this chain. The full chain is exercised
end-to-end in Phase 27 (Full E2E) including split tender, offline operation, and device flow.

## V1 non-goals

- No AI store manager / AI marketing / AI scheduling / biometrics (incl. face recognition).
- No self-built payment clearing platform, no self-built Android hardware.
- No full ERP general ledger, heavy HR, microservices, Kubernetes, Kafka.
- No full event-sourcing/CQRS, no multi-region Active-Active — "先进" never beats correctness.

## Operating model (Cloud + Store Edge)

- **Cloud authoritative**: org/tenant config, HQ control plane, multi-store reporting, cloud
  backup, device control.
- **Edge authoritative while operating**: live room/technician state, scheduling, 上/下钟,
  current orders, store business events.
- When the internet drops: open rooms, scheduling, start/extend/finish service, products, room
  state, cash checkout MUST keep working. Online payments, cross-store wallet use, third-party
  redemptions must NOT pretend to work offline.
- Realtime: WebSocket per store with monotonic `storeSeq`, client `lastStoreSeq`, replay after
  reconnect, snapshot fallback when the retention window is gone.

## V1 module map (modular monolith)

Auth · Organization · Employee · Room · Catalog · Technician · Scheduling · Visit ·
ServiceSession · Order · Payment · Member/Wallet · Commission · Inventory · Device · Approval ·
Audit · Reporting · EdgeSync

## Deliberately unfrozen business policies (spec §21)

Queue-down on 点钟? 补钟 after 退钟? Reservation lock windows? Tiered wages? Discount/refund
approval thresholds? Real WeChat/Alipay merchant model? Prepaid-value compliance per city?
→ Configurable dev defaults, every one tagged
**BUSINESS POLICY — REQUIRES PILOT VALIDATION**, collected in `docs/architecture/scheduling.md`
and `docs/architecture/domain-model.md` policy table.

## Quality bar

"可真实开店营业" (ready for real operation). Demo-runnable ≠ done. Financial, authorization,
scheduling, offline-sync, and audit issues are production-grade risks from day one. See
`docs/architecture/invariants.md` for the hard invariants and `PLANS.md` for phase state.
