# P0-14｜打手订单聊天 + 换人后的聊天隔离

## 零、Round 目标

正式 Round：`P0-14`

本轮只解决当前唯一“需求已冻结 + 依赖已满足 + 完全零实现 + 已有功能会受影响”的 P0 缺口：

1. 当前实际打手可以加入订单聊天；
2. 每次新的履约 assignment 使用独立聊天会话；
3. 换人 / 回池 / 封禁后，旧打手立即失去当前履约聊天权限；
4. 新打手不能看到旧打手 assignment 的聊天；
5. 用户仍能看到自己订单下的完整聊天历史；
6. Staff / Admin 在调查场景下可查看历史 assignment 会话。

本轮不实现聊天物理删除 / retention，因为 EX-CHAT-04 / Q-EX-07 的保留期规则仍未冻结。

---

## 一、执行前

完整阅读：

- `CLAUDE.md`
- `AGENTS.md`
- 最新 `docs/01-requirements/`
- 最新 `docs/02-tech-design/`
- `docs/03-dev/development-workflow.md`
- `docs/03-dev/总需求进度表.md`
- `docs/03-dev/需求功能点进度表.md`
- P0-6 / P0-7 / P0-8 / P0-10 / P0-11 / P0-13 档案
- 当前 message / conversation 类型、repository、mock repository、route、service、UI、tests

记录：

- HEAD
- `git status --short`
- 当前工作区 baseline
- `.claude/hooks/` 是否为用户已有未提交基础设施文件

若出现无法解释的业务代码改动，停止。

---

## 二、核心产品规则

### 2.1 用户

订单用户：

- 可以看到自己订单下所有 assignment 的聊天历史；
- 可以给“当前有效 assignment 会话”发送消息；
- 历史 assignment 会话只读，不再接受用户继续往旧打手会话发消息；
- 用户界面可以按时间线展示多个 assignment 会话，但不得混成一条让新打手看到旧消息的共享流。

### 2.2 当前实际打手

只有：

`Order.actualCompanionId === 当前 Companion`

且当前 assignment 仍有效时，才能：

- 查看当前 assignment 会话；
- 发送消息；
- 读取/更新自己的已读状态。

### 2.3 旧打手

一旦发生：

- companion cancel
- Staff release
- Staff direct replace
- Companion disabled release

旧打手立即：

- 不能继续读取当前履约会话；
- 不能继续发送；
- 不能看到后续新 assignment 的任何消息。

旧打手历史消息仍作为订单调查历史保存，但只允许 Staff/Admin/订单用户按权限查看。

### 2.4 新打手

新打手接受订单 / 被 Staff direct replace 后：

- 获得一个新的 assignment conversation；
- 只能看到这个新 assignment 开始后的会话；
- 不能看到旧打手历史聊天内容；
- 不继承旧打手 unread/read cursor。

---

## 三、模型设计要求

当前 `OrderConversationRecord` 仅以 `orderId` 为维度，无法表达多次 assignment。

本轮允许最小模型升级，引入 assignment 维度。

禁止为了聊天创建完整 Assignment 聚合。

建议最小表达：

- `conversationId`
- `orderId`
- `assignmentKey` / `assignmentId`（命名按现有架构）
- `companionId`
- `createdAt`
- 用户已读状态
- 当前打手已读状态

`assignmentKey` 必须能稳定区分：

A → B → C

三个履约阶段。

优先复用 P0-11 已存在的 release history / acceptedAt / current binding 事实构造最小标识，但如果无法稳定唯一，允许新增聊天领域内部的最小 assignment key。

不得改变 OrderStatus。

不得创建第二套 Order / Auth / Companion 身份系统。

---

## 四、会话生命周期

### 4.1 创建

当订单首次进入 accepted 且存在 actualCompanionId：

若该 assignment 尚无 conversation：

创建一条。

Staff direct replace：

旧 assignment conversation 保留；
新 companion 获得新 conversation。

