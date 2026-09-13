/**
 * 写接口的公共规则（幂等键）。
 *
 * ⚠️ 本文件没有任何运行时依赖，客户端与服务端都能引用，node 也能直接加载它做测试。
 *
 * 为什么需要幂等键：退款申请、投诉、发消息都是「点一下就该产生一条记录」的写操作。
 * 按钮禁用只能挡住手快，挡不住网络重试与用户刷新页面后重发。真正的防重必须由服务端
 * 用一个**客户端生成、同一业务意图下保持不变**的键来完成：同一个键第二次到达时，
 * 服务端返回第一次的结果，而不是再写一条。
 */

/** 幂等键格式：客户端用 `crypto.randomUUID()` 生成，这里只做基本约束。 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export const IDEMPOTENCY_KEY_MISSING_MESSAGE = "缺少或非法的幂等键";

/** 从请求体里取幂等键；非法或缺省返回 null（由调用方决定抛什么错）。 */
export function readIdempotencyKey(body: Record<string, unknown>): string | null {
  const raw = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  return IDEMPOTENCY_KEY_PATTERN.test(raw) ? raw : null;
}

/** 从请求体里取字符串字段并去掉首尾空格；非字符串一律当成空串。 */
export function readTrimmedString(body: Record<string, unknown>, key: string): string {
  const raw = body[key];
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * 从请求体里取布尔字段。
 *
 * 只认真正的布尔值与字符串 `"true"` / `"false"`——**不认 `1` / `0` / `"on"`**：
 * 这些写法谁也说不准调用方想表达什么，猜错的代价是「停用」变成「启用」。
 * 其余一律用 `fallback`，把「没传」与「传了个看不懂的值」都交给调用方的校验去处理。
 */
export function readBoolean(
  body: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const raw = body[key];
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

/** 从请求体里取整数；非整数（含小数、字符串数字）一律用 `fallback`。 */
export function readInteger(
  body: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const raw = body[key];
  return typeof raw === "number" && Number.isInteger(raw) ? raw : fallback;
}

/**
 * 从请求体里取字符串数组：非数组返回空数组，数组里的非字符串项被丢掉。
 *
 * 丢掉而不是报错，是因为调用方本来就要逐项校验取值（游戏、大区、标签都必须在目录里），
 * 一个混进来的数字会在那里变成「所选游戏不是有效游戏」，这比在这里先说一句
 * 「数组里有非字符串」更贴近调用方真正要判断的事。
 */
export function readStringArray(body: Record<string, unknown>, key: string): string[] {
  const raw = body[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}
