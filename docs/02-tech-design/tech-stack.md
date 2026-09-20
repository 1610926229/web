# 技术栈（Tech Stack）

> 完全依据 `package.json`、`pnpm-lock.yaml`、`tsconfig.json`、`next.config.ts`、`eslint.config.mjs`、`postcss.config.mjs`、`pnpm-workspace.yaml` 与当前源码 import 生成。
>
> **本文件只记录项目真实使用的技术。项目里没有使用的技术一律不写。**
>
> 状态标签：**CURRENT** / **TARGET**（`NOT IMPLEMENTED`）/ **TBD**（`DO NOT INVENT`）。

---

# 一、运行时与包管理

| 项 | 值 | 来源 |
|---|---|---|
| **包管理器** | **pnpm 12.3.4** | `package.json` → `packageManager` |
| **Node** | **20.9+ 最低**（Next.js 16 要求的底线）。当前环境为 Node 24——项目依赖 Node 24 才有的「原生剥离 TypeScript 类型」能力跑测试 | `package.json` scripts 的 `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` |
| **模块体系** | ESM（`"module": "esnext"`） | `tsconfig.json` |
| **仓库形态** | 单包（非 monorepo） | 无 `workspaces` 字段 |

**`pnpm-workspace.yaml` 的 `allowBuilds`**（构建脚本白名单）：

```yaml
allowBuilds:
  sharp: false
  unrs-resolver: false
```

**⚠️ 新增的原生依赖若必须跑构建脚本，必须在此文件放行**，否则 pnpm 会静默跳过它的安装脚本。

---

# 二、框架与语言

| 项 | 版本 | 说明 |
|---|---|---|
| **Next.js** | **16.3.4**（精确锁定，非 `^`） | App Router。Turbopack 是 `dev` 与 `build` 的**默认**，不加 `--turbopack` |
| **React** | **19.2.8** | —— |
| **react-dom** | **19.2.8** | —— |
| **TypeScript** | `^5`，最低 5.1 | `strict: true` |
| **类型检查** | `next typegen && tsc --noEmit` | **必须先 typegen** |

**`next.config.ts` 当前为空配置**（`const nextConfig: NextConfig = {}`）。

**`tsconfig.json` 要点**：

- `"jsx": "react-jsx"`、`"moduleResolution": "bundler"`、`"isolatedModules": true`、`"noEmit": true`
- `"target": "ES2017"`
- **路径别名 `@/*` → 仓库根**（`"paths": { "@/*": ["./*"] }`）。**没有 `src/` 目录**
- `include` 覆盖 `**/*.ts`、`**/*.tsx`、`**/*.mts` —— **`.mjs` 刻意不在其中**，因此 `tests/*.test.mjs` 天然不进 `tsc`，不需要额外的 `exclude`

---

# 三、样式

| 项 | 值 | 说明 |
|---|---|---|
| **Tailwind CSS** | `^4` | **CSS-first 配置** |
| **PostCSS 插件** | `@tailwindcss/postcss` | `postcss.config.mjs` |
| **设计令牌位置** | **`app/globals.css` 的 `@theme { … }` 块**（233 行） | **没有 `tailwind.config.js`**。⚠️ 是 `@theme`，**不是 `@theme inline`** |
| **字体** | **无 `next/font`。中文字体栈直接写在 `@theme` 里** | ⚠️ 脚手架自带的 Geist 接线**已被移除**。`--font-sans` = `-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", …` |

**⚠️ 新增设计令牌写进 `app/globals.css` 的 `@theme` 块，不要建 JS 配置。**

**`@theme` 当前包含四组令牌**：中性色（`--color-page` / `surface` / `ink` / `ink-2` / `ink-3` / `line`）、
品牌色（`--color-brand-yellow*` / `-red` / `-blue*`）、**订单状态色**（`--color-status-*`）、
订单页 tab 渐变（`--color-tab-from` / `-to`），以及字体栈。

**⚠️ 订单状态色只由 `lib/constants/orders.ts` 的 `ORDER_STATUS_CLASS` 引用**——页面与卡片不写死颜色，换色只改一处。

