/**
 * 售后凭证（退款申请与投诉共用）。
 *
 * ⚠️ 当前是 **Mock 凭证**：不接对象存储，也没有真实上传。
 * 客户端只提交「类型 + 文件名」，`url` 一律由**服务端**写成 `public/mock` 下的本地占位图。
 * 这样客户端既不能注入任意外链，也不会把用户机器上的本地文件路径当成正式 URL 存进数据里。
 *
 * 将来接入对象存储后：客户端先直传拿到正式地址，再由服务端校验归属后写入本类型的 `url`。
 */

/** 凭证类型。本阶段只允许图片与视频两种，且由服务端校验取值。 */
export type EvidenceKind = "image" | "video";

export type SupportEvidence = {
  id: string;
  kind: EvidenceKind;
  /** 文件名。仅用于展示，不作为地址使用。 */
  name: string;
  /** 占位地址；接入对象存储前始终指向本地 Mock 图。 */
  url: string;
};
