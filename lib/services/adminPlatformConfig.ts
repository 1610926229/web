import { ApiError } from "@/lib/api/ApiError";
import {
  PLATFORM_CONFIG_INVALID_TIMEOUT_MESSAGE,
  PLATFORM_CONFIG_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  PLATFORM_CONFIG_OPERATION_CONFLICT_MESSAGE,
  isValidPublicPoolTimeoutMinutes,
} from "@/lib/constants/platformConfig";
import { readIdempotencyKey } from "@/lib/constants/writes";
import {
  updatePlatformConfig,
  type AdminPlatformConfigWriteOutcome,
  type AdminWriteContext,
} from "@/lib/data/adminPlatformConfigTransaction";
import { getPlatformConfigRepository } from "@/lib/data/platformConfigRepository";
import type { AdminPlatformConfigWriteResult, PlatformConfig } from "@/lib/types/platformConfig";

/**
 * 管理端「平台参数」服务 —— 读写这一份配置的唯一入口。
 *
 * ⚠️ 本文件**只服务管理端**，调用它的每一个接口都先经过 `requireAdmin()`。
 * 服务本身不再做一次角色判断：权限判断只有一处
 * （`lib/api/adminRoute.ts`，理由见那里的注释）。
 *
 * 这一层负责三件事，多一件都不做：
 * 1. 解析与校验入参（**白名单**：客户端能改的字段只有 `publicPoolTimeoutMinutes`）；
 * 2. 把伪事务的失败翻译成明确的接口错误；
 * 3. 决定 DTO —— 本模块的 DTO 就是配置记录本身（它没有需要裁剪的字段）。
 *
 * 业务规则不在这里：取值上下限在 `lib/constants/platformConfig.ts`；
 * 「重放不生效」「值没变不算改动」在 `lib/data/adminPlatformConfigTransaction.ts`
 * 的原子区段里——它们必须与写入同一区间。
 */

/**
 * 当前平台参数（管理端读取）。
 *
 * ⚠️ 读的是**仓储**而不是直接 import Mock 存储：将来换成真实数据库时，
 * 这一行不用改。
 */
export async function getAdminPlatformConfig(): Promise<PlatformConfig> {
  return getPlatformConfigRepository().getConfig();
}

/**
 * 幂等键。**只从请求体来**，且必须符合 `IDEMPOTENCY_KEY_PATTERN`
 * （`readIdempotencyKey()` 已经做了格式判断，非法与缺省都返回 null）。
 */
function requireIdempotencyKey(body: Record<string, unknown>): string {
  const key = readIdempotencyKey(body);
  if (!key) {
    throw new ApiError("BAD_REQUEST", PLATFORM_CONFIG_MISSING_IDEMPOTENCY_KEY_MESSAGE, 400);
  }
  return key;
}

/**
 * 写上下文。
 *
 * ⚠️ 操作者的三个字段**只从这个函数的入参来**：`adminId` 是 `requireAdmin()`
 * 返回的会话里的 `admin.id`，身份类型恒为 `admin`，名称快照为 null
 * （管理端一律为 null，理由见 `lib/types/adminAudit.ts` 的 `actorName`）。
 * **请求体里的任何 actor 字段都读不到这里**——本函数不接收请求体。
 *
 * 与另外几个管理端服务（类目 / 商品 / 运营内容 / 协议）用的是**同一套写法**：
 * 九个模块的审计记录形状必须一致，否则审计表里会出现「有的行有操作者名字、
 * 有的没有」，而那种差异看起来像一条线索、实际上只是写法不统一。
 */
function writeContext(adminId: string, operationId: string): AdminWriteContext {
  return {
    actorId: adminId,
    actorRole: "admin",
    actorName: null,
    operationId,
    // 业务写入与审计写入共用这一个时间戳（理由见 `AdminWriteContext` 的注释）
    at: new Date().toISOString(),
  };
}

/**
 * 从请求体里读公共池超时时长。
 *
 * ⚠️ **不做隐式转换**：`"60"` 会被拒绝，不会被当成 `60`。
 * 数字输入框送上来的是字符串这件事由**表单自己**转换（`Number(value)`）——
 * 那是「用户在界面上填了什么」的知识，属于调用方；服务端只回答
 * 「这个值是不是一个合法的分钟数」。校验函数一旦开始猜，`"60abc"` 该不该通过
 * 就说不清了（`Number("60abc")` 是 `NaN`，而 `parseInt("60abc")` 是 `60`）。
 *
 * ⚠️ **非法值一律拒绝，绝不回退到默认值**：静默取默认会让一次写错参数的保存
 * 看起来成功了，而实际生效的是另一个数字——管理员随后看到的页面会显示
 * 默认值，但他以为那是他刚填的。
 */
function readTimeoutMinutes(body: Record<string, unknown>): number {
  const raw = body.publicPoolTimeoutMinutes;
  if (!isValidPublicPoolTimeoutMinutes(raw)) {
    throw new ApiError("BAD_REQUEST", PLATFORM_CONFIG_INVALID_TIMEOUT_MESSAGE, 400);
  }
  return raw;
}

/**
 * 伪事务的失败 → 接口错误。
 *
 * 本模块的成功与失败都很窄：参数是单例，因此没有「找不到」；参数没有上下架，
 * 因此没有「已移除」。唯一的失败是幂等键被另一个操作者用掉，
 * 它对应一个明确的 400——调用方换一个键重试即可。
 */
function toApiFailure(failure: Exclude<AdminPlatformConfigWriteOutcome, { kind: "ok" }>): ApiError {
  void failure;
  return new ApiError("BAD_REQUEST", PLATFORM_CONFIG_OPERATION_CONFLICT_MESSAGE, 400);
}

/** 伪事务结果 → 接口结果。成功只回配置本身与「这次有没有真的改动」。 */
function toWriteResult(outcome: AdminPlatformConfigWriteOutcome): AdminPlatformConfigWriteResult {
  if (outcome.kind !== "ok") throw toApiFailure(outcome);

  return { config: outcome.value.updated, changed: outcome.changed };
}

/**
 * 修改平台参数。
 *
 * 校验顺序是刻意的：**先要幂等键、再校验取值**。反过来的话，一个取值非法但没带键的
 * 请求会先被告知「取值非法」，调用方改完取值重试，才发现还缺一个键——
 * 两次往返里的第一次是白跑的。
 */
export async function updateAdminPlatformConfig(
  adminId: string,
  body: Record<string, unknown>,
): Promise<AdminPlatformConfigWriteResult> {
  const operationId = requireIdempotencyKey(body);
  const publicPoolTimeoutMinutes = readTimeoutMinutes(body);

  return toWriteResult(
    await updatePlatformConfig({ publicPoolTimeoutMinutes }, writeContext(adminId, operationId)),
  );
}

/**
 * ⚠️ 本模块**不导出**上下限这类常量的副本给页面用。
 *
 * 页面（客户端组件）要显示「1~1440 分钟」时从 `lib/constants/platformConfig.ts` 取——
 * 那个文件没有任何依赖，浏览器可以安全引用。若在这里转一道手，
 * 页面就会通过它把 `lib/data` 与 Mock 存储一起打进浏览器产物
 * （理由同 `lib/services/adminHttp.ts` 顶部的注释），
 * 而「同一个数字有两个导出点」本身也是将来会分叉的地方。
 */
