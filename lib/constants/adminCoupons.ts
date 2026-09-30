import type { AdminAuditAction } from "@/lib/types/adminAudit";
import type {
  AdminCouponTemplateItem,
  AdminCouponTemplateProfilePatch,
  AdminCouponTemplateWriteResult,
  Coupon,
} from "@/lib/types/coupon";
import { countCharacters } from "@/lib/utils/text";
import { fromDateTimeLocalValue, toDateTimeLocalValue } from "@/lib/utils/format";
import {
  readAdminCatalogKeyword,
  readAdminCatalogPaging,
  readAdminEnabledFilter,
  type AdminEnabledFilter,
} from "./adminCatalog";
import { COUPON_FORM_LABELS, isComputableCouponForm } from "./coupons";

/**
 * 管理端「优惠券模板管理」的字段规则、状态口径与 DTO 转换（服务端与浏览器共用）。
 *
 * ⚠️ 与 `./coupons` 的分工：那个文件管**用户端**怎么看待一张券（能不能领、能不能用），
 * 本文件管**后台**怎么建、怎么改、怎么停用一张券。两者的读者与后果都不同——
 * 例如「已领取」是用户视角才成立的概念，它在本文件里没有位置。
 *
 * ⚠️ 本文件除类型、`./adminCatalog`、`./coupons`、`lib/utils/text.ts` 与
 * `lib/utils/format.ts` 外没有运行时依赖（这些同样是纯函数模块），
 * 客户端组件引用它不会把 `lib/data` 或 `lib/mocks` 打进浏览器产物，
 * node 也能直接加载它做纯逻辑测试。
 *
 * ## 五条规则写在这里，它们都是 P1-6 的直接落点
 *
 * 1. **只允许新建 / 编辑 `threshold`**（§1）：`formKey` **不在编辑白名单里**，
 *    不存在「忘了校验」这条路径——改它等于把一张满减券变成折扣券，
 *    而两者的结算语义完全不同（`isComputableCouponForm()` 是那个判据）。
 * 2. **金额一律是整数分，且只拒绝、不夹取**（§2 / §4）：`threshold > 0`、
 *    `discount > 0`、`discount <= threshold`。非法输入返回 400，
 *    不静默截断到边界——「顺手夹一下」会让一次写错的保存看起来成功。
 * 3. **`valueLabel` / `conditionLabel` 不作为业务真值**（§3）：它们由
 *    `buildThresholdCouponLabels()` 从两个金额派生，客户端**没有**提交文案的位置。
 * 4. **有效期必须是可解析的时刻，且 `validTo > validFrom`**（§4）。
 * 5. **没有硬删除**（§6）：模板的生命周期止于 `enabled = false`，
 *    因此本文件里不存在 `removeCouponTemplate()` 这种东西。
 *
 * ⚠️ 时间在**表单**上是北京时间墙钟文本（`datetime-local`），在**接口**上是 ISO 字符串。
 * 两者的换算只有 `lib/utils/format.ts` 那一对函数，不在这里各写一份。
 */

/**
 * 模块首页（列表）的标题**不在这里**：它是侧栏标签与页头共用的那一份，
 * 唯一真值源是 `lib/constants/admin.ts` 的 `ADMIN_COUPONS_PAGE_TITLE`
 * （与平台参数同一条做法——同一个名字不该有两个导出点）。
 * 下面三个是**子页面**的标题，它们只有本模块用得到。
 */
export const ADMIN_COUPON_NEW_TITLE = "新建优惠券";
export const ADMIN_COUPON_DETAIL_TITLE = "优惠券详情";
export const ADMIN_COUPON_EDIT_TITLE = "编辑优惠券";

/**
 * 列表页顶部的一句话。
 *
 * ⚠️ 三件事必须说清楚，否则后台最容易犯的三种错都会发生：
 * 改动对已发出的券**不追溯**（有人会以为改面额能把发出去的券一起改）；
 * 停用**不影响**已领到的券的存在（有人会以为停用等于回收）；
 * 优惠券的成本**由平台承担**（有人会以为是从打手收入里扣）。
 */
