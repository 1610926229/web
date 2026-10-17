Round: DEV-1
Received At: 2026-09-24
Source: User

---

\# DEV-1｜Mock 身份切换验收工具



\## 零、背景



当前 P0-6 已开发完成，状态：



```text

AWAITING\_ACCEPTANCE

```



但人工验收需要频繁切换：



\* 普通下单用户；

\* 打手 A；

\* 打手 B；



目前只能依赖普通窗口 / 无痕窗口切换 Session，验收成本过高。



本轮不是开发正式账号系统，也不是开发微信 OAuth。



目标只是补一个 \*\*开发/Mock 环境专用的身份切换工具\*\*，方便后续人工验收。



\---



\# 一、本轮定位



Round：



```text

DEV-1

```



名称：



```text

Mock 身份切换验收工具

```



这是：



```text

开发 / 测试基础设施

```



不是 P0 业务功能。



不得改变：



```text

P0-6 = AWAITING\_ACCEPTANCE

```



DEV-1 完成后，用户会使用该工具补验 P0-6。



\---



\# 二、执行前先检查现状



完整阅读：



\* `CLAUDE.md`

\* `AGENTS.md`

\* `docs/03-dev/development-workflow.md`

\* `docs/03-dev/总需求进度表.md`

\* `docs/02-tech-design/architecture-rules.md`

\* `docs/02-tech-design/directory-structure.md`

\* 当前 Mock Auth 相关代码



重点搜索并确认是否已经存在：



```text

MockUserPicker

/api/auth/mock-login

/api/auth/logout

ENABLE\_MOCK\_AUTH

getSessionUser / User Session

```



技术设计已经记录项目存在 `MockUserPicker`。



\*\*优先复用已有能力。\*\*



如果现有 `MockUserPicker` 已经具备大部分功能，应扩展/接入，不允许重新造第二套 Mock 身份系统。



\---



\# 三、核心目标



在：



```text

ENABLE\_MOCK\_AUTH=true

```



的开发 / Mock 环境中提供一个方便的身份切换入口。



至少允许人工快速切换：



```text

普通用户 U

打手 A

打手 B

```



实际用户来源应复用现有 Mock User fixtures。



不要为了固定三个角色在组件里复制一套用户数据库。



\---



\# 四、正确认证模型



生产身份模型仍然是：



```text

一个浏览器

→ 一个 User Session

```



DEV-1 只是允许人工快速把当前 Session 从：



```text

User A

```



切换成：



```text

User B

```



不是同时维护多个 Session。



禁止：



\* 第二套 User Cookie；

\* 多账号并行 Session；

\* Companion 独立 Session；

\* Companion 独立登录；

\* 用户名密码系统；

\* 手机号密码系统；

\* 微信 OAuth；

\* 新 Auth Repository；

\* 新 Session 模型。



\---



\# 五、必须复用现有 Mock 登录接口



身份切换必须调用现有：



```text

POST /api/auth/mock-login

```



例如：



```json

{

&#x20; "userId": "u-1002"

}

```



退出复用：



```text

POST /api/auth/logout

```



浏览器 HTTP 请求继续通过项目已有 HTTP client / service 约定。



组件不得直接绕开架构随意 fetch。



如果现有 MockUserPicker 已有正确调用链，直接复用。



\---



\# 六、UI



做一个明显属于“开发工具”的小入口。



可以放在用户端全局布局中，例如：



```text

右下角悬浮按钮

```



展开后类似：



```text

Mock Identity



当前：

用户 U / u-1001



可切换：

\[用户 U]

\[打手 A]

\[打手 B]



\[退出登录]

```



不要求照抄这个视觉。



要求：



\* 手机页面不能被严重遮挡；

\* 明确标识这是 Mock / DEV 工具；

\* 能看出当前身份；

\* 点击目标用户即可切换；

\* 当前身份应有视觉区分；

\* 切换成功后页面重新加载或刷新 Session；

\* 不要求漂亮，优先清楚、稳定。



\---



\# 七、环境隔离



这是本轮最重要的安全约束。



当：



```text

ENABLE\_MOCK\_AUTH !== true

```



时：



\*\*身份切换 UI 必须完全不可使用。\*\*



优先：



```text

不渲染

```



而不仅仅是按钮 disabled。



现有 `/api/auth/mock-login` 自身已有关闭时 404 的保护，不得削弱。



因此需要同时满足：



```text

UI 层隐藏

\+

API 层已有保护保持不变

```



不要把 Mock 用户 ID 暴露到正式生产 UI。



\---



\# 八、用户列表



用户选择项应来自现有测试 / fixture 数据或现有安全的 Mock 用户配置。



要求至少覆盖：



1\. 一个普通 User；

2\. 至少两个具备有效 Companion 资格的 User。



如果当前 seed 已有：



```text

u-1001

u-1002

...

```



先检查各自真实资格，不要凭名字猜测。



UI 最好显示：



```text

nickname

displayId / userId

身份提示

```



例如：



```text

小明

u-1001

普通用户



护航A

u-1002

Companion

```



身份标签仅用于开发人员辨认。



不得因此创建新的正式角色模型。



\---



\# 九、切换行为



点击用户：



```text

POST mock-login

→ 成功

→ 刷新当前页面

```



刷新后：



\* Navbar / Mine / Companion 权限等重新按新 Session 计算；

\* 不残留旧用户客户端状态；

