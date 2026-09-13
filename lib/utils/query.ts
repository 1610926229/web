/**
 * 查询参数工具。
 *
 * Server Component 拿到的是 `searchParams` 普通对象（且可能是数组、可能缺省），
 * 而 service 与 Mock 调试层统一按 `URLSearchParams` 处理，这里做一次归一。
 */
export type PageSearchParams = Record<string, string | string[] | undefined>;

export function toSearchParams(input: PageSearchParams | undefined): URLSearchParams {
  const params = new URLSearchParams();
  if (!input) return params;

  for (const [key, value] of Object.entries(input)) {
    // 同名参数出现多次时只取第一个，Mock 调试参数没有多值语义
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value) && value.length > 0) params.set(key, value[0]);
  }

  return params;
}
