import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, readJsonBody, requireUser, toApiError } from "@/lib/api/route";
import { parseSelectionInput, previewCheckout } from "@/lib/services/checkout";

/**
 * 金额试算接口。
 *
 * POST 而不是 GET：输入是结构化的业务选择（数量、大区、多个增值服务、陪玩），
 * 塞进查询串既难读也容易被当成可缓存的 URL。
 *
 * 输入只有「用户选了什么」——`parseSelectionInput` 按白名单取字段，
 * 客户端就算额外塞 price / totalAmount 也不会被读取，金额一律现算。
 */
export async function POST(request: Request) {
  try {
    // 未登录直接拒绝：试算也要知道是谁，才对得上后续的支付请求
    await requireUser();
    const body = await readJsonBody(request);
    const selection = parseSelectionInput(body);

    if (!selection.productId) throw new ApiError("BAD_REQUEST", "缺少商品信息");

    const { searchParams } = new URL(request.url);
    return ok(await previewCheckout(selection, searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
