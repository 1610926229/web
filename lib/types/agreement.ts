/**
 * 协议与版本介绍的类型与对外 DTO。
 *
 * 四类内容共用一套模型（`user` / `companion` / `platform` / `version`），
 * 由 `type` 区分：用户协议、陪玩协议、平台协议、版本介绍。
 *
 * 正文采用**结构化段落**（`sections`），不是 HTML 字符串：
 * 页面按段落渲染，因此不存在 `dangerouslySetInnerHTML` 这类不受控的注入面，
 * 也不需要富文本编辑器。将来接入真实正文时，同样的结构由管理端产出。
 *
 * ⚠️ 平台主体名称、联系方式等法律信息**尚未提供**，正文里一律使用明显的占位变量
 * （见 `lib/constants/agreements.ts` 的 `PLATFORM_ENTITY_PLACEHOLDER`），
 * 不自行编造公司名称、注册地址、电话或统一社会信用代码。
 */

/** 四类内容。顺序即页面上的页签顺序。 */
export type AgreementType = "user" | "companion" | "platform" | "version";

/** 正文的一个段落块。`heading` 为空串表示该块没有小标题。 */
export type AgreementSection = {
  /** 小标题，例如「一、协议范围与修改」 */
  heading: string;
  /** 该块下的若干段落 */
  paragraphs: string[];
};

/**
 * 协议记录（仓储内部类型）。
 *
 * ⚠️ 页面与接口**不直接返回本类型**：`enabled` 这类配置字段通过
 * `AgreementDetail` 显式挑掉，历史版本的判断也只在服务端做。
 */
export type Agreement = {
  id: string;
  type: AgreementType;
  title: string;
  sections: AgreementSection[];
  /** 版本号，形如 `1.2.0`；同类型多个版本时取最高版本作为当前版本 */
  version: string;
  /** 该版本的更新时间（ISO） */
  updatedAt: string;
  /** 是否启用。停用的历史版本不会出现在任何响应里 */
  enabled: boolean;
};

/** 对外展示的协议（当前启用版本）。 */
export type AgreementDetail = {
  id: string;
  type: AgreementType;
  title: string;
  sections: AgreementSection[];
  version: string;
  updatedAt: string;
};

/**
 * 一个页签的内容。
 *
 * `agreement` 为 null 表示**该类型还没有配置启用内容**：页面显示「内容暂未配置」，
 * 其他类型照常显示，不会因为缺一类而整页报错。
 */
export type AgreementTab = {
  type: AgreementType;
  /** 页签名称，与服务端同源，前端不自己映射 */
  label: string;
  agreement: AgreementDetail | null;
};

/** `GET /api/agreements` 的响应体：四类内容一次返回，页签切换在客户端完成。 */
export type AgreementsDto = {
  /** 固定四项（顺序即页签顺序）；缺内容的类型 `agreement` 为 null */
  tabs: AgreementTab[];
  /** 内容性质说明（示例文案，不是正式生效的法律协议） */
  notice: string;
};
