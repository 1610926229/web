import AdminPlatformConfigConsole from "@/components/admin/AdminPlatformConfigConsole";
import { getAdminPlatformConfig } from "@/lib/services/adminPlatformConfig";

/**
 * 平台参数（`/admin/platform-config`）。
 *
 * 阅读顺序是**服务端渲染首屏 → 客户端接管**：这一页在服务端取一次当前配置交给
 * `AdminPlatformConfigConsole`，之后编辑、保存与错误处理都在浏览器里完成。
 * 因此直接打开这一页看到的是当前取值，而不是一片骨架屏。
 *
 * ⚠️ 这一页**不收 props**：平台参数是全局单例，既没有路径参数，也没有
 * 「筛选出一部分参数」这件事——手改地址栏上的查询串不会改变这一页显示的内容，
 * 因为这一页根本不读它。写一个用不上的 `searchParams` 只会让人以为它有用。
 *
 * ⚠️ 首屏读的是**服务层**而不是仓储或 Mock 存储：页面不该知道数据存在哪里。
 * 服务层那一层同时服务接口，因此页面显示的值与接口返回的值永远是同一个来源。
 */
export default async function AdminPlatformConfigPage() {
  const config = await getAdminPlatformConfig();

  return <AdminPlatformConfigConsole initialConfig={config} />;
}
