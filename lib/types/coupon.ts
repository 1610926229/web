import type { PageResult } from "./common";

/**
 * 优惠券类型与对外 DTO。
 *
 * ⚠️ **只有 `threshold`（满减券）参与结算**（P1-4 产品裁定 §1）。另外两种仍然是
 * **纯展示**：`discount` / `gift` 没有可计算字段，结算时会被**明确拒绝**，
 * 而不是「按 0 元优惠继续下单」——静默归零会让用户以为券生效了却一分没减。
 *
 * 金额与展示文案是**两件事**，本文件把它们分开：
 *
 * | 字段 | 性质 |
 * |---|---|
 * | `valueLabel` / `conditionLabel` / `formLabel` | 展示文案，**永远不参与运算** |
 * | `thresholdAmount` / `discountAmount` | 可参与运算的**整数分**，只有满减券有值 |
 *
 * 因此新增一种券时，要么给出可计算的金额字段，要么保持 `null`——
 * 「用正则从 `valueLabel` 里抠出数字」这类做法一律不做，文案改一个字就会算错钱。
 */

/**
 * 优惠形式。
 *
 * ⚠️ 它**同时是展示分类与计算开关**（P1-4 起）：只有 `threshold` 有可计算的
 * `thresholdAmount` / `discountAmount`，另外两种这两个字段恒为 `null`。
 * 判断「这张券能不能抵扣」的唯一依据是
 * `isComputableCouponForm()`（`lib/constants/coupons.ts`），不要再散落 if。
 */
export type CouponFormKey = "threshold" | "discount" | "gift";

/**
 * 券面快照：领取那一刻的券面内容，之后券的文案改了不影响已领取的记录。
 *
 * ⚠️ **两个金额字段也在这份快照里**，因此「券面内容」与「券的金额」是**同一份冻结**：
 * 领取之后再改券模板的面额，不追溯已领取的记录（P1-4 裁定 §9）。
 * 结算时的门槛判定与抵扣取值都读这里，不读券模板的当前值。
 */
export type CouponSnapshot = {
  name: string;
  formKey: CouponFormKey;
  /** 优惠形式的展示文案，如「满减券」 */
  formLabel: string;
  /** 券面值展示文案（Mock 文案，不参与计算） */
  valueLabel: string;
  /** 使用条件的展示文案 */
  conditionLabel: string;
  /** 有效期起（ISO） */
  validFrom: string;
  /** 有效期止（ISO） */
  validTo: string;
  /**
   * 满减门槛（**整数分**）。`originalAmount >= thresholdAmount` 才可用。
   *
   * 非满减券为 `null`——`null` 表示「没有可计算的门槛」，
   * 而不是「门槛为 0」（后者会让一张折扣券意外通过满减判定）。
   */
  thresholdAmount: number | null;
  /**
   * 抵扣金额（**整数分**）。非满减券为 `null`。
   *
   * ⚠️ 它是**名义面额**，不是最终的 `couponDiscountAmount`：
   * 实付不得为负，因此真正抵扣的是 `min(discountAmount, originalAmount)`
   * （见 `resolveCouponDiscountAmount()`）。
   */
  discountAmount: number | null;
};

/**
 * 券模板（领券中心里可领取的券）。
 *
 * `enabled` 由平台侧决定：停用的券还能看到（否则已领取的人会以为券凭空消失），
 * 但不能再领取。
 */
export type Coupon = CouponSnapshot & {
  id: string;
  /** 平台是否启用；停用后不可再领取 */
  enabled: boolean;
  /**
   * 券模板的建档时刻（P1-6）。
   *
   * ⚠️ **它不进 `CouponSnapshot`**：快照冻结的是「用户手里那张券长什么样」，
   * 而模板什么时候被建出来与券面无关。两条时间线必须分开——
   * 混进去的话，用户端「我的优惠券」会凭空多出一个与用户无关的时间。
   */
  createdAt: string;
  /**
   * 券模板最后一次被后台改动的时刻（P1-6）。
   *
   * ⚠️ 同样不进快照。顺带说清一件容易误会的事：**它变了不代表用户手里的券变了**——
   * `CouponClaim.snapshot` 在领取那一刻就冻结了（P1-4 裁定 §9），后台改模板不追溯。
   */
  updatedAt: string;
};