export const ADMIN_COUPON_TEMPLATE_NOTICE =
  "这里的改动只影响**此后**的领取与发放：已经发出去或领到手的券沿用领取那一刻的券面快照，" +
  "改面额、改有效期都不会追溯它们。停用只阻止新的领取与后续核销，不会删除任何已发出的券。" +
  "优惠券的优惠金额由平台承担，不影响订单的原价、打手分账基数与打手收益。";

/** 只有满减券参与结算，因此列表上必须一直挂着这句话。 */
export const ADMIN_COUPON_COMPUTABLE_NOTICE =
  "只有满减券参与结算：折扣券与无门槛券可以展示、可以启停，但不能编辑，也不会进入结算页的可选列表。";

export const ADMIN_COUPON_TEMPLATE_EMPTY_MESSAGE = "当前筛选下没有优惠券。";

/** 列表默认每页条数。券模板总数不多，一页 10 条足够。 */
export const ADMIN_COUPON_PAGE_SIZE = 10;

/** 概览卡片的角标口径说明。 */
export const ADMIN_COUPON_TEMPLATE_COUNT_LABELS = {
  all: "全部券模板",
  enabled: "已启用",
  disabled: "已停用",
} as const;

// ——————————————————————————— 字段规则 ———————————————————————————

/**
 * 券名上限。
 *
 * 用户端券卡片是一张窄条（手机屏），名称长了会折行把卡片撑变形。
 * 20 个字足够写出「新人首单立减券」「暑期活动专享券」这类名字，同时留出余量。
 */
export const ADMIN_COUPON_NAME_MAX_LENGTH = 20;

/**
 * 金额上限：99999.99 元（与商品单价的 `SPEC_PRICE_MAX_FEN` 同一个数）。
 *
 * ⚠️ 这不是在限制定价，而是挡住 `99999999999999` 这种手滑：一个天文数字的门槛
 * 会让这张券**永远用不出去**，而管理员看到的只是一张「正常保存了」的券。
 * P1-6 §4 只写了「大于 0」，本上限是**数据完整性**约束而不是业务规则——
 * 它拦下的输入在现实中从来不是一次有意的定价。
 */
export const ADMIN_COUPON_AMOUNT_MAX_FEN = 9_999_999;

export const ADMIN_COUPON_NAME_EMPTY_MESSAGE = "请填写优惠券名称";
export const ADMIN_COUPON_NAME_TOO_LONG_MESSAGE = `优惠券名称不能超过 ${ADMIN_COUPON_NAME_MAX_LENGTH} 个字符`;
export const ADMIN_COUPON_THRESHOLD_INVALID_MESSAGE = "满减门槛必须大于 0，最多两位小数";
export const ADMIN_COUPON_DISCOUNT_INVALID_MESSAGE = "优惠金额必须大于 0，最多两位小数";
export const ADMIN_COUPON_DISCOUNT_OVER_THRESHOLD_MESSAGE = "优惠金额不能大于满减门槛";
export const ADMIN_COUPON_VALID_FROM_INVALID_MESSAGE = "请选择有效期开始时间";
export const ADMIN_COUPON_VALID_TO_INVALID_MESSAGE = "请选择有效期结束时间";
export const ADMIN_COUPON_VALID_RANGE_INVALID_MESSAGE = "有效期结束时间必须晚于开始时间";

export const ADMIN_COUPON_FIELD_LABELS = {
  name: "优惠券名称",
  thresholdAmount: "满减门槛（元）",
  discountAmount: "优惠金额（元）",
  validFrom: "有效期开始",
  validTo: "有效期结束",
  enabled: "启用状态",
} as const;

/** 编辑表单的字段名。页面据此把错误定位到具体输入框（`aria-invalid` / `aria-describedby`）。 */
export type CouponTemplateField = keyof typeof ADMIN_COUPON_FIELD_LABELS;

/** 各字段的错误；没有错误为 null。 */
export type CouponTemplateFieldErrors = Record<CouponTemplateField, string | null>;

const NO_ERRORS: CouponTemplateFieldErrors = {
  name: null,
  thresholdAmount: null,
  discountAmount: null,
  validFrom: null,
  validTo: null,
  enabled: null,
};

/**
 * **规范形状**：金额是整数分、时间是 ISO 字符串。
 *
 * ⚠️ 它是**服务端与表单共用的那一个形状**：接口收到的是它（§2「所有金额以整数分为单位」），
 * 表单先把「元」文本与「北京时间墙钟」文本换算成它，再交给同一套校验。
 * 两份校验必然分叉，因此这里刻意只有一套。
 */
