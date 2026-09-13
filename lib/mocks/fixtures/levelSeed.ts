import type { ConsumptionLevel } from "@/lib/types/level";

/**
 * 预置消费等级配置。
 *
 * ⚠️ **全部为 Mock 配置**：等级名称、数量、阈值与权益都不是最终业务规则，
 * 页面上有明确说明（`LEVEL_CONFIG_NOTICE`），管理者将在后续 PC 管理后台配置真实规则。
 *
 * 阈值单位是**分**（金额全项目统一口径），因此 ¥500 写成 50000。
 * 配置满足 `validateLevelConfig` 的全部约束：最低启用等级阈值为 0、无负值、无重复。
 *
 * 权益**只做说明性展示**：条目里没有任何折扣率、次数、金额等可执行字段，
 * 本阶段不实现自动折扣、优先派单、专属客服、赠券或返现。四条权益描述的都是
 * 本实现里**真实存在**的展示行为（徽章、进度、排行榜等级名），不构成任何承诺。
 *
 * 其中一条**停用等级**是刻意的：用来证明「停用等级不参与判定、也不出现在全部等级列表里」，
 * 而不是只在测试里造一个对象。
 *
 * ⚠️ 仅服务端使用：本文件不会被任何客户端组件引用，接入真实后端后随 lib/mocks 一并移除。
 */

export const levelSeed: ConsumptionLevel[] = [
  {
    id: "lv-1",
    name: "普通老板",
    thresholdAmount: 0,
    privileges: [
      { id: "lv-1-badge", label: "等级徽章", description: "个人中心展示当前消费等级" },
      { id: "lv-1-progress", label: "进度可见", description: "在消费等级页查看升级进度与差额" },
    ],
    sortOrder: 1,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    id: "lv-2",
    name: "高级老板",
    thresholdAmount: 30000,
    privileges: [
      { id: "lv-2-badge", label: "等级徽章升级", description: "个人中心展示「高级老板」等级" },
      { id: "lv-2-rank", label: "排行榜展示等级", description: "消费排行榜会显示你的当前等级" },
    ],
    sortOrder: 2,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    id: "lv-3",
    name: "金牌老板",
    thresholdAmount: 60000,
    privileges: [
      { id: "lv-3-badge", label: "等级徽章升级", description: "个人中心展示「金牌老板」等级" },
      { id: "lv-3-rank", label: "排行榜展示等级", description: "消费排行榜会显示你的当前等级" },
      { id: "lv-3-all", label: "全部等级可见", description: "在消费等级页查看全部等级门槛" },
    ],
    sortOrder: 3,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    id: "lv-4",
    name: "至尊老板",
    thresholdAmount: 150000,
    privileges: [
      { id: "lv-4-badge", label: "最高等级徽章", description: "个人中心展示「至尊老板」等级" },
      { id: "lv-4-rank", label: "排行榜展示等级", description: "消费排行榜会显示你的当前等级" },
      { id: "lv-4-top", label: "等级已满", description: "已达到当前最高等级，无需继续升级" },
    ],
    sortOrder: 4,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  {
    // 停用等级：阈值与 lv-2 相同，但因为不启用，**不参与**「阈值不能重复」的校验，
    // 也不会进入判定与「全部等级」列表。留着它是为了让「停用」这条规则有真实数据可验。
    id: "lv-legacy",
    name: "资深老板（已停用）",
    thresholdAmount: 30000,
    privileges: [{ id: "lv-legacy-badge", label: "旧版徽章", description: "该等级已停用" }],
    sortOrder: 9,
    enabled: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
];
