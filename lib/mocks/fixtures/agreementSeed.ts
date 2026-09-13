import {
  PLATFORM_CONTACT_PLACEHOLDER,
  PLATFORM_ENTITY_PLACEHOLDER,
} from "@/lib/constants/agreements";
import type { Agreement } from "@/lib/types/agreement";

/**
 * 预置协议与版本介绍。
 *
 * ⚠️ **全部为示例文案**，不构成正式生效的法律文件，页面上有明确说明
 * （`AGREEMENT_MOCK_NOTICE`）。协议正文将来只有管理者在 PC 管理后台可以修改，
 * 本阶段只完成用户端读取与 Mock 数据访问层。
 *
 * 关于平台主体信息：正式的公司名称、注册地址、联系电话、统一社会信用代码
 * **尚未提供**，因此正文里凡是出现这些内容的位置一律使用明显的占位变量
 * （`PLATFORM_ENTITY_PLACEHOLDER` / `PLATFORM_CONTACT_PLACEHOLDER`）。
 * **不自行编造**任何公司名称、地址、电话或信用代码——那会让示例文案看起来像正式条款。
 *
 * 版本选择规则（见 `lib/constants/agreements.ts` 的 `pickCurrentAgreements`）需要真实数据来验证，
 * 因此这里刻意造出三种情况：
 *
 * - `user`：**两个启用版本**（1.1.0 / 1.0.0）→ 必须取 1.1.0，验证「多版本取最高」；
 * - `platform`：2.0.0 启用、1.0.0 **已停用** → 必须取 2.0.0，验证「停用版本不展示」；
 * - `companion` / `version`：单版本，用来验证「单版本照常返回」。
 *
 * ⚠️ 仅服务端使用：本文件不会被任何客户端组件引用，接入真实后端后随 lib/mocks 一并移除。
 */

const EXAMPLE_PREFIX =
  "【示例内容】以下为开发阶段的示例条款，用于验证协议页的展示与版本机制，不是正式生效的法律文件。";

