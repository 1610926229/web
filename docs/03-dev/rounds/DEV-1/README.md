Round ID: DEV-1
Title: Mock 身份切换验收工具
Status: DONE
Depends On: P0-6（本工具的第一个使用者；DEV-1 不改 P0-6 的行为，两者的验收各自独立记录）
Goal: 在 `ENABLE_MOCK_AUTH=true` 的开发 / Mock 环境里，让同一个人在**同一个窗口**内把当前用户会话从 A 换成 B，从而支持 P0-6 的多角色人工验收（下单用户 → 打手 A 接单 → 取消 → 打手 B 抢单 → 回到下单用户），不必再开无痕窗口。
Primary Domain: 开发 / 测试基础设施（用户端展示层 + Mock 认证复用）
Primary State Transition: 无（不涉及任何业务状态机）
Started At: 2026-09-24
Development Completed At: 2026-09-24
Accepted At: 2026-09-24
Git Commit: 53481ea

> ✅ **`DEV-1 DONE — implementation committed in 53481ea`**
>
> 「DONE 的双重门槛」（`development-workflow.md` §十七）**两个条件均已满足**：
> 1. **用户明确说明人工验收通过**（2026-09-24，`User Result` / `Final Result` = `PASSED`）：
>    开关关闭时面板**不存在**、名单与资格标签不进响应、认证接口与 Cookie 数量一个没多；
>    同一窗口跑完 `老板A u-1001 下单 → 夜航 u-1022 接单 → 取消 → 栖迟 u-1023 抢单 →
>    切回老板A 看通知`，**全程未进管理端、未通过任何申请**；
> 2. **用户本人完成 Git 提交**：`53481ea`，只读核对 `git show --name-only 53481ea`
>    确认同时包含本工具实现（`lib/auth/MockIdentitySwitcher|Panel|UserPicker`、
>    `app/(mobile)/layout.tsx` 挂载、`u-1022`/`u-1023` 预置打手）与测试
>    （`tests/devIdentity.test.mjs`、`tests/mockUsers.test.mjs`）。
>
> 提交由**用户本人**执行；Claude 未执行任何 Git 写操作。
>
> ⚠️ **验收期间另发现两个问题**（FIX-1 / FIX-2）属 **P0-6 域**，不是本工具的缺陷，
> 已记在 [`../P0-6/04-acceptance.md`](../P0-6/04-acceptance.md) 并登记为独立 `NEEDS_FIX` 待办。
> 二者**不推翻本轮 `DONE` 结论**。

## 一句话

用户端全局布局上挂了一个 `ENABLE_MOCK_AUTH` 控制的悬浮面板：点一个账号即以该账号登录
（复用既有 `/api/auth/mock-login`），点退出即恢复游客（复用既有 `/api/auth/logout`）。
**没有**第二套 Cookie、第二套会话、第二个登录接口、第二份用户名单。

而且**一启动就能跑通验收链路**：预置数据里直接有 1 个普通下单用户（`u-1001`）与
2 位真实有效打手（`u-1022` / `u-1023`，名下各有护航资料），面板上带服务端派生的
资格标签（普通用户 / 有效打手），因此「User 下单 → A 接单 → A 取消 → B 抢单 → 回到 User」
中间**不需要去后台通过任何申请**。

## 范围与边界

| 做了什么 | 没做什么 |
|---|---|
| 用户端全局浮层面板（当前身份 + 复用既有选择器 + 退出） | 微信 OAuth / 手机号 / 用户名密码 / 注册 |
| 复用 `MockUserPicker`、`authAdapter`、`MOCK_LOGIN_USERS` | 第二套 mock auth / session / user fixture |
| 开关在**服务端**判定，关闭时整块不渲染 | 多账号并行 Session、Companion 独立 Session |
| 注释与文档同步（此前写着「用户端无切换入口」的地方） | 管理端 / 客服端身份切换器 |
| **预置两位真实有效打手**（`cp-10`/`u-1022`、`cp-11`/`u-1023` + `ca-1008`/`ca-1009`），让 §G 链路**无需先审核** | P0-6 的任何业务行为、任何后续 P0 |
| **资格标签由服务端现算**（`resolveCompanionAccess`），只作显示、不作权限 | 绕过 `requireCompanion()` / 特殊 Companion Guard / 生产身份模型改动 |
| 新增 22 条测试（其中 4 条 HTTP） | — |

> **重做批说明**：首轮交付被人工作为「需求未达成」驳回（理由与全文见 `02-decisions.md` D6
> V1→V2）。首轮把 §八 的「至少两个具备有效 Companion 资格的 User」读成了「名单里要有候选身份」，
> 用**申请状态**贴字面要求——工具能切 User，却完不成它存在的理由。重做批改为在既有 fixture
> 体系里**真的造出**两位有效打手，且不破坏任何既有申请场景。

## 文档

| 文件 | 内容 |
|---|---|
| `01-prompt.md` | 用户原始指令（`cmd_dev-1.md` 原样归档） |
| `02-decisions.md` | 执行期判定 8 条，含一处**规则替换**的完整历史（D1） |
| `03-delivery.md` | 交付物、验证方式、门禁结果 |
| `04-acceptance.md` | 人工验收清单 |
