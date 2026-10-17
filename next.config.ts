import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * PROD-2 / Step 5.8.1：私有 Staging 部署只接收**运行产物**。
   *
   * 构建在 GitHub Actions 的 Linux 环境完成，服务器上不装 pnpm、不跑 `next build`。
   * `standalone` 会把运行所需的最小文件集（含被追踪到的 node_modules）输出到
   * `.next/standalone`，产物自带 `server.js`，不需要在服务器上再装依赖。
   *
   * ⚠️ standalone **不会**自动包含 `public/` 与 `.next/static/`。
   *    这两份必须由 `deploy/app/build-standalone.sh` 显式拷贝——
   *    漏掉任何一个，页面会返回 200 但静态资源全 404，而且日志里看不出原因。
   *
   * 该选项只影响 `next build` 的产物布局，对 `next dev` 与现有测试无影响。
   */
  output: "standalone",
};

export default nextConfig;