export const agreementSeed: Agreement[] = [
  // ————————————————————— 用户协议 —————————————————————
  {
    id: "ag-user-110",
    type: "user",
    title: "用户协议",
    version: "1.1.0",
    updatedAt: "2026-09-01T02:00:00.000Z",
    enabled: true,
    sections: [
      {
        heading: "重要提示",
        paragraphs: [
          EXAMPLE_PREFIX,
          `请您（以下简称「用户」或「您」）在注册成为 ${PLATFORM_ENTITY_PLACEHOLDER} 平台（包括但不限于官方网站、移动应用程序等，以下称「本平台」）用户前，仔细阅读并充分理解本协议全部内容，特别是其中涉及免除或限制责任、争议解决与法律适用的条款。`,
          "您一旦在本平台完成注册、登录或使用本平台服务，即视为您已阅读、理解并同意接受本协议的全部内容。如果您不同意本协议的任何内容，请立即停止注册或使用本平台服务。",
        ],
      },
      {
        heading: "一、协议范围与修改",
        paragraphs: [
          `1.1 本协议是您与 ${PLATFORM_ENTITY_PLACEHOLDER} 之间关于使用本平台各项服务所订立的协议。`,
          "1.2 平台有权根据需要不时修改本协议，修改后的协议将在本平台上公布。若您在协议修改后继续使用本平台服务，则视为您接受修改后的协议。",
          "1.3 本协议的具体条款内容以平台正式公布的版本为准；本页展示的示例条款不构成对任何一方的约束。",
        ],
      },
      {
        heading: "二、账号注册与使用",
        paragraphs: [
          "2.1 您确认，在注册或使用本平台服务时，您是具备完全民事行为能力的自然人、法人或其他组织。",
          "2.2 您应妥善保管账号信息，因您保管不善造成的损失由您自行承担。",
          "2.3 您不得利用本平台从事任何违反法律法规或公序良俗的活动。",
        ],
      },
      {
        heading: "三、服务内容与订单",
        paragraphs: [
          "3.1 本平台提供电竞陪玩、护航及相关增值服务的信息展示、下单与订单管理功能。",
          "3.2 订单在支付成功后生成，订单中的商品名称、规格与金额以下单时确认的信息为准。",
          "3.3 已完成的订单计入累计有效消费金额；已退款订单不计入。统计口径详见消费等级页面的说明。",
        ],
      },
      {
        heading: "四、免责与责任限制",
        paragraphs: [
          "4.1 因不可抗力、网络故障、第三方服务异常等非平台原因导致的服务中断，平台不承担责任。",
          "4.2 在法律允许的范围内，平台对您承担的责任以本协议约定及实际发生的直接损失为限。",
        ],
      },
      {
        heading: "五、争议解决",
        paragraphs: [
          "5.1 本协议的订立、执行与解释均适用中华人民共和国法律。",
          `5.2 因本协议产生的争议，双方应友好协商解决；协商不成的，可向 ${PLATFORM_ENTITY_PLACEHOLDER} 所在地有管辖权的人民法院提起诉讼。`,
          `5.3 联系方式：${PLATFORM_CONTACT_PLACEHOLDER}。`,
        ],
      },
    ],
  },
  {
    // 同一类型的**较早版本但仍处于启用状态**：版本选择必须取 1.1.0 而不是它
    id: "ag-user-100",
    type: "user",
    title: "用户协议",
    version: "1.0.0",
    updatedAt: "2026-06-01T02:00:00.000Z",
    enabled: true,
    sections: [
      {
        heading: "重要提示",
        paragraphs: [
          EXAMPLE_PREFIX,
          `这是用户协议的 1.0.0 版本示例。当前启用版本应为 1.1.0，本版不应出现在页面上。${PLATFORM_ENTITY_PLACEHOLDER}`,
        ],
      },
    ],
  },

  // ————————————————————— 陪玩协议 —————————————————————
  {
    id: "ag-companion-100",
    type: "companion",
    title: "陪玩协议",
    version: "1.0.0",
    updatedAt: "2026-07-15T02:00:00.000Z",
    enabled: true,
    sections: [
      {
        heading: "内容说明",
        paragraphs: [
          EXAMPLE_PREFIX,
          `本协议用于约定陪玩（护航）服务提供方与 ${PLATFORM_ENTITY_PLACEHOLDER} 之间的服务规则。陪玩服务的正式准入条件、结算规则与考核标准尚在确认中，本阶段仅展示示例条款。`,
        ],
      },
      {
        heading: "一、服务提供",
        paragraphs: [
          "1.1 陪玩应按订单约定的时间、内容与标准提供服务，不得擅自变更服务内容。",
          "1.2 陪玩不得将订单转交他人完成，不得使用任何违规手段影响对局公平性。",
        ],
      },
      {
        heading: "二、服务规范",
        paragraphs: [
          "2.1 陪玩应保持礼貌沟通，不得辱骂、骚扰用户或索要额外费用。",
          "2.2 陪玩不得在服务过程中引导用户脱离本平台进行交易。",
        ],
      },
      {
        heading: "三、订单与结算",
        paragraphs: [
          "3.1 陪玩的结算金额、结算周期与结算方式尚未确认，本阶段不做任何展示或承诺。",
          "3.2 因陪玩原因导致订单未能完成的，平台可按规则处理该笔订单。",
        ],
      },
      {
        heading: "四、违规处理",
        paragraphs: [
          `4.1 陪玩违反本协议的，平台可依据规则采取提醒、暂停接单或终止合作等措施。${PLATFORM_CONTACT_PLACEHOLDER}`,
        ],
      },
    ],
  },

  // ————————————————————— 平台协议 —————————————————————
  {
    id: "ag-platform-200",
    type: "platform",
    title: "平台协议",
    version: "2.0.0",
    updatedAt: "2026-09-10T02:00:00.000Z",
    enabled: true,
    sections: [
      {
        heading: "内容说明",
        paragraphs: [
          EXAMPLE_PREFIX,
          `本协议用于说明 ${PLATFORM_ENTITY_PLACEHOLDER} 平台的服务规则、平台责任边界与用户行为规范。`,
        ],
      },
      {
        heading: "一、平台服务",
        paragraphs: [
          "1.1 平台提供信息展示、订单撮合、订单管理与售后处理等服务。",
          "1.2 平台不对陪玩服务的实际结果作出保证，但会按规则处理用户提交的投诉与退款申请。",
        ],
      },
      {
        heading: "二、用户行为规范",
        paragraphs: [
          "2.1 用户不得提交虚假信息、恶意下单或恶意投诉。",
          "2.2 用户不得利用平台从事任何违反法律法规的活动。",
        ],
      },
      {
        heading: "三、投诉与退款",
        paragraphs: [
          "3.1 用户可在订单详情页提交投诉与退款申请，处理进度可在投诉进度页查看。",
          "3.2 退款申请的处理结果以平台审核为准；已退款的订单不计入累计有效消费金额。",
        ],
      },
      {
        heading: "四、其他",
        paragraphs: [`4.1 本协议未尽事宜，以平台后续公布的规则为准。${PLATFORM_CONTACT_PLACEHOLDER}`],
      },
    ],
  },
  {
    // 已停用的历史版本：不参与版本选择，也不会出现在接口响应里
    id: "ag-platform-100",
    type: "platform",
    title: "平台协议",
    version: "1.0.0",
    updatedAt: "2026-05-01T02:00:00.000Z",
    enabled: false,
    sections: [
      {
        heading: "内容说明",
        paragraphs: [
          EXAMPLE_PREFIX,
          `这是平台协议的 1.0.0 版本示例，已停用，不应出现在页面上。${PLATFORM_ENTITY_PLACEHOLDER}`,
        ],
      },
    ],
  },

  // ————————————————————— 版本介绍 —————————————————————
  {
    id: "ag-version-120",
    type: "version",
    title: "版本介绍",
    version: "1.2.0",
    updatedAt: "2026-09-13T02:00:00.000Z",
    enabled: true,
    sections: [
      {
        heading: "内容说明",
        paragraphs: [
          EXAMPLE_PREFIX,
          "本条记录介绍平台各版本的功能变化，仅用于展示版本介绍页的版式与版本机制，具体发布内容以平台正式公告为准。",
        ],
      },
      {
        heading: "v1.2.0 · 2026-09-13",
        paragraphs: [
          "新增消费等级与权益页面，展示累计有效消费金额、当前等级与升级进度。",
          "新增消费排行榜，按累计有效消费金额降序展示名次。",
          "新增相关协议页面，支持用户协议、陪玩协议、平台协议与版本介绍四类内容的查看。",
        ],
      },
      {
        heading: "v1.1.0 · 2026-09-01",
        paragraphs: [
          "新增优惠券、订单评价、鸡腿记录与功能建议。",
          "新增投诉进度查询与退款申请入口。",
        ],
      },
      {
        heading: "v1.0.0 · 2026-08-01",
        paragraphs: ["首个版本，提供商品浏览、下单、支付与订单管理功能。"],
      },
    ],
  },
];
