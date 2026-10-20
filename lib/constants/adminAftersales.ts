import { COMPLAINT_STATUSES, OPEN_COMPLAINT_STATUSES } from "@/lib/constants/complaints";
import { OPEN_REFUND_STATUSES, REFUND_STATUSES } from "@/lib/constants/refunds";
import type {
  AdminAftersaleCaseType,
  AdminAftersaleListQuery,
  AdminAftersaleRow,
  AdminAftersaleRowView,
  AdminAftersaleView,
} from "@/lib/types/aftersale";
import type { ComplaintStatus } from "@/lib/types/complaint";
import type { RefundStatus } from "@/lib/types/refund";
import { formatDateTime } from "@/lib/utils/format";
import { clampPage, clampPageSize } from "./pagination";

/**
 * 管理端「售后工作台」的视图规则、筛选与排序（服务端与浏览器共用）。
 *
 * ⚠️ 本文件除类型与另外几个常量模块（`./refunds`、`./complaints`、`./orderFilters`、
 * `./pagination` 与 `lib/utils/format.ts`，都是纯逻辑）外没有运行时依赖：
 * 客户端组件引用它不会把服务端模块打进浏览器产物，node 也能直接加载它做纯逻辑测试。
 *
 * ## 工作台**只做分流**，这是它没有写入规则的原因
 *
 * 它把退款申请与投诉放进同一张待办队列，让管理员一眼看到「现在有哪些案件等着人处理」。
 * 但**处置动作一个都不在这里**：退款仍然去 `/admin/refunds/[id]` 走审核状态机，
 * 投诉仍然去 `/admin/complaints/[id]` 走处理状态机，两边各自的落点没有变。
 * 因此本文件里没有迁移表、没有金额公式、没有审核意见校验——只有
 * 「一条案件属于哪个视图」这一个新规则。
 *
 * ## 视图是**分桶**，不是新状态
 *
 * `open` / `processing` / `closed` **不写进任何存储、不进任何状态机、
 * 不在 `RefundStatus` / `ComplaintStatus` 里**：它们只是把各领域已有的状态按
 * 「有没有完结、有没有人接手」重新分一次桶。分桶所依据的两个事实仍然是
 * 那两个领域的 `OPEN_*` 常量（**唯一真值源，本文件不复制第二套**），
 * 本文件只回答「在这些未完结里，哪些已经被人接手了」。
 *
 * ⚠️ **「分桶」不等于「互斥的分桶」**：`processing` 是 `open` 的**子集视图**
 * （`open` 是未完结全集，`processing` 是其中已接手的那一部分，见 D-P1-3-2），
 * 只有 `closed` 才是 `open` 的补集。因此三桶**不能相加**，正确的关系是
 * `all === open + closed` 且 `processing ⊆ open`（见 D-P1-3-8）。
 * 按视图收窄的判据只有一处：`aftersaleRowInView`。
 */

export const ADMIN_AFTERSALE_LIST_TITLE = "售后工作台";

/**
 * 列表顶部的说明：讲清楚这张队列的口径，以及**动作不在这里**。
 *
 * ⚠️ 这段文字由 `<p>{…}</p>` **原样渲染**，React 不解析 Markdown——
 * 写 `**加粗**` 只会让页面上出现四个星号。要用「」强调。
 */
export const ADMIN_AFTERSALE_LIST_NOTICE =
  "列表把退款申请与投诉合并成一个待办队列，按案件提交时间倒序。" +
  "「未完结」沿用各领域自己的口径（退款：待审核 / 审核中；投诉：待处理 / 处理中），" +
  "「处理中」是其中已经有人接手的那一部分，「已结束」是全部状态减去未完结。" +
  "工作台只做分流：处置动作仍然在各自的专用页面执行——退款去「退款审核」，投诉去「投诉处理」。";

/**
 * 列表为空时的提示。
 *
 * ⚠️ **只在 `total === 0` 时用它**：空列表有两种，见下一条。
 */
export const ADMIN_AFTERSALE_EMPTY_MESSAGE = "当前筛选下没有售后案件。";

/**
 * 页码越界时的提示（`total > 0`，但当前页没有任何行）。
 *
 * ⚠️ 与「没有案件」**必须分开**：手改地址栏到 `?page=3` 而总共只有一页时，
 * 页面上若写着「当前筛选下没有售后案件」，使用者会去改筛选条件——
 * 而分页控件在同一屏上还写着「共 12 条」，真正要改的是页码。
 * 判据只用服务端给的 `total`，不再重新数一遍当前页。
 */
