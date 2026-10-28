# 澜序 LanXu StoreOS V1 — Codex One-Shot Master Prompt

真实门店营业级 · 开发前冻结规格 / 一次性工程总提示词
版本：V1.0 · 2026-10-28
用途：可直接交给 Codex 建立仓库、拆阶段、持续实现、验证与审查

> 文档说明
>
> 使用方式：本文件既是一份工程规格书，也是一份可一次性给 Codex 的 Master Prompt。建议将整份文档作为项目基线；若 Codex 只能接收文本，则优先复制“附录 A：Codex 一次性执行指令”，并让 Codex 以本文件其余章节作为仓库内持久化规范。
>
> 核心原则不是让 Codex 一次生成整个系统，而是一次下达完整工程目标，让它先建立仓库知识库、计划与验证闭环，再按阶段持续实施。OpenAI 当前公开实践也强调：给 Codex 一张清晰的“地图”，而不是把所有长期知识塞进一个巨型 AGENTS.md。
>
> 本版本将“可真实开店营业”作为验收标准。任何资金、权限、排钟、离线同步和审计问题都按生产级风险处理，不因 Demo 可运行而视为完成。

## 目录

1. 项目目标与执行原则
2. 技术基线与系统架构
3. Monorepo 与仓库 Harness
4. PostgreSQL Schema 设计
5. 全部核心状态机
6. 排钟算法正式规格
7. OpenAPI / HTTP API Contract
8. WebSocket Event Contract
9. FrontDesk 页面与 Wireframe
10. Android Room APK
11. RBAC + 对象级授权
12. Offline Sync Protocol
13. Payment State Machine 与资金安全
14. Member Ledger / 会员资金账本
15. Commission Rule Engine
16. Audit / Security / Privacy / Observability
17. TDD Test Matrix
18. CI/CD、Migration、Backup 与发布门禁
19. Codex 分阶段 Task List
20. Production Invariants 与 Definition of Done
21. 暂不冻结的真实业务政策
22. Red Team 与 Kill Criteria
附录 A：可直接复制给 Codex 的一次性执行指令
附录 B：外部规范与参考来源
附录 C：文档状态

## 1. 项目目标与执行原则

### 1.1 Codex 角色

- Principal Software Engineer / Software Architect
- Backend / Frontend / Android / Database Engineer
- Security Engineer / QA Engineer / DevOps & SRE Engineer
- Independent Code Reviewer / Red Team Reviewer

任务不是生成演示 Demo，也不是只生成页面，而是从当前仓库状态出发，将澜序 StoreOS V1 建设成结构完整、可运行、可测试、可审计、可回滚、可继续迭代，并以真实门店营业为目标的软件系统。

### 1.2 执行总原则

1. 先 Inspect：阅读现有仓库规则、源码、测试、Schema、迁移、CI、文档和近期变更。
2. 再 Plan：建立 PLANS.md 与阶段文件，不靠聊天上下文维持项目状态。
3. 建立 Repository Harness：精简 AGENTS.md、架构文档、invariants、威胁模型、运行手册。
4. 采用最小完整纵向切片逐阶段实现，而不是一次生成全部代码。
5. 每阶段必须运行测试、lint、typecheck、build、migration/API contract 等适用验证。
6. 测试失败先找根因，不通过删测试、放宽权限、吞异常、移除约束来让 CI 变绿。
7. 外部真实支付 Secret、真实门店 SOP 等缺失时，建立 Adapter 与明确的 EXTERNAL BLOCKER，继续不受阻部分。

优先级：Correctness > Security/Authorization > Data Integrity > Financial Integrity > Reliability > Testability > Maintainability > UX Efficiency > Performance > Visual Polish

### 1.3 产品定位

澜序 LanXu StoreOS 面向足浴、SPA、按摩、养生和休闲服务门店。它不是普通 POS，而是围绕房间、技师、服务 Session、订单、支付、会员、设备与门店实时状态构成的运营操作系统。

### 1.4 V1 Golden Path

```
顾客到店 → 搜索会员 / 散客 → 人数与房型 → 分配房间 / 开房 → 选择服务项目
→ 点钟 / 轮钟 / 排钟 → 技师收到任务 / 确认 / 到房 → 上钟 / 服务计时
→ 商品 / 服务呼叫 / 加钟 / 换技师 → 下钟 → 待结账 / 优惠 → 支付 / 完成订单
→ 房间待清洁 → 保洁完成 → 空净
```

### 1.5 V1 非目标

- AI 店长、AI 自动营销、AI 排班、人脸识别或其他生物识别。
- 自研支付清算平台、自研 Android 硬件。
- 完整 ERP 总账、重型 HR、微服务、Kubernetes、Kafka。
- 为了“先进”引入完整 Event Sourcing/CQRS 或多区域 Active-Active。

## 2. 技术基线与系统架构

| 层 | V1 默认技术 | 说明 |
|---|---|---|
| Web | TypeScript + React + Next.js | FrontDesk / Manager / Boss / Staff Web |
| API | TypeScript + Node.js + NestJS + Fastify Adapter | 模块化单体 |
| Database | PostgreSQL 18 | 事务、约束、锁、RLS、防御纵深 |
| Cache / Coordination | Redis | 短期状态、协调、队列辅助 |
| Realtime | WebSocket | 单店事件序列 + 重连补事件 |
| Android Room | Kotlin + Jetpack Compose | Dedicated Device / Device Owner / Lock Task |
| Edge | Node.js + PostgreSQL + Redis + Docker Compose | 门店本地营业权威 |
| Contracts | OpenAPI 3.1.2 + JSON Schema | HTTP 接口契约 |
| Observability | OpenTelemetry + structured logs + metrics | Trace / metrics / health |

核心实体 ID 使用 UUIDv7。RFC 9562 定义了 UUIDv7 的时间有序格式，并建议在可行情况下优先使用 UUIDv7 而非 UUIDv1/v6。
API 采用 OpenAPI 3.1.2 作为 V1 基线；该规范提供语言无关的 HTTP API 描述，可用于文档、代码生成和契约测试。

### 2.1 模块化单体

Auth / Organization / Employee / Room / Catalog / Technician / Scheduling / Visit / ServiceSession / Order / Payment / Member / Wallet / Commission / Inventory / Device / Approval / Audit / Reporting / EdgeSync

第一版禁止无必要拆微服务。模块边界必须明确，但共享 PostgreSQL；模块间不应通过任意跨域查询制造隐式耦合。

### 2.2 Cloud + Store Edge

