import type { HomeData } from "@/lib/types/content";
import type { User } from "@/lib/types/user";
import { mockDataSource } from "./mockSource";

/**
 * 服务端可替换数据源。
 *
 * 存在的理由：Server Component 直接 `await` 取数，**不能**通过 HTTP 请求本项目自身的
 * Route Handler——那会在构建期产生自请求、依赖部署地址，还多一次无意义的网络跳转。
 * 所以服务端读取走这里，浏览器端请求继续统一走 `lib/api/client.ts`。
 *
 * 两条链路共用同一个 service（`lib/services/*`），只有最底层的取数实现不同：
 *
 *   Server Component ─┐
 *                     ├─→ lib/services/* ─→ DataSource ─→ Mock store（当前）
 *   Route Handler ────┘                              └─→ 数据库（将来）
 *   Browser ─→ lib/api/client.ts ─→ Route Handler ──┘
 *
 * 接入真实后端时，只需把下面的 `getDataSource()` 指向真实实现。
 */
export type DataSource = {
  getHomeData(): Promise<HomeData>;
  /** 按会话中记录的用户标识取用户；不存在时返回 null。 */
  findUserById(id: string): Promise<User | null>;
};

export function getDataSource(): DataSource {
  return mockDataSource;
}