**⚠️ 不要重新引入 `next/font/google`**：移除它是为了消除构建期外网依赖，同时保证中文字形覆盖。

**移动优先**：用户端套 480px 容器；管理后台是**独立桌面布局**，不复用移动壳层。
**主要运行环境是微信内置浏览器。**

---

# 四、测试

| 项 | 值 |
|---|---|
| **测试框架** | **无。使用 Node 内置 `node --test`** |
| **命令** | `pnpm test` |
| **完整命令** | `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/alias-hook.mjs --test "tests/*.test.mjs"` |
| **测试文件数** | 51 |
| **测试用例数** | 1011 |

**`tests/alias-hook.mjs`** 是一个约 20 行的 ESM resolve hook，教会 Node 两条它原生不支持的规则：

1. `@/*` 别名；
2. bundler 风格的无扩展名相对导入。

**两个关键后果**：

- **JSX 不被剥离**，因此测试**只覆盖非组件模块**（types / constants / data / services）。组件行为靠人工验收。
- 测试文件是 `.mjs` 是**刻意的**（见 §二 tsconfig 说明）。

**HTTP 冒烟测试需要起服务**：`tests/http-smoke.test.mjs` 依赖 `APP_BASE_URL`。不起服务时该批自动跳过（约 111 条）。

---

# 五、Lint 与构建

| 项 | 值 |
|---|---|
| **Lint** | `pnpm lint` → **ESLint CLI**（`eslint`） |
| **配置** | `eslint.config.mjs`，**flat config** |
| **继承** | `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript` |
| **⚠️ `next lint` 已被移除** | `next build` **不再执行 lint**。因此 lint 必须单独跑 |
| **构建** | `pnpm build`（Turbopack） |
| **启动** | `pnpm start` |
| **开发** | `pnpm dev`（:3000，Turbopack，输出在 `.next/dev`） |
| **typecheck** | `pnpm typecheck` = `next typegen && tsc --noEmit` |

**⚠️ 残留 `webpack` 配置会让 `next build` 失败**（除非显式传 `--webpack`）。当前 `next.config.ts` 没有 webpack 配置，保持这样。

---

# 六、状态管理 / 数据 / 网络

| 项 | 当前选型 | 说明 |
|---|---|---|
| **状态管理库** | **无** | 不用 Redux / Zustand / Jotai / MobX。服务端组件直接取数；客户端组件用 `*Http.ts` + React 本地状态 |
| **全局状态** | React `cache()`（服务端请求内共享） | 仅 `lib/auth/session.ts` 与 `lib/services/companionAccess.ts` 使用 |
| **数据库** | **无** | —— |
| **ORM** | **无** | —— |
| **数据存储** | **进程内内存 Map，挂在 `globalThis.__youmuMockStore__`** | 23 个 store，dev server 重启即清空（**预期行为**） |
| **HTTP 客户端（浏览器）** | **原生 `fetch`**，封装在 `lib/api/client.ts` | `apiGet` / `apiPost` / `apiPatch` / `apiDelete`。**无 axios / 无 swr / 无 react-query** |
| **HTTP 客户端（服务端）** | **无**。Server Component 直接调 service | 不走 HTTP 请求自身 |
| **请求超时** | `AbortSignal.timeout(10_000)` | 硬编码在 `lib/api/client.ts` |
| **凭证** | `credentials: "same-origin"` | 同上 |

**Mock 开关（`lib/config/env.ts`，全 5 个，仅服务端读取）**：

| 变量 | 作用 | 关闭时 |
|---|---|---|
| `ENABLE_MOCK_AUTH` | 用户模拟登录 | `/api/auth/mock-login` → 404 |
| `ENABLE_MOCK_ADMIN` | 管理员模拟登录（**独立**） | `/api/admin/auth/mock-login` → 404 |
| `ENABLE_MOCK_STAFF` | 客服模拟登录（**独立**） | `/api/staff/auth/mock-login` → 404 |
| `ENABLE_MOCK_PAYMENT` | 模拟支付 | `/api/payments/mock-confirm` → 404 |
| `ENABLE_MOCK_DEBUG` | 调试参数 `mockError` / `mockEmpty` / `mockDelay` | 参数失效 |