```
LanXu Cloud
     │ HTTPS / WSS
     ▼
LanXu Store Edge
     │
 ┌───┼──────────┐
FrontDesk   Room Android   Staff
```

- Cloud authoritative：组织、门店配置、总部控制面、多店报表、云备份、设备控制。
- Edge authoritative while operating：实时房态、技态、排钟、上/下钟、当前订单、门店营业事件。
- 互联网断开时，开房、排钟、上钟、计时、加钟、下钟、商品、房态、技态、现金结账等核心业务继续。
- 线上支付、跨店钱包、第三方核销等需要外部在线确认的功能不得伪装成离线可用。

## 3. Monorepo 与仓库 Harness

```
lanxu/
├─ apps/
│  ├─ web/
│  ├─ api/
│  ├─ edge/
│  └─ room-android/
├─ packages/
│  ├─ contracts/
│  ├─ domain/
│  ├─ db/
│  ├─ ui/
│  ├─ config/
│  ├─ observability/
│  └─ testkit/
├─ infra/
│  ├─ docker/
│  ├─ cloud/
│  ├─ edge/
│  ├─ monitoring/
│  └─ backup/
├─ docs/
│  ├─ architecture/
│  ├─ product/
│  ├─ security/
│  ├─ runbooks/
│  └─ adr/
├─ harness/
│  ├─ phases/
│  ├─ context/
│  ├─ reviews/
│  └─ build-log.md
├─ scripts/
├─ .github/workflows/
├─ AGENTS.md
├─ PLANS.md
├─ README.md
└─ SECURITY.md
```

### 3.1 AGENTS.md 原则

- 只保存长期、高价值、短而明确的仓库规则。
- 包含：项目目标、关键 invariants、编码/测试/安全规则、架构地图、必读文档、DoD。
- 详细业务规范放 docs；阶段执行状态放 PLANS.md / harness。
- 不要将全部 PRD、Schema 和业务历史复制成数万字 AGENTS.md。

### 3.2 Repository Knowledge Base

```
docs/product/product-brief.md
docs/architecture/system-architecture.md
docs/architecture/domain-model.md
docs/architecture/invariants.md
docs/architecture/state-machines.md
docs/architecture/scheduling.md
docs/architecture/offline-sync.md
docs/architecture/api-contract.md
docs/architecture/realtime-contract.md
docs/security/threat-model.md
docs/security/authorization.md
docs/security/device-security.md
docs/security/payment-security.md
docs/runbooks/backup-restore.md
docs/runbooks/edge-outage.md
docs/runbooks/payment-outage.md
docs/runbooks/rollback.md
PLANS.md
```

## 4. PostgreSQL Schema 设计

### 4.1 全局约定

| 项 | 规范 |
|---|---|
| 主键 | UUIDv7 |
| 时间 | timestamptz |
| 营业日 | 显式 business_date，支持跨午夜 |
| 金额 | BIGINT，单位“分” |
| 数量 | numeric(18,4) |
| 关键业务表 | id / organization_id / store_id / created_at / updated_at / version |
| 金融/历史记录 | 尽量 append-only，不改写历史 |

金额规则：¥398.00 存储为 39800。禁止使用 float/double/JavaScript 浮点数作为人民币业务金额权威表示。

### 4.2 Organization

| 表 | 核心字段 | 关键约束 / Index |
|---|---|---|
| organizations | id; name; code; status; timezone; created_at; updated_at | UNIQUE(code); status CHECK |
| stores | id; organization_id; code; name; timezone; business_date_cutoff_time; currency; status; address_text | FK organization; UNIQUE(organization_id, code); index status |
| store_settings | store_id; settings_version; scheduling_config; payment_config; room_config; receipt_config | store PK/FK; config 不存 Secret |
| areas | id; store_id; name; sort_order; status | index store |
| rooms | id; store_id; area_id; code; name; room_type; capacity; status; operational_state; current_visit_id; version | UNIQUE(store_id, code); capacity>0; state indexes |
| beds | id; room_id; code; name; status | UNIQUE(room_id, code) |

### 4.3 Identity / RBAC

| 表 | 核心字段 | 关键约束 / Index |
|---|---|---|
| users | id; organization_id; username; phone_encrypted; password_hash; status; last_login_at | username unique per policy |
| employees | id; organization_id; store_id; user_id; employee_no; display_name; employee_type; employment_status; joined_at; left_at | UNIQUE(store_id, employee_no) |
| roles | id; organization_id nullable; code; name; system_role | role code unique in scope |
| permissions | id; code; description | UNIQUE(code) |
| employee_roles | employee_id; role_id; store_id | composite PK |
| role_permissions | role_id; permission_id | composite PK |

### 4.4 Catalog

| 表 | 核心字段 | 关键约束 / Index |
|---|---|---|
| service_categories | id; store_id; name; sort_order; status | index store |
| services | id; organization_id; code; name; category_id; status | code unique in scope |
| service_variants | id; service_id; code; name; duration_minutes; base_price_cents; commission_category; status | duration>0; price>=0 |
| products | id; organization_id; sku; name; category; unit; status | sku unique in scope |
| price_books | id; organization_id; store_id nullable; name; valid_from; valid_until; status | validity checks |
| price_book_items | id; price_book_id; item_type; service_variant_id; product_id; price_cents | service/product exactly-one CHECK |

### 4.5 Technician / Queue

| 表 | 核心字段 | 关键约束 / Index |
|---|---|---|
| technicians | id; employee_id; store_id; technician_no; level; gender_code; queue_enabled; status | UNIQUE employee_id; UNIQUE(store_id, technician_no) |
| technician_skills | technician_id; service_variant_id; skill_level; enabled | composite PK |
| technician_status_history | id; technician_id; from_status; to_status; reason_code; actor_employee_id; occurred_at; metadata | append-only; index time |
| technician_shifts | id; technician_id; store_id; starts_at; ends_at; status | ends_at>starts_at |
| technician_queue_entries | id; store_id; technician_id; queue_type; position_key; eligible_since; priority_delta; state; version | partial UNIQUE active technician |
| technician_queue_events | id; queue_entry_id; event_type; old_position_key; new_position_key; reason; actor_id; occurred_at | append-only |

### 4.6 Visit / Service

