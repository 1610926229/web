/**
 * 协议与版本介绍的类型与对外 DTO。
 *
 * 五类内容共用一套模型（`user` / `privacy` / `companion` / `platform` / `version`），
 * 由 `type` 区分：用户协议、隐私协议、陪玩协议、平台协议、版本介绍。
 *
 * 正文采用**结构化段落**（`sections`），不是 HTML 字符串：
 * 页面按段落渲染，因此不存在 `dangerouslySetInnerHTML` 这类不受控的注入面，
 * 也不需要富文本编辑器。将来接入真实正文时，同样的结构由管理端产出。
 *
 * ⚠️ P8E-1 起**正文由管理后台维护**（见 `lib/data/adminAgreementTransaction.ts`）。
 * 这条改动**没有**放宽上面那句：后台编辑的仍然是 `sections` 结构，
 * 输入框里写的是段落文本，**不是 HTML**。因此「用户端不存在注入面」这句话
 * 在后台可写之后依然成立——它是本模型存在的理由，不是当时的权宜之计。
 *
 * ⚠️ 平台主体名称、联系方式等法律信息**尚未提供**，正文里一律使用明显的占位变量
 * （见 `lib/constants/agreements.ts` 的 `PLATFORM_ENTITY_PLACEHOLDER`），
 * 不自行编造公司名称、注册地址、电话或统一社会信用代码。
 */

/**
 * 五类内容。数组顺序即页面上的页签顺序（见 `AGREEMENT_TYPES`）。
 *
 * ⚠️ **`privacy`（隐私协议）是 P8E-1 新增的第五类，插在 `user` 之后**。
 * 前四个取值一个字都没有改，也没有做数据迁移：类型是历史数据的一部分，
 * 把 `user` 改名成别的会同时改变已存记录的含义，而收益只是命名好看。
 */
export type AgreementType = "user" | "privacy" | "companion" | "platform" | "version";

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

/** `GET /api/agreements` 的响应体：五类内容一次返回，页签切换在客户端完成。 */
export type AgreementsDto = {
  /** 固定五项（顺序即页签顺序）；缺内容的类型 `agreement` 为 null */
  tabs: AgreementTab[];
  /** 内容性质说明（示例文案，不是正式生效的法律协议） */
  notice: string;
};

// ——————————————————————————— 管理端 DTO（P8E-1）———————————————————————————

/**
 * 管理端协议列表的一行。
 *
 * ⚠️ **这一行里没有正文**：`sections` 是几十段法律文本，列表一次要带五条，
 * 把它塞进列表等于每次打开后台都传一遍全部协议全文。正文只在
 * `AdminAgreementDetail` 里出现，列表用 `sectionCount` / `paragraphCount`
 * 两个标量告诉运营「这份协议有多长」（与审计快照同一套口径）。
 *
 * ⚠️ `enabled` 在这里出现是**必须的**：列表上要让停用的那条能被看见并重新启用。
 * 它与公开 DTO（`AgreementDetail`）的约束不冲突——那条约束是「配置字段不下发到用户端」，
 * 而不是「任何地方都不许有 enabled」。
 */
export type AdminAgreementListItem = {
  id: string;
  type: AgreementType;
  /** 类型名称，与用户端页签同源（`lib/constants/agreements.ts`），前端不自己映射 */
  typeLabel: string;
  title: string;
  version: string;
  enabled: boolean;
  updatedAt: string;
  sectionCount: number;
  paragraphCount: number;
};

/** 管理端协议详情 = 列表行 + 正文。编辑表单要用的就是这两部分。 */
export type AdminAgreementDetail = AdminAgreementListItem & { sections: AgreementSection[] };

/**
 * `GET /api/admin/content/agreements` 的响应体。
 *
 * 没有分页与筛选：协议是固定五项、每项至多几百段文本，一次返回即可。
 * 分页会引入「第 2 页上有一条停用的协议没被看见」这类运营事故，
 * 而它换来的收益在只有五项数据时等于零。
 */
export type AdminAgreementListData = {
  /** 顺序即页签顺序（`AGREEMENT_TYPES`）；含停用的记录 */
  items: AdminAgreementListItem[];
  /** 列表页顶部的一句话说明（改动会直接影响用户端） */
  notice: string;
};

/**
 * 协议编辑白名单 —— 后台能改的字段就是这些，多一个都没有。
 *
 * ⚠️ **不在这个类型里**的字段：`id`、`type`、`version`、`updatedAt`。
 * 前两个是记录的身份（类型是固定枚举，改类型等于换了一份协议），
 * 后两个由服务端在写入时计算：`version` 由 `bumpAgreementVersion()` 递增，
 * `updatedAt` 取服务端时间戳。客户端多传一个也不会有任何效果——
 * 服务层**根本没有读取它们的位置**（§九：客户端伪造 ID、状态、时间必须被忽略）。
 *
 * ⚠️ 正文是**结构化段落**而不是 HTML 字符串，这里的类型就说明了这一点：
 * 客户端没有任何途径把一段 HTML 塞进协议正文（校验见
 * `lib/constants/adminAgreements.ts`）。
 */
export type AdminAgreementProfilePatch = {
  title: string;
  sections: AgreementSection[];
  enabled: boolean;
};

/**
 * 写操作的返回：界面据此就地更新那一行，不必为了刷新一个开关重拉整页。
 *
 * ⚠️ `changed: false` **不是错误**：它表示「提交的内容与现状完全一致」——
 * 管理员点了一次保存却没改任何东西。接口必须能把这件事说出来，
 * 否则界面会显示一个「已保存」而实际什么都没写。
 */
export type AdminAgreementWriteResult = {
  agreementId: string;
  version: string;
  enabled: boolean;
  updatedAt: string;
  changed: boolean;
};