/**
 * 用户领取记录（仓储内部类型）。
 *
 * 只记「未使用 / 已使用」两个**由平台写入**的状态；`expired` 是**按当前时间推导**的
 * 展示状态（见 `couponDisplayStatus`），不落库——否则一张没被用掉的券会永远停在
 * 「未使用」上，除非有人跑一个定时任务去改它。
 */
export type CouponClaimStatus = "unused" | "used";

/** 展示状态：在领取记录状态之上叠加「已过期」。 */
export type CouponDisplayStatus = CouponClaimStatus | "expired";

/**
 * 这张 Claim 是**怎么来的**（P1-4 验收整改轮 §六）。
 *
 * | 取值 | 谁产生的 | 「一模板一次」限制 |
 * |---|---|---|
 * | `self_claim` | 用户自己在领券中心点的「立即领取」 | **受**：同一 User 对同一模板只能领一次 |
 * | `admin_grant` | 管理员在后台向指定用户发放 | **不受**：可对已领过 / 已用过的用户再发，也可多次发 |
 *
 * ⚠️ **它是必填字段，不是可选的**。与 P1-5 的 `Dispatch.acceptedVia` 同一课：
 * 可选字段会被**新**写入路径静默漏掉，而漏掉之后没人能看出区别。
 * 必填意味着任何一处新增的 Claim 构造点**在编译期**就必须声明来源。
 * （唯一漏洞是 `.mjs` 测试夹具——它不过类型检查，登记在 03-delivery.md 已知局限。）
 */
export type CouponClaimSource = "self_claim" | "admin_grant";

export type CouponClaim = {
  id: string;
  userId: string;
  couponId: string;
  status: CouponClaimStatus;
  /** 见 `CouponClaimSource`。必填 */
  source: CouponClaimSource;
  /**
   * 这张 Claim **产生**的时刻。两种来源通用：
   * self-claim 是「领取时刻」，admin_grant 是「发放时刻」。
   *
   * ⚠️ **不另设 `grantedAt`**（这是我自行作出的技术决策，见 02-decisions.md §8.3 T2）：
   * 两个字段记同一件事就是**第二份真值**，而本仓库在 P0-15 已经为
   * `platformBorneAmount` 立过这条规矩——两份账迟早对不上，对账的人会以为其中一份是错的。
   * 发放行为真正多出来的信息是「**谁**发的」，那由下面的 `grantedByAdminId` 单独承载。
   */
  claimedAt: string;
  usedAt: string | null;
  /**
   * 发放这张券的管理员 id（P1-4 §六的「最小审计信息」）。
   *
   * `self_claim` 时**必须为 `null`**；`admin_grant` 时**必须有值**。
   * 两者互为充要条件，测试里有一条专门钉这个。
   */
  grantedByAdminId: string | null;
  /** 领取 / 发放那一刻的券面快照 */
  snapshot: CouponSnapshot;
};

/**
 * 「我的优惠券」列表项 DTO。
 *
 * 只返回当前用户的领取记录，且只带券面展示所需的字段：`userId`、券模板 id 之外的
 * 内部字段（如幂等索引）一律不出现。
 */