| 表 | 核心字段 | 关键约束 / Index |
|---|---|---|
| visits | id; store_id; customer_id; room_id; guest_count; status; opened_at; closed_at; opened_by; business_date | partial unique: one active visit per room |
| service_sessions | id; store_id; visit_id; order_id; room_id; bed_id; service_variant_id; technician_id; assignment_type; status; duration/start/end/price/queue snapshot/version | partial unique: one active session per technician |
| service_session_events | id; service_session_id; event_type; actor_type; actor_id; occurred_at; payload | append-only |
| service_extensions | id; service_session_id; minutes; price_delta_cents; approved_by; created_by; created_at | minutes>0 |
| technician_change_requests | id; session_id; from_technician_id; requested_technician_id; reason_code; status; requested_by; approved_by; timestamps | workflow record |

### 4.7 Orders / Payment

| 表 | 核心字段 | 关键约束 / Index |
|---|---|---|
| orders | id; store_id; visit_id; customer_id; status; subtotal/discount/payable/paid/refunded cents; business_date; timestamps; version | amounts >=0 |
| order_items | id; order_id; item_type; service_session_id/service_variant_id/product_id; name_snapshot; quantity; unit/gross/discount/net cents; status | 成交快照不可随 Catalog 漂移 |
| order_adjustments | id; order_id; order_item_id; type; amount_cents; reason_code; actor_id; approval_id; created_at | audit trail |
| payments | id; store_id; order_id; method; provider; amount_cents; status; provider IDs; idempotency_key; timestamps | UNIQUE(store,idempotency); UNIQUE provider txn |
| payment_attempts | id; payment_id; attempt_no; request_ref; provider_response_code; status; timestamps | attempt trace |
| refunds | id; payment_id; order_id; amount_cents; reason_code; status; approval_id; provider_refund_id; idempotency_key; timestamps | immutable refund record |
| cash_sessions / shift_reconciliations | cashier/store/business date/open-close/reconciliation fields | 交班核账 |

### 4.8 Customer / Wallet

| 表 | 核心字段 | 关键约束 / Index |
|---|---|---|
| customers | id; organization_id; display_name; phone_hash; phone_encrypted; status; created_at | 手机号 hash 查询 + encrypted 显示 |
| memberships | id; customer_id; organization_id; member_no; level; status; joined_at | member_no unique in org |
| wallets | id; membership_id; currency; principal_balance_cents; bonus_balance_cents; version | balances >=0 |
| wallet_ledger_entries | id; wallet_id; entry_type; principal_delta; bonus_delta; reference_type/id; idempotency_key; occurred_at; created_by; metadata | append-only; UNIQUE(wallet,idempotency) |

### 4.9 Commission / Audit / Device / Sync

| 表 | 核心字段 | 关键约束 / Index |
|---|---|---|
| commission_rules | id; organization_id; name; status | rule identity |
| commission_rule_versions | id; rule_id; version_no; effective_from/until; definition; created_at | UNIQUE(rule,version); used version immutable |
| commission_entries | id; store_id; technician_id; service_session_id; rule_version_id; type; amount_cents; business_date; status | UNIQUE tech+session+type |
| commission_adjustments | id; commission_entry_id; delta_cents; reason; approved_by; created_at | no overwrite original |
| devices | id; organization_id; store_id; room_id; device_type/code; platform/versions; public_key; credential_version; status; last_seen/enrolled | UNIQUE device_code; one active device per room |
| approval_requests / approval_actions | resource, type, requester, status, reason, approver/action, timestamps | 高风险审批 |
| audit_logs / security_events | actor/action/resource/request/device/before/after/reason/time | append-only; secrets excluded |
| outbox_events / inbox_events / sync_checkpoints | event/aggregate/type/payload/occurred/published/source/processed/checkpoint | Edge↔Cloud 幂等同步 |

### 4.9 数据库级关键 Invariants

- 同一房间最多一个 active Visit：partial unique index。
- 同一技师最多一个 active ServiceSession：partial unique index。
- 同一 provider transaction 只能成功入账一次。
- 同一 idempotency key 在业务范围内只能对应一个结果。
- Wallet 余额不得为负；余额变化必须同时有 ledger。
- 历史提成引用不可变 rule version。
- PostgreSQL 支持 CHECK / UNIQUE / FK / Row Security；但 RLS 只作为防御纵深，服务端对象级授权仍必须存在。

## 5. 全部核心状态机

### 5.1 Room

| Current | Event | Next | Guard |
|---|---|---|---|
| VACANT_CLEAN | OPEN_VISIT | OCCUPIED_WAITING_SERVICE | room enabled |
| RESERVED | GUEST_ARRIVED | OCCUPIED_WAITING_SERVICE | valid reservation |
| OCCUPIED_WAITING_SERVICE | SERVICE_STARTED | IN_SERVICE | active session |
| IN_SERVICE | ALL_SERVICES_COMPLETED | WAITING_CHECKOUT | no running session |
| WAITING_CHECKOUT | ORDER_PAID | DIRTY | balance = 0 |
| DIRTY | CLEANING_STARTED | CLEANING | cleaner/permission |
| CLEANING | CLEANING_COMPLETED | VACANT_CLEAN | checklist passed |
| non-occupied | MAINTENANCE_START | MAINTENANCE | authorized |
| MAINTENANCE | MAINTENANCE_END | VACANT_CLEAN | inspection |
| VACANT_CLEAN | DISABLE | DISABLED | manager |
| DISABLED | ENABLE | VACANT_CLEAN | manager |

禁止跳转：IN_SERVICE → VACANT_CLEAN 不允许直接发生；必须先完成服务、结账和清洁链路。

### 5.2 Technician

| Current | Event | Next |
|---|---|---|
| OFF_DUTY | CLOCK_IN | AVAILABLE |
| AVAILABLE | ASSIGN | ASSIGNED |
| ASSIGNED | ACK | GOING_TO_ROOM |
| GOING_TO_ROOM | ARRIVE | WAITING_START |
| WAITING_START | START_SERVICE | SERVING |
| SERVING | COMPLETE | Recompute state |
| AVAILABLE | BREAK_START | BREAK |
| BREAK | BREAK_END | AVAILABLE |
| AVAILABLE | LOCK | LOCKED |
| LOCKED | UNLOCK | AVAILABLE |
| eligible | CLOCK_OUT | OFF_DUTY |

服务完成后不得无条件切回 AVAILABLE，必须重新检查 shift end、下一预约、锁牌、用餐、暂停等条件。

### 5.3 ServiceSession

```
DRAFT
  → assign → ASSIGNED
  → acknowledge → ACKNOWLEDGED
  → arrive → ARRIVED
  → start → STARTED
      ├─ extend → STARTED
      ├─ change-technician → ASSIGNED
      └─ nearing-end → ENDING_SOON
  → complete → COMPLETED
```

