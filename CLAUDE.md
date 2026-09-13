# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Project state

Greenfield. `app/` is still the untouched `create-next-app` scaffold — one route, `/`. The product spec lives in `docs/prototype/` as 17 phone-screen prototypes (1260×2750 JPEGs, Chinese UI copy), captured in the WeChat in-app browser. They are the source of truth for the UI and **none of them is implemented yet**. Read the relevant prototype before building a screen; there is no existing code to match against.

The product ("有目电竞") is a mobile-first H5 storefront for esports companion/boosting services (陪玩 / 护航 / 打手), opened inside WeChat. The prototypes establish a five-tab bottom nav — 首页 / 分类 / 订单 / 客服 / 我的 — and flows for product packages (机密单), orders, payment, coupons, spending leaderboard, tips (鸡腿记录), complaints, spending tiers, and agreements. Design mobile-first; do not build desktop-first layouts and shrink them.

## Commands

pnpm is the package manager (`pnpm-lock.yaml`, `packageManager: pnpm@12.3.4`).

```bash
pnpm dev      # dev server on :3000 (Turbopack; output in .next/dev)
pnpm build    # production build
pnpm start    # serve the production build
pnpm lint     # ESLint CLI (flat config: eslint.config.mjs)
next typegen  # regenerate route types only, without a full build
```

There is no test runner — no `test` script and no test framework installed. (Next ships an experimental `next experimental-test` defaulting to Playwright; it is not configured here.)

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

- **Tailwind CSS v4, configured CSS-first.** There is no `tailwind.config.js`; theme tokens live in `app/globals.css` under `@theme inline` (currently `--color-background`, `--color-foreground`, `--font-sans`, `--font-mono`). Add design tokens there, not in a JS config. The PostCSS plugin is `@tailwindcss/postcss`.
- Fonts are wired through `next/font` in `app/layout.tsx` (Geist / Geist Mono) as CSS variables that the `@theme` block consumes.
- Import alias `@/*` maps to the repo root — there is no `src/` directory.
- `pnpm-workspace.yaml` pins `allowBuilds` (e.g. `sharp: false`); a native dependency whose build script must run has to be allowed there.

## Note on `AGENTS.md`

`AGENTS.md` holds a Next-managed rules block that `next dev` rewrites when missing (`node_modules/next/dist/server/lib/generate-agent-files.js`), which surfaces as a dirty diff. Leave the block in place rather than deleting it, and don't copy it into this file — this file imports it via `@AGENTS.md`.
