# P1-2｜管理员生命周期参数配置中心

## 一、Round 目标

正式 Round：`P1-2`

目标：把当前散落在代码 / PlatformConfig 中的订单生命周期参数统一纳入管理员配置中心，并补齐“专属池超时必须可配置”的缺口。

本轮完成：

1. 专属池超时配置；
2. 公共池超时配置；
3. 完成材料自动审核时间配置；
4. 投诉窗口时间配置；
5. Admin 查看与修改；
6. 生命周期 snapshot 语义保持正确；
7. 配置修改不得追溯改变已生成 deadline；
8. 清理“专属池固定 10 分钟不可配置”的旧实现 / 旧注释。

本轮不新增 OrderStatus，不引入 Scheduler，不改退款/聊天状态机。

---

## 二、前置状态

必须在 P1-1 完成开发并停在：

`AWAITING_ACCEPTANCE`

之后进入本轮。

进入 P1-2 时保持：

- P0-14 = `AWAITING_ACCEPTANCE`
- P1-1 = `AWAITING_ACCEPTANCE`

记录：

- HEAD
- 当前分支
- `git status --short`
- 当前 PlatformConfig 结构
- 当前生命周期 snapshot / deadline 字段
- 当前 Admin 设置 / 配置页面

若发现无法解释的业务代码改动，停止。

---

## 三、Round 档案

创建：

`docs/03-dev/rounds/P1-2/`

包含：

- README.md
- 01-prompt.md
- 02-decisions.md
- 03-delivery.md
- 04-acceptance.md

状态：

`PLANNED → READY → IN_PROGRESS → AWAITING_ACCEPTANCE`

Claude 不得自行 DONE。

---

## 四、专属池超时正式产品裁定

正式裁定：

**专属池超时必须可配置。**

新增 / 纳入：

`exclusivePoolTimeoutMinutes`

默认值：

`10`

当前代码 / 注释中如存在：

“固定 10 分钟，不可配置”

则与当前产品规则冲突。

以本轮裁定为准。

---

## 五、exclusive snapshot 语义

当订单 / assignment 正式进入指定打手专属接单阶段时：

1. 读取当前 `exclusivePoolTimeoutMinutes`；
2. snapshot 当前值；
3. 根据 snapshot 计算 exclusive deadline；
4. 后续管理员修改配置，不得影响已经存在的 assignment。

示例：

12:00：

`exclusivePoolTimeoutMinutes = 10`

订单 A 在 12:01 进入专属池：

`exclusiveDeadlineAt = 12:11`

12:05 管理员修改为：

`exclusivePoolTimeoutMinutes = 20`

结果必须是：

- A 仍然 12:11 到期；
- 订单 B 若 12:06 才进入专属池，则 deadline = 12:26。

严禁：

- 每次 sweep / 查询时读取最新 PlatformConfig 重算旧 deadline；
- 管理员改配置后批量改旧订单 snapshot；
- 用“当前配置值”覆盖已经发生的历史生命周期事实。

---

## 六、其它生命周期参数

完整检查当前 PlatformConfig。

预计至少已有：

- `publicPoolTimeoutMinutes`
- `completionAutoApprovalMinutes`
- `complaintWindowMinutes`

不得创建重复字段。

管理员配置中心统一管理当前真实存在、且权威需求明确允许配置的生命周期参数。

每个字段必须在 `02-decisions.md` 中明确：

- 当前值；
- 单位；
- 业务含义；
- snapshot 时点；
- 修改后影响哪些未来对象；
- 是否追溯旧对象。

---

## 七、各参数生效时点

### 7.1 专属池超时

进入专属池时 snapshot。

### 7.2 公共池超时

进入公共池时 snapshot。

### 7.3 完成材料自动审核时间

CompletionSubmission 进入 pending 时，按当前已冻结规则 snapshot。

### 7.4 投诉窗口

订单完成时 snapshot。

若权威需求 / 当前正确实现存在更精确时点：

优先沿用已冻结规则，不得为了配置 UI 改变业务语义。

---

## 八、核心不变量

本轮最高优先级不变量：

**PlatformConfig 是未来生命周期事件的模板；对象上已经生成的 snapshot / deadline 才是历史事实。**

管理员修改配置：

只影响之后新进入对应生命周期阶段的对象。

不得追溯改变：