异常：DRAFT/ASSIGNED 可 CANCEL；ASSIGNED 可 REJECT；STARTED 以后需 terminate/refund/adjustment，不允许普通 cancel。

### 5.4 Order / Payment

Order:
```
OPEN → IN_SERVICE → PENDING_CHECKOUT → PARTIALLY_PAID → PAID
PAID → REFUND_PENDING → PARTIALLY_REFUNDED / REFUNDED
```

Payment:
```
CREATED → PENDING → CAPTURED
                 ↘ FAILED / CANCELLED
CAPTURED → PARTIALLY_REFUNDED → REFUNDED
```

客户端不得通过 PATCH status 任意改领域状态。状态变化必须通过明确的 command endpoint，并在服务端验证 guard、权限、事务与审计。

## 6. 排钟算法正式规格

### 6.1 Assignment Modes

ROTATION / REQUESTED / RESERVATION / MANUAL / PRIORITY / COMPENSATION

### 6.2 Hard Constraints

- 同店、在职、当班、AVAILABLE、queue enabled。
- 具备该项目技能；未锁牌/未暂停；无 active service。
- 无预约冲突；符合配置化性别、区域等硬性要求。
- 任意 hard constraint 不满足即排除，不进入 soft score。

### 6.3 Soft Score

```
score = queue_position_score
      + idle_duration_score
      + fairness_score
      + compensation_score
      + skill_score
      + preference_score
      - future_reservation_penalty
      - overtime_penalty
```

| 因子 | 初始建议权重 | 备注 |
|---|---|---|
| queue_position | 1000 | ROTATION 的主导因素 |
| idle_duration | 100 | 空闲时间 |
| compensation | 300 | 补钟/优先补偿 |
| skill | 30 | 技能匹配 |
| preference | 20 | 偏好 |
| future_reservation | -500 | 预约冲突/接近预约 |
| overtime | -100 | 超时/疲劳 |

权重是开发默认值，不是最终真实门店政策。所有业务参数必须配置化，并标记 BUSINESS POLICY — REQUIRES PILOT VALIDATION。

### 6.4 原子分配与并发

```
BEGIN
SELECT technician FOR UPDATE
revalidate eligibility
lock/check active assignment
INSERT assignment
UPDATE technician state
UPDATE queue
INSERT service event
INSERT outbox event
COMMIT
```

两个前台同时给同一技师排单时，只允许一个事务成功。必要事务可用显式锁或 SERIALIZABLE + 正确重试，但不得无脑将整个系统设为 SERIALIZABLE。

### 6.5 可解释性

```json
{
  "selected": {"technicianNo":"082","queuePosition":1,"idleMinutes":48},
  "excluded": [
    {"technicianNo":"091","reason":"FUTURE_RESERVATION_CONFLICT"}
  ]
}
```

## 7. OpenAPI / HTTP API Contract

### 7.1 通用规则

- API root：/v1。
- 认证请求携带 Authorization 和 X-Request-Id。
- 危险写操作携带 Idempotency-Key。
- 列表默认 cursor pagination。
- 客户端业务逻辑依赖 error.code，不依赖英文 error.message。

Success:
```json
{"data": {...}}
```

Error:
```json
{
  "error": {
    "code": "SERVICE_INVALID_STATE",
    "message": "Current service session cannot be completed.",
    "requestId": "..."
  }
}
```

### 7.2 HTTP 状态语义

| Status | 语义 |
|---|---|
| 200/201 | 成功 / 创建 |
| 202 | 异步接受 |
| 400 | 格式/参数验证失败 |
| 401 | 未认证 |
| 403 | 无权限 |
| 404 | 不存在或不应泄漏存在性 |
| 409 | 并发/版本/业务冲突 |
| 422 | 合法请求但非法业务状态转换 |
| 429 | 限流 |
| 500 | 内部错误 |
| 503 | 依赖暂不可用 |

### 7.3 Core APIs

Rooms:
```
GET  /v1/rooms
GET  /v1/rooms/{roomId}
POST /v1/rooms/{roomId}/open
POST /v1/rooms/{roomId}/move
POST /v1/rooms/{roomId}/cleaning/start
POST /v1/rooms/{roomId}/cleaning/complete
```

Technicians:
```
GET  /v1/technicians
POST /v1/technicians/{id}/clock-in
POST /v1/technicians/{id}/clock-out
POST /v1/technicians/{id}/lock
POST /v1/technicians/{id}/unlock
```

Scheduling:
```
GET  /v1/scheduling/queue
POST /v1/scheduling/recommend
POST /v1/scheduling/assign
POST /v1/scheduling/skip
POST /v1/scheduling/compensate
POST /v1/scheduling/reorder
```

Service:
```
POST /v1/service-sessions
GET  /v1/service-sessions/{id}
POST /v1/service-sessions/{id}/assign
POST /v1/service-sessions/{id}/acknowledge
POST /v1/service-sessions/{id}/arrive
POST /v1/service-sessions/{id}/start
POST /v1/service-sessions/{id}/extend
POST /v1/service-sessions/{id}/change-technician
POST /v1/service-sessions/{id}/change-service
POST /v1/service-sessions/{id}/complete
POST /v1/service-sessions/{id}/terminate
```

Orders / Payments / Members:
```
GET  /v1/orders/{id}
POST /v1/orders/{id}/items
POST /v1/orders/{id}/discounts
POST /v1/orders/{id}/checkout
POST /v1/payments
GET  /v1/payments/{id}
POST /v1/refunds
GET  /v1/customers/search
POST /v1/customers
GET  /v1/members/{id}
GET  /v1/members/{id}/wallet
POST /v1/members/{id}/recharge
```

## 8. WebSocket Event Contract

`wss://<edge>/store/v1/realtime`

```json
{
  "eventId": "019...",
  "storeId": "019...",
  "storeSeq": 128456,
  "type": "service.started",
  "occurredAt": "2026-10-28T12:00:00Z",
  "aggregate": {"type":"service_session","id":"..."},
  "version": 4,
  "payload": {}
}
```

每个 Store 必须有单调递增 storeSeq。客户端持久化 lastStoreSeq；重连后请求 after=<lastSeq> 补事件。如果保留窗口已失效，则重新获取 snapshot，不能假设 WebSocket 永不丢事件。

事件类型：room.updated / visit.opened / visit.closed · technician.status_changed / technician.queue_changed · service.assigned / service.started / service.extended / service.completed · order.updated / order.paid / payment.updated · service_request.created / completed / device.status_changed

