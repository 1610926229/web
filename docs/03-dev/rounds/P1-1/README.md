# P1-1 · 管理员首页经营概览 + 待办聚合

Round ID: P1-1
Title: 把 `/admin` 从入口页升级为管理员经营首页 —— 今日订单数 / 今日 GMV / 今日退款金额 + 管理员当前待办 + 模块快捷入口
**Status: `AWAITING_ACCEPTANCE`**
Depends On: P0-1（平台参数）· P0-11 / P0-12 / P0-13（退款金额链路与 `RefundDecision`）· P8C（订单 / 退款 / 投诉三模块）—— 均为 `DONE`
Goal: 在**不加任何状态机、不写任何业务数据**的前提下，把管理后台首页做成真正能用的经营首页：三个「今日」口径的经营数字、三类管理员待办、以及指向真实模块的快捷入口。**不修改交易状态机，不做趋势图与任何画像。**
Primary Domain: Admin Dashboard（只读聚合）· Order（只读）· RefundRequest（只读）· Complaint（只读）· CompanionApplication（只读）
Primary State Transition: **无**。本轮**不产生任何写入**：不审批、不退款、不换人、不改申请状态、不建新状态
Started At: 2026-09-27
Development Completed At: 2026-09-27
Review: **两轮** `reviewer-agent` 只读审查。第一轮 **0 BLOCKER · 2 MAJOR · 4 MINOR · 6 NOTE**（见 `03-delivery.md` §4）；R6 fix 之后的第二轮 **0 BLOCKER · 1 MAJOR · 4 MINOR · 4 NOTE**（见 §8.4）。两轮的全部 BLOCKER / MAJOR 与 MINOR 均已修完，NOTE 逐条登记
Accepted At: —（⚠️ **Claude 不得自行 `DONE`**，等待产品负责人人工验收）
Git Commit: —（⚠️ 本批次**禁止任何 Git 写操作**，交付时点 `Git Commit` 留空是该时点的正确状态）

> ⚠️ **Claude 不得自行 `DONE`。** 本轮交付后停在 `AWAITING_ACCEPTANCE`，等待产品负责人人工验收。

---

## 状态沿革

| 时点 | 状态 | 依据 |
|---|---|---|
| 2026-09-27 | `PLANNED` | 档案建立（`01-prompt.md` 逐字保存） |
| 2026-09-27 | `READY` | Requirement Check 完成，**无 `OPEN` 决策**、不进入 `CLARIFYING`（见 `02-decisions.md` §二） |
| 2026-09-27 | `IN_PROGRESS` | 开始按 `01-prompt.md` + `02-decisions.md` 开发 |
| 2026-09-27 | `AWAITING_ACCEPTANCE` | 门禁全绿 + `reviewer-agent` 回报（0 BLOCKER / 2 MAJOR / 4 MINOR / 6 NOTE）→ 2 MAJOR 与 4 MINOR **全部修完** → **整套复跑**：targeted 41/38/0/3 · `pnpm test` 1487/1328/0/159 · `typecheck` / `lint` / `build` 均 exit 0 · 生产 `APP_BASE_URL` **1487/1487/0/0**。读数与处置见 `03-delivery.md` §3 / §4 |
| 2026-09-27 | `IN_PROGRESS` | **第二次指令到达**（`cmd_p1-1.md`，逐字留存在 `01-prompt.md` 第二段）：§六 作出 **R6 正式裁定**——「Dashboard 数量必须与点击后的列表一致」，推翻上一行末尾那条「披露式处置」。本轮**未 DONE**，因此按协议**回到 `IN_PROGRESS`** 做验收前 fix，而不是新开一轮 |
| 2026-09-27 | `IN_PROGRESS`（fix 开发中） | R6 fix 落地，**门禁首轮**跑通（当时的读数见 `03-delivery.md` §3.2 的历史行）。⚠️ **此时还没有跑 reviewer**，因此这一行**不是** `AWAITING_ACCEPTANCE`——按协议，reviewer 与它之后的那次完整复跑才算收尾 |
| 2026-09-27 | `AWAITING_ACCEPTANCE` | R6 fix：第二轮 reviewer 回报（**0 BLOCKER · 1 MAJOR · 4 MINOR · 4 NOTE**）→ 1 MAJOR + 4 MINOR **全部修完** → **最终完整复跑**：targeted 136/117/0/19 · `pnpm test` **1494/1335/0/159** · `typecheck` / `lint` / `build` 均 exit 0 · 生产 `APP_BASE_URL` **1494/1494/0/0**（`fail = 0` · `production skipped = 0`）。干净 store 对拍：卡片 == `?status=open` == `{2,4,3}`，`?status=pending` == `{1,3,1}`。读数与处置见 `03-delivery.md` §3.2 / §8 |