export type OwnedCouponItem = {
  /** 领取记录 id */
  id: string;
  couponId: string;
  name: string;
  formLabel: string;
  valueLabel: string;
  conditionLabel: string;
  validFrom: string;
  validTo: string;
  status: CouponDisplayStatus;
  /** 状态文案。由服务端按同一套规则算好，前端不自己推导，避免两侧口径不一致 */
  statusLabel: string;
  claimedAt: string;
  usedAt: string | null;

  /** 这张券的来源（自己领的 / 管理员发的）。 */
  source: CouponClaimSource;
  /** 来源文案。同上，服务端算好 */
  sourceLabel: string;

  /**
   * **这张券此刻能不能真的在 checkout 用掉**（P1-4 验收整改轮 §九）。
   *
   * ⚠️ 它与 `status` **不是一回事**，而这正是本轮那个缺陷的根因：
   *
   * | | 回答的问题 |
   * |---|---|
   * | `status` | 这张券**本身**是什么状态（未使用 / 已使用 / 已过期） |
   * | `settlementUsable` | 这张券**能不能参与结算**（还要看形态、看模板当前是否启用） |
   *
   * 一张 `unused` 的折扣券 `status` 是「未使用」，但 P1-4 只实现了满减券的
   * 结算语义，它在 checkout 里**永远选不到**——只报 `status` 就会让账户页写「可用」、
   * 而 checkout 永远显示「暂无可用优惠券」。裁定 §九 明文禁止这种前后矛盾。
   *
   * 判定口径与 checkout **共用同一个前置判定函数**（见 `lib/constants/coupons.ts`
   * 的 `resolveCouponClaimGate`），因此不可能再分叉。
   */
  settlementUsable: boolean;
  /**
   * 不可用于结算的**原因**；可参与结算时为空串。
   *
   * ⚠️ 这里**不含门槛**：账户页没有订单，谈不上「这一单够不够门槛」。
   * 门槛只在 checkout 判。
   */
  settlementReason: string;
};

/**
 * 「领券中心」列表项 DTO。
 *
 * `claimable` / `reason` / `claimed` **都由服务端判定**：券是否停用、是否过期、
 * 当前用户是否已经领过，前端只负责按值显示按钮与说明，不自己推断。
 */
export type ClaimableCouponItem = {
  id: string;
  name: string;
  formLabel: string;
  valueLabel: string;
  conditionLabel: string;
  validFrom: string;
  validTo: string;
  /** 当前用户能否领取 */
  claimable: boolean;
  /** 不能领取时的说明；能领取时为空串 */
  reason: string;
  /** 当前用户是否已经领取过 */
  claimed: boolean;
};

/** 两个 Tab 上的数量。每次列表请求都会带上，避免前端自己加减导致角标漂移。 */
export type CouponTabCounts = {
  /** 我的优惠券：我的领取记录数 */
  owned: number;
  /** 可领取：我还没领过、且当前可领取的券数 */
  claimable: number;
};

/**
 * 一次列表请求的返回：分页结果 + 两个 Tab 的数量 + 本次的 Tab。
 *
 * 两个 Tab 各有一个**具体的**类型（`tab` 是字面量），而不是一个泛型：
 * 服务端返回的是二者的联合，页面据此判断该渲染哪个列表，不需要任何类型断言；
 * 客户端组件也能安全引用这些形状（类型文件没有运行时依赖，
 * 而服务端模块依赖 `lib/data` 与 `lib/mocks`，客户端不该 import 它）。
 */
export type OwnedCouponPage = PageResult<OwnedCouponItem> & {
  tab: "owned";
  counts: CouponTabCounts;
};

export type ClaimableCouponPage = PageResult<ClaimableCouponItem> & {
  tab: "claimable";
  counts: CouponTabCounts;
};

/** 列表接口的返回：哪个 Tab 就是哪一份，联合里带得下。 */
export type CouponListPage = OwnedCouponPage | ClaimableCouponPage;

/** 领取结果。重复领取不再是错误：`created` 为 false 且返回第一次的结果。 */
export type CouponClaimResult = {
  claimId: string;
  couponId: string;
  created: boolean;
};

/**
 * 结算页可选的券（P1-4）。
 *
 * ⚠️ 与 `OwnedCouponItem` 分开，是因为两者的**用途不同、字段也就不同**：
 * 「我的优惠券」要的是完整状态与时间，结算页要的是「这一单能不能用、能减多少」。
 * 把判定结果塞进 `OwnedCouponItem` 会让那个类型依赖于「当前在看哪一单」，
 * 而它的语义里根本没有订单。
 *
 * `applicable` / `reason` / `discountAmount` **都由服务端算好**：前端不自己
 * 比对门槛，否则「页面算出来能减、服务端算出来不能减」迟早会发生。
 */
