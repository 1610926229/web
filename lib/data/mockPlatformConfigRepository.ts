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

function createStore(): MockPlatformConfigStore {
  return { config: clonePlatformConfig(platformConfigSeed) };
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
  return clonePlatformConfig(store().config);
}

/**
 * 覆盖式写入（**同步**）。
 *
 * 返回改动前后的**两份副本**：审计快照要 before/after 两份，
 * 而 before 必须在写入前取到——写完之后再去读，读到的已经是新值了。
 *
 * ⚠️ 本函数**不校验**取值是否合法：校验是服务层与伪事务的事
 * （非法值必须被拒，而不是被写进去）。仓储只负责存取。
 */
export function writePlatformConfig(next: PlatformConfig): PlatformConfigWriteResult {
  const previous = clonePlatformConfig(store().config);
  store().config = clonePlatformConfig(next);
  return { previous, updated: clonePlatformConfig(next) };
}

export const mockPlatformConfigRepository: PlatformConfigRepository = {
  async getConfig() {
    return readPlatformConfig();
  },
};
