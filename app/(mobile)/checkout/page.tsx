import Link from "next/link";
import NavBar from "@/components/common/NavBar";
import EmptyState from "@/components/common/EmptyState";
import CheckoutForm from "@/components/checkout/CheckoutForm";
import RequireAuth from "@/lib/auth/RequireAuth";
import { getSessionUser } from "@/lib/auth/session";
import { getProductDetail } from "@/lib/services/catalog";
import { getAddons, getCompanions, getGame, previewCheckout } from "@/lib/services/checkout";
import { toSearchParams } from "@/lib/utils/query";
import type { CheckoutPreview } from "@/lib/types/payment";

/**
 * 确认订单页（需登录）。
 *
 * 进入方式：商品详情「立即购买」→（游客先走统一登录流程）→ `/checkout?productId=..&specId=..`。
 *
 * 关于「从 URL 带过来的东西」，这里有一条硬规则：
 * **URL 只允许带 ID，不允许带价格。** `productId` / `specId` 只被当作「查什么」的键，
 * 商品名称、规格、单价、大区全部由服务端按这两个 id 重新读取；即便有人在地址里塞
 * `price=0.01`，也没有任何代码会去读它。刷新页面之所以能恢复所选商品与规格，
 * 也正是因为这两个 id 就在地址里。
 *
 * 不可支付的状态（缺参数 / 商品不存在 / 已下架 / 规格无效）在这里就被拦住，
 * 渲染成明确的说明页，不会把用户带进一个「看起来能付款」的表单。
 *
 * 该路由位于 `(tabs)` 之外，结算过程不显示底部 TabBar。
 * NavBar 放在 `RequireAuth` 外面：未登录时也能返回上一页，不会卡在登录拦截界面上。
 */
export default async function CheckoutPage({ searchParams }: PageProps<"/checkout">) {
  const query = toSearchParams(await searchParams);
  const productId = (query.get("productId") ?? "").trim();
  const specId = (query.get("specId") ?? "").trim();

  return (
    <>
      <NavBar title="确认订单" showBack />

      <RequireAuth>
        <CheckoutBody productId={productId} specId={specId} query={query} />
      </RequireAuth>
    </>
  );
}

/** 已完成登录后才有意义的内容：校验商品与规格，再渲染表单。 */
async function CheckoutBody({
  productId,
  specId,
  query,
}: {
  productId: string;
  specId: string;
  query: URLSearchParams;
}) {
  if (!productId) {
    return (
      <NotPayable
        title="缺少商品信息"
        description="请从商品详情页点击「立即购买」进入结算。"
        backHref="/category"
        backLabel="去逛逛"
      />
    );
  }

  const product = await getProductDetail(productId, undefined, "server");
  if (!product) {
    return (
      <NotPayable
        title="商品不存在"
        description="该商品可能已被删除，请返回重新选择。"
        backHref="/category"
        backLabel="去逛逛"
      />
    );
  }

  if (product.status !== "on") {
    return (
      <NotPayable
        title="商品已下架"
        description="该商品当前不可购买，无法进入支付。"
        backHref={`/product/${product.id}`}
        backLabel="返回商品"
      />
    );
  }

  const spec = product.specs.find((item) => item.id === specId);
  if (!spec) {
    return (
      <NotPayable
        title="商品规格无效"
        description="请返回商品详情重新选择规格后再结算。"
        backHref={`/product/${product.id}`}
        backLabel="返回商品"
      />
    );
  }

  // 会话用户：券有归属，试算与「可选券列表」都要用它。
  // `getSessionUser` 是 `cache()` 过的，`RequireAuth` 刚读过一次，这里不会二次查询
  const user = await getSessionUser();
  // `RequireAuth` 已经保证了登录，这里为 null 属于不可能状态；真要出现，
  // 说明外层守卫被拿掉了——那就按未登录处理，不猜一个用户出来
  if (!user) {
    return (
      <NotPayable
        title="请先登录"
        description="登录后才能进入结算。"
        backHref={`/product/${product.id}`}
        backLabel="返回商品"
      />
    );
  }

  const [game, addons, companions] = await Promise.all([
    getGame(product.gameId),
    getAddons(),
    getCompanions(),
  ]);

  if (!game || game.regions.length === 0) {
    return (
      <NotPayable
        title="暂不可购买"
        description="商品所属游戏的大区信息缺失，请稍后再试。"
        backHref={`/product/${product.id}`}
        backLabel="返回商品"
      />
    );
  }

  // 首屏试算：数量 1、未选增值服务、未选陪玩、游戏 ID 留空（试算阶段不校验它）
  const initialRegion = game.regions[0];
  let initialPreview: CheckoutPreview | null = null;
  let initialPreviewError = "";

  try {
    initialPreview = await previewCheckout(
      {
        productId: product.id,
        specId: spec.id,
        quantity: 1,
        region: initialRegion,
        addonIds: [],
        gameAccountId: "",
        remark: "",
        companionId: null,
        // 首屏还没选券。券列表在下面按「首屏那个金额」算出来，用户选了之后
        // 由表单自己重新试算（判定会跟着新的原价走）
        couponClaimId: null,
      },
      user.id,
      query,
      "http",
    );
  } catch (cause) {
    // 首屏试算失败不整页报错：表单照常渲染，金额显示为未知，由用户点「重试」重算
    initialPreviewError = cause instanceof Error ? cause.message : "金额试算失败，请重试";
  }

  return (
    <div className="flex flex-1 flex-col overflow-x-clip bg-page pb-2">
      <CheckoutForm
        product={{
          id: product.id,
          title: product.title,
          subtitle: product.subtitle,
          coverUrl: product.coverUrl,
        }}
        specs={product.specs}
        initialSpecId={spec.id}
        regions={game.regions}
        initialRegion={initialRegion}
        addons={addons}
        companions={companions}
        initialPreview={initialPreview}
        initialPreviewError={initialPreviewError}
      />
    </div>
  );
}

/** 不可支付状态：说清原因，并给一条明确的退路。 */
function NotPayable({
  title,
  description,
  backHref,
  backLabel,
}: {
  title: string;
  description: string;
  backHref: string;
  backLabel: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 bg-surface px-4 py-16">
      <EmptyState title={title} description={description} />
      <Link
        href={backHref}
        className="rounded-full border border-line px-6 py-2 text-[14px] text-ink-2"
      >
        {backLabel}
      </Link>
    </div>
  );
}