**⚠️ 实现要点**：这五个开关全部通过**动态 key** 读 env（`process.env[name] === "true"`），而不是 `process.env.ENABLE_MOCK_AUTH`。
理由（源码注释原文）：打包器会把静态写法在构建期内联成常量，导致「构建时开、运行时关」这类差异被抹掉。

---

# 七、认证

| 项 | 当前选型 |
|---|---|
| **认证方案** | **HttpOnly Cookie + 服务端会话查询**。无 JWT、无 NextAuth、无第三方认证库 |
| **Cookie 名** | `mock_user_id` / `mock_admin_id` / `mock_staff_id` |
| **抽象** | `lib/auth/AuthAdapter.ts`（接口）+ `MockAuthAdapter.ts`（实现）——**只有用户端走这层** |
| **客户端 hooks** | `lib/auth/useAuth.tsx`、`lib/auth/LoginGate.tsx`、`lib/auth/RequireAuth.tsx` |
| **⚠️ 现状** | 三套近乎复制的会话模块（用户 / 管理员 / 客服）+ 打手复用用户会话。见 `architecture-rules.md` §4.2 |

---

# 八、图片 / ID / 其他

| 项 | 当前选型 | 来源 |
|---|---|---|
| **图片组件** | **`next/image`** | Next 16 的默认值变化见 §九 |
| **图片远程源** | `images.remotePatterns`（若需配置） | `next.config.ts` 当前为空。**不用已废弃的 `images.domains`** |
| **ID 生成** | **业务 id：可读前缀 + 序号**（如 `nextRecordId`，`lib/data/adminWriteSupport.ts:204`）。**通知 id：随机 UUID + 冲突重试**（`mockNotificationRepository.ts:59`） | 见下方 ⚠️ |
| **时间格式** | **ISO 8601 字符串**（`string`，不是 `Date` 对象） | 全仓类型一致 |
| **金额格式** | **整数「分」**（`number`） | 见 `architecture-rules.md` §三 |
| **分页** | `lib/constants/pagination.ts` + `PageResult<T>`（`lib/types/common.ts`） | —— |
| **日期格式化** | `lib/utils/format.ts` | —— |
| **图标** | 无图标库，用内联 SVG / emoji | 源码可见 |

**⚠️ ID 生成的重要区分（不是规范，是事实与警告）**：
通知用的是**随机 UUID**，靠 `newNotificationId()` 的冲突重试保证唯一。
**TARGET 的新实体（如 Earning）不得照抄这个做法**——幂等业务键应当是可推导的（如 `orderId`），具体见 `database-schema.md` 的「Future DB Migration Constraints」。

---

# 九、Next.js 16 破坏性变更（CURRENT，已全部踩对）

**⚠️ 本版本与训练数据中的 Next.js 差异较大。写框架代码前先读 `node_modules/next/dist/docs/`。**
`01-app/02-guides/upgrading/version-16.md` 是权威的旧-新对照清单。

**最容易踩的几条**：