> `AWAITING_ACCEPTANCE` 一行在门禁与 reviewer 真的跑完之后才追加（`03-delivery.md`）——
> **没有跑过的门禁不写进档案**。

> ⚠️ 上面这一行是**先跑完门禁、拿到读数之后**才写的：reviewer 的 NOTE n1 指出档案里一度
> 出现过「已交付」措辞早于门禁的情况，此处按事实纠正。

> ✅ **R6 已由产品负责人裁定并落地**（`cmd_p1-1.md` §六 → `02-decisions.md` §八）。
> 上一版 README 在这里写着「⚠️ 尚有一项需产品负责人复核：卡片与列表不相等（披露式处置）」——
> 那一条已被裁定**推翻**：判据是「卡片上的数就是点进去能看到多少条」。
> 现在三张卡与三个列表在 `status=open` 上**同源**（卡上的数直接取列表服务的 `total`），
> 修复后实测卡片 `{2, 4, 3}` == `?status=open` total `{2, 4, 3}`，
> 而 `?status=pending` 是 `{1, 3, 1}`——**严格更少**，正是原报告里那条「点进去更少」的形态。

---

## ⚠️ 开工前的工作区检查（协议 §二十）

本批次开工时，工作区**已有上一批未提交内容**：P0-14 的完整交付（26 个已跟踪文件被修改、
12 个新增代码/测试文件、`docs/03-dev/rounds/P0-14/` 档案），且 P0-14 停在
`AWAITING_ACCEPTANCE`，**用户尚未提交**。

按协议「发现仍有上一批未提交内容，**先报告**，不要偷偷吸收到下一批」——
这里如实报告，并明确：

- P1-1 的落点见 `03-delivery.md` §2.1 / §7，**绝大多数文件两者可分辨**；
- ⚠️ **但有三处例外，必须点名**（早先「完全可分辨」的说法是不准确的，此处按事实更正）：
  1. `lib/services/staffConversations.ts` —— **同一个文件里同时有两批改动**：P0-14 的
     「会话按订单合并」（一单可有多段 assignment 会话）与 P1-1 的 `statuses` 形参改名、
     以及本轮 reviewer MAJOR 修掉的那两行。`git diff` 里两者交织，无法按文件切开。
  2. `docs/02-tech-design/api-contract.md` —— 两个批次都要在这份契约文档里登记，本就共用；
  3. 其余 `P0-14` 的文件（`lib/services/conversations.ts`、`lib/data/messageRepository.ts`、
     `lib/constants/service.ts`、`lib/constants/staff.ts`、`lib/mocks/fixtures/messageSeed.ts`
     等）**只有 P0-14 的改动**，P1-1 一个字都没碰。

  ⇒ **提交时若按文件 `git add`，第 1 项会把两批改动一起带上。** 这一点留给产品负责人在
  人工验收时决定如何处理（拆提交需要先把该文件的两批改动分开，本轮**禁止 Git 写操作**，
  因此只做报告，不动手）。
- P1-1 **不在 P0-14 的业务实现里加任何逻辑、不改 P0-14 的状态**；
- 提交由用户自行完成，**本轮禁止一切 Git 写操作**。

---

## 五件档案

| 文件 | 内容 |
|---|---|
| `01-prompt.md` | 原始指令档案（用户提示词原样保存） |
| `02-decisions.md` | Requirement Check 结论、口径裁决 D1–Dn、与既有文档的关系 |
| `03-delivery.md` | 实现结果、文件清单、门禁读数、reviewer 结论、Git 状态 |
| `04-acceptance.md` | 人工验收清单（编号步骤 + 预期结果） |
| `README.md` | 本文件 |