export const ADMIN_AFTERSALE_OUT_OF_RANGE_MESSAGE =
  "这一页没有案件——页码超出了范围，回到第 1 页继续。";

/**
 * 列表底部的字段边界说明。
 *
 * 三件事都要说清楚：列表上能看到什么、**看不到什么**，以及**动作在哪里**。
 * 「看不到」那半句必须写出来——它解释的是「为什么这条退款没有说明」「为什么这条投诉
 * 点不开联系方式」，不写的话，人会以为页面漏了字段而去找一个不存在的展开按钮。
 */
export const ADMIN_AFTERSALE_LIST_FIELDS_NOTE =
  "列表只给出案件编号、状态、金额摘要、用户摘要与订单摘要。" +
  "退款原因与说明、审核意见、投诉正文、凭证与联系方式都不在列表里——" +
  "它们只在各自的详情页可见，处置动作也在那里执行。";

/**
 * 筛选条件不合法时的提示。**返回 400，不静默回退**。
 *
 * 三个筛选都会**改变查到的数据**，一个手改坏的值若静默按默认处理，
 * 页面会显示一批与筛选栏不符的案件——那比报错更难排查。
 */
export const ADMIN_AFTERSALE_VIEW_INVALID_MESSAGE =
  "筛选条件 view 只能是 all / open / processing / closed";
export const ADMIN_AFTERSALE_CASE_TYPE_INVALID_MESSAGE =
  "筛选条件 caseType 只能是 all / refund / complaint";
export const ADMIN_AFTERSALE_DATE_INVALID_MESSAGE =
  "筛选条件 from / to 必须是 YYYY-MM-DD 格式的日期，且 from 不能晚于 to";

/** 列表默认每页条数。后台是 PC 宽屏，与另外两张管理列表一致。 */
export const ADMIN_AFTERSALE_PAGE_SIZE = 20;
export const ADMIN_AFTERSALE_MAX_PAGE_SIZE = 100;
export const ADMIN_AFTERSALE_MAX_PAGE = 1000;

// ——————————————————————————— 视图 ———————————————————————————

/**
 * 视图与案件类型的**类型**在本模块再导出一次（**纯类型导出**，不增加任何运行时依赖）。
 *
 * 两个类型定义在 `lib/types/aftersale.ts`（与行 DTO 放在一起，那是它们的家），
 * 但读到它们的地方几乎都是「要用视图规则」的地方——而视图规则正是本模块。
 * 消费方在一处拿到「规则 + 取值 + 类型」，比从两个模块分别取更不容易漏掉其中一半；
 * 这与 `AdminRefundStatusFilter` / `AdminComplaintStatusFilter` 直接长在各自
 * 规则模块里的做法是同一个形状。
 */
export type { AdminAftersaleCaseType, AdminAftersaleView } from "@/lib/types/aftersale";

export const ADMIN_AFTERSALE_VIEWS: readonly AdminAftersaleView[] = [
  "all",
  "open",
  "processing",
  "closed",
];

export const ADMIN_AFTERSALE_VIEW_LABELS: Record<AdminAftersaleView, string> = {
  all: "全部",
  open: "未完结",
  processing: "处理中",
  closed: "已结束",
};

/**
 * 默认视图：**未完结**。
 *
 * 与退款列表默认 `pending`、投诉列表默认 `pending` 同源：这是**工作台**，
 * 打开它就该看到要处理的。默认成「全部」会把已结束的历史记录混在最前面，
 * 而那张队列里有用的部分恰恰是它。
 *
 * ⚠️ 默认是 `open` 而不是 `processing`：`processing` 只包含「已经有人接手」的，
 * 默认成它会把**还没人看过的那一批**藏起来——而它们才是最先要处理的。
 */
export const DEFAULT_ADMIN_AFTERSALE_VIEW: AdminAftersaleView = "open";

export function isAdminAftersaleView(value: string): value is AdminAftersaleView {
  return (ADMIN_AFTERSALE_VIEWS as readonly string[]).includes(value);
}

/** 严格读取：非法值返回 null（由接口决定抛 400）。空值按默认视图处理。 */
export function readAdminAftersaleView(raw: string | null): AdminAftersaleView | null {
  if (raw === null || raw === undefined) return DEFAULT_ADMIN_AFTERSALE_VIEW;
  const value = raw.trim();
  if (value === "") return DEFAULT_ADMIN_AFTERSALE_VIEW;
  return isAdminAftersaleView(value) ? value : null;
}

