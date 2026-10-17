import {
  COMPLAINT_WINDOW_DEFAULT_MINUTES,
  COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES,
  EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES,
  PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES,
} from "@/lib/constants/platformConfig";
import { platformConfigSeed } from "@/lib/mocks/fixtures/platformConfigSeed";
import type { PlatformConfig } from "@/lib/types/platformConfig";
import { getMockStore } from "./mockStore";
import type { PlatformConfigRepository, PlatformConfigWriteResult } from "./platformConfigRepository";

/**
 * 平台参数的**进程内** Mock 存储（P0-1 起**可写**）。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后回到预置值；
 * 不写 localStorage、不写文件、不写数据库。将来由真实数据库替换，
 * 本文件的删除不影响上层接口。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`。
 *
 * ## 为什么存的是一个「单例记录」而不是一张表
 *
 * 平台参数按定义只有一份——「公共池超时」不可能同时是两个值。
 * 因此 store 里没有 Map、没有 id、没有查询条件：任何按 id 取配置的写法
 * 都在暗示「配置可以有多份」，而它不能。
 *
 * 建仓时把预置对象**复制一份**而不是直接引用常量：后台会改它，若 store 里存的
 * 就是 `PLATFORM_CONFIG_SEED` 那个对象，一次修改就把模块级常量改了——
 * 测试之间互相污染，`resetMockStore()` 之后也再也回不到预置值
 * （因为「预置值」本身已经被改掉了）。
 *
 * 并发安全的前提：Node 是单线程的，本文件里的写入方法内部没有 `await`，
 * 因此各自是一个原子动作；而「重放判定 + 写业务 + 写审计」这三件事合起来的
 * 原子性由 `lib/data/adminPlatformConfigTransaction.ts` 保证。
 *
 * ⚠️ `platformConfigStore()` 是**导出**的：后台写操作要在一段不可打断的同步区段里
 * 同时写「业务记录 + 审计」，那段伪事务在 `lib/data/adminPlatformConfigTransaction.ts`。
 * 除它以外不要从别处取这个 store。
 */

type MockPlatformConfigStore = {
  /**
   * 当前生效的配置。**恒不为 null**：没有任何记录时用预置值，
   * 而不是让每个调用方都去处理「还没有配置」这种情况——
   * 那会让「参数缺失」变成一条到处都要判的空值路径。
   */
  config: PlatformConfig;
};

/** 复制一份配置。store 内外的对象从此互不影响。 */
export function clonePlatformConfig(config: PlatformConfig): PlatformConfig {
  return { ...config };
}

/**
 * 一个「时长」字段的兜底：合法（有限、整数、> 0）就原样保留，否则回退到默认值。
 *
 * ⚠️ 判据是 **> 0** 而不是「非空」：所有时长字段的合法下界都 ≥ 1 分钟，因此
 * `0` / 负数 / `NaN` / `undefined` 都属于**不可能由正常写入产生**的值。
 * 让它们漏过去，deadline 会算成 `new Date(NaN).toISOString()` 并**抛异常**
 * （不是得到一个「很早的截止时间」）——一条这样的记录会让整次清扫炸掉。
 */
function withTimeoutFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * 把一份配置补齐成**完整的当前配置**（P1-2）——旧数据升级的唯一入口。
 *
 * ## 为什么必须有它
 *
 * store 挂在 `globalThis` 上（`lib/data/mockStore.ts`），而 `createStore` 只在
 * **第一次**取这个 store 时执行。于是存在这样一条真实路径：开发服务器上先跑的是
 * **旧版本**的代码，它建的 store 里没有 `exclusivePoolTimeoutMinutes` 这个键；
 * 换上新代码后（进程没重启、或热更新保留了那份 store），读到的就是 `undefined`。
 * 而上层任何一处把 `undefined` 当分钟数用，都会算出 `Invalid Date` 的截止时间。
 *
 * ⚠️ 兜底放在**读边界**（而不是每个调用点）：这样「配置对象的四个时长字段恒为
 * 合法整数」成为仓储的一条保证，服务层 / 事务层 / 页面都不需要写空值分支。
 * 在每个调用点判 `?? 10` 的写法，迟早会有一个漏判点，而漏判的那一处
 * 不会报错，只会安静地生成一条**永远不会过期**的派单。
 *
 * ⚠️ 它**不是**校验：校验是服务层的事，非法值必须在写入前被拒。
 * 这里只处理「这份记录是在本字段存在之前建的」这一种历史情况。
 */
export function normalizePlatformConfig(config: PlatformConfig): PlatformConfig {
  const cloned = clonePlatformConfig(config);
  return {
    ...cloned,
    exclusivePoolTimeoutMinutes: withTimeoutFallback(
      cloned.exclusivePoolTimeoutMinutes,
      EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES,
    ),
    publicPoolTimeoutMinutes: withTimeoutFallback(
      cloned.publicPoolTimeoutMinutes,
      PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES,
    ),
    completionAutoApprovalMinutes: withTimeoutFallback(
      cloned.completionAutoApprovalMinutes,
      COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES,
    ),
    complaintWindowMinutes: withTimeoutFallback(
      cloned.complaintWindowMinutes,
      COMPLAINT_WINDOW_DEFAULT_MINUTES,
    ),
  };
}

function createStore(): MockPlatformConfigStore {
  return { config: normalizePlatformConfig(platformConfigSeed) };
}

export function platformConfigStore(): MockPlatformConfigStore {
  return getMockStore("platformConfig", createStore);
}

/** 本文件内部取 store 的短名字。 */
function store(): MockPlatformConfigStore {
  return platformConfigStore();
}

/**
 * 当前配置（**同步**）。
 *
 * 返回的是副本：调用方拿到之后想怎么改都不会动到存储里的那一份。
 * 同步是刻意的——它要在其它模块的原子区段里被调用（见全局约束：
 * 原子区段内出现 `await` 就是 bug）。
 */
export function readPlatformConfig(): PlatformConfig {
  return normalizePlatformConfig(store().config);
}

/**
 * 覆盖式写入（**同步**）。
 *
 * 返回改动前后的**两份副本**：审计快照要 before/after 两份，
 * 而 before 必须在写入前取到——写完之后再去读，读到的已经是新值了。
 *
 * ⚠️ 本函数**不校验**取值是否合法：校验是服务层与伪事务的事
 * （非法值必须被拒，而不是被写进去）。仓储只负责存取。
 * 它做的是另一件事：**补齐缺失的字段**（见 `normalizePlatformConfig`），
 * 因此 store 里的那一份永远是四个时长齐全的完整配置——写进来的对象缺字段时，
 * 缺的那个按默认值补，而不是留一个洞给后面所有读的人。
 */
export function writePlatformConfig(next: PlatformConfig): PlatformConfigWriteResult {
  const previous = normalizePlatformConfig(store().config);
  store().config = normalizePlatformConfig(next);
  return { previous, updated: normalizePlatformConfig(next) };
}

export const mockPlatformConfigRepository: PlatformConfigRepository = {
  async getConfig() {
    return readPlatformConfig();
  },
};
