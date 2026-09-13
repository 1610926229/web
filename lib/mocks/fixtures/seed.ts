import type { HomeData } from "@/lib/types/content";
import type { User } from "@/lib/types/user";

/**
 * Mock 数据种子（P2 阶段）。
 *
 * ⚠️ 全部为 Mock 数据，仅用于打通取数链路与版式验证：
 * - 图片均为 public/mock 下的本地占位图，待管理端与对象存储就绪后替换；
 * - 商品名称与价格非最终业务数据，不得作为线上文案或定价依据；
 * - 商品名称中不含价格，名称与价格是两个独立字段；价格单位为「分」；
 * - 公告图片内容待管理端上传，此处仅为占位；
 * - 用户为虚构的 Mock 身份，不含 openid 等任何真实微信标识。
 *
 * 接入真实后端后，本目录随 lib/mocks 一并移除。
 */

/** 两个 Mock 用户，用于验证「切换用户后个人信息展示随之变化」。 */
export const userSeed: User[] = [
  {
    id: "u-1001",
    nickname: "老板A（占位）",
    avatarUrl: "/mock/avatar-1.svg",
  },
  {
    id: "u-1002",
    nickname: "老板B（占位）",
    avatarUrl: "/mock/avatar-2.svg",
  },
];

export const homeSeed: HomeData = {
  // 公告区：仅图片滚动展示，无跳转字段
  announcements: [
    { id: "a1", imageUrl: "/mock/announcement-1.svg", alt: "公告图片占位 1" },
    { id: "a2", imageUrl: "/mock/announcement-2.svg", alt: "公告图片占位 2" },
  ],

  activityImageUrl: "/mock/promo-activity.svg",

  shortcuts: [
    { id: "service", label: "联系客服", href: "/service" },
    { id: "benefits", label: "点单权益", href: "/placeholder?title=点单权益" },
    { id: "join", label: "考核入驻", href: "/placeholder?title=考核入驻" },
    { id: "complaint", label: "投诉客服专区", href: "/placeholder?title=投诉客服专区" },
  ],

  sections: [
    {
      id: "loss",
      title: "亏本单",
      moreHref: "/category",
      products: [
        {
          id: "p-400w",
          title: "机密400万",
          subtitle: "机密400万",
          coverUrl: "/mock/product-cover-1.svg",
          price: 2990,
          specs: [
            { id: "s-400w", name: "机密400万", price: 2990 },
            { id: "s-400w-2", name: "机密400万 · 双人", price: 3990 },
          ],
        },
        {
          id: "p-200w",
          title: "机密200万",
          subtitle: "机密200万！",
          coverUrl: "/mock/product-cover-2.svg",
          price: 1990,
          specs: [{ id: "s-200w", name: "机密200万", price: 1990 }],
        },
        {
          id: "p-jm200w",
          title: "绝密200万（只打巴克）",
          subtitle: "绝密200万 · 只打巴克",
          coverUrl: "/mock/product-cover-3.svg",
          price: 1990,
          specs: [
            { id: "s-jm200w", name: "绝密200万", price: 1990 },
            { id: "s-jm300w", name: "绝密300万", price: 2990 },
          ],
        },
        {
          id: "p-sh300w",
          title: "双护300万（只打巴克）",
          subtitle: "双护300万 · 只打巴克",
          coverUrl: "/mock/product-cover-4.svg",
          price: 2990,
          specs: [{ id: "s-sh300w", name: "双护300万", price: 2990 }],
        },
      ],
    },
    {
      id: "opening",
      title: "开业特惠",
      moreHref: "/category",
      products: [
        {
          id: "p-600w",
          title: "机密600万",
          subtitle: "机密600万",
          coverUrl: "/mock/product-cover-4.svg",
          price: 3990,
          specs: [{ id: "s-600w", name: "机密600万", price: 3990 }],
        },
        {
          id: "p-500w",
          title: "绝密500万",
          subtitle: "绝密500万",
          coverUrl: "/mock/product-cover-1.svg",
          price: 4990,
          specs: [{ id: "s-500w", name: "绝密500万", price: 4990 }],
        },
        {
          id: "p-800w",
          title: "双护800万",
          subtitle: "双护800万",
          coverUrl: "/mock/product-cover-2.svg",
          price: 5990,
          specs: [{ id: "s-800w", name: "双护800万", price: 5990 }],
        },
        {
          id: "p-1000w",
          title: "带打1000万",
          subtitle: "带打1000万",
          coverUrl: "/mock/product-cover-3.svg",
          price: 6990,
          specs: [{ id: "s-1000w", name: "带打1000万", price: 6990 }],
        },
      ],
    },
  ],
};