## 9. FrontDesk 页面与 Wireframe

### 9.1 页面树

```
/dashboard
/frontdesk/reception
/frontdesk/rooms
/frontdesk/rooms/:id
/frontdesk/clock
/frontdesk/technicians
/frontdesk/orders
/frontdesk/orders/:id
/frontdesk/checkout/:orderId
/frontdesk/members
/frontdesk/members/:id
/frontdesk/service-requests
/frontdesk/shifts
/manager/approvals
```

### 9.2 房态大屏

```
┌────────────────────────────────────────────┐
│ 澜序 · 门店               20:18            │
├────────────────────────────────────────────┤
│ 营业额 │ 客流 │ 空房 │ 空闲技师 │ 待服务   │
├────────────────────────────────────────────┤
│ [301 空净] [302 服务 62m] [303 待技师]    │
│ [304 待结] [305 呼叫!]   [306 待清]       │
└────────────────────────────────────────────┘
```

房态颜色不能作为唯一状态表达，必须同时提供文字/图标；前台应在数秒内判断全店状态。

### 9.3 钟房

```
号码  状态    排位  今日  点钟  空闲
082  空闲      1     6     2    48m
119  服务中    -     5     1     -
036  空闲      2     4     0    31m
091  预约      -     3     3     -

待安排：808-A / SPA 90
推荐：082（排位1，空闲48m） / 036（排位2）
```

### 9.4 收银

```
服务 / 商品明细
原价        ¥1680
优惠        -100
应付        ¥1580
已付        ¥1000
剩余         ¥580

[会员余额] [微信] [支付宝] [现金]
[完成结账]
```

必须支持 Split Tender；每种支付方式形成独立 Payment，不允许一个 payment_method 字段覆盖整单复杂支付。

## 10. Android Room APK

生产设备应使用 Android Dedicated Device / Fully Managed Device 思路。Android 官方 Lock Task 模式可将设备锁定为单应用或许可应用集合，通常禁止普通用户访问通知、非许可应用或主屏幕。只有 DPC allowlist 的应用才能真正进入 Lock Task。

### 10.1 页面

Boot / Enrollment / Device Offline / Vacant / Guest Waiting · Technician Assignment / Service / Multi Guest / Add Time · Products / Service Call / Bill Summary / Error / Maintenance

### 10.2 Enrollment

```
LANXU
设备未绑定
设备代码：LX-R-9A82K
请在管理后台绑定：组织 → 门店 → 房间
```

### 10.3 Service UI

```
808                        服务中
          00:58:42
         SPA · 90分钟
           082号
          剩余 31:18
────────────────────────
[ 加钟 ]      [ 商品 ]
[ 服务 ]      [ 查看消费 ]
```

### 10.4 设备安全要求

- Device Owner / DPC / Lock Task allowlist。
- 开机自动启动、进程崩溃恢复、Kiosk 逃逸测试。
- 设备 credential 绑定 store/room，后端不得信客户端任意 roomId。
- Room 变为空房后清除上一客人的临时/敏感状态。
- APK 内禁止内置数据库密码、支付商户私钥或服务器 Secret。

## 11. RBAC + 对象级授权

| 能力 | 前台 | 收银 | 钟房 | 技师 | 主管 | 店长 | 财板 | 老板 |
|---|---|---|---|---|---|---|---|---|
| 开房 | ✓ | ✓ | - | - | ✓ | ✓ | - | ✓ |
| 换房 | ✓ | - | - | - | ✓ | ✓ | - | ✓ |
| 普通排钟 | ✓ | - | ✓ | - | ✓ | ✓ | - | ✓ |
| 强制调钟 | - | - | △ | - | ✓ | ✓ | - | ✓ |
| 本人上/下钟 | - | - | - | ✓ | ✓ | ✓ | - | ✓ |
| 改服务时间 | - | - | - | - | △ | ✓ | - | ✓ |
| 普通结账 | ✓ | ✓ | - | - | ✓ | ✓ | - | ✓ |
| 折扣 | △ | ✓ | - | - | ✓ | ✓ | - | ✓ |
| 退款申请 | ✓ | ✓ | - | - | ✓ | ✓ | ✓ | ✓ |
| 退款批准 | - | - | - | - | △ | ✓ | ✓ | ✓ |
| 钱包调整 | - | - | - | - | - | △ | ✓ | ✓ |
| 提成调整 | - | - | - | - | - | ✓ | ✓ | ✓ |
| 权限管理 | - | - | - | - | - | ✓ | - | ✓ |
| 查看审计 | - | - | - | - | ✓ | ✓ | ✓ | ✓ |

△ 表示阈值/条件满足时需审批。拥有某个 Permission 不等于可以操作任意对象。OWASP API Security Top 10 2023 将 Broken Object Level Authorization 列为 API1，因此每个资源都必须验证 organization/store ownership 与对象关系。

## 12. Offline Sync Protocol

### 12.1 Authority

| 数据类型 | 权威 |
|---|---|
| 营业中的房态/技态/Service/Order | Store Edge |
| 总部配置/租户/多店控制面 | Cloud |
| 支付 Provider 最终状态 | Provider + Server verified state |
| 跨店钱包 | Cloud/central authority，离线默认限制 |

### 12.2 Transactional Outbox

```
BEGIN
write business state
write domain event
write outbox event
COMMIT

Sync Worker: Edge Outbox → Cloud Inbox → dedupe(eventId) → apply → ACK → mark published
```

禁止：禁止“先提交数据库，再发布消息”的双写方式；进程在中间崩溃会造成数据存在但事件永久丢失。

### 12.3 冲突策略

- Payment / Wallet / ServiceSession / Scheduling / Commission / Refund 禁止 last-write-wins。
- 配置可使用 version / If-Match / 409 conflict 做乐观并发。
- Edge 已发生的真实营业事件不能被 Cloud 配置覆盖。
- 记录 client_occurred_at 与 server_received_at；账务/排序以服务端权威时间为主。

## 13. Payment State Machine 与资金安全

### 13.1 Cash

CREATED → cashier confirm → CAPTURED，并记录 cash_session_id 与交班对账。

### 13.2 Online Adapter

```
Payment.CREATED → provider create order → PENDING
  → verified webhook / query → CAPTURED
```

- Webhook 必须验签、校验 merchant、amount、currency、payment reference 与 provider transaction。
- 重复 callback 必须幂等。
- 客户端“支付成功”界面不能成为 CAPTURED 的权威证据。
- 开发/测试可用 FakeOnlinePaymentProvider，但生产检测到 fake provider 必须 fail closed。