/** 宽松规范化：非法值回到默认视图（页面地址栏用）。 */
export function normalizeAdminAftersaleView(raw: string | null): AdminAftersaleView {
  return readAdminAftersaleView(raw) ?? DEFAULT_ADMIN_AFTERSALE_VIEW;
}

// ——————————————————————————— 案件类型 ———————————————————————————

/** 案件类型筛选。`all` 表示不限。 */
export type AdminAftersaleCaseTypeFilter = AdminAftersaleCaseType | "all";

export const ADMIN_AFTERSALE_CASE_TYPES: readonly AdminAftersaleCaseTypeFilter[] = [
  "all",
  "refund",
  "complaint",
];

export const ADMIN_AFTERSALE_CASE_TYPE_LABELS: Record<AdminAftersaleCaseTypeFilter, string> = {
  all: "全部类型",
  refund: "退款",
  complaint: "投诉",
};

export const DEFAULT_ADMIN_AFTERSALE_CASE_TYPE: AdminAftersaleCaseTypeFilter = "all";

/** 是不是一个**真实的**案件类型（`all` 是查询层写法，不是类型）。 */
export function isAdminAftersaleCaseType(value: string): value is AdminAftersaleCaseType {
  return value === "refund" || value === "complaint";
}

/** 严格读取：非法值返回 null（由接口决定抛 400）。空值表示不限类型。 */
export function readAdminAftersaleCaseType(raw: string | null): AdminAftersaleCaseTypeFilter | null {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_ADMIN_AFTERSALE_CASE_TYPE;
  if (value === "all") return "all";
  return isAdminAftersaleCaseType(value) ? value : null;
}

/** 宽松规范化：非法值回到「不限类型」（页面地址栏用）。 */
export function normalizeAdminAftersaleCaseType(raw: string | null): AdminAftersaleCaseTypeFilter {
  return readAdminAftersaleCaseType(raw) ?? DEFAULT_ADMIN_AFTERSALE_CASE_TYPE;
}

// ——————————————————————————— 视图 ↔ 状态 ———————————————————————————

/**
 * 「已经有人接手了」的那几个状态——**处理中视图的唯一落点**。
 *
 * ⚠️ 两个值都取自**既有枚举**（`RefundStatus` / `ComplaintStatus`），
 * 这里**没有一个新状态**：视图分组不是状态机的一部分。
 *
 * ⚠️ `open` 的口径始终是 `OPEN_REFUND_STATUSES` / `OPEN_COMPLAINT_STATUSES`
 * （**唯一真值源，不得复制第二套**，见 `lib/constants/refunds.ts` 与
 * `lib/constants/complaints.ts`）。本常量只回答一个问题：
 * 「那两个未完结集合里，哪几个表示已经被人接手了」。
 *
 * ⚠️ 因此它必须是那两个集合的**子集**（`tests/` 会断言）。
 * 若将来某个领域新增一个「未完结且已接手」的状态，加在这里而不是复制整个集合；
 * 若新增的未完结状态**不**属于已接手，那就什么都不用改——它自然落进 `open`。
 *
 * 语义上两者确实是同一件事：退款「审核中」意味着有人开始了审核，
 * 投诉「处理中」意味着客服已开始核实。而退款「待审核」与投诉「待处理」都是
 * 「还没有人看过」——那正是工作台默认视图要显示的。
 */
export const AFTERSALE_IN_PROGRESS_STATUSES: {
  refund: readonly RefundStatus[];
  complaint: readonly ComplaintStatus[];
} = {
  refund: ["reviewing"],
  complaint: ["processing"],
};

/**
 * 视图 → 退款的**真实领域状态集合**（`null` 表示不限）。
 *
 * - `all` → `null`（仓储不限）；
 * - `open` → `OPEN_REFUND_STATUSES` **本身**（不是它的复制）；
 * - `processing` → `AFTERSALE_IN_PROGRESS_STATUSES.refund`；
 * - `closed` → `REFUND_STATUSES` 减去 `OPEN_REFUND_STATUSES`。
 *
 * ⚠️ `open` **包含** `processing`（`reviewing` 同时属于两者）——`open` 是未完结全集，
 * `processing` 是它的子集视图，两者**不互斥**。`closed` 才是 `open` 的补集。
 */
