Round ID: DEV-2
Title: 测试隔离整改 —— HTTP 用例的服务端状态基线（Test isolation: server-side state baseline for HTTP suites）
Status: AWAITING_ACCEPTANCE   # ✅ 2026-09-30 开发完成 + 门禁走完（targeted → pnpm test → typecheck → lint → build → production APP_BASE_URL ×5 → reviewer，未闭合 BLOCKER/MAJOR = 0）。⚠️ **不是业务 Round**：不改任何业务规则、状态机、金额、权限、DTO。⚠️ 本轮全部改动**未提交**（用户指令「禁止任何 Git 写操作」），等用户自行 commit
Depends On:
- P1-6（`03-delivery.md` §2.2 / §2.3）——本轮的**直接起因**：P1-6 的 13 次 production 门禁里有 1 次抖动（`1780 tests / fail 1`），当时登记为「不在本轮的用例里」，作为独立缺口交了出来
- P1-6 新增的 HTTP 端到端券用例 —— 取证后确认它就是**污染源**（建了一张总数 30 的券模板，把 `http-smoke` 的「首页有可领券」对推到第 2 页）
Goal: 让「带 HTTP 用例的测试文件」从**确定的初始状态**出发，而不是依赖「前面几十个文件刚好没改到我要的数据」。**只做隔离，不做重构，不放宽任何断言**
Primary Domain: 测试基础设施（`tests/**`、`package.json`）+ 一个 Mock 调试接口
Primary State Transition: 无（不涉及任何业务状态机）
Started At: 2026-09-30
Development Completed At: 2026-09-30
Accepted At: （待人工验收）
Git Commit: 无 —— 本轮**未提交**，遵循用户「禁止任何 Git 写操作」的指令

---

## 一句话

测试套件里有一批用例真的去打 `next start` 起的**那一个**服务进程，而它读写的
`globalThis` 内存存储在进程启动后**只增不减**——于是「这条断言成不成立」取决于
**运行顺序**。本轮给这批用例装上「开跑前把服务端存储丢回预置」的机制，
并加一条门禁保证它不被静默删掉。

## 这不是「修一条 flaky 测试」

`01-prompt.md` 原本把它描述成「偶发、isolated rerun 又全绿」。取证表明它更糟：
**不重启服务连跑同一批 HTTP 用例，失败会单调累积并永久稳定下来**——
第 1、2 轮全绿，第 3 轮掉到 `549 / 540 / 9`，第 4 轮起永久 `347 / 324 / 23`，
**再也不会自己好**。完整数据见 `02-decisions.md` §2.3。

## 本轮的改动面（可直接核对 diff）

| # | 文件 | 性质 |
|---|---|---|
| 1 | `lib/data/mockStore.ts` | **新增一个导出函数** `resetAllMockStores()`；既有函数签名与语义**未动** |
| 2 | `lib/services/mockStores.ts` | **新增**——薄转发（一行为主），只为不让 `app/` 直接 import `lib/data` |
| 3 | `app/api/debug/reset/route.ts` | **新增** Mock 调试接口，POST only，`ENABLE_MOCK_DEBUG` 关闭时 404 |
| 4 | `tests/httpReset.mjs` | **新增**测试侧助手 `resetServerStores()` |
| 5 | `tests/httpIsolation.test.mjs` | **新增**门禁，6 条断言 |
| 6 | `tests/*.test.mjs` ×23 | 各加 5 行（一个 import、一行顶格 `await`、3 行说明注释），**没有改任何既有断言** |
| 7 | `package.json` | test 脚本加 `--test-concurrency=1` |

**零业务改动**：`lib/services/**` 的业务逻辑、`lib/data/**` 的事务、
`app/api/**` 下**既有**接口的 handler —— 一个字节都没动。
逐条对照 `01-prompt.md` 五条禁令的表见 `02-decisions.md` §五。

## 为什么「两半缺一不可」

重置是**全局**的，不是「我这个文件的那一份」。若两个 HTTP 文件同时跑，
后启动的会把先启动那个的中间状态清掉——**反而更糟**。因此逐文件重置
（`tests/httpReset.mjs`）必须与 `--test-concurrency=1` 一起看。
两半各有一条门禁盯着（`tests/httpIsolation.test.mjs` 第 1、2 条）。

## 门禁数字

见 `03-delivery.md`。人工验收步骤见 `04-acceptance.md`（⭐ C 项是最值得看的一条）。
取证的完整记录、被否决的替代方案、以及**六条已知限制**见 `02-decisions.md`
与 `04-acceptance.md` §三。
