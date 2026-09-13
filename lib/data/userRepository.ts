import type { User } from "@/lib/types/user";
import { mockUserRepository } from "./mockUserRepository";

/**
 * 用户资料的可替换仓储。
 *
 * 为什么单独开一个仓储，而不是继续放在支付仓储或数据源里：
 * 「我的」页现在会**写**用户资料（昵称 / 头像 / 简介），而支付仓储的一半字段是订单与金额，
 * 把用户资料混进去会让「哪些是用户数据、哪些是交易数据」变得说不清；数据源（`source.ts`）
 * 又是只读契约。因此资料单独一层，读写在同一个地方，将来换成数据库只替换本实现。
 *
 * ⚠️ 本层只负责存取，**不校验**「昵称能不能为空」「头像地址合不合法」——那是业务规则，
 * 在 `lib/services/profile.ts` 里做。仓储只保证自己这份数据的一致性。
 */

/**
 * 用户记录（**内部**形态）。
 *
 * `bio` 与 `displayId` 是资料页新增的字段；`displayId` 是平台给用户看的 ID，
 * 与微信 OpenID / UnionID 无关。本类型只存在于服务端，不会进入浏览器产物。
 */
export type UserRecord = {
  id: string;
  /** 平台展示给用户的 ID（原型「ID: xxxx」那一行），不是任何微信标识 */
  displayId: string;
  nickname: string;
  avatarUrl: string;
  bio: string;
};

/** 允许改动的资料字段。三个字段必须一起给，避免「只改昵称」这类部分更新出现空值。 */
export type UserProfilePatch = {
  nickname: string;
  avatarUrl: string;
  bio: string;
};

export type UserRepository = {
  /** 按 id 取用户记录；不存在返回 null。 */
  findUserById(id: string): Promise<UserRecord | null>;

  /**
   * 覆盖式更新资料。用户不存在返回 null（由服务层转成 404）。
   *
   * 只改这三个字段，**身份字段（id / displayId）一个字都不动**：
   * 编辑资料不能变成修改微信身份数据。
   */
  updateProfile(id: string, patch: UserProfilePatch): Promise<UserRecord | null>;
};

export function getUserRepository(): UserRepository {
  return mockUserRepository;
}

/**
 * 用户记录 → 登录态用户。
 *
 * 显式挑三个字段：登录态只回答「谁登录了」，**不带简介**——资料页要的那一份走
 * `toUserProfile()`，两个 DTO 各取所需，避免「顺手把整个记录塞进会话」。
 */
export function toSessionUser(record: UserRecord): User {
  return { id: record.id, nickname: record.nickname, avatarUrl: record.avatarUrl };
}
