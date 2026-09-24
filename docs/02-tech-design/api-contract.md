# 接口契约（API Contract）

> 状态标签：**CURRENT** / **TARGET**（`NOT IMPLEMENTED`）/ **TBD**（`DO NOT INVENT`）。
>
> CURRENT 部分由扫描 `app/api/**/route.ts` 生成，共 **125 个 route.ts**（`admin` 62 · `staff` 20 · `companion` 8 · 其余为面向用户的接口）。

> **2026-09-23 需求重校准说明**：CURRENT 路由数量与现有行为保持不变；第三部分 TARGET 已按 `docs/01-requirements/` V0.3 更新。旧 P0-6/P0-7/P0-8 仅是历史计划编号，未来 Round 需重新分配。

---

# 第一部分：CURRENT API

**守卫列**：`—` 表示无守卫（公开或自行处理）。

---

## 1. 认证（auth）

### 用户端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| POST | `/api/auth/mock-login` | — | `lib/auth/session` + `lib/data/userRepository` ⚠️ | 模拟登录，写 Mock 会话 Cookie。由 `ENABLE_MOCK_AUTH` 控制，关闭时 404。可用 `{"userId":"u-1002"}` 切换身份：接口层（自动化 / curl）一直可以，**DEV-1 起用户端也有一个开发环境专用的悬浮面板**（`lib/auth/MockIdentityPanel.tsx`，服务端开关控制、关闭时整块不渲染）。切换 = **替换**当前会话，不是第二套登录态 |
| POST | `/api/auth/logout` | — | `lib/auth/session` | 清除会话 Cookie。`ENABLE_MOCK_AUTH` 关闭时 404 |

⚠️ `/api/auth/mock-login` 的 Route Handler **直接调用 `lib/data/userRepository`**，未经过 service 层。这是 Observed Current，见 §API Conventions 的说明。

### 管理端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| POST | `/api/admin/auth/mock-login` | — | `adminAuth` | 模拟管理员登录。由 `ENABLE_MOCK_ADMIN` 控制 |
| POST | `/api/admin/auth/logout` | — | `adminAuth` | 退出管理端 |
| GET | `/api/admin/auth/session` | `requireAdmin` | `adminAuth`（经守卫） | 当前管理员会话 DTO。**不受 `ENABLE_MOCK_ADMIN` 直接控制**——由开关关闭时 `getSessionAdmin()` 返回 null 间接变成 401 |

### 客服端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| POST | `/api/staff/auth/mock-login` | — | `staffAuth` | 模拟客服登录。由 `ENABLE_MOCK_STAFF` 控制 |
| POST | `/api/staff/auth/logout` | — | `staffAuth` | 退出客服端 |
| GET | `/api/staff/auth/session` | `requireStaff` | `staffAuth`（经守卫） | 当前客服会话 DTO |

**⚠️ 打手端没有自己的 auth 接口。** 打手复用用户会话，见 `architecture-rules.md` §4.2。

---

## 2. 公开读取（home / catalog / companions / agreements / rankings）

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/home` | — | `home` | 首页聚合数据（公告 / banner / 快捷入口 / 商品） |
| GET | `/api/catalog/products` | — | `catalog` | 商品列表查询（分类 / 筛选 / 分页），只返回上架商品 |
| GET | `/api/companions` | `requireUser` | `companions` | 陪玩（护航）公开列表，按可用状态 / 游戏 / 关键词筛选 |
| GET | `/api/agreements` | — | `agreements` | 协议列表与正文 |
| GET | `/api/rankings/consumption` | `requireUser` | `rankings` | 消费排行榜 |

---

## 3. 个人（me / profile / levels）

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/me` | `requireUser` | `profile` | 当前用户资料 |
| PATCH | `/api/me` | `requireUser` | `profile` | 编辑资料（昵称 / 头像 / 简介） |
| GET | `/api/me/consumption-level` | `requireUser` | `levels` | 消费等级与累计消费 |
| GET | `/api/me/companion-application` | `requireUser` | `companionApplications` | 我的入驻申请状态 |

---

## 4. 下单与支付（checkout / payment）

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| POST | `/api/orders/preview` | `requireUser` | `checkout` | 结算预览：校验选择、算金额、返回可用优惠券与陪玩 |
| POST | `/api/orders/pay` | `requireUser` | `checkout` | 创建支付请求（幂等键）。**不产生订单** |
| POST | `/api/payments/mock-confirm` | `requireUser` | `checkout` | 模拟支付确认 → 生成订单 + 支付记录 + 派单。**由 `ENABLE_MOCK_PAYMENT` 控制，关闭时 404** |

**⚠️ 订单是在 `mock-confirm` 里产生的，不是在 `/api/orders/pay`。**
订单初值 `status: "paid"` 由 `lib/services/checkout.ts:316` 的 `buildOrderFromRequest` 写入。

---

## 5. 订单（orders）

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/orders` | `requireUser` | `orders` | 我的订单列表（状态 tab / 关键词 / 分页） |
| GET | `/api/orders/[id]` | `requireUser` | `orders` | 订单详情（DTO 裁剪，不含 `clubNetIncome`） |
| POST | `/api/orders/[id]/refunds` | `requireUser` | `refunds` | 对订单发起退款申请（幂等键） |
| POST | `/api/orders/[id]/reviews` | `requireUser` | `reviews` | 对已完成订单提交评价（幂等键） |
| GET | `/api/orders/[id]/messages` | `requireUser` | `conversations` | 订单会话消息列表 |
| POST | `/api/orders/[id]/messages` | `requireUser` | `conversations` | 发送消息（幂等键） |
| POST | `/api/orders/[id]/messages/read` | `requireUser` | `conversations` | 标记用户侧已读 |

---

## 6. 退款（refunds）

### 用户端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/refunds/[id]` | `requireUser` | `refunds` | 退款详情（含时间轴、可执行动作） |
| POST | `/api/refunds/[id]/cancel` | `requireUser` | `refunds` | 撤销退款申请（仅 `pending` 可撤） |