export type CheckoutCouponOption = {
  /** 领取记录 id，提交时回传的就是它 */
  claimId: string;
  couponId: string;
  name: string;
  valueLabel: string;
  conditionLabel: string;
  validFrom: string;
  validTo: string;
  /** 这一单能否用它 */
  applicable: boolean;
  /** 不能用时的说明；能用时为空串 */
  reason: string;
  /** 能用时的实际抵扣额（**分**）；不能用时为 0。已夹到不超过原价 */
  discountAmount: number;
};

/* ───────────────── 管理端：向指定用户发放（P1-4 验收整改轮 §四） ───────────────── */

/**
 * 管理端可选来发放的券模板。
 *
 * ⚠️ **只返回当前 `enabled` 的模板**（裁定 §四.2 明文「选择 enabled Coupon 模板」）：
 * 让管理员挑一张已停用的券，等于让他发出去一张永远核销不了的券。
 * 过滤在**服务端**做，页面不自己筛——两个地方各筛一次，迟早分叉。
 *
 * `validFrom` / `validTo` 一并返回是为了**显示**：模板虽然 enabled，
 * 但有效期可能已经过去（那种券发出去也是废的）。管理员看得见才能自己判断。
 */
export type AdminCouponGrantOption = {
  id: string;
  name: string;
  formLabel: string;
  valueLabel: string;
  conditionLabel: string;
  validFrom: string;
  validTo: string;
  /** 是否仍在有效期内。**只用于显示**，不参与「能不能发」的判定 */
  withinValidity: boolean;
};

/**
 * 发放目标用户。
 *
 * ⚠️ 只带**管理员挑人需要**的三项：`id`（提交时回传）、`displayId` 与昵称。
 * 用户简介、头像之外的任何资料都不在这里——发券不需要它们。
 */
export type AdminGrantTargetUser = {
  /** 提交发放时用的就是它 */
  id: string;
  displayId: string;
  nickname: string;
  avatarUrl: string;
  /**
   * 这个人**当前已持有**的券张数，**不分模板**（`queryOwnedCoupons({ userId }).total`）。
   *
   * ⚠️ 服务层数的是这个用户的**全部** Claim，因此界面上的文案只能是「已持有 N 张」，
   * 不能写成「已持有 N 张该模板的券」——挑人的时候模板还没选，
   * 按模板数在这里也算不出来。发放**允许重复**（§五），所以能拦住重复的不是这里，
   * 而是让管理员**看得见**对方手上已经有多少张。
   */
  ownedCount: number;
};

/** 一次管理员发放的结果。`created: false` 表示这次提交与上一次是同一个幂等键。 */
export type AdminCouponGrantResult = {
  claimId: string;
  couponId: string;
  userId: string;
  created: boolean;
};

/* ───────────────── 管理端：券模板管理（P1-6） ───────────────── */

/**
 * 管理端券模板列表项。
 *
 * ⚠️ 它是**管理端**的 DTO，与 `ClaimableCouponItem` 不是一回事：后者回答
 * 「当前用户能不能领」，这一份回答「平台上有哪些券、它们现在是什么状态」。
 * 合成一个类型的话，「已领取」这种只有用户视角才成立的概念会漏进后台。
 *
 * `thresholdAmount` / `discountAmount` 在**这里永远是数字**（不是 `number | null`）：
 * 管理端列表要显示满减门槛与优惠金额，而 `null` 表示「这张券没有可计算金额」，
 * 界面需要把这件事**显示出来**（非满减券），所以原样保留 `null` 反而更准确。
 * 见 `AdminCouponTemplateItem.thresholdAmount` 上的说明。
 */