public pool 中没有 actualCompanionId 时：

不创建打手 assignment conversation。

### 4.2 失效

以下动作发生时：

- cancel
- release
- replace
- disable release

旧 assignment conversation 立即停止 Companion 访问。

失效不等于删除。

### 4.3 重入

A 接单 → 取消 → A 未来再次接到同一订单：

视为新的 assignment。

必须新建 conversation，不能复用旧会话。

---

## 五、接口

按现有架构扩展，不自行创造第二套聊天系统。

至少需要支持打手侧：

- 当前自己的订单聊天列表 / 入口
- 当前 assignment conversation 详情
- 读取消息
- 发送消息
- 标记已读

具体 route 地址应优先延续现有 `/api/orders/.../messages` 或 conversation 风格，不要因角色不同复制整套 service/repository。

如果现有 User / Staff chat route 能安全复用 service，则复用 service，权限放在角色入口层。

---

## 六、打手端 UI

至少：

- 打手订单详情出现“订单聊天”入口；
- 当前 assignment 可进入；
- 能看到用户与自己的当前 assignment 消息；
- 可以发消息；
- unread 状态正确；
- 旧 assignment / 非本人 / 失效 assignment 不可进入。

不要做：

- 图片上传
- 文件附件
- 语音
- WebSocket
- 实时推送基础设施

现阶段继续使用现有轮询/刷新模式。

---

## 七、用户端 UI

用户订单聊天必须兼容多 assignment。

要求：

- 用户仍能查看完整历史；
- 不把旧打手消息暴露给新打手；
- UI 可以明确分段显示“历史服务会话”“当前服务会话”；
- 不要求展示内部 companionId / assignmentId；
- 历史会话只读时要避免用户误以为还能给旧打手发送。

---

## 八、Staff / Admin

Staff：

- 可查看订单全部 assignment conversation 历史；
- 用于投诉 / 售后 / 调查；
- 不因换人丢失旧聊天。

Admin：

- 如现有权限体系允许查看订单调查信息，则延续现有权限；
- 不单独新建 Admin Chat 系统。

---

## 九、已读状态

必须按：

`角色 + conversation/assignment`

隔离。

禁止继续只按 orderId 保存 Companion 已读 cursor。

要求：

- User 的历史阅读进度不被新 assignment 重置；
- Companion A 的 unread 不影响 Companion B；
- 新 Companion 初始 unread 只针对自己的新 conversation；
- Staff 现有 read 状态不可被打手侧改坏。

---

## 十、权限矩阵

至少覆盖：

1. 未登录 → 401；
2. 普通 User 不能访问 companion route；
3. 非 Companion → 403/既有一致语义；
4. Companion 只能访问自己当前有效 assignment；
5. 已被 replace 的旧 Companion → 404/403（按既有隐私约定）；
6. disabled Companion 失去权限；
7. 新 Companion 看不到旧 assignment 消息；
8. 订单用户看得到完整历史；
9. 非订单用户看不到；
10. Staff 能看全部历史；
11. Admin 按既有权限边界；
12. 写入与读取权限一致。

---

## 十一、与 P0-11 的联动

必须复用 P0-11 的唯一释放原语：

`releaseCurrentAssignment`

不要在 chat 模块重新判断“换人发生了没”。

需要在同一业务动作中保证：

- assignment release 成功；
- 旧 conversation 对旧 Companion 失效。

Mock 阶段保持同步原子语义；不得在伪事务原子区段加入 await。

如果聊天失效需要跨 repository 写入，使用现有 transaction 模式扩展，不要在 Route Handler 拼业务。

---

## 十二、与 direct replace 的联动

Staff direct replace：

`old assignment → release → new accepted assignment`

要求：

- old conversation 保留；
- old Companion 无访问权；
- new conversation 创建；
- new Companion 不看到 old conversation；
- 用户看到两段历史；
- Staff 看到两段历史。

---

## 十三、明确不做

