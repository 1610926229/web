# PROD-1E — Complete PostgreSQL Migration & Runtime Activation

> 原始开发指令档案。正文保持用户原话。

---

## 主指令

```
# PROD-1E — Complete PostgreSQL Migration & Runtime Activation

从现在开始采用连续执行模式。

目标：不增加任何新产品功能，把当前系统剩余 Mock persistence 全部迁移到
PostgreSQL，并最终让核心业务真实运行在 PostgreSQL 上。

不要为了历史规划机械拆成 PROD-1E / 1F / 1G 多个小 Round。
本轮内部可以分多个 Wave，但最终作为一个完整 PostgreSQL migration /
activation Round 交付。

自动执行规则：除以下情况外，不要停下来询问用户：
1. 遇到真正无法从当前代码、既有业务规则和数据库约束推导的产品决策；
2. 出现 BLOCKER，继续会产生业务数据错误；
3. 需要用户提供外部凭证、账号或第三方平台信息；
4. PostgreSQL 全量迁移已经完成，准备正式交付人工验收。

MINOR / NOTE / 普通技术取舍：自行采用最小改动、保持业务语义的方案处理并记录。
禁止为了确认常规工程选择反复询问用户。

Git Discipline 仍然严格禁止任何 Git 写操作：
git add / git commit / git push / git reset / git restore / git checkout /
git rebase / git amend。
可以：status / diff / log / show。
本轮所有工作可以留在工作区，最终由用户一次性 review + commit。
连接中断后必须从当前工作区恢复，不得重复创建 migration / repository /
transaction。
```

## Phase 0 — 重新建立当前真值

```
不要依赖旧数字。重新生成当前：
- 28 Repository migration matrix
- Transaction matrix
- writeAudit matrix
- schema matrix
- runtime datasource matrix

确认 PROD-1D 已提交、工作区干净后直接继续。
```

## Phase 1 — 迁移全部剩余业务域

```
user, catalog, content, staff, agreement, qualification, level, tip,
message, review, admin, companionApplication + 任何新扫描出的 Mock-only
repository。

禁止仅因为「当前访问不多」而保留 globalThis 作为生产真值。
```

## Phase 2 — 剩余 Admin Write Closure

```
直到 Mock-only AdminAudit writer = 0。
```

## Phase 3 — Schema

```
users, admin_accounts, categories, products, product specs, announcements,
banners, quick entries, agreements, staff, companion applications,
qualifications, reviews, plus message/chat, level, tip and others；
从 interfaces / Mock repos / transactions / DTOs 推导最小 schema——
不是从表名推导。
money 用整数「分」；时间统一 timestamptz UTC；
FK / UNIQUE / CHECK 只用于真实不变式；
0001–current migrations 不得修改；新 schema 走新的连续版本号 migration。
```

## Phase 4 — 零业务漂移

```
Mock 行为是迁移的语义基线；历史 bug 予以登记，不修（除非它会破坏 DB 正确性）。
```

## Phase 5 — Repository Contract

```
Mock + Pg + 统一接口，Mock/Pg 契约等价；禁止静默 Mock fallback。
```

## Phase 6 — Datasource Activation Architecture

```
DATA_SOURCE 未设置/mock → Mock；
DATA_SOURCE=postgres → 全部核心 repository 走 PostgreSQL；
任何核心 repository 缺 Pg 实现时，在启动或首次 datasource 构造时 fail-fast。
```

## Phase 7 — Transaction Runtime 接线

```
Service 按 datasource 选择**完整**的事务实现；
不允许 Repository→Pg + Transaction→Mock；
不允许一个原子闭包内一半 Pg 一半 globalThis。
```

## Phase 8 — 身份闭环

```
Mock/dev identity switcher 可以继续作为鉴权机制，
但该用户/打手/管理员**持久化的业务记录**必须来自 PostgreSQL；
未接微信 OAuth 不得阻塞用户实体 Pg 迁移。
```

## Phase 9 — Chat / Message 持久化迁移

