# P1-2 · 决策记录（Requirement Check 结论与口径裁决）

Round: P1-2 · 管理员生命周期参数配置中心
状态: `READY`（Requirement Check 完成，**无 `OPEN` 决策**，不进入 `CLARIFYING`）
日期: 2026-09-27

---

## 一、Requirement Check 结论

**本轮不是新增业务规则，而是把一个「已经冻结、但实现没跟上」的需求补齐。**

权威需求里早已写明专属池超时必须可配置，且早已写明快照语义，**实现侧写着「固定 10 分钟，
不可配置」**——本轮整改的是那个差值。

### 1.1 逐条依据（原文引用）

| 依据 | 原文 | 说明 |
|---|---|---|
| `docs/01-requirements/超哥电竞_业务流程表.md:279` | 「后台后续修改参数，不改变已经进入专属池订单的 deadline。」 | 快照语义的权威表述 |
| `…业务流程表.md:281` | 「原"固定 10 分钟"规则已被 2026-09-23 新需求替代。」 | **直接点明「固定 10 分钟」是作废的旧规则** |
| `…业务流程表.md:10` | 「投诉期与专属池超时改为后台可配置」 | 2026-09-23 需求校对 |
| `…业务流程表.md:274-276` | 「专属接单期限：**由后台平台参数配置**；进入 `exclusive` 时冻结本次 deadline / timeout snapshot」 | 快照时点 |
| `…业务流程表.md:1124` | 「专属池到期转公共池 \| 已有基础；"固定时长 → 后台可配置"待整改」 | 需求侧自己登记的整改项 |
| `docs/01-requirements/超哥电竞_用户权限表.md:546-555` | §8.5 平台配置：管理员可以修改「公共池超时时长；**专属池超时时长**；投诉期时长；完成材料自动审核时长」 | 配置中心应包含的字段清单 |
| `…用户权限表.md:144` | 「查看/管理平台参数」一行为 Admin 独有 ✅ | 权限 |
| `…用户权限表.md:642` | 「修改平台参数（含公共池 timeout、**专属池 timeout**、投诉期、完成材料自动审核时长）」 | 管理员能力清单 |
| `docs/01-requirements/超哥电竞_特殊情况与异常处理表.md:801` | **EX-CONFIG-04**「管理员修改专属池超时参数，但已有订单正在专属池」→「已有订单：exclusive deadline 不变」「新订单：使用新配置」「审计：必须」 | 逐条规则 |
| `…特殊情况与异常处理表.md:1146` | 「投诉期、公共池超时、专属池超时等生命周期参数改变时，已进入对应阶段的历史订单继续使用自己的 deadline snapshot。」 | 总的不变量 |
| `…特殊情况与异常处理表.md:813-825` | **EX-CONFIG-05** 投诉期：默认 1440、范围 60~10080 | 相邻字段的取值范围（对照用） |
| `…特殊情况与异常处理表.md:827-839` | **EX-CONFIG-06** 完成材料：默认 10 分钟、进入 pending 时冻结 | 相邻字段的取值范围（对照用） |

### 1.2 CURRENT / TARGET / 本轮变更

| 项 | CURRENT（本轮之前） | 本轮变更 |
|---|---|---|
| 专属池时长来源 | 源码常量 `EXCLUSIVE_WAIT_MINUTES = 10`（`lib/constants/dispatch.ts`），注释明写「固定 10 分钟，不可配置」 | **取 `PlatformConfig.exclusivePoolTimeoutMinutes`**，默认 10 |
| 专属池快照字段 | **不存在**（只有 `exclusiveDeadlineAt`） | 新增 `Dispatch.exclusiveTimeoutMinutesSnapshot` |
| `PlatformConfig` 字段数 | 3（公共池 / 完成材料 / 投诉窗口） | **4**（+ 专属池） |
| 管理后台配置页 | 3 个输入框 | **4 个** |
| 配置审计快照 | 3 个时长字段 | **4 个** |
| 公共池 / 完成材料 / 投诉窗口 | 已有 snapshot 语义 | **零改动**（本轮只回归验证，见 §四） |