- 已生成的 exclusive deadline；
- 已生成的 public deadline；
- 已生成的 completion auto-approval deadline；
- 已生成的 complaint deadline。

---

## 九、Requirement Check

编码前完整检查：

- `docs/01-requirements/`
- `docs/02-tech-design/`
- `docs/03-dev/总需求进度表.md`
- `docs/03-dev/需求功能点进度表.md`
- PlatformConfig 类型
- config repository / mock store
- dispatch constants
- companion dispatch transaction
- completion transaction
- complaint lifecycle
- earning lifecycle
- Admin settings/config 页面
- API contract
- database/mock schema
- 所有 lifecycle snapshot / deadline 字段

明确区分：

- TARGET
- CURRENT
- 本轮变更

不得用旧实现覆盖已冻结产品规则。

---

## 十、配置页面

先检查是否已有 Admin 平台设置 / 配置页面。

如已有：

复用现有页面。

如无：

按现有 Admin 路由和视觉体系创建统一：

`平台配置 / 生命周期配置`

至少展示：

- 专属池超时
- 公共池超时
- 完成材料自动审核时间
- 投诉窗口

每项必须展示：

- 当前值
- 单位
- 清晰业务说明
- 修改后生效范围

专属池示例文案：

“指定打手在此时间内拥有独占接单权；超时后进入公共接单池。修改后仅影响之后进入专属池的订单。”

禁止只显示：

“超时：10”

而不解释含义。

---

## 十一、保存行为

采用显式保存。

要求：

- 初始加载真实当前配置；
- 修改后可保存；
- 保存成功有反馈；
- 保存失败有可见反馈；
- 服务端必须验证；
- 重复保存幂等；
- 若当前架构方便，未修改时避免无意义写入。

页面不得直接操作 mock store。

---

## 十二、权限

配置读取 / 修改：

**Admin only**

必须覆盖：

- anonymous 拒绝；
- User 拒绝；
- Companion 拒绝；
- Staff 拒绝；
- Admin 成功。

继续复用：

`requireAdmin()`

不得创建第二套 Admin auth。

---

## 十三、架构

继续遵守：

Browser  
→ Http Service  
→ Route Handler  
→ Service  
→ Repository

配置读取 / 写入必须有唯一领域入口。

禁止：

- 页面直接改 store；
- dispatch 组件自己保存配置；
- 在多个 transaction 中硬编码默认 10；
- 创建第二套 PlatformConfig；
- Route Handler 编写业务逻辑。

---

## 十四、默认值与兼容

旧 Mock store / seed 若缺少：

`exclusivePoolTimeoutMinutes`

必须安全补齐默认：

`10`

resetMockStore 后必须稳定存在。

不得出现：

- undefined；
- NaN deadline；
- snapshot 缺失；
- 旧 seed 初始化失败；
- 老测试依赖未升级导致随机崩溃。

---

## 十五、输入验证

优先复用现有 PlatformConfig 验证体系。

所有分钟字段至少要求：

- 必须是有限数；
- 必须是整数；
- 必须 > 0；
- 拒绝 NaN；
- 拒绝 Infinity；
- 拒绝字符串冒充数字；
- 拒绝超过合理范围的数值。

若已有字段存在明确 min / max：

继续沿用。

专属池字段的 min / max 优先从：

- 权威需求
- 现有 PlatformConfig 规范
- 相邻 timeout 字段规则

推导。

不得在：

- UI
- Service
- transaction

各自复制一套不同范围。

服务端规则为最终权威。

---

## 十六、API / DTO

建立明确的 Admin PlatformConfig DTO。

只暴露管理员 UI 真正需要的配置字段。

如当前没有统一接口，可以按现有项目风格新增类似：

- `GET /api/admin/platform-config`
- `PATCH /api/admin/platform-config`

具体路径按当前 Admin API 命名规范决定，不强制照抄。

要求：

- `requireAdmin()` 为第一权限动作；
- Route 只负责 auth / parse / service / response；
- Service 负责验证和业务；
- Repository 负责存储；
- 不返回整个 mock store；
- 做 DTO exact keys 测试。

---

## 十七、专属池旧实现清理

全仓搜索：

- 固定 10 分钟
- hard-coded 10
- `EXCLUSIVE_POOL_TIMEOUT`
- dispatch 常量
- “不可配置”
- 任何根据固定常量计算 exclusive deadline 的业务路径