| 变更 | 正确写法 |
|---|---|
| `params` / `searchParams` / `cookies()` / `headers()` / `draftMode()` **全部是 async** | `const { slug } = await props.params`。v15 的同步兼容窗口**已关闭** |
| 路由类型 | 用**全局生成的** `PageProps<'/blog/[slug]'>` / `LayoutProps<'/dashboard'>` / `RouteContext<'/users/[id]'>`，**不要手写**。无需 import |
| 这些类型**只在生成后存在** | 由 `pnpm dev` / `pnpm build` / `next typegen` 产出到 `.next/dev/types/`。**新克隆的仓库必须先跑一次，否则编辑器报 `PageProps` 未定义** |
| `middleware.ts` → **`proxy.ts`** | `export function proxy()`，类型 `NextProxy`。**Node runtime only**，`export const runtime = 'edge'` 会抛错 |
| `revalidateTag` **需要第二个参数** | `revalidateTag('posts', 'max')` |
| **Turbopack 是默认** | 去掉 `--turbopack` 标志 |
| **`next lint` 已移除** | 用 ESLint CLI。`next build` 不再 lint |
| `next/image` 默认值变了 | `qualities` 只有 `[75]`；`minimumCacheTTL` 4 小时；`imageSizes` 去掉了 `16` |
| **已移除** | AMP、`serverRuntimeConfig` / `publicRuntimeConfig`（用 env 变量）、`exportPathMap`、`unstable_rootParams` |
| 并行路由插槽 | 需要显式 `default.js` |
| **Caching** | `fetch` 默认不缓存，缓存 opt-in。`experimental.ppr` / `dynamicIO` / `useCache` 已移除，替代品是顶层 `cacheComponents: true` |
| **已转正的标志** | `turbopack`、`reactCompiler`、`typedRoutes` 移出 `experimental` |
| **最低要求** | Node 20.9+、TypeScript 5.1+ |

---

# 十、技术引入规则

**⚠️ 新增以下任何一类依赖之前，必须有明确理由，并得到产品负责人确认。**
**禁止 Claude 因个人偏好替换当前技术栈。**

| 类别 | 当前状态 | 引入前提 |
|---|---|---|
| **状态管理框架**（Redux / Zustand / Jotai…） | 无 | 必须说明**当前方案具体在哪个场景下做不到**。而不是「项目变大了」 |
| **ORM**（Prisma / Drizzle…） | 无 | **属 TBD，禁止自行选定**。必须先确认数据库选型 |
| **DB library**（pg / mysql2…） | 无 | 同上 |
| **UI 组件库**（shadcn / Ant Design / MUI…） | 无 | 必须说明现有 Tailwind + 自研组件的缺口。**用户端是移动优先微信 H5**，桌面型组件库默认不合适 |
| **validation 框架**（zod / yup / valibot…） | 无。当前是手写校验，放在 `lib/constants/*.ts` | 必须说明手写校验在哪一类输入上已经失控 |
| **event bus** | 无。跨聚合协作靠「同一原子区段内顺序调用写入器」 | 必须说明哪个跨聚合场景**无法**用原子区段表达 |
| **queue** | 无 | 同 event bus。**注意**：定时推进的既定方案是复用 domain sweep 函数，不是引入队列 |
| **cache**（Redis 等） | 无 | 必须说明缓存目标与失效策略 |
| **test framework**（Jest / Vitest…） | **无，用 Node 内置 runner** | 必须说明 `node --test` 具体缺什么。**注意：JSX 不被剥离是 Node 的限制，不是 `node --test` 的**——换框架前先确认它真的能解决这个问题 |
| **HTTP 客户端**（axios / swr / react-query…） | 原生 `fetch` + 自研 `lib/api/client.ts` | 必须说明现有封装缺什么 |
| **日期库**（dayjs / date-fns…） | 无 | 必须说明为什么 `lib/utils/format.ts` + ISO 字符串不够 |
| **图标库** | 无 | 低门槛，但仍需说明 |

**禁止**：

- ❌ 替换现有技术栈（Next.js / React / Tailwind / pnpm / Node 内置测试）
- ❌ 为了「更现代」引入并行方案（例如新加一个 HTTP 客户端而 `lib/api/client.ts` 仍在用）
- ❌ 自己决定数据库或 ORM（**TBD**）

---

# 十一、TBD — DO NOT INVENT

| 项 | 状态 |
|---|---|
| 数据库选型 | **TBD**。PostgreSQL / MySQL / 其他**均未确认** |
| ORM 选型 | **TBD**。Prisma / Drizzle / 其他**均未确认** |
| 真实支付渠道接入方式 | **TARGET**（计划 TD-3）。具体 SDK 与流程未确认 |
| 部署环境与 CI | **TBD**。当前无 CI 配置 |
| 定时调度器的运行环境（cron / 平台调度 / 常驻进程） | **TBD**。只确认了「必须复用同一个 domain service」 |