### 管理端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/admin/refunds` | `requireAdmin` | `adminRefunds` | 退款列表（状态 / 关键词筛选） |
| GET | `/api/admin/refunds/[id]` | `requireAdmin` | `adminRefunds` | 退款详情 |
| POST | `/api/admin/refunds/[id]/start-review` | `requireAdmin` | `adminRefunds` | `pending → reviewing` |
| POST | `/api/admin/refunds/[id]/approve` | `requireAdmin` | `adminRefunds` | 审核通过。**联动把订单置为 `refunded` 且写入 `refundedAmount`** |
| POST | `/api/admin/refunds/[id]/reject` | `requireAdmin` | `adminRefunds` | 驳回（必填意见） |

**⚠️ `approve` 的退款金额口径（已由产品负责人裁定，2026-09-19）**：

- 当前阶段人工退款审批**只有「拒绝 / 全额退款」两种结果**，部分退款尚未实现。
- 批准时**必须**把 `order.actualPaidAmount` 作为实际退款金额写入 `order.refundedAmount`。
- **`refundedAmount` = 该订单累计实际已经退还给用户的金额**；未来部分退款上线后扩展为累计值。
- **曾经的缺陷（P0-5.5 已修复）**：`lib/data/adminRefundTransaction.ts` 调用 `applyOrderRefund` 时**省略了第三个参数**，会出现「已退款但 `refundedAmount` 为 0」。裁定为**修 Bug，不通过隐藏字段规避**——现显式传 `order.actualPaidAmount`（`adminRefundTransaction.ts:247`）。
- 金额取自**被修改的那张订单**，不取退款申请上的 `amount` 快照；`applyOrderRefund` 对已 `refunded` 的订单短路返回 `changed: false`，因此重复批准不会重复累计、也不刷新 `refundedAt`。
- **回归测试断言**：管理员全额退款后 `Order.status === "refunded"` **且** `refundedAmount === actualPaidAmount`。详见 `database-schema.md` §9。

### 客服端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/staff/refunds` | `requireStaff` | `staffRefunds` | 退款列表 |
| GET | `/api/staff/refunds/[id]` | `requireStaff` | `staffRefunds` | 退款详情 |
| POST | `/api/staff/refunds/[id]/start-review` | `requireStaff` | `staffRefunds` | `pending → reviewing` |
| POST | `/api/staff/refunds/[id]/reject` | `requireStaff` | `staffRefunds` | 驳回 |

**⚠️ 客服端没有 `approve`。** 客服不能批钱。`lib/constants/staffRefunds.ts` 的 `staffRefundAllowedActions` **只有 `canStartReview` 与 `canReject`**。
⚠️ 但真正拦住的是路由层（`app/api/staff/refunds/` 下没有 `approve/` 目录）——若有人往常量里补一个 `canApprove`，**没有任何测试会失败**。

---

## 7. 投诉（complaints）

### 用户端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/complaints` | `requireUser` | `complaints` | 我的投诉列表 |
| POST | `/api/complaints` | `requireUser` | `complaints` | 提交投诉（幂等键） |
| GET | `/api/complaints/[id]` | `requireUser` | `complaints` | 投诉详情 |

### 管理端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/admin/complaints` | `requireAdmin` | `adminComplaints` | 投诉列表 |
| GET | `/api/admin/complaints/[id]` | `requireAdmin` | `adminComplaints` | 投诉详情 |
| POST | `/api/admin/complaints/[id]/start-processing` | `requireAdmin` | `adminComplaints` | `pending → processing` |
| POST | `/api/admin/complaints/[id]/resolve` | `requireAdmin` | `adminComplaints` | `processing → resolved` |
| POST | `/api/admin/complaints/[id]/close` | `requireAdmin` | `adminComplaints` | → `closed` |

### 客服端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/staff/complaints` | `requireStaff` | `staffComplaints` | 投诉列表 |
| GET | `/api/staff/complaints/[id]` | `requireStaff` | `staffComplaints` | 投诉详情 |
| POST | `/api/staff/complaints/[id]/start-processing` | `requireStaff` | `staffComplaints` | 同管理端，**共用同一条伪事务** |
| POST | `/api/staff/complaints/[id]/resolve` | `requireStaff` | `staffComplaints` | 同上 |
| POST | `/api/staff/complaints/[id]/close` | `requireStaff` | `staffComplaints` | 同上 |

**客服端三个动作齐全**（与管理端不同，这里没有权限删减）。投诉处理**不改订单、不改退款**。

---

