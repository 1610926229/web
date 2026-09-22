# 接口契约（API Contract）

> 状态标签：**CURRENT** / **TARGET**（`NOT IMPLEMENTED`）/ **TBD**（`DO NOT INVENT`）。
>
> CURRENT 部分由扫描 `app/api/**/route.ts` 生成，共 **115 个 route.ts**。

> **2026-09-23 需求重校准说明**：CURRENT 路由数量与现有行为保持不变；第三部分 TARGET 已按 `docs/01-requirements/` V0.3 更新。旧 P0-6/P0-7/P0-8 仅是历史计划编号，未来 Round 需重新分配。

---

# 第一部分：CURRENT API

**守卫列**：`—` 表示无守卫（公开或自行处理）。

---

## 1. 认证（auth）

### 用户端

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| POST | `/api/auth/mock-login` | — | `lib/auth/session` + `lib/data/userRepository` ⚠️ | 模拟登录，写 Mock 会话 Cookie。由 `ENABLE_MOCK_AUTH` 控制，关闭时 404。**验收期可用 `{"userId":"u-1002"}` 切换身份；用户端页面无切换入口** |
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

**⚠️ 打手接口 CURRENT 只有这 2 个**；未来 Companion 订单/取消/开始服务接口见第三部分 TARGET，真正落地时再扩充清单。
**⚠️ `app/api/companion/**` 的接口清单门禁属 P0-5.5**（管理端有 62 条、客服端有 16 条）：
本轮已冻结下面两条的清单契约（`GET` / `POST`、`requireCompanion()` 为第一动作、引用的服务层函数），
门禁测试写入 `tests/`，见 §2.11。

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

**三种机制并存，按场景选择**：

| 机制 | 实现位置 | 用于 |
|---|---|---|
| **幂等键索引** | 各 store 的 `${userId}:${idempotencyKey}` → 记录 id | 用户侧创建类接口（支付请求 / 退款 / 投诉 / 评价 / 反馈 / 领券 / 消息） |
| **业务唯一键索引** | 如 `${userId}:${orderId}`（一单一评）、`orderId`（一单一退款） | 天然唯一的业务关系 |
| **`operationId` 重放** | `lib/data/adminWriteSupport.ts` 的 `takeReplay` / `takeReplayForAction` / `takeCreateReplay` | 管理端 / 客服端写操作 |

**⚠️ 幂等的关键性质**：**同一个幂等键第二次到达时，既不重复写业务数据，也不写第二条审计。**
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
| 客服端 | `tests/staff.test.mjs` | 16 |
| 打手端 | `tests/`（P0-5.5 建立，扫描 `app/api/companion/**`） | 2 |

**打手端门禁：已确认建立（产品裁定 2026-09-19），属 P0-5.5，本轮落地。**
建立与 Admin / Staff 类似的 Companion API route manifest / route gate，扫描 `app/api/companion/**` 并与预期清单比对：

- 清单**逐条列出**（不是只断言数量），当前**恰好两条**：`GET /api/companion/dispatches`、`POST /api/companion/dispatches/[id]/accept`；
- 每个路由**导出的 HTTP 方法**要与清单一致（多一个方法也要现形），第一动作必须是 `requireCompanion()`，且不出现其它身份的守卫；引用的服务层函数也要与清单一致；
- **不得**把 `/companion/orders`、`/companion/orders/[id]` 等尚不存在的 TARGET 路由登记进清单；
- **未来真正新增 Companion 订单/取消/开始服务接口时同步扩充清单**；
- **新增、删除、误改路径时测试必须失败**；
- **沿用现有 tests 的源码扫描 / 路由门禁方式，不新建测试框架**；文件名遵循仓库现有命名风格，不为了名字本身新增抽象。

**`tests/companion.test.mjs` 已于 P0-5.5 建立**（当前 2 条路由 / 7 条用例，全绿）；上列清单即该文件里的 `COMPANION_API_MANIFEST`，「第一动作必须是 `requireCompanion()`」由位置断言强制（比较前先剥掉 import，否则该断言恒为真）。

---

# 第三部分：TARGET API

**以下能力已由 2026-09-23 V0.3 需求确认，但尚未实现。**
**一律标注 `TARGET — NOT IMPLEMENTED`；旧 P0-6/P0-7/P0-8 编号不再作为执行顺序真值。**