### 1.3 无 `OPEN` 决策

需求侧对**默认值、快照时点、是否追溯、权限、审计**都已给出明确答案（见 §1.1），
因此不进入 `CLARIFYING`。唯一需要**推导**的是专属池字段的 min / max（需求未写），
推导过程与依据见 §三 D1。

---

## 二、平台参数字段全表（指令 §六 要求的六项）

「当前值」一列写的是**本轮交付时的预置值**（`platformConfigSeed`），可由管理员改。

### 2.1 `exclusivePoolTimeoutMinutes` —— 专属池超时（**本轮新增**）

| 项 | 内容 |
|---|---|
| **当前值** | `10`（分钟） |
| **单位** | 分钟（整数）。存储与后台配置的单位一律是分钟 |
| **业务含义** | 订单被指定给某位打手后，该打手在这段时间内**独占接单权**；到点仍未接单 → 该订单转入**公共接单池**（不是退款，是换池子重新等人） |
| **取值范围** | `1 ~ 1440` 分钟（推导见 D1） |
| **snapshot 时点** | **订单/派单进入 `exclusive` 状态的那一刻**（`createDispatchForOrder()`，即支付成功建派单时；指定了打手才进专属池） |
| **改后影响哪些未来对象** | 此后**新进入**专属池的派单（`Dispatch.state === "exclusive"`） |
| **是否追溯旧对象** | **否**。已进入专属池的派单看自己的 `exclusiveTimeoutMinutesSnapshot` 与 `exclusiveDeadlineAt`，管理员改配置**一个字都不会动它们** |

### 2.2 `publicPoolTimeoutMinutes` —— 公共池超时（**既有，本轮零改动**）

| 项 | 内容 |
|---|---|
| **当前值** | `60`（分钟） |
| **单位** | 分钟（整数），范围 `1 ~ 1440` |
| **业务含义** | 订单在**公共池**中无人接单达到该时长 → 停止接取并**自动全额退款** |
| **snapshot 时点** | 进入公共池的那一刻（`publicPoolEnteredAt`）。⚠️ **每次进入都会重新冻结**：未指定打手是首次进入，专属池超时是第二次进入——两次各按**当时**的配置 |
| **改后影响哪些未来对象** | 此后进入公共池的订单（含从专属池超时转过来的那一批） |
| **是否追溯旧对象** | **否**（`Dispatch.publicTimeoutMinutesSnapshot`） |

### 2.3 `completionAutoApprovalMinutes` —— 完成材料自动审核时长（**既有，本轮零改动**）

| 项 | 内容 |
|---|---|
| **当前值** | `10`（分钟） |
| **单位** | 分钟（整数），范围 `1 ~ 1440` |
| **业务含义** | 打手提交完成材料后，等待该时长仍 `pending`、无退款/投诉阻塞、且订单仍 `serving` → 由 System 自动通过（`reviewSource = "system"`） |
| **snapshot 时点** | **提交进入 `pending` 的那一刻**（每次提交/重新提交都重新冻结；驳回后重提重新计时） |
| **改后影响哪些未来对象** | 此后**新提交**的完成材料 |
| **是否追溯旧对象** | **否**（`CompletionSubmission.autoApprovalMinutesSnapshot` / `autoApprovalDeadlineAt`） |

### 2.4 `complaintWindowMinutes` —— 投诉窗口（**既有，本轮零改动**）

| 项 | 内容 |
|---|---|
| **当前值** | `1440`（分钟，24 小时） |
| **单位** | 分钟（整数），范围 `60 ~ 10080`（1 小时 ~ 7 天） |
| **业务含义** | **两件事**：① 订单完成后的这段时间内用户仍可发起投诉；② 它同时是打手该单收益的冻结时长（`Earning.availableAt` = 本单 `complaintDeadlineAt`） |
| **snapshot 时点** | 订单**真正进入 `completed`** 的那一刻 |
| **改后影响哪些未来对象** | 此后完成的订单 |
| **是否追溯旧对象** | **否**（`Order.complaintWindowMinutesSnapshot` / `complaintDeadlineAt`） |

### 2.5 为什么**没有**把「商品分账比例」放进这张表