```
保持已冻结规则：
按派单(assignment)分会话、A→B→A 是不同会话、旧打手失去未来访问、
历史分段只读、客服会话独立、全额退款后派单会话只读。
不引入 websocket / 实时推送 / 图片 / Redis / MQ；保留轮询 / HTTP。
```

## Phase 10 — Seed / Reset

```
核心 users, admin/staff, companion, catalog, order-lifecycle objects,
coupon, platform config, content, review；
测试 reset 必须覆盖新表；
生产 seed / reset 安全守卫不得被削弱。
```

## Phase 11 — Mock Isolation

```
DATA_SOURCE=postgres 时，核心业务链不得写入或依赖 Mock persistence；
tests / dev datasource / dev identity switcher / 显式 fixture 除外。
```

## Phase 12 — Activation

```
只有全部通过之后才激活；不得提前切换以观察效果。
```

## Phase 13 — 全业务真库 E2E

```
user 登录→浏览商品→用/不用券下单→支付→查看订单；
Dispatch 专属/公共派单→接单→开始服务→完成材料→审核完成；
Revenue earning 冻结→到期 release；
Refund 用户退款→Staff/Admin review→partial/full→earning adjustment；
Complaint 创建→管理员处置→blocking fact；
Review 用户评价→Admin approve/reject/hide/unhide→公共聚合；
Admin Catalog/Content/Coupon/Platform config/Staff/Companion/Agreement；
Persistence across service restart。
```

## Phase 14 — PostgreSQL 并发回归

```
重跑所有既有 Pg 并发测试；
在新增 schema 有竞争不变式处补真库并发测试；
不要把并发测试强加到纯 CRUD 上。
```

## Phase 15 — 全量回归

```
targeted tests / pnpm test:pg / pnpm test / 生产 APP_BASE_URL 全量 /
pnpm typecheck / pnpm lint / pnpm build；
最终 0 fail；生产全量 0 skipped；任何 skip 逐条解释。
```

> ⚠️ **用户更正（2026-10-11）**：本条最初写作「`pnpm test:pg` / `pnpm test` / …」时重复了
> 两次 `pnpm test`，**第二个应为 `pnpm test:pg`**。以本更正后的口径执行：
> `targeted tests` → `pnpm test`（全量，含 24 个需要 `APP_BASE_URL` 的 HTTP 用例）
> → `pnpm test:pg`（真库队列）→ 生产 `APP_BASE_URL` 全量 → `typecheck` / `lint` / `build`。
> 其余指令不变。

## Phase 16 — 独立只读 Reviewer

```
剩余 Mock 泄漏、Pg→Mock 副作用、半事务、缺失 FK/unique 约束、
金额精度、时间戳正确性、锁顺序、死锁风险、replay/幂等、
AdminAudit 原子性、DTO 隐私、seed/reset 安全、datasource fail-fast、
业务规则漂移、runtime activation 正确性；
要求 0 BLOCKER / 0 MAJOR。
```

## Phase 17 — Activation Readiness Final Report

```
Repository 总数 / 已 Pg 实现 / 运行时 Pg / Mock-only；
Transaction 总数 / 已 Pg 实现 / 运行时 Pg / Mock-only；
AdminAudit 总数 / Pg 原子 / Mock-only writers；
Schema migration 数 / 业务表数；
DATA_SOURCE=postgres YES/NO 及完整证据，或继续修。
```

## Phase 18 — Round 文档

```
docs/03-dev/rounds/PROD-1E/：
Wave A schema / B repositories / C admin transactions /
D runtime wiring / E activation / F E2E+regression；
最终 PROD-1E = AWAITING_ACCEPTANCE，永不 DONE。
```

## Stop Conditions

```
Case A 激活成功 → 最终报告，停在 AWAITING_ACCEPTANCE；
Case B 阻塞性产品决策 → 一次性列出并停止；
Case C 需要外部凭证 → 说明需要什么并停止。
除此之外：继续执行。
```