### 13.3 Refund

REQUESTED → APPROVED → PROCESSING → COMPLETED / FAILED

退款是独立不可变业务记录；不能 DELETE Payment 或直接修改已捕获金额。Provider 退款失败时，原 Payment 仍为 CAPTURED。

## 14. Member Ledger / 会员资金账本

会员资金必须用 Wallet + append-only Ledger，不能只维护 member.balance。本金与赠金必须分账，以支持退款、过期、审计与合规。

### 14.1 Ledger Types

RECHARGE_PRINCIPAL / RECHARGE_BONUS / CONSUMPTION_PRINCIPAL / CONSUMPTION_BONUS / REFUND_PRINCIPAL / REFUND_BONUS / EXPIRE_BONUS / MANUAL_ADJUSTMENT

### 14.2 示例

充值 ¥1000，赠送 ¥200：+100000 principal，+20000 bonus。
消费 ¥398（假设先赠金后本金）：-20000 bonus，-19800 principal。

### 14.3 并发扣款

```
BEGIN
SELECT wallet FOR UPDATE
verify available balance
INSERT ledger entries
UPDATE materialized balances
INSERT payment allocation
INSERT outbox
COMMIT
```

每日自动 reconciliation：wallet.principal_balance == SUM(principal_delta)，bonus 同理。任何不一致按高等级财务告警处理。

## 15. Commission Rule Engine

提成使用版本化声明式规则。禁止 arbitrary JavaScript、eval 或任意 SQL 作为工资规则脚本。

```json
{
  "when": {
    "serviceCategory": "SPA",
    "assignmentType": "REQUESTED",
    "technicianLevel": ["S", "A"]
  },
  "result": {
    "type": "FIXED",
    "amountCents": 8000
  }
}
```

- 支持 FIXED / PERCENT_OF_NET_SERVICE_PRICE / PER_MINUTE / TIERED。
- Rule v3 一旦参与真实订单不可修改；变更生成 v4。
- ServiceCompleted 触发 Commission Calculator 生成 commission_entry。
- 后续退款/纠错通过 commission_adjustment，不删除或改写原 entry。

## 16. Audit / Security / Privacy / Observability

### 16.1 必须审计的动作

登录失败、权限变化、设备绑定/解绑 · 开房/换房、手工排钟/调牌、上/下钟、服务时间覆盖、退钟/终止 · 折扣、免单、订单作废、退款 · 会员充值、钱包调整、提成调整、库存调整、配置修改。

Audit 普通应用角色只能 INSERT，不得普通 DELETE。Audit 不记录 password、token、payment secret、完整银行卡或其他敏感明文；手机号在日志中脱敏。

### 16.2 安全测试基线

- 跨租户/跨门店 IDOR / BOLA。
- Broken Authentication / Broken Function Level Authorization。
- 伪造 storeId / roomId / payment success / replay。
- 输入验证、XSS、CSRF、SSRF、路径遍历、文件上传（若存在）。
- 限流：登录、支付、退款、设备注册、公开查询等。

### 16.3 Observability

- 所有请求含 requestId / traceId。
- 结构化日志包含 service/store/actor/device/action/resource/result/latency，敏感字段脱敏。
- Metrics：API error/latency、DB pool、Redis、WebSocket、Edge sync lag、outbox pending、device online、payment failure、active rooms/services 等。
- 提供 /live 与 /ready；live 表示进程活着，ready 表示可真实处理请求。

## 17. TDD Test Matrix

### 17.1 Domain / Integration

| 域 | 必须覆盖 |
|---|---|
| Room | 全部合法/非法 transition |
| Technician | shift / lock / service transitions |
| Scheduling | eligibility / fairness / requested / concurrency |
| Service | start / extend / complete / change / terminate |
| Order | totals / discounts / void / snapshot |
| Payment | idempotency / duplicate callback / timeout / split / refund |
| Wallet | recharge / consume / refund / principal+bonus / concurrency |
| Commission | 所有 rule type / immutable versions / adjustments |
| Authorization | cross-store / cross-tenant / object scope |

Integration tests 必须使用真实 PostgreSQL，不使用 SQLite 模拟 PostgreSQL 锁/事务/索引语义。

### 17.2 Golden Path E2E

```
Guest → Open Room → Add Service → Rotation Schedule → Technician ACK / Arrive / Start
→ Add Product → Extend → Complete → Checkout → Split Payment → Paid → Dirty → Cleaning → Vacant Clean
```

### 17.3 Offline / Reliability

- 断外网 30 分钟，Edge 继续营业。
- Edge 重启、Cloud 恢复、ACK 丢失、outbox 重复上传、Cloud 500、事件乱序。
- 不得产生重复订单、重复服务、重复支付、重复提成或钱包损坏。

## 18. CI/CD、Migration、Backup 与发布门禁

### 18.1 PR 门禁

install · format check · lint · typecheck · unit tests · integration tests · migration test · OpenAPI contract validation · build · security checks

主干额外运行关键 E2E；Release 运行 staging deploy、migration dry-run、smoke 和 rollback verification。

### 18.2 Migration Policy

- 每个 migration 明确旧数据、NULL、索引、锁表风险、兼容窗口与回滚/前滚策略。
- 禁止将破坏性 schema 与不兼容代码一次性不可逆上线。
- 大表 NOT NULL / type change 等变更采用分步迁移。

### 18.3 Backup / Restore

Cloud PostgreSQL 至少设计每日备份 + PITR 能力，并编写 backup-restore runbook。最终门禁必须实际执行 Restore Drill；“配置了备份”不等于“可恢复”。

## 19. Codex 分阶段 Task List

