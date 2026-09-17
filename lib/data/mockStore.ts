/**
 * 进程内 Mock 存储的**唯一**挂载方式。
 *
 * ⚠️ 仅用于本地开发与自动化测试：
 * - 数据只在内存里，**开发服务器重启后全部丢失**，这是预期行为；
 * - 不写 localStorage、不写文件、不写数据库，客户端也拿不到任何「可信状态」；
 * - 将来由真实数据库替换（唯一索引 + 事务），删除本文件不影响上层接口。
 *
 * 为什么挂在 `globalThis` 上：开发模式热更新会重新执行模块，若存在模块作用域里，
 * 每次改动文件都会把联调时创建的数据清空，非常难用。挂到 globalThis 后，
 * 同一个 Node 进程内始终是同一个 store。
 *
 * 为什么统一在这里建仓：四个新仓储（退款 / 投诉 / 消息 / 通知）与既有的支付仓储
 * 需要同一套「建仓时写入预置数据、之后读写都在同一份 Map 上」的语义。
 * 各仓储自己写一遍 `globalThis` 取值，迟早会出现有的仓储忘了挂 globalThis、
 * 有的仓储建仓时覆盖了已有数据这类问题。
 *
 * 并发安全的前提：Node 是单线程的，而各仓储里「读—判断—写」的**原子区段内没有 await**，
 * 因此不会被别的请求插入执行。将来换成数据库时，这段需要换成真正的事务。
 */

/** 各仓储的 store 名。集中列出，避免同一个仓储在两处用了不同的名字。 */
export type MockStoreName =
  | "payment"
  | "refund"
  | "complaint"
  | "message"
  | "notification"
  | "user"
  | "favorite"
  | "coupon"
  | "review"
  | "tip"
  | "suggestion"
  | "level"
  | "agreement"
  | "companionApplication"
  /**
   * 护航（陪玩）名单。P8A 起这份名单**可写**（审核通过会往里加记录、后台会改资料），
   * 因此它从「只读种子」变成了一个真正的仓储——但名单仍然只有这一份。
   */
  | "companion"
  /** 用户资格（多角色结构）。见 `lib/data/qualificationRepository.ts`。 */
  | "qualification"
  /** 管理操作审计记录（只由服务端写入）。见 `lib/data/adminAuditRepository.ts`。 */
  | "adminAudit"
  /**
   * 商品目录（游戏 / 类目 / 商品 / 规格）。P8B 起这份目录**可写**：
   * 后台会改类目、改商品、改规格，因此它也从一个只读种子变成了真正的仓储——
   * 但目录仍然只有这一份，首页 / 分类页 / 详情 / 结算 / 后台读的都是它。
   * 见 `lib/data/mockCatalogRepository.ts`。
   */
  | "catalog"
  | "admin"
  /**
   * 客服账号（第三类身份）。P8D-1 起这份名单**可写**：管理后台会新增、编辑、
   * 启用、停用与软删除客服账号，因此它是一个真正的仓储。
   * 见 `lib/data/mockStaffRepository.ts`。
   */
  | "staff"
  /**
   * 首页运营内容（图片公告 / 活动 Banner / 快捷入口）。P8E-1 起这份内容**可写**：
   * 管理后台会新增、编辑、启用、停用与软移除它们，因此它是一个真正的仓储——
   * 但全站仍然只有这一份，首页读的与管理后台改的是同一批记录。
   * 见 `lib/data/mockContentRepository.ts`。
   */
  | "content"
  /**
   * 平台级参数（公共池超时等）。P0-1 起这份配置**可写**：后台能改，
   * 而订单进入需要计时的环节时会把自己那一刻的参数值冻结成快照，
   * 因此「改配置」不会动到已经生成的订单。
   * 见 `lib/data/mockPlatformConfigRepository.ts`。
   */
  | "platformConfig";

const PREFIX = "__youmuMockStore__";

function holder(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

function storeKey(name: MockStoreName): string {
  return `${PREFIX}${name}`;
}

/**
 * 取（必要时创建）某个仓储的 store。
 *
 * `create` **只在第一次调用时执行一次**：预置数据在建仓时写入，之后所有读写
 * 都发生在这个 store 上，因此「预置数据」与「用户新提交的数据」在列表里是同一种数据、
 * 走同一条查询路径——不会出现「访问一次列表就把新提交的记录冲掉」。
 */
export function getMockStore<T>(name: MockStoreName, create: () => T): T {
  const target = holder();
  const key = storeKey(name);
  const existing = target[key];
  if (existing === undefined) {
    const created = create();
    target[key] = created;
    return created;
  }
  return existing as T;
}

/**
 * 丢弃某个仓储的 store，下次取用时按预置数据重新建仓。
 *
 * **只给自动化测试用**：测试需要从一份干净的数据出发（例如「这一单还没有退款申请」），
 * 而各仓储的预置数据恰好就是这个起点。业务代码不要调用它——那等于清空用户数据。
 */
export function resetMockStore(name: MockStoreName): void {
  delete holder()[storeKey(name)];
}
