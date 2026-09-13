import { homeSeed, userSeed } from "@/lib/mocks/fixtures/seed";
import type { DataSource } from "./source";

/**
 * Mock 数据源：直接读取进程内的种子数据，不经过任何网络。
 *
 * ⚠️ 仅服务端使用，仅供开发阶段；接入真实后端时整个文件删除。
 * 这里不做故障注入（那属于传输层，由 `lib/mocks/debug.ts` 统一处理），
 * 也不做数据加工——数据源只负责「把数据取出来」。
 */
export const mockDataSource: DataSource = {
  async getHomeData() {
    return homeSeed;
  },

  async findUserById(id) {
    return userSeed.find((user) => user.id === id) ?? null;
  },
};