| Phase | 名称 | Goal | 关键验证 |
|---|---|---|---|
| 00 | Repository Foundation | monorepo、工具链、CI、Docker dev、AGENTS/PLANS/docs skeleton | install/lint/typecheck/test/build |
| 01 | Database Foundation | PostgreSQL、migration、organizations/stores/identity/RBAC | migration fresh/up/down where safe |
| 02 | Authentication & Authorization | auth、store scope、object authorization、permissions | cross-store IDOR regression |
| 03 | Room Domain | Room state machine + persistence/API | transition tests |
| 04 | Technician Domain | technician/skill/shift/status/history | state + history tests |
| 05 | Scheduling | queue/recommend/assign/rotation/requested/manual/skip/lock/compensation | 并发同技师仅一个成功 |
| 06 | Visit / ServiceSession | 完整服务执行链 | domain + integration |
| 07 | FrontDesk Room Board | 首个真实 Web vertical slice | 真实 API，不以 mock 冒充完成 |
| 08 | Clock Board | 真实 queue / recommendation / explainability | UI + API E2E |
| 09 | Android Enrollment | 设备注册/审批/绑定 | 未绑定设备不可访问房间业务 |
| 10 | Android Room Core | vacant/waiting/service/timer/extend/products/requests/offline | reboot/crash/offline |
| 11 | Order Engine | Order/OrderItem/pricing/discount/checkout | 金额与快照 |
| 12 | Cash Payment | 现金支付、cash session | 对账 |
| 13 | Split Payment | 多 payment allocation | 混合支付 |
| 14 | Customer / Member | 客户与会员基础 | lookup/privacy |
| 15 | Wallet Ledger | 本金/赠金账本、并发 | Blocker 级并发/对账 |
| 16 | Refund | 审批+退款+wallet reversal+audit | 重复退款/失败 |
| 17 | Commission | versioned declarative rules | 工资样本回归 |
| 18 | WebSocket | storeSeq/replay/reconnect/snapshot fallback | 断线补事件 |
| 19 | Edge Runtime | 本地 API/Postgres/Redis/Sync | 本地可营业 |
| 20 | Transactional Outbox | crash-safe sync | crash simulation |
| 21 | Offline Operation | 断网 Golden Path | 30min offline |
| 22 | Reconciliation | order/payment; wallet/ledger; service/commission; edge/cloud | 自动差异检测 |
| 23 | Approval / Audit Hardening | 高风险审批与审计 | 权限与日志完整性 |
| 24 | Security Pass | 独立 Red Team | Blocker/High 清零 |
| 25 | UX Hardening | 真实营业效率、错误/空/加载/离线状态 | 键盘/触屏/可访问性 |
| 26 | Backup / Restore | 真实恢复演练 | restore proof |
| 27 | Full E2E | 全部 Golden Path | 自动化通过 |
| 28 | Production Readiness Review | tests/security/migrations/backup/observability/rollback/docs | 仅当门禁通过才 Production Ready Candidate |

### 19.1 每个 Phase 文件模板

Goal · Current State · Scope · Non-goals · Files · Architecture Decisions · Acceptance Criteria · Tests · Security Considerations · Migration Considerations · Rollback · Risks · Definition of Done · Verification Result

## 20. Production Invariants 与 Definition of Done

1. 一个房间最多一个 active Visit。
2. 一个技师最多一个 active ServiceSession。
3. 一个 Provider transaction 只能入账一次。
4. 同一 Idempotency-Key 不产生两个不同业务结果。
5. 钱包余额不能无 Ledger 改变。
6. 提成不能无 ServiceSession/Adjustment 来源产生。
7. 订单、支付与退款必须可数学对账。
8. 所有跨门店/跨租户访问必须显式授权。
9. 所有高风险修改必须有 Audit。
10. Cloud 离线不得导致真实营业事件丢失。
11. 历史订单保存成交快照。
12. 历史提成规则版本不可变。
13. 支付成功不信任客户端自报。

### 20.1 Phase DoD

implementation exists · tests added and pass · lint passes · typecheck passes · build passes · migration verified if relevant · security reviewed · docs updated · no known Blocker

不满足则只能标记 IMPLEMENTED BUT NOT VERIFIED 或 BLOCKED，不得写 DONE。

### 20.2 Production Ready Candidate

- Golden Path works；自动测试通过。
- 权限与资金 invariants 已验证。
- 离线路径已验证。
- Backup Restore 已验证。
- Observability 与 rollback 存在。
- 无未解决 Blocker / High 安全问题。

## 21. 暂不冻结的真实业务政策

- 点钟是否下牌；退钟如何补牌；加钟是否改变轮牌。
- 预约提前多久锁技师；不同门店“优轮/补钟”规则。
- 真实技师工资/提成公式。
- 折扣与退款审批金额阈值。
- 真实微信/支付宝/聚合支付商户模式与 Provider API。
- 实际营业城市的预付消费/会员储值合规细则。

这些未知项不能被 Codex 猜成“唯一正确规则”。应建立 rule/config abstraction，并使用明确开发默认值，同时标记 BUSINESS POLICY — REQUIRES PILOT VALIDATION。

### 21.1 试点前必须获取的真实样本

1. 一家真实门店完整排钟 SOP：点钟、轮钟、加钟、补钟、跳钟、退钟、预约。
2. 至少一个完整工资周期的脱敏技师工资/提成样本。
3. 真实收银小票和日结单。
4. 20–50 个真实异常案例：退钟、换技师、支付失败、余额不足、断网、客诉退款等。
5. 真实支付渠道信息、营业城市、Android 硬件样机。

## 22. Red Team 与 Kill Criteria

### 22.1 Blocker

双重排钟 / 技师双重服务 · 重复支付 / 重复退款 · Wallet 并发双扣或账本与余额不一致 · 跨店/跨租户越权 · Room Device 越权 · 离线事件丢失或重复导致账务/提成重复 · 客户端伪造支付成功 · 资金金额使用浮点数 · Audit 可被普通业务管理员删除。

### 22.2 High

退款/改价/改钟无审批 · 提成历史规则可直接修改 · 设备可轻易退出 Kiosk · Edge 同步冲突用 last-write-wins · 无实际 Restore Drill。

### 22.3 Kill Criteria

| 类别 | 停止/转向条件 |
|---|---|
| 技术 | 仍存在重复订单/扣款、余额错误、技师双重分配、钟单丢失 → STOP expansion |
| 用户 | 员工持续绕过系统使用纸笔/群聊/Excel → PIVOT UX/workflow |
| 经营 | 开房、排钟、结账效率明显低于旧系统 → PIVOT |
| 数据 | 月底仍需人工重新算提成/营业额才能可信 → 系统不可信，停止扩张 |

## 附录 A：可直接复制给 Codex 的一次性执行指令

说明：下面这段是给 Codex 的“启动指令”。完整技术与业务规范以本文件前述章节为 Source of Truth。若 Codex 可读取仓库文件，应先把本文件或等价 Markdown 规范保存进 docs，再持续执行。

