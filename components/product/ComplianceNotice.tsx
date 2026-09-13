/**
 * 商品详情页顶部的合规提示条。
 *
 * 文案为固定的平台合规声明，不来自接口，也不随商品变化——它约束的是整页展示，
 * 因此由服务端直接渲染。
 */
export default function ComplianceNotice() {
  return (
    <p className="bg-[#fdf6e3] px-3 py-2 text-[12px] leading-[18px] text-[#8a6d1f]">
      温馨提示：平台所有商品不涉及游戏代练、游戏装备及其他虚拟商品交易
    </p>
  );
}