`用户权限表` §8.5 的清单里还有「商品分账比例」。它**不属于**本轮范围，理由是它
**不是「平台级单例参数」而是商品自身的属性**（`Product.companionRateBp`）——
一件商品的抽成比例按商品配，不能有一个全局值把它盖掉。把它塞进 `PlatformConfig`
会开出一个「改一次全局配置就改变所有人分账」的入口，而
`lib/types/platformConfig.ts` 的头部注释**已经明文禁止**这件事
（「把资金规则塞进这张表，等于给『改一次全局配置就改变所有人的钱』开了一个入口」）。
「未来 B/A/S 并发上限」同理（那是伙伴侧属性，且需求标注为未来项）。

⇒ 本轮纳入配置中心的，是**生命周期时长**这一类参数，共 4 项。

---

## 三、口径裁决

### D1 · 专属池字段的 min / max 取 `1 ~ 1440`（**复用**公共池那一组）

**依据链**（指令 §十五 要求「从权威需求 / 现有 PlatformConfig 规范 / 相邻 timeout 字段规则 推导」）：

1. **权威需求没写**专属池的取值范围（EX-CONFIG-04 只写了默认值与快照规则）。
2. **相邻字段的既有规范**是现成的两套：公共池与完成材料共用 `1 ~ 1440`，
   投诉窗口独立用 `60 ~ 10080`。
3. 专属池该跟哪一套？跟**公共池 / 完成材料**那一套。理由是三者是**同一种量**：
   「系统在派单/审核流程里等多久」——量级是分钟到一天。投诉窗口是另一种量
   （「用户还有多久可以翻案」），所以它才独立成了 60~10080。
4. **默认值 10 落在 `1~1440` 内**，且与完成材料自动审核时长（默认也是 10）同类。

**为什么下界不是 0**：与公共池同一条理由——`0` 会让订单进入专属池的同一瞬间就超时，
那位打手从未真正拥有过专属时间，「指定他」这个动作在业务上等于没发生。

**为什么上界是 1440 而不是更大**：专属池超时同时是「用户被指定打手的承诺绑住多久」的上限。
一个手滑多打一位的 `14400`（10 天）会让订单静默挂在专属池里十天。

**不复制数字**：常量写成 `= PUBLIC_POOL_TIMEOUT_MIN_MINUTES` / `= PUBLIC_POOL_TIMEOUT_MAX_MINUTES`
（与 `COMPLETION_AUTO_APPROVAL_*` 的写法一致），因此「1~1440」在全仓仍然只有一处数字。

### D2 · 快照字段命名 `exclusiveTimeoutMinutesSnapshot`，与 `publicTimeoutMinutesSnapshot` 对仗

`Dispatch` 上已有 `publicTimeoutMinutesSnapshot`（进入公共池时冻结）。专属池加
`exclusiveTimeoutMinutesSnapshot`，两者并排、语义对称，读代码的人不需要记住两套命名规则。
**为什么不叫 `exclusiveWaitMinutesSnapshot`**：`EXCLUSIVE_WAIT_MINUTES` 这个旧常量名
本轮被删除，沿用它的名字会把一个已作废的概念带进新字段。

### D3 · 默认值 `10` 只允许作为 **PlatformConfig 的默认值**存在

指令 §十七 的要求。落地形态：

- 唯一落点：`lib/constants/platformConfig.ts` 的 `EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES = 10`；
- 预置数据从它取（`platformConfigSeed`）；
- **`lib/constants/dispatch.ts` 的 `EXCLUSIVE_WAIT_MINUTES` 整个删除**——
  业务路径（派单事务、种子、测试）一律改为读配置，不再有一个「固定 10」可以依赖。

### D4 · 旧 store / 旧 seed 缺字段时在读边界补齐（**不是**在每个调用点兜底）

`lib/data/mockPlatformConfigRepository.ts` 增加 `normalizePlatformConfig()`：
读或写之前，把缺失／非有限的数值字段补成各自默认值。