export function aftersaleRefundStatusesForView(
  view: AdminAftersaleView,
): readonly RefundStatus[] | null {
  if (view === "all") return null;
  if (view === "open") return OPEN_REFUND_STATUSES;
  if (view === "processing") return AFTERSALE_IN_PROGRESS_STATUSES.refund;
  return REFUND_STATUSES.filter((status) => !isOpenRefundStatus(status));
}

/**
 * 视图 → 投诉的**真实领域状态集合**（`null` 表示不限）。口径同上。
 *
 * ⚠️ 与退款那一个**必须是两个函数**：两个领域的枚举不同，
 * 合成一个「泛型」版本只会把类型参数一路扩散到调用点，
 * 而调用点恰恰是想要「退款的集合」还是「投诉的集合」最清楚的地方。
 */
export function aftersaleComplaintStatusesForView(
  view: AdminAftersaleView,
): readonly ComplaintStatus[] | null {
  if (view === "all") return null;
  if (view === "open") return OPEN_COMPLAINT_STATUSES;
  if (view === "processing") return AFTERSALE_IN_PROGRESS_STATUSES.complaint;
  return COMPLAINT_STATUSES.filter((status) => !isOpenComplaintStatus(status));
}

/**
 * 一行案件是否落在视图 `view` 里——**按视图收窄的唯一判据**。
 *
 * ⚠️ 它按**该领域的状态集合**（`aftersale*StatusesForView`）判断，
 * **不拿行的精确桶去比 `view`**：`open` 是未完结全集，一条 `reviewing` 的退款行
 * 精确桶是 `processing`，但它**必须**出现在「未完结」里。按精确桶比，
 * 正是「未完结」页签里只剩 `pending`、把等着批准的退款漏掉的那个缺陷（见 D-P1-3-8）。
 *
 * ⚠️ **筛选栏的角标不走这里**：`counts` 在服务层用行的精确桶分批，再把 `processing`
 * 计入 `open`（因为 `open ⊇ processing`）。两条路径都从本文件这一组常量导出，
 * 因此「角标数」与「点进去的条数」必然一致——见 `lib/services/adminAftersales.ts`
 * 里计数那一段的注释。
 *
 * `view === "all"` 时一律命中（与 `statusesForView("all") === null` 同义）。
 */
export function aftersaleRowInView(
  row: Pick<AdminAftersaleRow, "caseType" | "status">,
  view: AdminAftersaleView,
): boolean {
  if (view === "all") return true;
  const statuses: readonly string[] | null =
    row.caseType === "refund"
      ? aftersaleRefundStatusesForView(view)
      : aftersaleComplaintStatusesForView(view);
  // 除 all 之外的三个视图都有确定的状态集合；null 只是类型上的可能
  return statuses === null ? true : statuses.includes(row.status);
}

/**
 * 退款状态 → 它落在哪个**精确桶**（`AdminAftersaleRowView`）。
 *
 * ⚠️ **它不是 `aftersaleRefundStatusesForView` 的反函数**，两者是**包含关系**：
 *
 * | 关系 | 含义 |
 * |---|---|
 * | `statusesForView("open") ⊇ statusesForView("processing")` | `open` 是未完结全集，`processing` 是其中已接手的那一部分 |
 * | `statusesForView("closed")` | 是 `open` 的**补集**——只有它与其余两者之间才是干净的互补 |
 *
 * 因此本函数返回的是**最细的那一桶**：`reviewing` 会得到 `"processing"`，
 * 而它**同时**落在 `statusesForView("open")` 里。**不要拿它去实现 `open` 的收窄**——
 * 「按 open 筛出来一条、它自己却显示成 processing」不是矛盾，是包含关系本身；
 * 收窄统一走 `aftersaleRowInView`。
 *
 * ⚠️ 但两个方向**必须由同一组常量导出**：各写一份判断，才会真的出现
 * 「按 `open` 筛出来、它自己却显示成已结束」这种自相矛盾的列表。
 */
export function aftersaleRefundViewOf(status: RefundStatus): AdminAftersaleRowView {
  if (!isOpenRefundStatus(status)) return "closed";
  return (AFTERSALE_IN_PROGRESS_STATUSES.refund as readonly RefundStatus[]).includes(status)
    ? "processing"
    : "open";
}

/**
 * 投诉状态 → 它落在哪个**精确桶**。与 `aftersaleComplaintStatusesForView` 的关系
 * 同退款那一对：`open ⊇ processing`、`closed` 是 `open` 的补集，**不是严格双射**。
 */
