import PlaceholderPage from "@/components/common/PlaceholderPage";
import { PLACEHOLDER_NOTICE } from "@/lib/constants/site";

/**
 * 寻找陪玩（陪玩列表）。
 *
 * ⚠️ 正式路由是**复数** `/companions`。这里只是占位：陪玩列表、筛选与陪玩详情属于后续阶段，
 * 本阶段不提前实现，也不自行编造陪玩的等级、价格与筛选条件。
 *
 * 免登录可访问：陪玩列表是浏览型内容，与商品列表同类，**不放进受保护路由**
 * （它位于 `(tabs)` 之外，因此显示返回导航、不显示底部 TabBar）。
 */
export default function CompanionsPage() {
  return (
    <PlaceholderPage
      title="寻找陪玩"
      description={`功能开发中：陪玩列表、筛选与陪玩详情待后续阶段实现，本阶段仅保留入口，不提前实现正式列表。${PLACEHOLDER_NOTICE}。`}
    />
  );
}
