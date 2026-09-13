import type { Addon, Game, ProductListQuery } from "@/lib/types/catalog";
import type { PageResult } from "@/lib/types/common";
import type { Companion } from "@/lib/types/companion";
import type { HomeData } from "@/lib/types/content";
import type { Product, ProductDetail } from "@/lib/types/product";
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
  /** 游戏及其类目，用于分类页的顶部游戏切换与左侧类目竖栏。 */
  getGames(): Promise<Game[]>;
  /** 商品列表查询；只返回上架商品，按条件过滤并分页。 */
  queryProducts(query: ProductListQuery): Promise<PageResult<Product>>;
  /** 商品详情；不存在返回 null。下架商品仍可取到（详情页需要展示下架状态）。 */
  getProductDetail(id: string): Promise<ProductDetail | null>;
  /** 单个游戏；不存在返回 null。结算页据此校验大区取值。 */
  getGame(id: string): Promise<Game | null>;
  /** 增值服务目录，用于结算页选择与金额计算。 */
  listAddons(): Promise<Addon[]>;
  /** 陪玩名单，**包含当前不可选的**（列表中标灰，服务端会拒绝选中）。 */
  listCompanions(): Promise<Companion[]>;
  /** 单个陪玩；不存在返回 null。 */
  getCompanion(id: string): Promise<Companion | null>;
};

export function getDataSource(): DataSource {
  return mockDataSource;
}
