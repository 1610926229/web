# P0-10 · 客服全量订单查询工作台

Round ID: P0-10
Title: 客服全量订单查询工作台（`/staff/orders` + `/staff/orders/[id]`）
Status: AWAITING_ACCEPTANCE
Depends On: P0-9（`DONE`，`eef4e62`）— 客服侧订单只读详情所依赖的 Completion / Complaint / Refund / Earning 事实链
Goal: 补齐 P0「客服查看订单」。新增统一客服订单入口（列表 + 详情），复用现有 Staff Auth 与 Order / Refund / Complaint / Completion / Dispatch 数据，**不创建第二套订单系统**；本轮到查询与只读详情为止。
Primary Domain: Staff（客服工作台）· Order 只读查询
Primary State Transition: 无（本轮**不引入任何新的状态迁移路径**；两个接口各挂一次既有的幂等惰性物化，理由见 `02-decisions.md` §九 A9-4）
Started At: 2026-09-24
Development Completed At: 2026-09-24
Accepted At:
Git Commit: ——（本批次禁止 Git 写操作；提交由用户本人完成，Claude 无权代填）

> ✅ **开发已于 2026-09-24 完成，自动门禁全部通过**（`03-delivery.md` §六，**复核整改之后**的读数）：
> `pnpm test` **1278** / fail 0 · 生产 `APP_BASE_URL` 全量 **1278/1278 / fail 0 / skipped 0** ·
> typegen + `tsc --noEmit` · `eslint`（0 error 0 warning）· `next build` 全部 exit 0。
>
> ✅ **只读 reviewer 复核已结束并整改完毕**（`03-delivery.md` §七）：
> **BLOCKER 0 / MAJOR 1 / MINOR 4 / NOTE 7** → **MAJOR 与 MINOR 全部修完并复跑门禁，现为 0 / 0**。
> 那 1 条 MAJOR 是**回归保护缺失**（两条新接口此前没有任何 HTTP 级测试，
> 而 `null → 404` 这条映射**在全仓无覆盖**），reviewer 已手工确认**行为本身都是对的**。
> 整改内容：`tests/staffOrders.test.mjs` 追加 **5 条 HTTP 契约用例**（17 → **22** 条），
> 并对新增用例做**受控 mutation** 证明它们真会红（§7.3，含一次被安全策略拒绝的 mutation 及替代证明）。
>
> ✅ **验收前整改 A0 已完成（2026-09-25）**：产品负责人裁定 `02-decisions.md` §九 **A9-9**
> 选**方案 B**——`/staff/orders` **新增** `displayId` 一路，**既参与搜索、也展示在页面上**；
> 旧的内部标识 `u-1001` **继续可搜**（是新增，不是替换）。
> 改动 3 个文件（`lib/types/staff.ts` · `lib/services/staffOrders.ts` · 两个客服订单组件），
> 测试钉进既有的「列表 3」与 DTO 边界两条**而不新增顶层用例**（22 条不变）——
> 因为 A0 修的是**既有用例宣言覆盖、实际没盖住**的地方。记录见 `03-delivery.md` §十一。
> ⚠️ 会话 / 退款 / 投诉 / 完成材料四个客服页面**按裁定「不扩展业务范围」一个字没改**，
> 由此产生的「客服工作台内部有两种平台 ID」已由 A9-11 登记为**遗留项**，**不是缺陷**。
>
> ⏸️ **当前状态 `AWAITING_ACCEPTANCE`——等用户本人验收。**
> 验收清单见 `04-acceptance.md`，其 **A0** 已由「⚠️ 待产品裁定」改为「✅ 已裁定并已修复」，
> 验收动作变成「**验一下真的搜得到了**」。
>
> ⚠️ **`Status` 不由 Claude 改成 `DONE`**：按「DONE 双门槛」，需要 ① 用户本人说明验收通过
> **且** ② 用户本人完成 Git 提交。本批次（P0-10 → P0-13）**禁止任何 Git 写操作**。

---

## 本轮范围

**做**：

- `/staff/orders` 列表页 + `/staff/orders/[id]` 详情页；
- Staff 导航新增「订单」入口；
- 列表：搜索（订单号 / 用户昵称 / 平台 ID / 商品名）、筛选（状态 / 游戏 / 时间范围）、分页、创建时间降序 + 稳定次级排序；
  ✅ 「平台 ID」这一项**已补齐**（2026-09-25 整改 A0，`02-decisions.md` §九 **A9-11**）：
  客服订单页同时认**用户资料页上那串** `displayId`（形如 UUID）与内部平台标识 `u-1001`
  （形如 `u-1001`），**两串都显示在页面上**、两串都能搜到。
  ⚠️ 会话 / 退款 / 投诉 / 完成材料四页**仍只有内部标识**——那是裁定明确划定的范围外，
  登记为遗留项而非缺陷；
- 详情：订单号、状态、用户摘要、商品/规格/增值服务快照、必要金额、当前打手、Dispatch 摘要、Completion / Complaint / Refund 摘要、`CompanionReleaseRecord` 历史；
- Staff 独立 DTO（最小化，不暴露 Admin-only 财务字段）。

**不做**（本轮明确边界）：

- ❌ 换打手 / re-pool（P0-11）
- ❌ 退款 / 售后资金动作（P0-12 / P0-13）
- ❌ 任何**客服可触发**的订单状态变更（换人 / 退款 / 改单）。
  ⚠️ 两个接口各挂一次**幂等的惰性物化**（派单超时、完成材料到期自动通过），
  那是既有读取路径惯例、不是客服的动作——见 `02-decisions.md` §九 A9-4
- ❌ 第二套 Order / Refund / Notification / Auth / 复杂 Assignment

---

## 权威依据

| 事项 | 文档 |
|---|---|
| 客服可「查看工作所需订单」 | `docs/01-requirements/超哥电竞_用户权限表.md` §7.1 |
| 客服「只开放履职需要的信息」 | 同上 §10「数据最小化要求 · 客服」 |
| 客服**不可**看分账比例 / 最终资金 | 同上 §7.2 |
| 权限开发纪律（页面级 + 服务端鉴权 + DTO 最小化 + 401/403/404 测试） | 同上 §十三 |
| 分层与 DTO 裁剪职责 | `docs/02-tech-design/architecture-rules.md` §2.2 / §2.3 |
| 客服身份守卫 `requireStaff()` | 同上 §4.2 |
| 客服接口清单门禁须同批扩充 `tests/staff.test.mjs` | 同上 §十.4 |
| 本批原始指令 | `docs/03-dev/rounds/cmd_p0-10.md` → `01-prompt.md` |
| 批次约束 | `docs/03-dev/rounds/cmd_batch_p0-10_to_p0-13.md` |

---

## 五件档案

| 文件 | 内容 |
|---|---|
| `01-prompt.md` | 原始指令档案（`cmd_p0-10.md` 原样） |
| `02-decisions.md` | Requirement Check 结果、决策与执行口径 |
| `03-delivery.md` | 实现结果与验证 |
| `04-acceptance.md` | 人工验收记录 |
| `README.md` | 本文件 |