export function aftersaleComplaintViewOf(status: ComplaintStatus): AdminAftersaleRowView {
  if (!isOpenComplaintStatus(status)) return "closed";
  return (AFTERSALE_IN_PROGRESS_STATUSES.complaint as readonly ComplaintStatus[]).includes(status)
    ? "processing"
    : "open";
}

/**
 * 是不是「未完结」的退款状态。
 *
 * 只做一次**类型放宽**（`OPEN_REFUND_STATUSES` 已经是 `readonly RefundStatus[]`，
 * 这里不宽放），因此不是第二套判断：比较的对象仍然是那一个数组本身。
 */
function isOpenRefundStatus(status: RefundStatus): boolean {
  return (OPEN_REFUND_STATUSES as readonly RefundStatus[]).includes(status);
}

/**
 * 同上，投诉那一侧。
 *
 * ⚠️ 这里必须转一次类型：`OPEN_COMPLAINT_STATUSES` 是 `as const satisfies` 出来的
 * **字面量元组**（`"pending" | "processing"`），直接 `includes` 一个更宽的
 * `ComplaintStatus` 编译不过。转换只影响类型，比较的仍然是那一个数组。
 */
function isOpenComplaintStatus(status: ComplaintStatus): boolean {
  return (OPEN_COMPLAINT_STATUSES as readonly ComplaintStatus[]).includes(status);
}

// ——————————————————————————— 关键词 ———————————————————————————

/**
 * 关键词：只去首尾空格，不设上限也不截断（与其它管理列表一致）。
 *
 * ⚠️ **只搜「案件编号 / 订单号 / 用户昵称 / 平台展示 ID / 打手昵称」五处**，
 * 不搜退款说明、审核意见、投诉正文、处理结果与联系方式：那几段是内容不是标识，
 * 用它们搜出来的结果没人能预期；而说明与正文里可能有用户写的隐私信息，
 * 联系方式更是——把它们当搜索对象，等于让任何一个能进后台的人
 * 用关键词把别人的手机号试出来。
 */
export function readAdminAftersaleKeyword(raw: string | null): string {
  return (raw ?? "").trim();
}

/**
 * 关键词是否命中：**五处任一包含**即可。
 *
 * 前三路（案件编号 / 订单号 / 用户昵称 / 平台展示 ID）与
 * `complaintMatchesAdminKeyword`、`orderMatchesKeyword` **同口径**，归一化逐字照抄：
 * 去首尾空格、转小写、逐字段 `includes`，空关键词一律命中。
 * 「同口径」不是洁癖——同一个关键词在两张表上给出不同结果，是无法向使用者解释的。
 *
 * 第 5 路「打手昵称」是工作台**自己的**：它要能回答「这位打手名下的售后案件」。
 * ⚠️ 现有数据里**没有「案件 → 打手」的外键**——退款申请与投诉上都只有 `orderId`，
 * 订单上记的是打手快照（`Order.companion`，一个 `id` / `name` / `avatarUrl` 的冻结副本）。
 * 因此这里以**打手昵称并入关键词搜索**，而不是在地址栏上造一个「按打手 id 筛」的参数：
 * 那个参数在界面上列不出候选（后台没有从打手反查案件的接口），
 * 造出来只会是一个要靠手输 id 才能用的筛选框。
 */
export function aftersaleMatchesKeyword(
  input: {
    caseNo: string;
    orderNo: string;
    nickname: string;
    displayId: string;
    companionName: string;
  },
  keyword: string,
): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return true;

  return (
    String(input.caseNo).toLowerCase().includes(needle) ||
    String(input.orderNo).toLowerCase().includes(needle) ||
    String(input.nickname).toLowerCase().includes(needle) ||
    String(input.displayId).toLowerCase().includes(needle) ||
    String(input.companionName).toLowerCase().includes(needle)
  );
}

// ——————————————————————————— 日期 ———————————————————————————

/**
 * ## 地址栏的日期参数**复用 `readOrderFilterDate`**（`./orderFilters`）
 *
 * 本文件不导出一个自己的日期读取函数，服务层直接调 `readOrderFilterDate`。
 * ⚠️ 复用一个名字带 `order` 的函数，而不是另写一遍 `YYYY-MM-DD` 正则，理由是：
 * 那份实现已经是仓库里**唯一**的地址栏日期参数校验（订单列表用它，
 * 客服与管理的另外几张列表也用它），连「`2026-13-45` 这种形状对、日期不存在的值」
 * 都由它一并挡住。在这里重写一遍，两处迟早会对「什么算合法日期」给出不同答案，
 * 而这种差异的表现是「同一个日期在订单页筛得出来、在售后工作台报 400」。
 *
 * 那个名字里的 `order` 说的是**它当年为订单列表写的**，不是「只对订单成立」：
 * 它只收一个字符串、只返回一个字符串，与业务对象无关。
 * 工作台自己的两个读取（`readAdminAftersaleView` / `readAdminAftersaleCaseType`）
 * 之所以留在本文件，是因为它们**只属于工作台**，没有第二处会用到。
 */

