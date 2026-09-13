import {
  ADMIN_APPLICATION_LIST_HREF,
  ADMIN_APPLICATION_METRIC_HINTS,
  ADMIN_APPLICATION_METRIC_LABELS,
  ADMIN_APPLICATION_METRIC_STATUSES,
  ADMIN_COMPANION_LIST_HREF,
  ADMIN_COMPANION_METRIC_HINTS,
  ADMIN_COMPANION_METRIC_LABELS,
  ADMIN_OVERVIEW_NOTICE,
  countCompanionStates,
} from "@/lib/constants/admin";
import { getCompanionApplicationRepository } from "@/lib/data/companionApplicationRepository";
import { getDataSource } from "@/lib/data/source";
import { mockEmptyApplies, withMockDebug, type MockSurface } from "@/lib/mocks/debug";
import type { AdminOverview, AdminOverviewMetric } from "@/lib/types/admin";
import type { Companion } from "@/lib/types/companion";
import type { CompanionApplicationStatus } from "@/lib/types/companionApplication";

/**
 * 管理后台的**只读聚合服务** —— 概览页与两个模块页共用的唯一取数入口。
 *
 * ⚠️ 本文件**只读**：不写任何状态、不创建任何记录、不改动任何业务数据。
 * 它做的事情只有一件——把已经存在的数据聚合成后台要看的数字。
 *
 * ⚠️ 调试参数在这一层处理，**不在页面里**：页面只把 `searchParams` 交进来，
 * 因此 `app/admin/**` 下的页面组件不必（也不得）引用 `lib/mocks/*`——
 * 与用户端「页面不碰 Mock 层」是同一条分层规则。
 *
 * 数据来源是**当前仓储**，不是页面里写死的常量：
 * - 申请数来自 `companionApplicationRepository.countApplicationsByStatus()`，
 *   因此用户在用户端新提交一条申请，刷新后台就能看到「待审核申请」加一；
 * - 护航数来自 `getDataSource().listCompanions()`（陪玩名单只有这一份，不另建名册），
 *   口径由 `countCompanionStates()` 定义，页面不自己数。
 *
 * 「为空」与「出错」是两件事：`?mockEmpty=…` 只把相应那组数字清零并**正常返回**，
 * `?mockError=1` 才抛错（由 error.tsx 与重试处理）。
 */

/** 申请各状态的计数，含 `withdrawn`（概览不展示它，但列表页的角标需要完整口径）。 */
export type CompanionApplicationCounts = Record<CompanionApplicationStatus, number>;

/** 护航三个状态的计数。 */
export type CompanionRosterCounts = ReturnType<typeof countCompanionStates>;

function zeroCounts(): CompanionApplicationCounts {
  return { pending: 0, reviewing: 0, approved: 0, rejected: 0, withdrawn: 0 };
}

function emptyRosterCounts(): CompanionRosterCounts {
  return { enabled: 0, disabled: 0, unavailable: 0, total: 0 };
}

/**
 * 按状态统计全部入驻申请。
 *
 * 这是后台唯一跨用户读取申请的地方：用户端的每一次查询都按会话里的 `userId` 过滤，
 * 而管理后台要看的正是「全部申请的状态分布」。
 */
export async function getCompanionApplicationCounts(
  params?: URLSearchParams,
  surface: MockSurface = "server",
): Promise<CompanionApplicationCounts> {
  const counts = await withMockDebug(params, surface, () =>
    getCompanionApplicationRepository().countApplicationsByStatus(),
  );

  return mockEmptyApplies(params, "applications") ? zeroCounts() : counts;
}

/**
 * 按状态统计护航人数。
 *
 * 读的是用户端公开名单使用的**同一份**陪玩数据源，口径见 `countCompanionStates()`。
 */
export async function getCompanionRosterCounts(
  params?: URLSearchParams,
  surface: MockSurface = "server",
): Promise<CompanionRosterCounts> {
  const companions = await withMockDebug(params, surface, () =>
    getDataSource().listCompanions(),
  );

  return mockEmptyApplies(params, "companions")
    ? emptyRosterCounts()
    : countCompanionStates(companions as readonly Companion[]);
}

/**
 * 后台概览：七个数字 + 每一项对应的列表筛选地址。
 *
 * 两件事**在同一次取数里完成**（一次 `withMockDebug`、一次并发读），
 * 而不是分别调用上面两个函数——那会让页面付两次模拟延迟，
 * 也会让「延迟 → 抛错 → 取数」这套顺序执行两遍。
 */
export async function getAdminOverview(
  params?: URLSearchParams,
  surface: MockSurface = "server",
): Promise<AdminOverview> {
  const [statusCounts, companions] = await withMockDebug(params, surface, async () => {
    const [counts, list] = await Promise.all([
      getCompanionApplicationRepository().countApplicationsByStatus(),
      getDataSource().listCompanions(),
    ]);
    return [counts, list] as const;
  });

  const applications = mockEmptyApplies(params, "applications") ? zeroCounts() : statusCounts;
  const roster = mockEmptyApplies(params, "companions")
    ? emptyRosterCounts()
    : countCompanionStates(companions as readonly Companion[]);

  const metrics: AdminOverviewMetric[] = [
    ...ADMIN_APPLICATION_METRIC_STATUSES.map((status) => ({
      key: `applications.${status}`,
      label: ADMIN_APPLICATION_METRIC_LABELS[status],
      value: applications[status],
      // 点进去就是对应筛选的列表：地址由常量给出，页面不自己拼参数
      href: ADMIN_APPLICATION_LIST_HREF(status),
      hint: ADMIN_APPLICATION_METRIC_HINTS[status],
    })),
    {
      key: "companions.enabled",
      label: ADMIN_COMPANION_METRIC_LABELS.enabled,
      value: roster.enabled,
      href: ADMIN_COMPANION_LIST_HREF("enabled"),
      hint: ADMIN_COMPANION_METRIC_HINTS.enabled,
    },
    {
      key: "companions.disabled",
      label: ADMIN_COMPANION_METRIC_LABELS.disabled,
      value: roster.disabled,
      href: ADMIN_COMPANION_LIST_HREF("disabled"),
      hint: ADMIN_COMPANION_METRIC_HINTS.disabled,
    },
    {
      key: "companions.unavailable",
      label: ADMIN_COMPANION_METRIC_LABELS.unavailable,
      value: roster.unavailable,
      href: ADMIN_COMPANION_LIST_HREF("unavailable"),
      hint: ADMIN_COMPANION_METRIC_HINTS.unavailable,
    },
  ];

  return {
    metrics,
    notice: ADMIN_OVERVIEW_NOTICE,
    generatedAt: new Date().toISOString(),
  };
}
