# 批次总控｜P0-6.1 → P0-7 → P0-8 → P0-9 连续开发

## 一、批次目标
连续执行四个 Round：

1. P0-6.1：打手工作台返回入口 + 订单池 oldest-waiting-first
2. P0-7：accepted → serving
3. P0-8：CompletionSubmission + 客服审核 + 默认 10min 自动审核
4. P0-9：Earning.frozen + 可配置投诉窗口 + frozen → available

每个 Round 保持独立 Prompt、独立 Round 档案、独立 delivery/acceptance 记录。本文件只负责编排，不替代各 Round 业务 Prompt。

## 二、执行顺序
严格顺序：
`P0-6.1 → P0-7 → P0-8 → P0-9`

进入每轮前必须完整读取：
- `docs/03-dev/rounds/cmd_p0-6.1.md`
- `docs/03-dev/rounds/cmd_p0-7.md`
- `docs/03-dev/rounds/cmd_p0-8.md`
- `docs/03-dev/rounds/cmd_p0-9.md`

不得只根据 batch 文件猜业务规则。

## 三、状态
每轮：
`PLANNED → READY → IN_PROGRESS → AWAITING_ACCEPTANCE`

AI 不得自行标 DONE。

单轮进入 AWAITING_ACCEPTANCE 后，只要满足继续条件，不等待用户逐轮确认，自动进入下一 Round。

P0-9 完成后停止，等待用户统一人工验收。

## 四、继续条件
只有同时满足以下条件才能自动进入下一轮：

1. Requirement Check 无未解决 OPEN 决策；
2. 本轮范围内实现完成；
3. `pnpm test` fail=0；
4. `pnpm typecheck` exit 0；
5. `pnpm lint` exit 0；
6. `pnpm build` exit 0；
7. 本轮要求的 production APP_BASE_URL 全量测试 fail=0、skipped=0；
8. reviewer 最终 BLOCKER=0、MAJOR=0；
9. 没有无法解释的外部工作区改动；
10. 下一轮前置能力真实存在。

MINOR / NOTE：
- 能安全修复的自动修复；
- 不值得扩大范围的记录进 delivery；
- 只要不影响正确性、安全性、权限、资金或下一轮前置，不阻塞继续。

## 五、必须停止批次
出现任一情况立即停止：

- requirements 与 tech-design 真正冲突；
- 出现新的产品 TBD 且当前实现必须依赖；
- 需要自行发明金额、权限、状态、默认时间等产品决定；
- 自动门禁无法修到全绿；
- reviewer 仍有 BLOCKER / MAJOR；
- 必须越过当前 Round 明确“不做”边界才能继续；
- 工作区有无法解释的人工/外部代码改动；
- 数据模型与权威文档存在不可自行调和冲突。

停止时只报告：停在哪轮、已完成哪些轮、精确阻塞、可选方案；不得擅自拍板。

## 六、未提交工作区纪律
Claude 禁止 commit，因此四轮期间会累积未提交改动。

每轮开始记录：
- HEAD
- `git status --short`
- 已存在修改文件集合
- 前一轮 delivery 的 delta

每轮结束在 `03-delivery.md` 精确记录：
- 本轮新增文件
- 本轮修改文件
- 对共享文件的具体职责/区段
- 哪些修改来自前序 Round，不算本轮产物

不得把最终总 diff 冒充成本轮 delta，也不得为整理差异而回写前一轮历史 delivery。

## 七、Prompt 与档案
每轮创建：
`docs/03-dev/rounds/<ROUND_ID>/`

包含：
- README.md
- 01-prompt.md
- 02-decisions.md
- 03-delivery.md
- 04-acceptance.md

对应 `cmd_*.md` 原样保存到 `01-prompt.md`。

用户最终统一验收前：
- User Result = PENDING
- Final Result = PENDING
- Round = AWAITING_ACCEPTANCE

不要提前写 PASSED。

## 八、Requirement Check 原则
已经在最新 requirements / tech-design 冻结的事项不要重复询问。

纯技术组织问题由工程自行决定，例如：
- 放哪个现有 service
- 复用哪个现有组件
- comparator 命名
- staff 功能挂在哪个合理既有入口

只有真正影响产品规则、资金、权限、生命周期语义的未决问题才进入 CLARIFYING。

## 九、测试与 Reviewer
每轮：
1. targeted tests
2. 完整 `pnpm test`
3. typecheck
4. lint
5. build
6. production server + APP_BASE_URL 全量测试（按该轮要求）
7. reviewer-agent 只读审查
8. 修 BLOCKER/MAJOR
9. 修复后重跑受影响门禁，最终完整 suite 必须全绿

不要为了速度跳过单轮门禁。

## 十、两类时间规则
P0-8 自动完成审核：
- 默认 10 分钟
- 后台可配置
- 每次 pending submission 冻结 snapshot/deadline
- reject 后重提重新计时

P0-9 投诉窗口：
- 后台可配置
- completed 时冻结 snapshot/deadline
- 不把 48h 写死成不可变规则
- 如果最新权威文档没有定义 Mock 默认值，不得自行创造，必须停止并报告

## 十一、架构硬约束
整个批次禁止：
- 第二套 Order Repository
- 第二套 Refund 系统
- 第二套 Notification 通道
- 第二套 PlatformConfig
- 第二套 User/Companion Auth
- 复杂 Assignment 聚合（除非最新权威设计明确要求）
- Route Handler 承载主要业务
- 客户端复制金额/排序/权限真值
- 伪事务原子区段出现 await
- 未经产品确认扩大状态枚举
- 为 UI 把 completion_review / settling / settled 塞入 OrderStatus

## 十二、Git
绝对禁止：
- git add
- git commit
- git push
- git reset
- git restore
- git checkout
- git rebase
- git amend

只允许只读：
- git status
- git diff
- git log
- git show
- git rev-parse
- git reflog

## 十三、最终批次报告
P0-9 完成后一次性输出：

### A. 四轮状态表
列：Round / Status / Requirement Check / Test / HTTP / typecheck / lint / build / Reviewer BLOCKER/MAJOR

### B. 每轮实际交付
分别列 P0-6.1 / P0-7 / P0-8 / P0-9，不得混在一起。

### C. 最终领域链
说明是否真实跑通：
`paid → accepted → serving → completion_review → completed → settling → settled`

明确：
- completion_review / settling / settled 是派生展示阶段
- 不是 OrderStatus

### D. 统一人工验收清单
按最少切换身份次数组织一套端到端流程，覆盖四轮。

### E. 遗留
列：
- 尚未实现
- MINOR/NOTE
- production blockers
- 后续 Round 候选

### F. Git
输出 HEAD、`git status --short`，并明确声明无 Git 写操作。

完成后停止，不得开始 P0-10。
