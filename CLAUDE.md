# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Project state

**Not greenfield.** `app/` is a working application, not the `create-next-app` scaffold. The layered architecture (`app/` → `lib/services/` → `lib/data/` → mock store) is established and enforced across the whole repo.

| Fact | Value |
|---|---|
| Ends | **Four** — 用户端 `app/(mobile)/` · 管理后台 `app/admin/` · 客服工作台 `app/staff/` · 打手工作台 `app/companion/` |
| Pages | 78 `page.tsx`, 8 `layout.tsx` |
| API routes | 125 `route.ts` (`admin` 62 · `staff` 20 · `companion` 8 · rest user-facing) |
| Repositories | 26 (interface + mock impl + `globalThis` store) |
| Tests | 65 files, 1255 cases — `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm build` all green |
| Product name | **超哥电竞** — `lib/constants/site.ts:11` `PLATFORM_NAME`. The name "有目电竞" is **wrong** |

The product is a mobile-first H5 storefront for esports companion/boosting services (陪玩 / 护航 / 打手), opened inside WeChat. Five-tab bottom nav — 首页 / 分类 / 订单 / 客服 / 我的. Design mobile-first; do not build desktop-first layouts and shrink them.

**Prototypes:** `docs/ui-reference/prototype/` — 18 JPEGs (1260×2750, Chinese UI copy) captured in the WeChat in-app browser.
⚠️ **`docs/prototype/` no longer exists** (the old path in this file was stale).

⚠️ **The prototypes are the source of truth for UI only.** "The page shows it" is **not** evidence that the feature is implemented. There is no database and no real payment channel; much of the app runs on `globalThis` mock stores that reset when the dev server restarts.

## 开发前必读

开发业务前必须阅读（按顺序）：

```
docs/03-dev/development-workflow.md            ← 开发轮次记录协议（先读：本轮该怎么走）
docs/03-dev/总需求进度表.md                     ← 全局项目进度唯一真值源
docs/01-requirements/                          ← 业务流程 / 用户权限 / 特殊情况与异常处理（权威需求）
docs/02-tech-design/architecture-rules.md      ← 分层职责、唯一真值源、金额规则、Observed Current vs 规范
docs/02-tech-design/tech-stack.md              ← 技术选型与技术引入规则
docs/02-tech-design/directory-structure.md     ← 每个目录的职责与「新功能放置规则」
docs/02-tech-design/api-contract.md            ← 现有 125 个接口、约定、TARGET 与 TBD
docs/02-tech-design/database-schema.md         ← 逻辑数据模型、TARGET 领域、未来 DB 迁移约束
```

若上述文档中出现 **TBD**：**禁止自行决定**，先问产品负责人。
文档里的 **TARGET** 一律标注 `NOT IMPLEMENTED` 的一律是**尚未实现**，不得当作已有能力使用。

**所有正式业务开发批次必须创建对应 `docs/03-dev/rounds/<ROUND_ID>/`，遵循 Development Round Protocol。若 Round 存在 OPEN decision，禁止开始业务编码。**

## Commands

pnpm is the package manager (`pnpm-lock.yaml`, `packageManager: pnpm@12.3.4`).

```bash
pnpm dev      # dev server on :3000 (Turbopack; output in .next/dev)
pnpm build    # production build
pnpm start    # serve the production build
pnpm lint     # ESLint CLI (flat config: eslint.config.mjs)
pnpm test     # node's built-in test runner (see below)
next typegen  # regenerate route types only, without a full build
```

`tests/*.test.mjs` run on **Node's built-in runner** (`node --test`) — no test framework was added. Node 24 strips TypeScript types natively, so the tests import the real `lib/**` modules; `tests/alias-loader.mjs` is a ~20-line ESM resolve hook that teaches Node the two rules it does not implement (the `@/*` alias and bundler-style extensionless relative imports). Two consequences worth remembering:

- JSX is *not* stripped, so tests cover non-component modules only (constants, repositories, services) — client component behaviour is verified by hand.
- Tests are `.mjs` on purpose: tsconfig's `include` covers `**/*.ts`, so `.mjs` stays out of `tsc` without an `exclude` entry.

## Next.js 16: read the vendored docs before writing framework code

This is Next.js 16.3.4, not 15. Assumptions from training data break at runtime *and* in `tsc`. The docs are checked into the repo at `node_modules/next/dist/docs/` — read the relevant guide there rather than relying on recalled APIs. `01-app/02-guides/upgrading/version-16.md` is the definitive old-vs-new checklist; start there.

The changes most likely to bite in this repo:

- **`params`, `searchParams`, `cookies()`, `headers()`, `draftMode()` are async.** v15's sync-access compatibility window is closed. Always `await` (or `React.use()`): `const { slug } = await props.params`. Same for `params`/`id` in `opengraph-image`/`icon`/`apple-icon`, and `await id` in `sitemap`.
- **Use the globally generated prop types instead of hand-writing them.** `PageProps<'/blog/[slug]'>`, `LayoutProps<'/dashboard'>`, and `RouteContext<'/users/[id]'>` are global (no import) and resolve `params`/`searchParams` to Promises for a route literal. `app/layout.tsx` already uses `LayoutProps<"/">`.
- **Those types only exist after generation** — emitted to `.next/dev/types/` by `pnpm dev`, `pnpm build`, or `next typegen`. `next-env.d.ts` is gitignored and imports from there, so on a fresh clone run one of those before `tsc` or the editor will report `PageProps`/`LayoutProps` as undefined. For CI typechecking: `next typegen && tsc --noEmit`.
- **`middleware.ts` is now `proxy.ts`** — `export function proxy()`, typed `NextProxy`; the old name is deprecated (codemod: `npx @next/codemod@canary middleware-to-proxy .`). Proxy is Node-runtime only: `export const runtime = 'edge'` throws, and edge runtime is deprecated framework-wide (`skipMiddlewareUrlNormalize` → `skipProxyUrlNormalize`).
- **`revalidateTag('tag')` now requires a second argument** — `revalidateTag('posts', 'max')`. `updateTag(tag)` (Server Actions, read-your-writes) and `refresh()` are new.
- **Turbopack is the default** for `dev` and `build`; drop `--turbopack` flags. A leftover `webpack` config makes `next build` fail unless you pass `--webpack`.
- **`next lint` is removed** and `next build` no longer lints — hence the `lint` script calling the ESLint CLI, and no `eslint` config option.
- **Caching:** `fetch` remains uncached by default; caching is opt-in. `experimental.ppr`, `experimental.dynamicIO`, and `experimental.useCache` are removed — their replacement is top-level `cacheComponents: true`, which turns PPR on and retires the `dynamic`/`revalidate`/`fetchCache` route segment configs. `unstable_cacheLife`/`unstable_cacheTag` are now `cacheLife`/`cacheTag` from `next/cache`.
- **Flags that graduated out of `experimental`:** `turbopack`, `reactCompiler`, `typedRoutes`.
- **`next/image` defaults changed:** `qualities` is `[75]` only, `minimumCacheTTL` is 4 hours, `maximumRedirects` is 3, `imageSizes` dropped `16`; `images.domains` and `next/legacy/image` are deprecated (use `remotePatterns` / `next/image`).
- **Removed:** AMP, `serverRuntimeConfig`/`publicRuntimeConfig` (use env vars), `exportPathMap`, `unstable_rootParams` (use `next/root-params`). Parallel-route slots now require an explicit `default.js`.
- Minimums: Node 20.9+, TypeScript 5.1+.

## Stack notes

- **Tailwind CSS v4, configured CSS-first.** There is no `tailwind.config.js`; theme tokens live in `app/globals.css` (233 lines) under `@theme { … }` — **not `@theme inline`**. The block holds the neutral palette (`--color-page` / `surface` / `ink` / `ink-2` / `ink-3` / `line`), the brand palette (`--color-brand-*`), the order status colours (`--color-status-*`), the order-tab gradient pair (`--color-tab-*`), and the font stacks. **Add design tokens there, not in a JS config.** The PostCSS plugin is `@tailwindcss/postcss`.
- **No `next/font`.** The scaffold's Geist wiring was removed. `--font-sans` is a **Chinese system font stack** (PingFang SC / Microsoft YaHei / …), declared directly in `@theme` precisely to avoid a build-time network dependency — so `next/font/google` should not be reintroduced without a reason.
- Order status colours are referenced **only** through `ORDER_STATUS_CLASS` in `lib/constants/orders.ts`; pages and cards must not hardcode them.
- Import alias `@/*` maps to the repo root — there is no `src/` directory.
- `pnpm-workspace.yaml` pins `allowBuilds` (e.g. `sharp: false`); a native dependency whose build script must run has to be allowed there.

## Note on `AGENTS.md`

`AGENTS.md` holds a Next-managed rules block that `next dev` rewrites when missing (`node_modules/next/dist/server/lib/generate-agent-files.js`), which surfaces as a dirty diff. Leave the block in place rather than deleting it, and don't copy it into this file — this file imports it via `@AGENTS.md`.