**为什么放在仓储层而不是调用点**：
1. 真实场景是**开发服务器重启用的是同一段进程内存里的旧 store**（`globalThis`），
   它是在本轮之前建的，里面没有这个键。若在每个调用点判 `?? 10`，
   就会有「谁忘了判」的风险，而且 `undefined` 会一路渗进 deadline 计算 →
   `new Date(NaN)` → `Invalid Date` → **一条永远不过期的派单**。
2. 放在读边界之后，「配置对象的字段恒为合法数字」成为一条**仓储的保证**，
   上层不需要任何空值分支。

### D5 · 历史 Round 文档不篡改，只标注 `superseded by P1-2`

指令 §十七。落地时**只在本轮档案与少量当前代码注释里**写「superseded by P1-2」，
不去改 `cmd_p0-*.md`、`rounds/P0-*/` 等历史记录里已写下的「固定 10 分钟不可配置」。

### D6 · 配置页复用既有页面，不新建第二个配置入口

`app/admin/(console)/platform-config/page.tsx` + `components/admin/AdminPlatformConfigConsole.tsx`
**已存在**（P0-1 起，已含公共池 / 完成材料 / 投诉窗口三项，且已有显式保存、幂等键、
成功/失败反馈、服务端校验）。本轮**在它上面加第四个字段**，不新建页面、
不新建接口（`GET` / `PATCH /api/admin/platform-config` 已存在）。

唯一需要动的是它的**展示形态**：指令 §十 要求每项都要有「当前值 / 单位 / 清晰业务说明 /
修改后生效范围」，并**点名禁止**只显示「超时：10」。该页面现有的 `AdminField`
（label + hint）已经满足这个形态，本轮为新字段按同一形态写文案，
并把指令给定的专属池示例文案**逐字**用在 hint 里。

### D7 · 「改了配置不重算旧 deadline」靠**结构**保证，不靠自觉

本轮不新增任何「重算」代码，因此「不重算」是靠**没有那个代码路径**成立的。
测试（指令 §十八 第 17 项）另加一条：改了配置之后，**旧派单的
`exclusiveTimeoutMinutesSnapshot` 与 `exclusiveDeadlineAt` 逐字节不变**。

---

## 四、既有三项的回归（指令 §七 7.2 / 7.3 / 7.4）

| 参数 | 需求侧规定的生效时点 | 当前实现 | 本轮结论 |
|---|---|---|---|
| 公共池超时 | 进入公共池时 snapshot | `publicTimeoutMinutesSnapshot` + `publicDeadlineAt`，**每次进入都重新冻结** | **一致，零改动**。⚠️ 本轮在测试里显式覆盖「专属池超时转公共池时，公共池用的是**那一刻**的配置」 |
| 完成材料自动审核 | 进入 pending 时 snapshot | `autoApprovalMinutesSnapshot` + `autoApprovalDeadlineAt` | **一致，零改动** |
| 投诉窗口 | 订单完成时 snapshot | `complaintWindowMinutesSnapshot` + `complaintDeadlineAt` | **一致，零改动**。⚠️ 与 `Dispatch` 两处的一处差别：`Order.complaintWindowMinutesSnapshot` 允许为 `null`（历史数据），本轮不动 |

**没有为了配置 UI 改动任何业务语义**（指令 §七 的要求）：
本轮只**新增**一个字段、**删除**一个常量、**改一行**取数来源，其余三个参数的
snapshot 时点、deadline 计算、判定谓词一行未动。

---

## 五、明确不做（指令 §二十一）

Scheduler · 真数据库 · 微信 OAuth · 微信支付 · 提现 · 钱包 · 聊天 retention ·
优惠券 · 新 `OrderStatus` · 配置历史版本系统 · AB Test · 自动运营调参。

另有一项**本轮刻意不做**：**没有**为配置改动加「版本号 / 生效时间」之类的机制。
`PlatformConfig` 仍是「一份当前值 + 一份审计流水」，审计回答「谁在什么时候把哪个值
从多少改成了多少」，快照回答「某个对象当初按什么规则走」。这三者已经够用，
再加一层版本系统就与 `lib/types/platformConfig.ts` 里「不给配置表加预留字段」
那条说明相冲突。