> 你现在是“澜序 LanXu StoreOS V1”的 Principal Software Engineer + Software Architect + Backend/Frontend/Android/Database/Security/QA/DevOps/SRE + Independent Reviewer。
>
> 目标不是生成 Demo，而是把当前仓库推进为可真实门店营业的软件系统。请直接执行，不要只给方案。
>
> 执行流程必须是：Inspect → Plan → 建立精简 AGENTS.md / PLANS.md / docs / harness → Phase 00 → Verify → Repair → Phase 01 → Verify → Repair → 持续推进。
>
> 如果仓库已有代码：先读 AGENTS.md、README、架构文档、源码、测试、Schema、migration、CI 和真实调用链，不得覆盖重建或凭文件名猜。
> 如果仓库为空：按本规格建立 monorepo、CI、dev environment、文档和第一批测试。
>
> 永久规则：
> 1. Correctness > Security/Authorization > Data/Financial Integrity > Reliability > Testability > Maintainability > UX > Performance > Visual polish。
> 2. 不得通过删测试、skip 关键测试、放宽权限、删 constraint、吞异常、关闭 typecheck、hardcode success 或假数据冒充集成来让构建通过。
> 3. 所有业务状态改变通过领域 command/state machine，禁止客户端任意 PATCH status。
> 4. 所有资金变化可追溯：Payment/Refund/Wallet Ledger/Commission 都不得改写历史来“修账”。
> 5. 所有跨 organization/store/resource 访问必须服务端对象级授权；客户端传入的 storeId/roomId/userId 不可信。
> 6. 支付成功只相信服务端验证的 provider 状态；危险写操作必须幂等。
> 7. Edge/Cloud 使用 transactional outbox/inbox + eventId 去重；关键业务禁止 last-write-wins。
> 8. 真实排钟/提成/审批阈值若缺失，不得编造唯一规则；做配置化默认值并标 BUSINESS POLICY — REQUIRES PILOT VALIDATION。
> 9. 每个阶段必须在 harness/phases/ 记录 Goal/Scope/Files/Acceptance/Tests/Security/Migration/Rollback/Risk/DoD/Verification。
> 10. 每个阶段完成前执行适用的 lint/typecheck/unit/integration/migration/API contract/build/E2E/security checks。未执行项明确 NOT VERIFIED。
>
> 核心 Golden Path：顾客到店 → 会员/散客 → 开房 → 项目 → 排钟/点钟 → 技师确认/到房 → 上钟 → 服务/商品/加钟/换技师 → 下钟 → 结账 → 支付 → 清房 → 空净。
>
> 核心技术基线：Next.js/React/TypeScript；NestJS+Fastify；PostgreSQL 18；Redis；WebSocket；Android Kotlin+Jetpack Compose Dedicated Device/Lock Task；Edge Node+PostgreSQL+Redis+Docker Compose；OpenAPI 3.1.2；OpenTelemetry；UUIDv7；金额 BIGINT cents；时间 timestamptz + business_date。
>
> 核心架构：Modular Monolith，模块至少 Auth/Organization/Employee/Room/Catalog/Technician/Scheduling/Visit/ServiceSession/Order/Payment/Member/Wallet/Commission/Device/Approval/Audit/Reporting/EdgeSync。
>
> 核心 DB invariants：一个房间最多一个 active Visit；一个技师最多一个 active ServiceSession；provider transaction 唯一；Idempotency-Key 唯一结果；Wallet 余额只能由 Ledger 变化；历史 Order 保存成交快照；Commission 引用不可变 rule version；Audit append-only；真实营业事件不因 Cloud 离线丢失。
>
> 核心状态机、Schema、排钟、API、WebSocket、Room/FrontDesk UI、RBAC、Offline Sync、Payment、Wallet、Commission、Audit、TDD、Phase 00–28 的详细规则全部以《澜序 StoreOS V1 — Codex One-Shot Master Prompt》本文档为 Source of Truth。
>
> 现在立即开始：
> 1. 检查当前仓库并写 harness/context/repository-baseline.md。
> 2. 建立精简 AGENTS.md、PLANS.md、架构/invariants/threat-model/runbooks。
> 3. 创建 Phase 00 并实际实施。
> 4. 运行验证；失败先收集证据与修根因。
> 5. 通过后继续 Phase 01、02……直到当前环境能力或真正外部依赖阻塞。
> 6. 不要因为任务大就停在“计划如下”。在有代码执行权限的环境中直接工作。
> 7. 每轮最终只报告 Implemented / Verification / Not Verified / Known Risks / Blockers / Current Phase / Next Phase，禁止夸大完成状态。

## 附录 B：外部规范与参考来源（2026-10-28 核对）

| 来源 | 链接 | 用于本规格的依据 |
|---|---|---|
| OpenAI — Iterating Development Workflows with Codex | https://developers.openai.com/cookbook/examples/codex/iterating-development-workflows-with-codex | AGENTS.md 作为持久仓库指导；PLANS.md / harness 工作流约定 |
| OpenAI — Harness Engineering | https://openai.com/index/harness-engineering/ | 仓库作为记录系统；给 agent“地图而不是 1000 页说明书” |
| PostgreSQL 18 — Data Definition / Constraints | https://www.postgresql.org/docs/18/ddl.html | CHECK / NOT NULL / UNIQUE / PK / FK / Row Security |
| PostgreSQL 18 — Unique Indexes | https://www.postgresql.org/docs/18/indexes-unique.html | 唯一索引与部分唯一约束 |
| RFC 9562 — UUIDs | https://www.rfc-editor.org/rfc/rfc9562.html | UUIDv7 时间有序格式 |
| OpenAPI Specification 3.1.2 | https://spec.openapis.org/oas/v3.1.2.html | HTTP API 契约规范 |
| Android Developers — Lock task mode | https://developer.android.com/work/dpc/dedicated-devices/lock-task-mode | Dedicated Device/Kiosk Lock Task 与 DPC allowlist |
| OWASP API Security Top 10 | https://devguide.owasp.org/en/07-training-education/07-api-top-ten/ | BOLA、认证、功能级授权等 API 风险基线 |

## 附录 C：文档状态

| 项目 | 当前状态 |
|---|---|
| 产品/系统架构 | 可进入仓库实施 |
| 核心 Schema / 状态机 / API / 同步原则 | 开发冻结候选 |
| 排钟参数 | 需要真实门店 SOP 验证 |
| 提成参数 | 需要真实工资样本验证 |
| 支付 Provider | 等待真实商户/渠道 |
| 特定城市预付合规 | 等待实际营业城市确认 |
| 生产完成 | 未达到；需实际实现、自动验证、试点与 Red Team |

准确结论：功能规格已达到可启动工程仓库的程度，但尚未达到生产完成标准。Production Ready 只能由真实测试、权限/资金不变量验证、离线恢复、备份恢复、监控与回滚证据共同证明。
