# P0-6.1｜打手工作台返回入口 + 订单池等待最久优先

## 零、Round 定位
本轮只处理 P0-6 人工验收后发现的两个整改项：
- FIX-1：打手工作台缺少返回普通用户端入口
- FIX-2：公共池 / 专属池排序改为“当前池等待最久优先”

不得扩大范围，不修改 P0-6 已通过的历史验收结论。

## 一、执行前
完整阅读 `CLAUDE.md`、`AGENTS.md`、最新 `docs/01-requirements/`、`docs/02-tech-design/`、`docs/03-dev/development-workflow.md`、`docs/03-dev/总需求进度表.md`、P0-6 与 DEV-1 Round 档案。

记录 branch / HEAD / `git status --short` 和本轮开始前工作区基线。批次模式下允许前面 Round 留下未提交改动，但不得把前一 Round 的已有改动算成本轮 delta。

## 二、FIX-1：打手工作台返回用户端
User 与 Companion 共用同一 User Session。这里需要的是界面导航，不是 logout、身份切换或重新认证。

在 Companion console 统一顶部区域左侧提供明确返回入口，例如 `← 返回用户端`。优先返回 `/`；如项目已有用户主入口常量则复用。

优先放在统一 layout/header，不要每页复制。至少覆盖 `/companion`、`/companion/pool`、`/companion/exclusive`、`/companion/orders`、`/companion/orders/[id]`。

点击后必须保持原 Session，不调用 logout、不清 Cookie、不修改 Companion 资格。

## 三、FIX-2：订单池等待最久优先
正式规则：
- 公共池：`publicPoolEnteredAt ASC`
- 专属池：`exclusiveEnteredAt ASC`

列表顶部 = 在当前池等待最久；从上到下越来越新。

禁止把 Map/数组插入顺序、seed 顺序、`Order.createdAt`、deadline 当主要排序真值。排序应由服务端池查询统一完成，客户端不得复制业务 `.sort(...)`。

重新回池时必须使用新的 `publicPoolEnteredAt`。老订单刚刚重新进入 public，应按“刚进入当前池”参与排序，不因创建时间早就冲到最前。

时间相同使用稳定确定性的 secondary key，优先复用已有 `id`/`orderNo` 习惯。

重点检查 `lib/services/companionDispatch.ts` 与现有 `compareByDeadline`。若旧 comparator 被其它场景复用，可拆成语义明确的 public/exclusive comparator，但禁止大规模重构。

## 四、测试
至少覆盖：
1. Companion console 统一返回入口存在；
2. pool/exclusive/orders/order detail 均被统一 layout/header 覆盖；
3. 返回目标正确且不 logout；
4. 不新增 Companion Session/Cookie/Auth；
5. public enteredAt 10:00/10:10/10:20 返回 A/B/C；
6. 运行时新增 10:30 的订单在更靠下位置；
7. P0-6 取消重回 public 后使用新的 `publicPoolEnteredAt`；
8. exclusive 按 `exclusiveEnteredAt ASC`；
9. 同时间 tie-breaker 稳定；
10. 构造 enteredAt 与 deadline 排序相反的场景，结果必须服从 enteredAt；
11. 服务端为唯一排序真值。

## 五、明确不做
不得实现 accepted→serving、CompletionSubmission、自动完成审核、Earning、封禁回池、客服换人、新退款流程、账号系统、Dispatch 状态模型重构、timeout 规则改造。

## 六、Round Protocol
创建 `docs/03-dev/rounds/P0-6.1/` 的五件档案，并将本文件原样归档到 `01-prompt.md`。

状态：`PLANNED → READY → IN_PROGRESS → AWAITING_ACCEPTANCE`。

批次模式下，自动门禁全绿且 reviewer 无 BLOCKER/MAJOR 后，本轮停在 AWAITING_ACCEPTANCE 并自动进入 P0-7；不得自行标 DONE。

## 七、门禁
运行：
- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- production server + `APP_BASE_URL=... pnpm test`

HTTP 要求 fail=0、skipped=0。Reviewer 必须只读；BLOCKER/MAJOR 必须修复并重跑。

## 八、Git
禁止 add/commit/push/reset/restore/checkout/rebase/amend。只允许只读 Git。

## 九、交付
记录本轮 delta、FIX-1 实现位置、返回目标与 Session 行为、public/exclusive 排序公式、tie-breaker、取消重回池验证、测试/HTTP/reviewer/git status。完成后在 batch 允许时自动进入 P0-7。