\* 当前 Mock Identity 显示新身份。



如果当前页面对新用户不可访问：



允许刷新后由现有权限体系正常处理。



不要为测试工具绕过页面权限。



\---



\# 十、退出行为



支持：



```text

Logout

```



调用现有退出接口。



退出后恢复游客状态。



不得自己删 Cookie。



\---



\# 十一、P0-6 验收辅助要求



DEV-1 完成后，应能支持如下人工流程，不需要开多个浏览器：



```text

切 User U

→ 创建/查看订单



切 Companion A

→ 接单

→ 取消接单



切 Companion B

→ 公共池找到该订单

→ 重新接单



切 User U

→ 查看订单与通知

```



注意：



DEV-1 \*\*只提供身份切换工具\*\*。



不要顺手修改 P0-6 业务行为。



如果在测试 DEV-1 时发现 P0-6 Bug：



记录，但不要擅自扩大 DEV-1 修复业务范围，除非属于 DEV-1 引入的回归。



\---



\# 十二、推荐实现原则



优先顺序：



```text

1\. 复用现有 MockUserPicker

2\. 扩展现有 Mock Auth HTTP service

3\. 复用现有 User fixtures

4\. 接入一个合适的现有 layout

```



不要新建：



```text

第二套 mock auth

第二套 session

第二套 user fixture

```



如果现有 MockUserPicker 已经完整满足需求，只需要把它正确接入可访问位置，则本轮可以非常小。



\---



\# 十三、测试



至少覆盖：



1\. `ENABLE\_MOCK\_AUTH=true` 时工具可用；

2\. Mock Auth 关闭时工具不应出现在正式 UI；

3\. 用户切换调用既有 mock-login；

4\. userId 来自允许的 Mock 用户；

5\. 切换后 Session 变成目标用户；

6\. logout 后 Session 清除；

7\. 普通 User 切换到 Companion User 后可以通过现有 Companion Guard；

8\. Companion User 切回普通 User 后不能继续使用 Companion 权限；

9\. 不新增 Companion Cookie / Session；

10\. 现有 auth 测试不回归。



如果 JSX 不适合当前 Node 自动测试体系，可以：



\* 自动测试 service / auth / source-level contract；

\* UI 行为进入人工验收。



不要为 DEV-1 新建测试框架。



\---



\# 十四、人工验收目标



交付后用户至少能够验证：



\### A



页面能看到：



```text

Mock Identity

```



并知道当前是谁。



\### B



```text

普通用户

→ 打手 A

→ 打手 B

→ 普通用户

```



可以连续切换。



\### C



切到不同身份后：



```text

/mine

/companion

/companion/orders

```



按照真实权限变化。



\### D



退出后恢复游客。



\### E



Mock Auth 关闭时：



```text

身份切换工具不存在

```



\---



\# 十五、明确不做



本轮不得实现：



\* 微信 OAuth；

\* 手机号登录；

\* 用户名密码；

\* 注册系统；

\* 多设备登录；

\* 多 Session 并行；

\* 账号绑定；

\* Token Refresh；

\* Companion Login；

\* Admin / Staff 身份切换器；

\* P0-6 新业务功能；

\* accepted → serving；

\* CompletionSubmission；

\* 任何后续 P0；

\* 与 Mock 身份切换无关的大规模 UI / Auth 重构。



\---



\# 十六、Round Protocol



创建：



```text

docs/03-dev/rounds/DEV-1/

```



包含：



```text

README.md

01-prompt.md

02-decisions.md

03-delivery.md

04-acceptance.md

```



将：



```text

docs/03-dev/rounds/cmd\_dev-1.md

```



原样归档到：



```text

DEV-1/01-prompt.md

```



状态：



```text

PLANNED

→ READY

→ IN\_PROGRESS

→ AWAITING\_ACCEPTANCE

```



DEV-1 完成编码后不得自行标 DONE。



同时：



\*\*不要修改 P0-6 的验收结果。\*\*



P0-6 继续：



```text

AWAITING\_ACCEPTANCE

```



\---



\# 十七、自动门禁



完成后执行：



```text

pnpm test

pnpm typecheck

pnpm lint

pnpm build

```



如本轮影响 HTTP 行为，再执行 production server +：



```text

APP\_BASE\_URL=http://localhost:<port> pnpm test

```



要求：



```text

fail = 0

skipped = 0

```



\---



\# 十八、Git 纪律



禁止：



```text

git add

git commit

git push

git reset

git restore

git checkout

git rebase

git amend

```



允许只读 Git 命令。



所有 Git 写操作由用户本人完成。



\---



\# 十九、交付报告



最终报告：



1\. DEV-1 状态；

2\. 是否复用了现有 MockUserPicker；

3\. UI 最终放在哪里；

4\. 可切换哪些用户；

5\. 如何识别普通 User / Companion；

6\. mock-login / logout 调用链；

7\. Mock Auth 关闭时如何保证工具消失；

8\. 是否新增 Auth / Cookie / Session —— 正确答案应为没有；

9\. 测试结果；

10\. typecheck / lint / build；

11\. HTTP 全量结果（如执行）；

12\. 人工验收步骤；

13\. git status --short；

14\. 明确未执行 Git 写操作；

15\. 明确 P0-6 仍保持 AWAITING\_ACCEPTANCE。



完成后停止。



不得开始 P0-7。