export type AdminCouponTemplateItem = {
  id: string;
  name: string;
  formKey: CouponFormKey;
  /** 优惠形式的展示文案，如「满减券」 */
  formLabel: string;
  /** 券面值展示文案（后台新建/编辑时由服务端按金额派生） */
  valueLabel: string;
  /** 使用条件的展示文案（同上） */
  conditionLabel: string;
  validFrom: string;
  validTo: string;
  enabled: boolean;
  /**
   * 满减门槛（**整数分**）。非满减券为 `null`。
   *
   * ⚠️ 后台**必须看得见这个 `null`**：它是「这张券不参与结算」的唯一标记
   * （P1-4 裁定 §1 只有满减券参与抵扣，`isComputableCouponForm()` 是那个判据）。
   * 把 `null` 显示成 0 会让管理员以为它是一张「满 0 减 0」的券。
   */
  thresholdAmount: number | null;
  /** 抵扣金额（**整数分**）。非满减券为 `null`。理由同上。 */
  discountAmount: number | null;
  /**
   * 这张模板**能不能被编辑**。
   *
   * ⚠️ 由**服务端**算好（`isComputableCouponForm(formKey)`），页面不自己推导：
   * 界面自己判一次、服务端再判一次，两侧迟早给出不同答案——
   * 而这次分叉的后果是「按钮能点、点下去 400」。
   *
   * 非满减券（`discount` / `gift`）为 `false`：它们是历史模板，可以展示、
   * 可以启停，但**不能改**（P1-6 §1「只允许新建/编辑 `threshold`」）。
   */
  editable: boolean;
  /**
   * 这个模板已经被领走 / 发出多少张（含自己领的与管理员发的）。
   *
   * ⚠️ **它是「停用会影响谁」的展示，不是判断依据**：真正的停用没有前置条件
   * （§5 明文 disable 不删除 Claim）。页面拿它提醒管理员后果，仅此而已。
   */
  claimCount: number;
  createdAt: string;
  updatedAt: string;
};

/** 一页券模板 + 各状态角标。页面首屏与接口返回的是同一个形状。 */
export type AdminCouponTemplateListData = {
  items: AdminCouponTemplateItem[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  counts: { all: number; enabled: number; disabled: number };
  notice: string;
};

/** 写操作的返回：界面据此就地更新那一行，不必为了刷新一个开关重拉整页。 */
export type AdminCouponTemplateWriteResult = {
  couponId: string;
  enabled: boolean;
  updatedAt: string;
  changed: boolean;
};

/**
 * 券模板的编辑白名单 —— 后台能改的字段就是这些，多一个都没有。
 *
 * ⚠️ **不在这个类型里**的字段：`id`、`createdAt`、`updatedAt`、
 * `formKey`、`formLabel`、`valueLabel`、`conditionLabel`。
 *
 * | 字段 | 为什么不可改 |
 * |---|---|
 * | `formKey` | 改它等于把一张满减券变成折扣券，而两者的结算语义完全不同（§1） |
 * | `valueLabel` / `conditionLabel` | **它们不是业务真值**，由服务端按金额派生（§3）。让客户端传等于把「用户看到的那句话」交给调用方决定 |
 * | `createdAt` / `updatedAt` | 服务端时间戳（§九：客户端伪造时间必须被忽略） |
 *
 * 注意 `enabled` 在这里：编辑表单可以一次把字段与启用状态一起提交；
 * 而详情页上的启停开关走的是两个**窄写入**接口，不经过这个 patch。
 */
export type AdminCouponTemplateProfilePatch = {
  name: string;
  thresholdAmount: number;
  discountAmount: number;
  validFrom: string;
  validTo: string;
  enabled: boolean;
};

/**
 * 新建券模板的入参。
 *
 * ⚠️ 与 `AdminCouponTemplateProfilePatch` **是同一个形状**，但刻意分开命名：
 * 新建时服务端会额外写入 `formKey: "threshold"`（客户端**没有**声明形态的位置，
 * §1 只允许新建满减券），而编辑时形态是**读出来的**、不是补上去的。
 * 两个动作对同一个请求体的解释不同，就不该共用一个名字。
 */
export type AdminCouponTemplateInput = AdminCouponTemplateProfilePatch;
