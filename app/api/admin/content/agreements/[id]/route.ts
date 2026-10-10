import { requireAdmin } from "@/lib/api/adminRoute";
import { ApiError } from "@/lib/api/ApiError";
import { fail, ok, readJsonBody, toApiError } from "@/lib/api/route";
import { ADMIN_AGREEMENT_NOT_FOUND_MESSAGE } from "@/lib/constants/adminAgreements";
import { getAdminAgreementDetail, updateAdminAgreement } from "@/lib/services/adminAgreements";

/**
 * 管理端协议详情与编辑：`GET` / `PATCH /api/admin/content/agreements/[id]`。
 *
 * ⚠️ 两个方法的第一件事都是 `requireAdmin()`。
 *
 * GET 返回**列表行 + 正文**（`AdminAgreementDetail`）。编辑表单必须走它：
 * 列表行刻意不带 `sections`，拿列表去拼编辑表单只会拼出一个空正文，
 * 一保存就把用户的协议清空了。
 *
 * PATCH 改的是**标题 + 正文段落 + 启用状态**，没有别的：
 * - `id` / `type` 是记录的身份，类型是固定枚举，改类型等于换了一份协议；
 * - `version` 与 `updatedAt` 由服务端在写入时算出来——客户端传什么都没用；
 * - 协议没有 `removedAt` 这类字段，因此一次保存无法把协议「移除」，
 *   也不存在被移除之后不能再编辑的状态（要下架请用停用，那是可逆的）。
 *
 * ⚠️ 正文只接受**纯文本**：段落里出现 `<` 或 `>` 一律 400，message 说明请填写纯文本。
 * 本阶段没有 sanitizer，因此不是「接受 HTML 之后清洗」，而是根本不接受 HTML——
 * 用户端按段落纯文本渲染，放行就等于把不受控内容送进用户端。
 *
 * 版本号规则：标题或正文真的变了才递增；提交的内容与现状完全一致时
 * 返回 `changed: false`，**不写数据、不写审计、不动版本号、不动更新时间**。
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/admin/content/agreements/[id]">,
) {
  try {
    await requireAdmin();
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    const detail = await getAdminAgreementDetail(id, searchParams, "http");
    if (!detail) throw new ApiError("NOT_FOUND", ADMIN_AGREEMENT_NOT_FOUND_MESSAGE, 404);

    return ok(detail);
  } catch (cause) {
    return fail(toApiError(cause));
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/admin/content/agreements/[id]">,
) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await readJsonBody(request);

    return ok(await updateAdminAgreement(admin.id, id, body));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