export type CouponTemplateDraft = {
  name: string;
  /** 满减门槛（**整数分**） */
  thresholdAmount: number;
  /** 抵扣金额（**整数分**） */
  discountAmount: number;
  /** ISO 字符串 */
  validFrom: string;
  /** ISO 字符串 */
  validTo: string;
  enabled: boolean;
};

/**
 * 元 → 分。**字符串解析，不产生浮点中间值**（与 `parsePriceYuanToFen` 同一套做法）。
 *
 * 只接受 `123` / `123.4` / `123.45` 三种形状：
 * - 拒绝 `1e3`、`0x10`、`+1`、`-1`、`１２３`（全角）、`1,000`——猜错的代价是金额写错；
 * - 拒绝超过两位小数（`1.005` 无法精确表示成整数分，任何「就近取整」都是在替运营改价）；
 * - 拒绝 `0` 与负数（§4：必须大于 0）；
 * - 拒绝超过 `ADMIN_COUPON_AMOUNT_MAX_FEN`。
 *
 * 返回值是**分**；不合法返回 null，由调用方决定给什么错误文案。
 *
 * ⚠️ 非字符串一律当成不合法，**不是**先 `String()` 一下再解析：`10` 与 `"10"`
 * 长得像，但 `0.1 + 0.2` 这种浮点结果一旦被 toString 就会变成一个看似合法的金额。
 */
export function parseCouponYuanToFen(raw: string): number | null {
  if (typeof raw !== "string") return null;

  const value = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;

  const [yuanText, decimalsText = ""] = value.split(".");
  // 分 = 整数部分与补齐到两位的小数部分**拼成字符串**再转一次整数：
  // `"10"` → `"1000"` → 1000，`"10.5"` → `"1050"` → 1050。
  // 全程没有 `10.5` 这样的浮点中间值，因此 `1.005 * 100` 那条路径根本不存在
  const fen = Number(`${yuanText}${decimalsText.padEnd(2, "0")}`);

  if (!Number.isSafeInteger(fen) || fen <= 0 || fen > ADMIN_COUPON_AMOUNT_MAX_FEN) return null;
  return fen;
}

/**
 * 分 → 元文本，用于表单的初始值（`10000` → `"100"`）。与券面文案共用 `formatCouponYuan`。
 *
 * ⚠️ 收 `null`：非满减券没有金额（`thresholdAmount: null`），它的编辑表单**根本不会渲染**
 * （`editable: false`），但「记录里没有金额」这件事必须有一个确定的表现——空输入框，
 * 而不是 `NaN` 或者把 `null` 显示成 0（那会让人以为它是一张「满 0 减 0」的券）。
 */
export function formatCouponFenForInput(fen: number | null): string {
  if (fen === null || !Number.isFinite(fen)) return "";
  return fen % 100 === 0 ? String(Math.trunc(fen) / 100) : (Math.trunc(fen) / 100).toFixed(2);
}