本轮不做：

- 聊天物理删除
- retention scheduler
- EX-CHAT-04 未冻结的永久保留规则
- 图片/附件/语音
- WebSocket
- 在线状态
- typing indicator
- 消息撤回
- 消息举报
- 完整 Assignment 聚合
- 新 User/Companion Auth
- 真数据库
- 真 Scheduler

---

## 十四、测试

至少覆盖：

### 模型/仓储

1. 一订单可有多个 assignment conversation；
2. 同一 assignment 不重复创建；
3. A → B 创建两条；
4. A → B → A 再次回来时创建第三条；
5. 历史消息不丢；
6. conversation 不以 orderId 单键覆盖。

### Companion

7. 当前 Companion 可读；
8. 当前 Companion 可发；
9. 非当前 Companion 拒绝；
10. release 后旧 Companion 立即失权；
11. replace 后旧 Companion 失权；
12. disable release 后失权；
13. 新 Companion 看不到旧消息；
14. 新 Companion 只能看到自己的 conversation；
15. 新 Companion unread 独立；
16. 旧 Companion unread 不污染新 Companion。

### User

17. owner 可看所有 assignment 历史；
18. owner 可对当前 conversation 发消息；
19. owner 不向历史 conversation 继续发消息；
20. non-owner 不可读；
21. 多 assignment UI/DTO 顺序稳定。

### Staff

22. Staff 可看全部历史；
23. release history 与 conversation history 对得上；
24. Staff read state 不被 Companion read state 污染。

### HTTP

25. companion chat 401；
26. 403/404 权限边界；
27. GET happy path；
28. POST happy path；
29. 旧 Companion route 拒绝；
30. 新 Companion route 只返回自己的消息；
31. User route 返回完整历史但不泄露内部 assignment key；
32. Staff route 返回调查所需历史但不泄露无关隐私。

### 回归

33. 用户 ↔ Staff 现有聊天不回归；
34. P0-11 cancel/release/replace 不回归；
35. P0-12/P0-13 refund 不回归；
36. completion/complaint 不回归；
37. route manifest / API 契约更新；
38. DTO key 精确边界测试。

---

## 十五、Requirement Check

开始写代码前检查：

- EX-SERVICE-04
- EX-CHAT-01
- EX-CHAT-02
- 当前 message schema
- 当前 conversation repository
- P0-11 release 原语

如果发现“assignment conversation 的创建时点”在权威需求中存在冲突，进入 CLARIFYING。

聊天保留期未冻结不阻塞本轮，只需明确 DEFER。

---

## 十六、Round Protocol

创建：

`docs/03-dev/rounds/P0-14/`

五件档案：

- README.md
- 01-prompt.md
- 02-decisions.md
- 03-delivery.md
- 04-acceptance.md

状态：

`PLANNED → CLARIFYING（如需要） → READY → IN_PROGRESS → AWAITING_ACCEPTANCE`

Claude 不得自行 DONE。

---

## 十七、门禁

执行：

- targeted chat tests
- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- production APP_BASE_URL 全量测试
- reviewer-agent 只读审查
- 修复全部 BLOCKER / MAJOR
- 最终完整复跑

生产 HTTP：

- fail = 0
- skipped = 0

---

## 十八、Git

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

## 十九、交付报告

必须输出：

1. Round Status；
2. Requirement Check；
3. conversation 模型变化；
4. assignmentKey 设计；
5. 用户/打手/Staff 权限矩阵；
6. A→B→A 聊天隔离证明；
7. P0-11 release/replace 联动；
8. 已读隔离；
9. DTO 隐私；
10. 新增/修改接口；
11. 新增/修改页面；
12. targeted tests；
13. pnpm test；
14. production HTTP；
15. typecheck/lint/build；
16. reviewer；
17. MINOR/NOTE；
18. retention DEFER；
19. git status；
20. 明确未开始 P0-15。

完成后停在 AWAITING_ACCEPTANCE。