/**
 * 案件的提交日是否落在 `[from, to]` 区间内（含两端，北京时间的自然日）。
 * 空串表示该侧不限；时间戳坏掉按「不在范围内」处理。
 *
 * ⚠️ 日期 key 取 `formatDateTime(...)` 的**前 10 位**：那是全仓库唯一的时区实现
 * （固定 UTC+8），与页面展示口径一致——列表上显示「2026-09-12」，
 * 按 9-12 筛就应该筛得到它。**不得**用 `toLocaleDateString` / `Intl` / 本地时区：
 * 那会让服务端渲染与浏览器渲染算在不同的日子上。
 *
 * ⚠️ 与 `lib/constants/orderFilters.ts` 的 `orderInDateRange` 是**同类判断**，
 * 但**不是同一个**：那个读的是 `Order.createdAt`，这里读的是案件的 `submittedAt`，
 * 两者是两条不同的记录（一条退款申请可以挂在很早下的订单上）。
 * 共用的那部分（时区与格式化）本来就只有一处，就是 `formatDateTime`。
 */
export function aftersaleInDateRange(
  row: Pick<AdminAftersaleRow, "submittedAt">,
  from: string,
  to: string,
): boolean {
  if (!from && !to) return true;
  const date = formatDateTime(row.submittedAt).slice(0, 10);
  // 时间戳坏掉时按「不在范围内」处理：它本来也没法按日期归属，放进任何一次筛选都是错的
  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

// ——————————————————————————— 排序 ———————————————————————————

/**
 * 默认排序：**提交时间倒序**，同一时间按 `caseType` 升序，再按 `id` 升序兜底。
 *
 * 后两层是**非业务稳定键**：它们不表达任何业务含义（`caseType` 的字母顺序
 * 无关紧要，`id` 更是随机串），只保证同一份数据每次排出来的顺序**完全一致**、
 * 分页不重不漏。⚠️ 它们**不改变业务并列含义**——「同一时刻提交的两条案件」
 * 仍然并列，只是需要一个确定的先后，否则同一条会在第一页出现过、翻到第二页又出现一次
 * （理由与 `compareOrdersByCreatedAt` 逐字相同）。
 *
 * ⚠️ 跨类型排序必须在这里一次做完：退款与投诉各自在仓储里已经排好，
 * 但两串合并之后的重排只可能发生在服务层，而「怎么算并列」只应该有一处定义。
 */
export function compareAftersaleRowsNewestFirst(
  a: Pick<AdminAftersaleRow, "submittedAt" | "caseType" | "id">,
  b: Pick<AdminAftersaleRow, "submittedAt" | "caseType" | "id">,
): number {
  if (a.submittedAt !== b.submittedAt) return a.submittedAt < b.submittedAt ? 1 : -1;
  if (a.caseType !== b.caseType) return a.caseType < b.caseType ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

// ——————————————————————————— 列表查询 ———————————————————————————

/** 分页与关键词从地址栏原样读；三个筛选值由调用方解析好之后传进来。 */
export function buildAdminAftersaleListQuery(input: {
  params: URLSearchParams;
  /** 已经解析好的视图（接口用 `read*` 严格解析，页面用 `normalize*` 规范化） */
  view: AdminAftersaleView;
  /** 已经解析好的案件类型筛选 */
  caseType: AdminAftersaleCaseTypeFilter;
  /** 已经解析好的日期区间；空串表示该侧不限 */
  from: string;
  to: string;
}): AdminAftersaleListQuery {
  return {
    view: input.view,
    caseType: input.caseType,
    keyword: readAdminAftersaleKeyword(input.params.get("keyword")),
    from: input.from,
    to: input.to,
    page: clampPage(input.params.get("page"), ADMIN_AFTERSALE_MAX_PAGE),
    pageSize: clampPageSize(
      input.params.get("pageSize"),
      ADMIN_AFTERSALE_PAGE_SIZE,
      ADMIN_AFTERSALE_MAX_PAGE_SIZE,
    ),
  };
}