## 8. 打手（companion）

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/companion/dispatches` | `requireCompanion` | `companionDispatch` | 当前打手的两张订单池（专属 + 公共），含 `canAccept` 与 `notice` |
| POST | `/api/companion/dispatches/[id]/accept` | `requireCompanion` | `companionDispatch` | 接单（幂等重放）。所有判定在 `acceptDispatch` 的原子区段内 |
| GET | `/api/companion/orders` | `requireCompanion` | `companionOrders` | 仅返回 `actualCompanionId = 当前打手` 的订单 |
| GET | `/api/companion/orders/[id]` | `requireCompanion` | `companionOrders` | 打手订单详情；非 actualCompanion 统一按不泄露存在性的 404 处理 |
| POST | `/api/companion/orders/[id]/cancel` | `requireCompanion` | `companionOrders` / `companionOrderTransaction` | 仅 `accepted` actualCompanion 可主动取消；请求体含取消原因与幂等标识；成功后 `accepted → paid`、回 public、通知用户、记录最小退出历史；当前 P0 不处罚 |

**⚠️ 打手接口 CURRENT 共 5 个**（上表即全部；`dispatches` 两条属 P0-5，`orders` 三条属 P0-6）。
本章是打手端 CURRENT 的**唯一真值源**——`COMPANION_API_MANIFEST` 与磁盘上的
`app/api/companion/**` 都由门禁与本表对齐，别处不要再列第二份 CURRENT 清单。
未来 Companion 开始服务接口见第三部分 TARGET，真正落地时再扩充清单。

**⚠️ `app/api/companion/**` 的接口清单门禁由 P0-5.5 建立**（管理端有 62 条、客服端有 16 条）：
清单契约（`GET` / `POST`、`requireCompanion()` 为第一动作、引用的服务层函数）由
`tests/companion.test.mjs` 强制，且该文件**扫描磁盘上的真实 route 文件**与清单做双向
`deepEqual`，见 §2.11。

### 8.1 `GET /api/companion/dispatches` 的**返回顺序**（P0-6.1）

**两张池子的顺序是接口契约的一部分，服务端是唯一真值源。**

| 池子 | 排序真值 | 方向 |
|---|---|---|
| 专属池 `exclusive` | `DispatchRecord.exclusiveEnteredAt` | ASC（等待最久优先） |
| 公共池 `public` | `DispatchRecord.publicPoolEnteredAt` | ASC（等待最久优先） |

- **顶部 = 在**当前这个池子**里等得最久的一单**；越往下 = 越晚进入当前池。
- **`EnteredAt` 取「当前池」的那一个**：由 `record.state` 决定
  （`exclusive` 取 `exclusiveEnteredAt`，其余取 `publicPoolEnteredAt`），
  与 `companionDispatchTransaction.currentDeadlineAt` **同形状**。
  ⚠️ 不能按 `exclusiveCompanionId` 取：`public` 记录可以带**非空**的
  `exclusiveCompanionId` / `exclusiveEnteredAt`（用户指定过、对方超时转池），
  那是历史事实，不是当前池。
- **禁止**以 `publicDeadlineAt` / `exclusiveDeadlineAt`（到点时刻）、`Order.createdAt`、
  Map / 数组插入顺序作为排序依据。前者在「公共池时长被后台改过」后与 `EnteredAt` 序**不同**
  （P0-1 起该时长可配置），后者在 P0-6 取消回池后会**倒挂**。
- **重新回池按新时刻**：`cancel` 回 public 会**重写** `publicPoolEnteredAt`
  （见本节上表 `cancel` 一条与 §3.1 共同约束），因此一张很早创建的订单在取消回池后
  按**这次进入**的时刻参与排序。
- **并列**：时刻完全相同时按 **`dispatchId` ASC**（稳定、确定性、与请求顺序无关）。
- **顺序只在服务端算一次**：调用方（页面 / HTTP 测试 / 将来的客户端）**不得再 `.sort(...)`**。
  排序键不进入 DTO——`CompanionPoolItem` 的字段集合**不因此变更**（见 §2.5 DTO 最小化）。
- 回归测试：`tests/companionPoolOrder.test.mjs`。

---

## 9. 入驻申请（companion-applications）

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| POST | `/api/companion-applications` | `requireUser` | `companionApplications` | 提交入驻申请（幂等键，一人一条） |
| POST | `/api/companion-applications/[id]/withdraw` | `requireUser` | `companionApplications` | 撤回申请 |

### 管理端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/admin/companion-applications` | `requireAdmin` | `adminCompanionApplications` | 申请列表 |
| GET | `/api/admin/companion-applications/[id]` | `requireAdmin` | `adminCompanionApplications` | 申请详情 |
| POST | `/api/admin/companion-applications/[id]/start-review` | `requireAdmin` | `adminCompanionApplications` | 开始审核 |
| POST | `/api/admin/companion-applications/[id]/approve` | `requireAdmin` | `adminCompanionApplications` | 通过 → 建立护航记录 |
| POST | `/api/admin/companion-applications/[id]/reject` | `requireAdmin` | `adminCompanionApplications` | 驳回 |

**⚠️ 这 5 条**，而 `tests/admin.test.mjs` 的标题写的是「申请审核**四件**」——是文案漂移，清单数组本身是 62 条且准确。

---

## 10. 其余用户端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/coupons` | `requireUser` | `coupons` | 我的优惠券 / 可领券列表 |
| POST | `/api/coupons/[id]/claim` | `requireUser` | `coupons` | 领券（幂等键，同一券限领一次） |
| GET | `/api/favorites` | `requireUser` | `favorites` | 我的收藏 |
| POST | `/api/favorites` | `requireUser` | `favorites` | 添加收藏（重复添加幂等） |
| GET / DELETE | `/api/favorites/[productId]` | `requireUser` | `favorites` | 查询 / 取消单条收藏 |
| GET | `/api/notifications` | `requireUser` | `notifications` | 站内通知列表 + 未读数 |
| POST | `/api/notifications/[id]/read` | `requireUser` | `notifications` | 标记已读 |
| GET | `/api/tips` | `requireUser` | `tips` | 鸡腿（打赏）记录 |
| GET | `/api/suggestions` | `requireUser` | `suggestions` | 我的反馈列表 |
| POST | `/api/suggestions` | `requireUser` | `suggestions` | 提交反馈（幂等键） |
| GET | `/api/reviews` | `requireUser` | `reviews` | 我的评价（已评 / 待评两个 tab） |
| GET | `/api/service/conversations` | `requireUser` | `conversations` | 客服会话列表 |

---

## 11. 客服工作台（staff）—— 16 条

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/staff/conversations` | `requireStaff` | `staffConversations` | 全部订单会话 |
| GET | `/api/staff/conversations/[orderId]` | `requireStaff` | `staffConversations` | 单个会话详情 |
| POST | `/api/staff/conversations/[orderId]/messages` | `requireStaff` | `staffConversations` | 客服发消息 |
| POST | `/api/staff/conversations/[orderId]/read` | `requireStaff` | `staffConversations` | 标记客服侧已读（按 `staffId` 独立） |

投诉 5 条 + 退款 4 条见上文 §6 / §7。auth 3 条见 §1。

**⚠️ 客服侧已读与用户侧已读是两份独立状态**，刻意不合并：
客服读完一个会话不能把用户的未读角标清零，反之亦然。键里带 `staffId`，因为两位客服同时值班时，一位读过的会话不该从另一位的工作台上消失。

---

## 12. 管理后台（admin）—— 62 条

### 12.1 订单 / 退款 / 投诉 / 申请

见 §5 / §6 / §7 / §9 中的管理端部分（`requireAdmin`）。订单管理端**只读**：

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/admin/orders` | `requireAdmin` | `adminOrders` | 订单列表（状态 / 游戏 / 日期筛选） |
| GET | `/api/admin/orders/[id]` | `requireAdmin` | `adminOrders` | 订单详情 |

### 12.2 护航管理（7 条）

| Method | URL | Guard | Service |
|---|---|---|---|
| GET | `/api/admin/companions` | `requireAdmin` | `adminCompanions` |
| GET / PATCH | `/api/admin/companions/[id]` | `requireAdmin` | `adminCompanions` |
| POST | `/api/admin/companions/[id]/enable` | `requireAdmin` | `adminCompanions` |
| POST | `/api/admin/companions/[id]/disable` | `requireAdmin` | `adminCompanions` |
| POST | `/api/admin/companions/[id]/pause` | `requireAdmin` | `adminCompanions` |
| POST | `/api/admin/companions/[id]/resume` | `requireAdmin` | `adminCompanions` |
| POST | `/api/admin/companions/[id]/remove` | `requireAdmin` | `adminCompanions` |

**⚠️ `pause` / `resume` 改的是 `available`（当前能不能接新单），`enable` / `disable` 改的是 `enabled`（资格在不在架），`remove` 是软删除（写 `removedAt`）。三者语义不同，不要合并。**

### 12.3 商品与类目（11 条）

| Method | URL | Guard | Service |
|---|---|---|---|
| GET / POST | `/api/admin/products` | `requireAdmin` | `adminProducts` |
| GET / PATCH | `/api/admin/products/[id]` | `requireAdmin` | `adminProducts` |
| POST | `/api/admin/products/[id]/publish` | `requireAdmin` | `adminProducts` |
| POST | `/api/admin/products/[id]/unpublish` | `requireAdmin` | `adminProducts` |
| POST | `/api/admin/products/[id]/remove` | `requireAdmin` | `adminProducts` |
| GET / POST | `/api/admin/categories` | `requireAdmin` | `adminCategories` |
| GET / PATCH | `/api/admin/categories/[id]` | `requireAdmin` | `adminCategories` |
| POST | `/api/admin/categories/[id]/enable` | `requireAdmin` | `adminCategories` |
| POST | `/api/admin/categories/[id]/disable` | `requireAdmin` | `adminCategories` |
| POST | `/api/admin/categories/[id]/remove` | `requireAdmin` | `adminCategories` |

### 12.4 运营内容（15 条）

四类内容同构：**协议（agreements）/ 公告（announcements）/ Banner（banners）/ 快捷入口（quick-entries）**。

| 模式 | Method | Guard | Service |
|---|---|---|---|
| `GET` 列表 | GET | `requireAdmin` | `adminAgreements` / `adminAnnouncements` / `adminBanners` / `adminQuickEntries` |
| `POST` 新建 | POST | `requireAdmin` | 同上（协议无新建） |
| `GET / PATCH` 单条 | GET, PATCH | `requireAdmin` | 同上 |
| `/enable` `/disable` `/remove` | POST | `requireAdmin` | 同上 |

具体路径：`/api/admin/content/{agreements,announcements,banners,quick-entries}`。

### 12.5 客服账号（5 条）

| Method | URL | Guard | Service |
|---|---|---|---|
| GET / POST | `/api/admin/staff` | `requireAdmin` | `adminStaff` |
| GET / PATCH | `/api/admin/staff/[id]` | `requireAdmin` | `adminStaff` |
| POST | `/api/admin/staff/[id]/enable` | `requireAdmin` | `adminStaff` |
| POST | `/api/admin/staff/[id]/disable` | `requireAdmin` | `adminStaff` |
| POST | `/api/admin/staff/[id]/remove` | `requireAdmin` | `adminStaff` |

### 12.6 平台配置（1 条）

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET / PATCH | `/api/admin/platform-config` | `requireAdmin` | `adminPlatformConfig` | 公共池超时等平台级参数 |

---

# 第二部分：API Conventions

**以下约定在当前仓库中已经稳定，新增接口必须遵守。**

## 2.1 四个守卫

| 守卫 | 位置 | 读取 | 未登录 | 已登录但无权限 |
|---|---|---|---|---|
| `requireUser()` | `lib/api/route.ts` | 用户 Cookie | 401 `UNAUTHORIZED` | — |
| `requireAdmin()` | `lib/api/adminRoute.ts` | 管理 Cookie | 401 `UNAUTHORIZED` | 403 `FORBIDDEN` |
| `requireStaff()` | `lib/api/staffRoute.ts` | 客服 Cookie | 401 `UNAUTHORIZED` | 403 `FORBIDDEN` |
| `requireCompanion()` | `lib/api/companionRoute.ts` | 用户 Cookie + `resolveCompanionAccess()` | 401（由 `requireUser()` 给出） | 403 `FORBIDDEN`（两种情形分开表达） |

**规则**：

1. **每个接口必须自己调用守卫，而且必须是第一步。** 页面上的隐藏按钮、侧栏里的禁用项**不构成保护**——接口可以被直接请求。
2. **四个守卫并列，不合并成参数化函数。** 理由见 `architecture-rules.md` §4.2。
3. **「我是谁」只能由服务端会话决定**，不接受请求体或查询参数里的任何用户标识。

## 2.2 401 / 403 / 404 语义

| 状态 | 含义 | 客户端处置 |
|---|---|---|
| **401 `UNAUTHORIZED`** | 未登录 / 会话失效 | 去登录页 |
| **403 `FORBIDDEN`** | 已登录，但没有该权限（换账号也没用） | 换账号 |
| **404 `NOT_FOUND`** | 资源不存在；**或用于刻意隐藏存在性**；**或功能未启用** | 视场景 |

**两个刻意使用 404 的场景**：

1. **不泄露资源存在性**——如「其他打手访问不属于他的订单」返回 404 而不是 403。
2. **Mock 开关关闭**——`mock-login` / `mock-confirm` 在开关关闭时返回 **404 而不是 403**：功能不存在，而不是「你没权限」。

**⚠️ 两种拒绝的文案策略**：管理端与客服端给**同一套、不含具体原因的提示**——区分「你不是管理员」与「你的账号被停用了」，等于给出一个可以探测账号状态的接口。
**打手端是例外**：「不是护航」与「资格已下架」分开表达，因为这两件事对使用者的下一步动作完全不同（去入驻 vs 找管理员），且不构成账号探测（这位用户自己本来就知道）。

## 2.3 响应信封

```ts
// 成功
{ data: T }

// 失败
{ error: { code: ApiErrorCode; message: string } }
```

`ApiErrorCode`（`lib/types/common.ts`）= `BAD_REQUEST` | `UNAUTHORIZED` | `FORBIDDEN` | `NOT_FOUND` | `SERVER_ERROR` | `NETWORK_ERROR`。

**⚠️ `NETWORK_ERROR` 只在浏览器侧产生**，不参与 HTTP 状态映射（`STATUS_BY_CODE` 里为 0）。

**状态码由 `code` 推导**（`lib/api/ApiError.ts` 的 `STATUS_BY_CODE`），少数刻意区分的场合显式传入。
**⚠️ 缺了这层映射就会出现「业务校验失败却回 500」**：客户端拿到的 `code` 是 `BAD_REQUEST`、状态码却是 500，重试策略与日志都会把它当成服务端故障。

Route Handler 侧统一用 `ok()` / `fail()` / `toApiError()`。
**非 `ApiError` 一律归一成 `SERVER_ERROR`，不把内部异常信息暴露给客户端。**

## 2.4 请求体校验

用 `readJsonBody(request)`（`lib/api/route.ts`）：解析失败或不是对象（含数组）→ 抛 `BAD_REQUEST`。
字段级校验在 **`lib/constants/*.ts`** 里做（如 `validateGameAccount`、`validateComplaintText`），返回校验结果供 service 抛 `ApiError`。

**CURRENT 没有 validation 框架。** 引入需先说明手写校验在哪类输入上已失控，见 `tech-stack.md` §十。

## 2.5 DTO 最小化 —— 硬约束

**接口从不返回仓储记录整体，一律显式挑字段。**

**已明确执行的三条**：

| 接口 | 刻意不返回 |
|---|---|
| `/api/admin/auth/session` | 密码、密钥、`enabled`、`lastLoginAt` |
| `/api/companion/dispatches`（池卡片） | `gameAccountId`、`remark`、`userId`、金额明细 |
| `/api/orders/[id]`（用户侧订单） | `clubNetIncome` |

**理由**：字段是**显式挑出来的**，因此将来给实体加字段**不会自动顺着接口流出去**。

## 2.6 金额单位

**一律整数「分」**（`number`）。
**只在服务端计算**，`*Http.ts` 与 `components/` 不做金额算术。
**公式必须复用** `lib/constants/orderAmount.ts`。

## 2.7 时间格式

**ISO 8601 字符串**（`string`），不是 `Date` 对象。
需要「同一时刻」语义的地方（如清扫 + 剩余时间），**由调用方传入 `at`**，不在函数内取 `new Date()`。

## 2.8 幂等（idempotency）

**四种机制并存，按场景选择**：

| 机制 | 实现位置 | 用于 |
|---|---|---|
| **幂等键索引** | 各 store 的 `${userId}:${idempotencyKey}` → 记录 id | 用户侧创建类接口（支付请求 / 退款 / 投诉 / 评价 / 反馈 / 领券 / 消息） |
| **业务唯一键索引** | 如 `${userId}:${orderId}`（一单一评）、`orderId`（一单一退款） | 天然唯一的业务关系 |
| **`operationId` 重放** | `lib/data/adminWriteSupport.ts` 的 `takeReplay` / `takeReplayForAction` / `takeCreateReplay` | 管理端 / 客服端写操作 |
| **状态本身即判据** | 动作伪事务的原子区段内先判「结果状态是否已经成立」 | **只有结果状态可作判据的推进类动作**：`acceptDispatch`（P0-5）/ `startCompanionOrder`（P0-7）/ `approveCompletion` · `rejectCompletion`（P0-8）。**有没有请求体不是判据**——`rejectCompletion` 带 `reviewNote`，但重放判据仍是「这份材料是否已经是 `rejected`」 |

**⚠️ 选哪种，先问「这个动作有没有天然的状态判据」。** 有（「这一单已经是我的 `serving` 了吗」）就用第四种——
它不引入需要客户端生成、传输、保存的键，因此也不需要一条「键必填」的校验规则；没有（用户侧创建类，
同一用户可能合法地连提两次）才需要幂等键。

**⚠️ 幂等的关键性质**：**同一个幂等键第二次到达时，既不重复写业务数据，也不写第二条审计。**
**⚠️ 状态判据式的重放还要求**：不刷新已经写入的时间戳（`start` 的 `servingAt`、`completion` 通过后的
`completedAt`、以及审核结果首次落地的 `reviewedAt` 都必须停在第一次那一刻——三处都写成
`xxx ?? at`；`rejectCompletion` 的重放**不覆盖**第一次的驳回原因）。
**⚠️ 第四种机制的一个已知边界**：完成材料的 `applyCompletionReview` 只按调用方给的目标状态写入，
**它自己不校验起始状态**——合法性由伪事务在调用它之前判定。因此「作废一份 pending」这类新动作
（P0-9 的封禁回池）**不能**图省事复用它，那会写出状态机不允许的边，并且会让
「同一订单最多一份 pending」的索引与记录状态脱钩。
**⚠️ 实现细节（Observed Current，不是规范）**：`operationId` 重放是靠**扫描内存中的审计条目**（`auditIdByOperationId` Map），**不是数据库唯一索引**。映射到真实数据库时必须改为 unique constraint，见 `database-schema.md`。

## 2.9 资源归属

**归属判定必须在服务端做，且只在 service / 事务里做一次。**

- 用户侧：查询一律带 `userId`，不是「查出来再比对」。
- 打手侧：`order.actualCompanionId` 决定谁能操作；非归属者的访问按 **404**（不泄露存在性）处理。
- 客服侧：客服的已读状态**按 `staffId` 独立**。

## 2.10 Mock API 开关

五个开关见 `tech-stack.md` §六。**关键行为**：

- 关闭时对应接口返回 **404**（不是 403）：功能不存在。
- 开关用**动态 key** 读 env，避免被构建期内联。
- **三个登录开关互不影响**：「用户 Cookie 不能获得管理权限」「管理 Cookie 不能冒充普通用户」在开关层面也不会串。

**调试参数**（`ENABLE_MOCK_DEBUG` 控制）：`mockError` / `mockEmpty` / `mockDelay`，由 `lib/api/client.ts` 的 `withMockParams` 透传，`lib/mocks/debug.ts` 读取。**Mock 层移除时一并删除**。

## 2.11 接口清单门禁

**新增后台 / 客服 / 打手接口时，必须同批扩充清单数组**：

| 门禁 | 位置 | 当前条数 |
|---|---|---|
| 管理端 | `tests/admin.test.mjs` | 62 |
| 客服端 | `tests/staff.test.mjs` | 20 |
| 打手端 | `tests/`（P0-5.5 建立，扫描 `app/api/companion/**`；P0-6 / P0-7 / P0-8 / P0-9 扩充） | 8 |

**打手端门禁：已确认建立（产品裁定 2026-09-19），属 P0-5.5，本轮落地。**
建立与 Admin / Staff 类似的 Companion API route manifest / route gate，扫描 `app/api/companion/**` 并与预期清单比对：

- 清单**逐条列出**（不是只断言数量）。**P0-9 起共八条**：`GET /api/companion/dispatches`、`POST /api/companion/dispatches/[id]/accept`（P0-5.5），`GET /api/companion/orders`、`GET /api/companion/orders/[id]`、`POST /api/companion/orders/[id]/cancel`（P0-6），`POST /api/companion/orders/[id]/start`（P0-7），`POST /api/companion/orders/[id]/completion`（P0-8），`GET /api/companion/earnings`（P0-9）；
- 每个路由**导出的 HTTP 方法**要与清单一致（多一个方法也要现形），第一动作必须是 `requireCompanion()`，且不出现其它身份的守卫；引用的服务层函数也要与清单一致；
- 同时 `orders/**` 下的 `POST` 写入口**恰好三个**（`cancel` / `start` / `completion`）且集合逐字相等——门禁按「导出 `POST` 的文件集合」判定，因此把接口改名成 `begin` / `serve` / `submit` 也绕不过去；
- **不得**把**尚未实现**的 TARGET 路由登记进清单。这条由「清单与实际路由**逐字相等** + 数量**恰好**」两条断言共同强制：`app/api/companion/**` 下多出任何一个 `route.ts`（当前最可能的是提现入口 `/companion/withdrawals`——它的入口 / 流程 / 渠道 / 最小金额全部仍是 TBD，见第四部分）都会让数量断言失败，因此**不需要**为每个未来路径各写一条具名负向断言。⚠️ 该机制的前提是**数量断言与清单长度同批更新**——只改清单不改数量，就等于把门禁关掉；
- **P0-9 新增的负向约束**：`earnings` 是**只读**接口，`app/api/companion/earnings/route.ts` 只允许导出 `GET`。收益的任何写入（生成 / 解冻）都发生在服务端伪事务里，接口层没有写入入口——因此「打手自己把自己的收益改成可提现」在结构上不存在；
- 另一条只属于 `start` 的门禁：**它的接口不读请求体**（这个动作没有原因、没有幂等键，幂等判据是状态本身）。一旦有人给它加上 `readJsonBody`，一个空体 POST 就会变成 400，等于发明了一条服务端文档里没有的必填体规则；
- **「不读请求体」不是 `start` 独有**：`POST /api/staff/completions/[id]/approve`（P0-8）同样不读体（通过没有原因，幂等判据是状态本身）。**反例是 `reject`**——它必须读 `reviewNote` 且必填。判据是「这个动作有没有必须由人填写的输入」，不是「它属不属于推进类动作」；
- **未来真正新增 Companion 订单接口时同步扩充清单**；
- **新增、删除、误改路径时测试必须失败**；
- **沿用现有 tests 的源码扫描 / 路由门禁方式，不新建测试框架**；文件名遵循仓库现有命名风格，不为了名字本身新增抽象。

**`tests/companion.test.mjs` 已于 P0-5.5 建立，P0-6 扩充至 5 条路由 / 7 条用例，P0-7 扩充至 6 条路由 / 8 条用例，P0-8 扩充至 7 条路由 / 8 条用例，P0-9 扩充至 8 条路由**（全绿）；上列清单即该文件里的 `COMPANION_API_MANIFEST`，「第一动作必须是 `requireCompanion()`」由位置断言强制（比较前先剥掉 import，否则该断言恒为真）。

---

# 第三部分：TARGET API

**以下能力已由 2026-09-23 V0.3 需求确认，尚未实现的一律标注 `TARGET — NOT IMPLEMENTED`；旧 P0-6/P0-7/P0-8 编号不再作为执行顺序真值。**

## 3.1 Companion 我的订单、主动取消与开始服务

> ⚠️ **本节四条全部已实现**：`GET /api/companion/orders`、`GET /api/companion/orders/[id]`、
> `POST /api/companion/orders/[id]/cancel`（P0-6）与 `POST /api/companion/orders/[id]/start`（P0-7）。
> 它们属 CURRENT，清单**只在 §8 列出一次**，本节不重复——同一份文档里放两张 CURRENT 表，
> 迟早会有一张先改、另一张被当成还没实现。

### TARGET — NOT IMPLEMENTED

（无。`start` 已于 P0-7 落地，见 §8；后续阶段是 §3.2 的 CompletionSubmission。）

**共同约束（四条 CURRENT 接口都适用）：**

- `exclusiveCompanionId` 不授予我的订单详情/动作权限；资源归属看 `actualCompanionId`。
- `cancel` 只允许 `accepted`；`serving` 后没有普通主动取消入口。
- `cancel` 回 public 时必须重新冻结 `publicPoolEnteredAt / publicTimeoutMinutesSnapshot / publicDeadlineAt`，并清除“当前履约绑定”；历史由最小退出记录保留。
- `start` 只有 `accepted` 合法，且不存在任何根据时间 / 备注 / 聊天自动进入 serving 的路径。
- 幂等/并发下只允许一次真实状态推进，不重复通知、不刷新已经成功写入的时间。
  两条接口的重放判据不同：`cancel` 用幂等键，`start` 用**状态本身**（已经是 `serving` 且归本人）。
- 新增 Companion API 落地时必须同步扩充 `tests/companion.test.mjs` 的 manifest；未实现前不得预登记（见第二部分末的负向门禁）。

**打手端页面入口**：`/companion/orders`、`/companion/orders/[id]`（P0-6 已实现）。

同一个详情页继续承载 `accepted` 的“开始服务”（**P0-7 已落地**）和 `serving` 的“提交完成材料”（**P0-8 已落地**，见 §3.2），不得为后续阶段复制第二套订单详情。

## 3.2 CompletionSubmission：人工审核 + 10 分钟默认自动审核

> ⚠️ **本节五条已于 P0-8 全部实现**（`POST /api/companion/orders/[id]/completion`、
> `GET /api/staff/completions`、`GET /api/staff/completions/[id]`、
> `POST /api/staff/completions/[id]/approve`、`POST /api/staff/completions/[id]/reject`），
> 因此它们属 **CURRENT**。
>
> **下表不是第二份清单**——**条数的唯一真值源是 §2.11 的门禁**（客服端 20 条见
> `tests/staff.test.mjs`，打手端 **8** 条见 `tests/companion.test.mjs` 的 `COMPANION_API_MANIFEST`）。
> 保留这张表是为了记录这五条的**契约形状**（Guard / Service / 语义），
> 它是本文件里唯一一处写出「哪条路由归哪个服务模块」的地方；**增删路由时改的是清单数组，
> 不是这张表**。§3.1 能直接删表，是因为那四条打手路由在 §2.11 里已逐条列出。
>
> 本节剩下的 TARGET 只有最后一条（封禁回池时作废 pending），见下方标注。

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| POST | `/api/companion/orders/[id]/completion` | `requireCompanion` | `companionCompletions` | 当前实际打手在 `serving` 提交截图 + 5~50 字说明 |
| GET | `/api/staff/completions` | `requireStaff` | `staffCompletions` | 待审列表 |
| GET | `/api/staff/completions/[id]` | `requireStaff` | `staffCompletions` | 详情 |
| POST | `/api/staff/completions/[id]/approve` | `requireStaff` | `staffCompletions` | 人工通过 → Order `completed`；**不读请求体** |
| POST | `/api/staff/completions/[id]/reject` | `requireStaff` | `staffCompletions` | 驳回 → Order 保持 `serving`；允许重新提交；**读 `reviewNote` 且必填** |

**已确认约束：**

- 同一订单同时最多 **1 份 `pending`**；已有 pending 时重复提交必须拒绝/幂等，不创建第二份。
- 自动审核配置默认 **10 分钟**，后台可修改。
- 每次 submission 进入 pending 时冻结 `autoApprovalMinutesSnapshot` 与 `autoApprovalDeadlineAt`；后台之后改配置不追溯改变该份材料。
- rejected 后重新提交时重新读取当前配置并重新计时。
- `sweepCompletionAutoApprovals(at)`（P0-8 落地名，同步、幂等）只在：仍 pending、Order 仍 serving、deadline 已到、无投诉/有效售后阻塞、尚未被人工处理时自动通过。它挂在读取路径上做惰性物化（与 `sweepExpiredDispatches` 同形），真实 Scheduler 上线后必须复用**同一个**函数。
- 自动通过与客服通过都产生 `Order.status = completed`，但必须记录审核来源为 System，**不得伪装成 Staff**。
- **TARGET（P0-9）：** Companion 被封禁/移除导致订单回池时，其旧 pending CompletionSubmission 必须先作废并退出自动审核资格。⚠️ 实现时注意 `applyCompletionReview` **不校验起始状态**，且「同一订单最多一份 pending」的索引只在它内部清除——见 §2.8 的已记录边界。
- 人工通过、自动通过、人工驳回、封禁作废之间必须并发安全；先成功的一方决定事实，后续动作安全失败/no-op。

## 3.3 用户退款：未服务直接全额退款，已服务进入售后

**复用 CURRENT `POST /api/orders/[id]/refunds` 作为用户退款入口，不新增第二套 Refund 系统。TARGET 行为按 Order 状态分流：**

| Order.status | TARGET 行为 |
|---|---|
| `paid` | 直接全额退款成功；不需要客服/管理员审批 |
| `accepted` | 直接全额退款成功；打手收益为 0，不生成 Earning；通知已接单打手；终态保留 `actualCompanionId` 历史事实 |
| `serving` | 创建/进入人工售后退款链路，由客服调查，管理员最终决定资金 |
| `completed` | 仅在本单 `complaintDeadlineAt` 前按投诉/售后规则处理 |
| `refunded` | 不允许再次退款，幂等返回既有结果或业务拒绝 |

**重要**：CURRENT `/api/orders/[id]/refunds` 仍是旧“创建退款申请”行为；上表是 TARGET，不得在文档中假装已经实现。

## 3.4 平台生命周期配置

CURRENT `/api/admin/platform-config` 继续复用，不新增第二个平台配置系统。TARGET 至少增加：

- `exclusivePoolTimeoutMinutes`（或与现有命名规范等价的字段）：进入 exclusive 时冻结本单 snapshot/deadline；
- `completionAutoApprovalMinutes`：默认 **10**；每次 completion 进入 pending 时冻结 snapshot/deadline；
- `complaintWindowMinutes`：默认 **1440**（24 小时），取值 **60 ~ 10080** 分钟；进入 completed 时冻结本单 snapshot/deadline；
- 现有 `publicPoolTimeoutMinutes` 保持同样 snapshot 语义。

PATCH 必须走既有 Admin 守卫、校验、审计与平台配置事务；修改配置只影响未来进入对应生命周期阶段的业务事实。

## 3.5 Companion 封禁 / 移除的订单联动

**复用 CURRENT 管理端 Companion disable/remove 动作，不新增“封禁订单”第二套接口。TARGET 事务副作用：**

- 当前打手存在 `accepted` / `serving` 订单时，解除当前履约并重新进入 public；
- 通知用户；
- 若有其 pending CompletionSubmission，先作废并退出自动审核资格；
- 记录最小退出历史；
- 封禁动作本身不自动退款。

## 3.6 客服直接换人（P0 最小实现）

产品权限已确认：**客服可以直接执行换人，不需要管理员批准，且不设置固定换人次数上限；退款资金仍由管理员最终决定。**

为避免提前引入复杂 Assignment 聚合，P0 技术映射采用“解除当前履约 → 回 public → 由新打手重新接单”的最小路径，并保留最小退出历史。客服动作的最终 URL/DTO 在对应 Round 按现有 `staff` 路由命名冻结后写入 manifest；**在真实路由出现前不得把猜测路径登记为 CURRENT。**

## 3.7 Earning / Settlement

**状态：CURRENT（P0-9 落地）。**

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/companion/earnings` | `requireCompanion` | `companionEarnings` | 打手收益列表 + 汇总（冻结 / 可提现；只读） |

**已确认目标语义（P0-9 全部落地）：**

- Order completed → 为当时实际履约打手生成 frozen Earning，金额取订单 `companionBaseIncome` 快照；
- 解冻时点不再硬编码 `completedAt + 48h`，而是消费本单冻结的 `complaintDeadlineAt`；
- deadline 到达且无投诉/售后冻结原因后 `frozen → available`；
- `sweepMaturedEarnings(now)` 同步、幂等、可重复调用；Scheduler 必须复用它；
- 提现、自动罚款、余额桶细节仍按 TBD 处理。

**实现要点（可据此核对，落点在 `lib/data/earningTransaction.ts` 与 `lib/services/companionEarnings.ts`）：**

- **结算只有一个入口**：`settleOrderCompletion()` 一次写完「订单 → completed + 冻结 `complaintWindowMinutesSnapshot` / `complaintDeadlineAt` + 生成 frozen Earning」。P0-8 的两条完成路径（客服人工通过、System 到期自动通过）都只调用它，不允许任何一处自己再算一次 deadline 或再建一条收益；
- **金额不重算**：`incomeAmount` 直接搬 `Order.companionBaseIncome`（下单时的分账快照），不查商品现价、不查当前分账比例；
- **`availableAt` = 本单 `complaintDeadlineAt`**，不另加一次分钟数；
- **不追溯**：P0-9 之前已完成的历史订单**不回填**窗口与收益（回填等于用今天的配置去改历史订单，或用历史 `completedAt` 凭空造出一笔「早该解冻」的钱）；
- **接口只读**：`GET` 是唯一导出方法，收益写入没有 HTTP 入口；
- **DTO 隐私**：打手收益 DTO 不含 `clubNetIncome` / `companionId` / `reversedAmount` / `fineAmount` / `withdrawnAt`。

## 3.8 计划存在但本次不提前实现

- 优惠券正式核销、B/A/S 并发、提现、管理员余额调整/会费批扣账本细节等继续按各自后续需求处理。
- 完整 AfterSalesCase 聚合不是 P0 必需条件；P0 可复用现有 Complaint / Refund + 最小回池动作，禁止为了“模型漂亮”先造复杂系统。

# 第四部分：TBD — DO NOT INVENT

**以下接口/能力既未实现，规则也未确认。禁止自行设计。**

| 能力 | 状态 |
|---|---|
| **提现 API** | **TBD — DO NOT INVENT**。入口、审核流程、打款渠道、最小金额全部未定 |
| **自动罚款 / 余额扣减 API** | **TBD — DO NOT INVENT**。accepted 主动取消当前 P0 明确不处罚；管理员人工余额调整/会费批扣仅确认业务需要，账本/API 细节未冻结 |
| **结算 / 对账 API** | **TBD — DO NOT INVENT** |
| **复杂 Replacement / Assignment 聚合 API** | **TBD — DO NOT INVENT**。P0 已确认客服直接换人、次数不限，并采用最小“回 public + 退出历史”路径；复杂指定改派/统一 Assignment 模型仍未确认 |
| **用户封禁 API** | **TBD — DO NOT INVENT** |
| **打手侧统一「操作史」查询 API** | **TBD — DO NOT INVENT**（计划 R7） |
| **「服务异常」触发与售后区** | **TBD — DO NOT INVENT**（计划 R4） |
| **「非普通投诉通道」** | **TBD — DO NOT INVENT**（计划 R5） |
