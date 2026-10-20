/**
 * 凭据字段的长度限制（服务端与浏览器共用）。
 *
 * ⚠️ 单独放一份是为了让**客户端表单**不必 import `lib/auth/password.ts`：
 * 那个文件依赖 `node:crypto`，一旦被客户端组件引用就会打进浏览器产物。
 * 服务端的校验函数从这里取同一组数字，因此「表单允许的长度」与「服务端接受的
 * 长度」不会分叉。
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const EMAIL_MAX_LENGTH = 254;