/** 一个可解析的时刻；解析不出来返回 null。 */
function parseInstant(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function validateName(raw: string): string | null {
  const value = raw.trim();
  if (!value) return ADMIN_COUPON_NAME_EMPTY_MESSAGE;
  if (countCharacters(value) > ADMIN_COUPON_NAME_MAX_LENGTH) {
    return ADMIN_COUPON_NAME_TOO_LONG_MESSAGE;
  }
  return null;
}

function validateAmount(value: number, message: string): string | null {
  if (!Number.isSafeInteger(value)) return message;
  if (value <= 0) return message;
  if (value > ADMIN_COUPON_AMOUNT_MAX_FEN) return message;
  return null;
}

/**
 * 推导编辑表单各字段的错误。
 *
 * 与类目、商品同一套做法：**逐字段给出一条**最终会生效的错误，
 * 页面拿它做 `aria-invalid` / `aria-describedby`，并把第一条出错的字段聚焦过去。
 * 校验顺序即页面上的字段顺序——「第一条错误」因此是「最靠上的那条」。
 *
 * ⚠️ 三处刻意的取舍：
 * - **`discountAmount <= thresholdAmount` 只在两个数都合法时才判**：否则一张
 *   「门槛填错 + 金额超门槛」的表单会在两个字段上各报一次，而第二条是没有意义的
 *   （门槛根本不是个数）；
 * - **有效期只在两个时刻都解析得出来时才比大小**：与上一条同理；
 * - **不做任何夹取与归一**：非法就是非法，`couponTemplateFieldErrors` 只产出文案，
 *   真正的拒绝由 `normalizeCouponTemplatePatch()` 返回 `null` 完成。
 */
export function couponTemplateFieldErrors(
  draft: CouponTemplateDraft,
): CouponTemplateFieldErrors {
  const thresholdError = validateAmount(
    draft.thresholdAmount,
    ADMIN_COUPON_THRESHOLD_INVALID_MESSAGE,
  );
  const discountError = validateAmount(
    draft.discountAmount,
    ADMIN_COUPON_DISCOUNT_INVALID_MESSAGE,
  );

  const from = parseInstant(draft.validFrom);
  const to = parseInstant(draft.validTo);

  return {
    ...NO_ERRORS,
    name: validateName(draft.name),
    thresholdAmount: thresholdError,
    discountAmount:
      discountError ??
      (thresholdError === null && draft.discountAmount > draft.thresholdAmount
        ? ADMIN_COUPON_DISCOUNT_OVER_THRESHOLD_MESSAGE
        : null),
    validFrom: from === null ? ADMIN_COUPON_VALID_FROM_INVALID_MESSAGE : null,
    validTo:
      to === null
        ? ADMIN_COUPON_VALID_TO_INVALID_MESSAGE
        : from !== null && to <= from
          ? ADMIN_COUPON_VALID_RANGE_INVALID_MESSAGE
          : null,
  };
}

/** 表单是否有错。页面用它决定「不提交、把第一条错误聚焦过来」。 */
export function hasCouponTemplateError(errors: CouponTemplateFieldErrors): boolean {
  return Object.values(errors).some((message) => message !== null);
}

/** 「第一条错」的字段名，按页面上的字段顺序。全部通过时返回 null。 */
export function firstCouponTemplateErrorField(
  errors: CouponTemplateFieldErrors,
): CouponTemplateField | null {
  for (const field of Object.keys(ADMIN_COUPON_FIELD_LABELS) as CouponTemplateField[]) {
    if (errors[field]) return field;
  }
  return null;
}

/**
 * 规范形状 → 编辑入参（**服务端写操作的唯一入口形状**）。
 *
 * ⚠️ 返回 `null` 表示**校验没过**，调用方必须先 `couponTemplateFieldErrors()` 拿到
 * 逐字段的错误再决定怎么办。这里再挡一次，是为了让「忘了先校验」也不可能写进脏数据。
 *
 * ⚠️ **返回值里没有 `formKey`、没有 `valueLabel` / `conditionLabel`**：
 * 形态由服务端钉死为 `threshold`，文案由服务端派生（§1 / §3）。
 */
export function normalizeCouponTemplatePatch(
  draft: CouponTemplateDraft,
): AdminCouponTemplateProfilePatch | null {
  if (hasCouponTemplateError(couponTemplateFieldErrors(draft))) return null;

  return {
    name: draft.name.trim(),
    thresholdAmount: draft.thresholdAmount,
    discountAmount: draft.discountAmount,
    validFrom: draft.validFrom,
    validTo: draft.validTo,
    enabled: draft.enabled,
  };
}

/* ───────────────── 表单原始文本 ⇄ 规范形状 ───────────────── */

/**
 * 表单里的原始值：金额是**元文本**，时间是**北京时间墙钟文本**（`datetime-local` 的取值）。
 *
 * ⚠️ 与 `CouponTemplateDraft` 分开是必须的：输入框里的一串字符随时可能不是数字
 * （用户正在输入「10.」），而规范形状里那两个字段是 `number`——
 * 让「正在输入」和「一个合法的整数分」共用一个类型，等于让 `NaN` 到处流动。
 */
export type CouponTemplateFormInput = {
  name: string;
  /** 元文本 */
  thresholdYuan: string;
  /** 元文本 */
  discountYuan: string;
  /** `datetime-local` 取值 */
  validFromLocal: string;
  /** `datetime-local` 取值 */
  validToLocal: string;
  enabled: boolean;
};

/**
 * 表单原始文本 → 规范形状。
 *
 * ⚠️ **解析不出来时塞 `NaN` / 空串，而不是在这里报错**：报错的文案只有一份，
 * 在 `couponTemplateFieldErrors()` 里。这里只负责「把文本搬成规范形状」，
 * 搬不动的部分原样变成非法值，让那唯一一套校验去发现它。
 */
export function couponTemplateDraftFromForm(input: CouponTemplateFormInput): CouponTemplateDraft {
  return {
    name: input.name,
    thresholdAmount: parseCouponYuanToFen(input.thresholdYuan) ?? Number.NaN,
    discountAmount: parseCouponYuanToFen(input.discountYuan) ?? Number.NaN,
    validFrom: fromDateTimeLocalValue(input.validFromLocal),
    validTo: fromDateTimeLocalValue(input.validToLocal),
    enabled: input.enabled,
  };
}

/**
 * 规范形状 → 表单原始值（编辑表单的初始值）。
 *
 * ⚠️ 两个金额收 `number | null`：传进来的通常是 `AdminCouponTemplateItem`，
 * 它把非满减券的金额表示成 `null`（那是「这张券不参与结算」的标记，
 * 见 `AdminCouponTemplateItem.thresholdAmount`）。非满减券的编辑表单不会渲染，
 * 但类型上必须允许它——把 `null` 挡在类型外面只会逼调用方写一个 `?? 0`，
 * 而那个 `0` 会变成一张「满 0 减 0」的券。
 */
export function couponTemplateFormFromPatch(
  patch: Pick<AdminCouponTemplateProfilePatch, "name" | "validFrom" | "validTo" | "enabled"> & {
    thresholdAmount: number | null;
    discountAmount: number | null;
  },
): CouponTemplateFormInput {
  return {
    name: patch.name,
    thresholdYuan: formatCouponFenForInput(patch.thresholdAmount),
    discountYuan: formatCouponFenForInput(patch.discountAmount),
    validFromLocal: toDateTimeLocalValue(patch.validFrom),
    validToLocal: toDateTimeLocalValue(patch.validTo),
    enabled: patch.enabled,
  };
}

/* ───────────────── 白名单 / 变更判定 ───────────────── */

/**
 * 这次编辑对应哪一个审计动作。
 *
 * 启用状态变了就记「启用 / 停用优惠券」，否则记「编辑优惠券」。
 * 「停用」既可能来自详情页上的开关，也可能来自编辑表单里把勾去掉，
 * 两者记的都是同一件事——审计的粒度是「发生了一次什么变更」，不是「调了哪个接口」。
 */
export function adminCouponTemplateActionFromPatch(
  previous: Pick<Coupon, "enabled">,
  patch: Pick<AdminCouponTemplateProfilePatch, "enabled">,
): AdminAuditAction {
  if (previous.enabled !== patch.enabled) {
    return patch.enabled ? "coupon.enable" : "coupon.disable";
  }
  return "coupon.update";
}

/**
 * 这次编辑是否什么都没改。没改就不写数据、也不写审计、**也不刷新 `updatedAt`**。
 *
 * 「最后修改时间刚刚变过」是一个会被当作证据的字段——它一变，事后追查的人
 * 就会去找一次并不存在的改动。
 *
 * ⚠️ 比对的是**入参里的六个字段**，其中 `name` 用 `trim()` 后的值：
 * 只把「满100减10」改成「满100减10 」（多一个尾空格）不算一次改动，
 * 因为写进记录的就是 trim 后的那一份。
 *
 * ⚠️ `formKey` / `valueLabel` / `conditionLabel` **不参与比对**：
 * 它们不在白名单里，本来就不可能被这次编辑改到（文案由金额派生，
 * 金额没变文案就不会变）。
 */
export function isCouponTemplateUnchanged(
  previous: Coupon,
  patch: AdminCouponTemplateProfilePatch,
): boolean {
  return (
    previous.name === patch.name.trim() &&
    previous.thresholdAmount === patch.thresholdAmount &&
    previous.discountAmount === patch.discountAmount &&
    previous.validFrom === patch.validFrom &&
    previous.validTo === patch.validTo &&
    previous.enabled === patch.enabled
  );
}

/* ───────────────── 状态口径 ——————————————————————————— */

/**
 * 一条券模板在后台眼里的状态。**两个取值互斥**：已停用 / 已启用。
 *
 * ⚠️ 没有第三种「已过期」：过期是**按当前时间推出来的**（`isExpiredAt`），
 * 与启用状态是两个正交的维度——一张券可以「已启用且已过期」。
 * 把它并进这个状态，后台就会出现一条「过期的券不能被停用」这种不存在的规则。
 * §十一 要求**状态不能只靠颜色表达**，因此每一条记录都必然带一句可读的文字。
 */
export type AdminCouponTemplateStatusKey = "enabled" | "disabled";

export type AdminCouponTemplateStatus = {
  key: AdminCouponTemplateStatusKey;
  label: string;
  description: string;
};

const COUPON_TEMPLATE_STATUS_TEXT: Record<
  AdminCouponTemplateStatusKey,
  { label: string; description: string }
> = {
  enabled: {
    label: "已启用",
    description: "可以在领券中心被领取、可以被后台发放、已发出的券可以核销",
  },
  disabled: {
    label: "已停用",
    description: "不能再被领取或发放，已发出的券也无法核销；券本身不会被删除",
  },
};

export function adminCouponTemplateStatus(
  coupon: Pick<Coupon, "enabled">,
): AdminCouponTemplateStatus {
  const key: AdminCouponTemplateStatusKey = coupon.enabled ? "enabled" : "disabled";
  return { key, ...COUPON_TEMPLATE_STATUS_TEXT[key] };
}

/**
 * 列表角标：全部 / 已启用 / 已停用。
 *
 * ⚠️ 三个数**加起来等于模板总数**。这里没有「已移除」这一类——
 * §6 明文不提供硬删除，因此不存在第三个状态。
 */
export function countAdminCouponTemplateStates(
  records: readonly Pick<Coupon, "enabled">[],
): { all: number; enabled: number; disabled: number } {
  let enabled = 0;

  for (const record of records) {
    if (record.enabled) enabled += 1;
  }

  return { all: records.length, enabled, disabled: records.length - enabled };
}

/* ───────────────── 列表查询 ───────────────── */

export type CouponTemplateListQuery = {
  /** 空串表示不搜索 */
  keyword: string;
  enabled: AdminEnabledFilter;
  page: number;
  pageSize: number;
};

/**
 * 解析列表查询条件。约定与其它管理列表一致：
 * **接口** `strict: true` 非法枚举 400；**页面** `strict: false` 规范化到默认值。
 *
 * ⚠️ `enabled` 的读取规则与类目列表**共用** `./adminCatalog` 那一份：
 * 同一个筛选参数在两个列表里必须接受同一批取值、回同一句错误文案。
 */
export function buildCouponTemplateListQuery(input: {
  params: URLSearchParams;
  enabled: AdminEnabledFilter;
}): CouponTemplateListQuery {
  const { page, pageSize } = readAdminCatalogPaging(input.params, ADMIN_COUPON_PAGE_SIZE);

  return {
    keyword: readAdminCatalogKeyword(input.params.get("keyword")),
    enabled: input.enabled,
    page,
    pageSize,
  };
}

export const readAdminCouponEnabledFilter = readAdminEnabledFilter;

/** 关键词匹配券名与 id：管理员手里的线索可能是其中任何一个。 */
export function matchesCouponTemplateKeyword(coupon: Coupon, keyword: string): boolean {
  if (!keyword) return true;
  const lowered = keyword.toLowerCase();
  return (
    coupon.name.toLowerCase().includes(lowered) || coupon.id.toLowerCase().includes(lowered)
  );
}

/** 列表排序：**建档时间倒序**，新建的排在最前面；同一时刻用 id 兜底保证顺序稳定。 */
export function compareCouponTemplatesForAdmin(
  a: Pick<Coupon, "createdAt" | "id">,
  b: Pick<Coupon, "createdAt" | "id">,
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/* ───────────────── 二次确认（§八） ───────────────── */

/**
 * 两个危险动作的二次确认文案。
 *
 * ⚠️ 二次确认是**界面上的**保障，它挡不住网络重试与并发请求。真正的防重是
 * 幂等键加服务端的状态判断（§九：不能依赖按钮禁用防重），确认框只负责让人看清后果。
 */
export const ADMIN_COUPON_CONFIRM_TEXTS = {
  disable:
    "停用后这张券不能再被领取或发放，**已经领到手的用户也无法再用它核销**，" +
    "但券不会被删除、历史订单不受影响；重新启用即可恢复。确定停用？",
  enable: "启用后这张券重新出现在领券中心，也可以被后台发放。确定启用？",
} as const;

/** 动作按钮的文案。列表与详情共用同一份，不出现两种叫法。 */
export const ADMIN_COUPON_ACTION_LABELS = {
  disable: "停用",
  enable: "启用",
  save: "保存修改",
  create: "新建优惠券",
} as const;

// ——————————————————————————— 服务端提示 ———————————————————————————

export const ADMIN_COUPON_NOT_FOUND_MESSAGE = "优惠券不存在";
export const ADMIN_COUPON_OPERATION_CONFLICT_MESSAGE = "幂等键已被其它操作使用，请重新提交";
export const ADMIN_COUPON_MISSING_IDEMPOTENCY_KEY_MESSAGE = "缺少或非法的幂等键";
/** 字段校验未通过时的兜底提示（正常情况下字段级错误已经由表单给出）。 */
export const ADMIN_COUPON_PROFILE_INVALID_MESSAGE = "优惠券校验未通过，请检查表单";

/**
 * 编辑一张非满减券。
 *
 * ⚠️ 这句话与 `AdminCouponTemplateItem.editable` **同源**：界面上的「编辑」入口
 * 本来就不会出现在非满减券上，走到这里说明调用方绕过了界面。
 * 服务端仍然要自己判一次——§九：不能依赖按钮禁用。
 */
export const ADMIN_COUPON_NOT_EDITABLE_MESSAGE =
  "只有满减券可以编辑：折扣券与无门槛券不参与结算，改动它们的金额没有任何去向";

// ——————————————————————————— DTO 转换 ———————————————————————————

/**
 * 内部实体 → 管理端列表项 / 详情。
 *
 * ⚠️ **显式挑字段**：不是 `{ ...record }` 再删几个，实体新增字段时默认不外流。
 * `claimCount` 由调用方传入（仓储是异步的，DTO 转换保持纯函数，
 * 这样它才能被客户端组件引用、被 node 直接加载测试）。
 *
 * ⚠️ `editable` **由服务端算好**（`isComputableCouponForm`），不从 `formKey` 让页面自己推：
 * 界面自己判一次、服务端再判一次，两侧迟早给出不同答案——
 * 而这次分叉的后果是「按钮能点、点下去 400」。
 */
export function toAdminCouponTemplateItem(coupon: Coupon, claimCount: number): AdminCouponTemplateItem {
  return {
    id: coupon.id,
    name: coupon.name,
    formKey: coupon.formKey,
    formLabel: coupon.formLabel,
    valueLabel: coupon.valueLabel,
    conditionLabel: coupon.conditionLabel,
    validFrom: coupon.validFrom,
    validTo: coupon.validTo,
    enabled: coupon.enabled,
    thresholdAmount: coupon.thresholdAmount,
    discountAmount: coupon.discountAmount,
    editable: isComputableCouponForm(coupon.formKey),
    claimCount,
    createdAt: coupon.createdAt,
    updatedAt: coupon.updatedAt,
  };
}

/** 写操作的返回。界面据此就地更新那一行，不必为了刷新一个开关重拉整页。 */
export function toAdminCouponTemplateWriteResult(
  updated: Pick<Coupon, "id" | "enabled" | "updatedAt">,
  changed: boolean,
): AdminCouponTemplateWriteResult {
  return {
    couponId: updated.id,
    enabled: updated.enabled,
    updatedAt: updated.updatedAt,
    changed,
  };
}

/* ───────────────── 与用户端的共用口径 ————————————————— */

/**
 * 新建券模板时由服务端钉死的形态（§1：只允许新建满减券）。
 *
 * ⚠️ 客户端**没有**声明形态的位置：请求体里带 `formKey` 也不会被读到。
 */
export const ADMIN_COUPON_TEMPLATE_FORM_KEY = "threshold" as const;

/** 新建券模板时由服务端写死的形态文案。与用户端共用同一份映射表。 */
export const ADMIN_COUPON_TEMPLATE_FORM_LABEL = COUPON_FORM_LABELS.threshold;