要求：

业务路径不再依赖“固定 10”。

默认值可以是 10，但只能作为 PlatformConfig 默认值存在。

历史 Round 文档不篡改。

若历史曾写：

“固定 10 分钟不可配置”

则在当前文档中标记：

`superseded by P1-2`

而不是改写历史记录。

---

## 十八、Snapshot 测试

至少覆盖：

1. PlatformConfig 默认包含 `exclusivePoolTimeoutMinutes = 10`；
2. Admin 修改 exclusive 配置成功；
3. A 在配置=10 时进入专属池；
4. A snapshot=10；
5. A deadline 正确；
6. 管理员将配置改为 20；
7. A snapshot 仍为 10；
8. A deadline 不变；
9. B 修改后进入专属池；
10. B snapshot=20；
11. B deadline 使用 20；
12. A/B 两种 snapshot 同时存在；
13. exclusive timeout 后仍进入 public；
14. public timeout 使用自己 snapshot；
15. completionAutoApproval 使用自己 snapshot；
16. complaintWindow 使用自己 snapshot；
17. 运行时修改配置不重算旧 deadline。

---

## 十九、其它测试

### PlatformConfig / reset

18. resetMockStore 后 exclusive 默认仍为 10；
19. 旧 seed 缺字段可安全升级；
20. DTO exact keys。

### 权限

21. anonymous 不可读；
22. User 不可读；
23. Companion 不可读；
24. Staff 不可读；
25. Admin 可读；
26. 非 Admin 不可写；
27. Admin 可写。

### 验证

28. 0 拒绝；
29. 负数拒绝；
30. 小数拒绝；
31. NaN 拒绝；
32. Infinity 拒绝；
33. string 拒绝；
34. 超范围拒绝。

### UI

35. 显示当前值；
36. 显示正确单位；
37. 显示清晰业务说明；
38. 保存成功；
39. 保存失败；
40. reload 后值正确；
41. loading；
42. error；
43. retry。

### 结构

44. 全仓不存在第二套 PlatformConfig；
45. 业务路径不再硬编码 exclusive 固定 10；
46. 已有 lifecycle tests 全部回归；
47. 修改任意配置不追溯旧 snapshot。

---

## 二十、文档同步

更新：

- `docs/02-tech-design/api-contract.md`
- `docs/02-tech-design/database-schema.md`（如适用）
- `docs/02-tech-design/architecture-rules.md`（仅必要时）
- `docs/03-dev/总需求进度表.md`
- `docs/03-dev/需求功能点进度表.md`
- P1-2 Round 档案

不得篡改历史 Round。

---

## 二十一、明确不做

P1-2 不做：

- Scheduler
- 真数据库
- 微信 OAuth
- 微信支付
- 提现
- 钱包
- 聊天 retention
- 优惠券
- 新 OrderStatus
- 配置历史版本系统
- AB Test
- 自动运营调参

---

## 二十二、门禁

依次执行：

1. targeted tests
2. `pnpm test`
3. `pnpm typecheck`
4. `pnpm lint`
5. `pnpm build`
6. production `APP_BASE_URL` 全量测试
7. reviewer-agent 只读审查
8. 修复全部 BLOCKER / MAJOR
9. 最终完整复跑

最终要求：

- fail = 0
- production skipped = 0
- BLOCKER = 0
- MAJOR = 0

---

## 二十三、Git

禁止：

- git add
- git commit
- git push
- git reset
- git restore
- git checkout
- git rebase
- git amend

仅允许只读 Git。

---

## 二十四、最终状态

结束时保持：

- P0-14 = `AWAITING_ACCEPTANCE`
- P1-1 = `AWAITING_ACCEPTANCE`
- P1-2 = `AWAITING_ACCEPTANCE`

不得开始 P1-3。

P1-2 最终交付报告必须包含：

1. Round Status
2. Requirement Check
3. PlatformConfig 变化
4. exclusive snapshot 设计
5. public/completion/complaint snapshot 回归
6. Admin 配置 UI
7. API / DTO
8. 权限
9. 输入验证
10. A/B snapshot 前后对照证明
11. targeted tests
12. pnpm test
13. production tests
14. typecheck / lint / build
15. reviewer
16. git status
17. 人工验收入口

完成后停止，等待统一人工验收。