## 3.1 Companion 我的订单、主动取消与开始服务

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/companion/orders` | `requireCompanion`（预期） | `companionOrders` | 仅返回 `actualCompanionId = 当前打手` 的订单；至少区分进行中/已结束 |
| GET | `/api/companion/orders/[id]` | `requireCompanion`（预期） | `companionOrders` | 打手订单详情；非 actualCompanion 统一按不泄露存在性的 404 处理 |
| POST | `/api/companion/orders/[id]/cancel` | `requireCompanion`（预期） | `companionOrders` / 对应 transaction | 仅 `accepted` actualCompanion 可主动取消；请求体必须包含取消原因与幂等标识；成功后 `accepted → paid`、回 public、通知用户、记录最小退出历史；当前 P0 不处罚 |
| POST | `/api/companion/orders/[id]/start` | `requireCompanion`（预期） | `companionOrders` | `accepted → serving`；必须由当前 actualCompanion 显式点击触发 |

**共同约束：**

- `exclusiveCompanionId` 不授予我的订单详情/动作权限；资源归属看 `actualCompanionId`。
- `cancel` 只允许 `accepted`；`serving` 后没有普通主动取消入口。
- `cancel` 回 public 时必须重新冻结 `publicPoolEnteredAt / publicTimeoutMinutesSnapshot / publicDeadlineAt`，并清除“当前履约绑定”；历史由最小退出记录保留。
- `start` 只有 `accepted` 合法，且不存在任何根据时间 / 备注 / 聊天自动进入 serving 的路径。
- 幂等/并发下只允许一次真实状态推进，不重复通知、不刷新已经成功写入的时间。
- 这些新增 Companion API 落地时必须同步扩充 `tests/companion.test.mjs` 的 manifest；未实现前不得预登记。

**打手端页面入口（TARGET）**：

```
/companion/orders
/companion/orders/[id]
```

同一个详情页承载 `accepted` 的“开始服务”和 `serving` 的“提交完成材料”，不得为后续阶段复制第二套订单详情。

## 3.2 CompletionSubmission：人工审核 + 10 分钟默认自动审核

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| POST | `/api/companion/orders/[id]/completion` | `requireCompanion`（预期） | `companionCompletions` | 当前实际打手在 `serving` 提交截图 + 5~50 字说明 |
| GET | `/api/staff/completions` | `requireStaff`（预期） | `staffCompletions` | 待审列表 |
| GET | `/api/staff/completions/[id]` | `requireStaff`（预期） | `staffCompletions` | 详情 |
| POST | `/api/staff/completions/[id]/approve` | `requireStaff`（预期） | `staffCompletions` | 人工通过 → Order `completed` |
| POST | `/api/staff/completions/[id]/reject` | `requireStaff`（预期） | `staffCompletions` | 驳回 → Order 保持 `serving`；允许重新提交 |

**已确认约束：**

- 同一订单同时最多 **1 份 `pending`**；已有 pending 时重复提交必须拒绝/幂等，不创建第二份。
- 自动审核配置默认 **10 分钟**，后台可修改。
- 每次 submission 进入 pending 时冻结 `autoApprovalMinutesSnapshot` 与 `autoApprovalDeadlineAt`；后台之后改配置不追溯改变该份材料。
- rejected 后重新提交时重新读取当前配置并重新计时。
- `sweepCompletionAutoApprovals(now)`（名称可在实现 Round 按现有命名规范落地）只在：仍 pending、Order 仍 serving、deadline 已到、无投诉/有效售后阻塞、尚未被人工处理时自动通过。
- 自动通过与客服通过都产生 `Order.status = completed`，但必须记录审核来源为 System，**不得伪装成 Staff**。
- Companion 被封禁/移除导致订单回池时，其旧 pending CompletionSubmission 必须先作废并退出自动审核资格。
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
- `complaintWindowMinutes`：进入 completed 时冻结本单 snapshot/deadline；
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

| Method | URL | Guard | Service | 作用 |
|---|---|---|---|---|
| GET | `/api/companion/earnings` | `requireCompanion`（预期） | `companionEarnings` | 打手收益（总收入 / 冻结 / 可提现；罚款自动规则仍未定义） |

**已确认目标语义：**

- Order completed → 为当时实际履约打手生成 frozen Earning，金额取订单 `companionBaseIncome` 快照；
- 解冻时点不再硬编码 `completedAt + 48h`，而是消费本单冻结的 `complaintDeadlineAt`；
- deadline 到达且无投诉/售后冻结原因后 `frozen → available`；
- `sweepMaturedEarnings(now)` 同步、幂等、可重复调用；Scheduler 必须复用它；
- 提现、自动罚款、余额桶细节仍按 TBD 处理。

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
