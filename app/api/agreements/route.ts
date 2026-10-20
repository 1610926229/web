import { fail, ok, toApiError } from "@/lib/api/route";
import { listAgreements } from "@/lib/services/agreements";

/**
 * 协议与版本介绍（五类内容一次返回）。
 *
 * 权限：**游客可访问**。协议是公开内容，登录与否看到的是同一份数据，
 * 因此这里既不要求登录，也不读会话——没有用户身份，也就没有可以泄漏的用户数据。
 *
 * 响应里**只有正文本身**：类型、标题、版本、更新时间与结构化段落。
 * 不返回 `enabled` 这类配置字段，也不返回任何停用版本——页面无法通过参数
 * 指定要看哪一版，历史版本将来只在管理后台可见。
 *
 * ⚠️ 本文件**只有 GET**，且正文以结构化段落（`sections`）下发而不是 HTML：
 * 页面按段落渲染，不使用富文本编辑器，也不使用 `dangerouslySetInnerHTML`，
 * 因此 Mock 文案里不可能夹带可执行内容。
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    return ok(await listAgreements(searchParams, "http"));
  } catch (cause) {
    return fail(toApiError(cause));
  }
}
