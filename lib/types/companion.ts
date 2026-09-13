/**
 * 陪玩（打手）类型。
 *
 * 只有**公开信息**：昵称、头像、展示用等级标签与当前是否可选。
 * 不含联系方式、真实姓名、接单记录等任何内部数据。
 */

export type Companion = {
  id: string;
  name: string;
  avatarUrl: string;
  /** 展示用标签，如「钻石打手」。 */
  rankLabel: string;
  /**
   * 当前是否可选。不可选的陪玩**仍会出现在列表中**（置灰并标注），
   * 但服务端会拒绝把它写进支付请求；不静默隐藏，用户才不会以为名单里少了一个人。
   */
  available: boolean;
};
