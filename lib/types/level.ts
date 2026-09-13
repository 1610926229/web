/**
 * 消费等级与权益的类型与对外 DTO。
 *
 * 三个类型各司其职，刻意不合并：
 *
 * - `ConsumptionLevel` 是**仓储内部形态**：包含 `enabled` / `createdAt` / `updatedAt`
 *   这些只有配置侧才关心的字段，页面与接口都拿不到它；
 * - `ConsumptionLevelView` 是**对外展示形态**：显式挑字段，配置内部字段不会顺势外泄；
 * - `ConsumptionLevelSummary` 是**专用 DTO**：把「当前金额、当前等级、下一等级、
 *   差额、进度」一次算清交给页面，页面只负责显示，不自己遍历订单或推导等级。
 *
 * 金额一律是「分」为单位的整数。等级配置是**可替换的 Mock 数据**，
 * 不是写死的业务常量：页面必须明确标注当前为 Mock 配置（见 `LEVEL_CONFIG_NOTICE`）。
 */

/**
 * 一条权益说明。
 *
 * ⚠️ 权益**只做说明性展示**。本阶段不实现自动折扣、优先派单、专属客服、赠券或返现，
 * 因此这里没有任何金额、折扣率、次数之类的**可执行**字段——只有名称与一句说明。
 */
export type ConsumptionPrivilege = {
  id: string;
  /** 权益名称，例如「等级徽章」 */
  label: string;
  /** 一句话说明 */
  description: string;
};

/**
 * 消费等级配置（仓储内部类型）。
 *
 * ⚠️ 页面与接口**不直接返回本类型**：对外一律使用下面的两个 DTO。
 */
export type ConsumptionLevel = {
  id: string;
  name: string;
  /** 达到该等级所需的**累计有效消费金额**，单位：分 */
  thresholdAmount: number;
  privileges: ConsumptionPrivilege[];
  /** 展示顺序（同为启用等级时供排序兜底） */
  sortOrder: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

/** 对外展示的等级：只有页面真正需要的字段。 */
export type ConsumptionLevelView = {
  id: string;
  name: string;
  /** 单位：分 */
  thresholdAmount: number;
  privileges: ConsumptionPrivilege[];
  sortOrder: number;
};

/**
 * 当前用户的消费等级摘要（`GET /api/me/consumption-level` 的响应体）。
 *
 * **刻意不含**订单列表、游戏 ID、备注、退款原因等任何订单明细：
 * 页面要的是「我现在是什么等级、还差多少」，不是「我买过什么」。
 */
export type ConsumptionLevelSummary = {
  /**
   * 等级配置是否可用。
   *
   * 为 false 时 `currentLevel` / `nextLevel` 一律为 null，页面显示
   * `unavailableReason`。**不生成默认等级掩盖配置错误**——那会把「配置坏了」
   * 显示成「你是普通老板」。
   */
  available: boolean;
  /** 配置不可用时的说明；可用时为空串 */
  unavailableReason: string;

  /**
   * 累计有效消费金额（分）。
   *
   * 配置不可用时**仍然给出**：它来自订单快照，与等级配置无关，
   * 页面上可以照常展示金额，只是不能给出等级。
   */
  effectiveSpendAmount: number;

  currentLevel: ConsumptionLevelView | null;
  nextLevel: ConsumptionLevelView | null;
  /** 距离下一等级还差的金额（分），**永远不小于 0**；已是最高等级时为 null */
  amountToNextLevel: number | null;

  /** 当前等级区间内的进度，0–100 的有限数（不会出现 NaN / Infinity / 负值） */
  progressPercent: number;
  /** 进度分子的原始金额（分）：当前金额减去当前等级阈值 */
  progressCurrentAmount: number;
  /** 进度分母（分）：当前等级到下一等级的区间宽度；已是最高等级时为 null */
  progressTargetAmount: number | null;

  /** 全部**启用**等级，按阈值升序 */
  levels: ConsumptionLevelView[];

  /** 等级配置的口径说明（当前为 Mock 配置） */
  configNotice: string;
  /** 消费金额的统计口径说明 */
  calculationNotice: string;
};

/** 等级配置的一条问题。由纯校验函数给出，供测试与配置侧使用。 */
export type ConsumptionLevelConfigIssue = {
  levelId: string;
  reason: string;
};
