# DEV-2 · 取证与决定

> 逐条回答 `01-prompt.md`「## 要求」里的五项。**先取证，再修改**——本文件的第一手数据
> 全部来自本轮实测，命令与原始输出都可复现。
> 逐条交付结果见 `03-delivery.md`，人工验收见 `04-acceptance.md`。

---

## 一、共享写入点

**只有一处：`next start` 起的那个服务进程里的 `globalThis`。**

| 事实 | 证据 |
|---|---|
| 测试套件 **82** 个文件、1794 条用例 | `ls tests/*.test.mjs \| wc -l` → 82；用例数取 `pnpm test` 汇总行 |
| 其中 **24 个用例文件真的会打服务端** | `grep -l "process\.env\.APP_BASE_URL" tests/*.test.mjs` → 24 个 |
| 另有 2 个用例文件只是在**注释**里提到 `APP_BASE_URL` | `adminContentImages` / `adminContentQuickEntries`，没有 HTTP 用例 |
| 另有 1 个**工具**文件读同一个变量 | `tests/httpReset.mjs`——它是被上面 24 个文件 import 的实现，不是用例文件（`tests/*.mjs` 会连它一起数出来，共 25 个） |
| 全部 Mock 存储挂在进程的 `globalThis` 上 | `lib/data/mockStore.ts`：`PREFIX = "__youmuMockStore__"` |
| 服务端存储**建仓时写预置数据，之后只增不减** | 各仓储 `getMockStore(name, create)` 的 `create` 只在第一次调用时执行 |

按「写操作密度」排，最重的几个 HTTP 文件：

```
companionChatHttp.test.mjs          37
adminProducts.test.mjs              19
staffOrderActions.test.mjs          14
http-smoke.test.mjs                 14
directRefund.test.mjs               12
adminCompanionManagement.test.mjs   10
adminCouponTemplates.test.mjs        9
adminCategories.test.mjs             9
platformConfig.test.mjs              7
```

**这 23 个文件读写的是同一份内存存储**：它们下单、退款、建券、发券、改配置，
改的都是服务端那一份。除此之外**没有**第二个共享写入点——进程内的用例之间不受影响（见下节）。

---

## 二、为什么会互相污染

### 2.1 根因：`resetMockStore()` 够不着服务端

`node --test` 让**每个测试文件跑在自己的子进程**里。因此：

- **进程内的用例天然隔离**：文件 A 里 `resetMockStore("coupon")` 删的是 **A 进程**的
  `globalThis`，碰不到 B 文件的进程。这正是 `admin.test.mjs` / `adminAgreements.test.mjs`
  等几十个文件一直在用的机制，它**没有问题**。
- **HTTP 用例打的是另一个进程**：测试进程里的 `resetMockStore()` 与 `next start` 的
  `globalThis` **不是同一个**。删了也白删。

而服务端**没有任何重置入口**：

```
$ grep -rln "resetMockStore" app/
（无输出）
```

于是那条链路是：**服务端存储从进程启动那一刻起被写，直到进程被杀，中间没有任何东西能把它恢复。**

### 2.2 直接后果：列表被测试自己造的数据顶掉

`http-smoke.test.mjs:345` 的用例是「优惠券领取幂等」，它从**领券中心第一页**里找一张
可领取或已领取的券：

```js
const target = center.items.find((item) => item.claimable) ?? center.items.find((item) => item.claimed);
assert.ok(target, "领券中心里至少应有一张可领取或已领取的 Mock 券");
```

`adminCouponTemplates.test.mjs` 的 HTTP 端到端用例每跑一次就往这张表里**加一张券模板**
（`name: "HTTP 端到端券"`），而且**从不清理**。页面大小上限 20、按新→旧排序，因此攒够
十几张之后，种子里那 6 张券就被挤出了第一页。

实测（同一个服务进程，跨多次运行）：

| 时刻 | 券模板 `total` | 第一页 `claimable` | `http-smoke` 该用例 |
|---|---|---|---|
| 攒了约 19 次运行之后 | **30** | **0** | ✖ 失败 |
| 杀掉进程重启后 | 6 | 1 | ✔ 通过 |

**决定性实验**：重启服务 → `total: 6, claimable: 1, claimed: 3`，
`http-smoke.test.mjs` 单独跑 **60/60 · 0 fail**。根因到此确认，不是推测。

### 2.3 比「偶发」更严重：它不是抖动，是**单调塌陷**

`01-prompt.md` 的「已知现象」把这件事描述成「偶发……isolated rerun 又全绿」。
**取证结果表明它比这更糟**：不重启服务、连续跑同一批 HTTP 用例，
失败会**累积并稳定下来**，而不是偶发。实测（24 个 HTTP 文件、串行、同一进程）：

| 迭代 | tests | pass | fail | 说明 |
|---|---|---|---|---|
| 1 | 760 | 760 | **0** | 全绿 |
| 2 | 760 | 760 | **0** | 全绿 |
| 3 | **549** | 540 | **9** | 从 `earningsHttp` 起整排失败，**少了 211 条用例计数** |
| 4–12 | **347** | 324 | **23** | 失败名单**每轮完全相同**，且不会自己恢复 |

三个要害：

1. **单调**：只有前两轮绿，之后**再也不会自己好**；
2. **塌陷后稳定**：第 4 轮起每轮失败的文件、数量完全一致——这是**状态**问题，不是随机性问题；
3. **用例计数会丢**：760 → 549 → 347。用例不是「跑了但失败」，是**压根没跑起来**。

第 3 点与 P1-6 `03-delivery.md` §2.3 记下的那次抖动（`1780 tests`，比全量少 8）
**是同一个形态**：**丢子用例计数 + 文件级失败**。本轮把它复现出来了。

### 2.4 一处诚实的缺口：还有一个**运行器层面**的现象没能定性

有一个**性质不同**的现象，本轮**没有**查清：

`tests/companionOrders.test.mjs` 曾在一次全量串行运行里出现「**文件被判失败、但没有任何错误正文、
且最后两条 HTTP 用例整条消失**」；同一次运行 `tests` 只有 **1787**（比全量少 1）。
对照组：**通过**的那次串行运行里，那两条用例是 `ok 620` / `ok 621`，确实存在。

已排除的可能：

- **不是数据污染**：这个文件**单独**跑（`APP_BASE_URL` 指向**已经被污染的服务**）
  连续 5 次都是 **20/20 · 0 fail**；
- **不是 `--test-concurrency=1` 引入的**：它在**并行**模式下也出现过（P1-6 的 A2）。

**因此它是运行器层面的现象**（子进程的最后一批结果没被上报），
本轮**没有**定位到机制。`01-prompt.md` 明确要求「若旧失败无法稳定复现，
也必须基于明确共享状态证据做隔离修正，**不能声称问题不存在**」——
本节既不复现它，也不否认它：**它存在，机制未定，且本轮的重置机制不一定能覆盖它。**

> ⚠️ 这一条直接决定了 `03-delivery.md` 里门禁数字的**读法**：5 次全绿是
> 「本轮改动没有引入回归」的证据，**不是**「从此再也不会出现任何文件级失败」的证明。

---

## 三、旧隔离机制

**一句话：靠约定，没有任何东西执行它。**

机制写在三个文件头里，措辞不同、意思一样——「这批用例会改服务端的存储，
你跑门禁之前请自己把服务重启一下」：

| 文件 | 原文 |
|---|---|
| `tests/http-smoke.test.mjs` | 「要跑门禁请**重启服务**（Mock 存储在内存里，重启即回到预置状态）」 |
| `tests/companionChatHttp.test.mjs` | 「这一批跑在**另一个进程**里，`resetMockStore()` 够不着它……绝不假设全局只有自己那一单」 |
| `tests/staffComplaints.test.mjs` | 「HTTP 写用例**只占用** `cmp-seed-1001-01`……每条用例都不依赖上一条改完的状态」 |

**它为什么不够**：

1. **不可执行**——没有断言、没有钩子、没有门禁。忘了重启不会有任何提示；
2. **只写在 3 个文件里**，另外 20 个会写服务端的文件一个字都没提；
3. **失败形态会骗人**——塌陷之后失败的文件与被污染的数据之间没有明显因果关系
   （「优惠券用例失败」看起来像券的问题），很容易被当成「偶发」「重跑一次就好了」，
   从而**掩盖**它其实是确定性的状态污染。P1-6 §2.3 就是这么把它记成「抖动」的；
4. **`isolated rerun 又全绿`** 这个观察本身就是它的产物：单独跑一个文件时，
   那个文件自己的写操作还没把列表撑爆，所以看起来是好的。

---

## 四、新隔离机制

由**两半**组成，缺一半不成立。

### 4.1 第一半：服务端重置能力

| 落点 | 作用 |
|---|---|
| `lib/data/mockStore.ts` · `resetAllMockStores()` | 把 `globalThis` 上**所有** `__youmuMockStore__*` 丢掉 |
| `app/api/debug/reset/route.ts` | `POST` 一次，在**服务进程内**执行上面的操作 |
| `tests/httpReset.mjs` · `resetServerStores()` | 测试侧调用入口 |

`resetAllMockStores()` **按前缀扫**，而不是遍历 `MockStoreName` 联合类型。这是刻意的：
联合类型是一份**要人工维护**的清单，将来新增仓储时忘了往里加，不会有任何提示——
测试只会**静默地**少重置一份存储，又变回「偶发」。按前缀扫天然覆盖将来每一个仓储。

**接口的安全边界**（与 `/api/payments/mock-confirm`、`/api/auth/mock-login` 同一取舍）：

- **POST only**：不导出 `GET`。运行时实测 `GET → 405`；
- **由 `ENABLE_MOCK_DEBUG` 控制**：未开启时返回 **404**（「接口不存在」，不是 403）。

> ⚠️ **代价说清楚**：在**开**着 `ENABLE_MOCK_DEBUG` 的环境里，任何能访问该服务的人
> 都能清空 Mock 数据。本地开发与自动化测试里这是可接受的（数据本来就是内存里的、
> 重启就没的一次性数据，且**这份存储里没有也不会有真实用户数据**），
> 但它意味着**这个开关不能开在任何一个有真实数据的部署上**。这与既有的
> `mockEmpty` / `mockError` / `mockDelay` 是**同一个前提**，不是本轮新增的风险面。

### 4.2 第二半：每个 HTTP 文件开跑前重置 + HTTP 文件串行

- **24 个 HTTP 用例文件**在 `const BASE = process.env.APP_BASE_URL;` 之后、
  **发起任何请求之前**，各加一行 `await resetServerStores();`
  （其中 23 个是本轮改的；第 24 个 `httpIsolation.test.mjs` 是本轮新建，写的时候就直接带上了；另有 1 个工具文件 `httpReset.mjs` 提供实现）；
- `package.json` 的 test 脚本加 **`--test-concurrency=1`**。

**为什么两半必须一起**：重置是**全局**的，不是「我这个文件的那一份」。
两个 HTTP 文件**同时**跑，后启动的那个会把先启动那个的中间状态清掉——
**不加串行，重置机制会把测试变得更差**。这不是推测，是设计上的必然。

**为什么 `resetServerStores()` 拿不到 200 就抛错，而不是静默跳过**：
「重置不了」与「重置成功」在用例看来都是「继续跑」。静默放过等于让隔离保证
悄悄失效——那正是旧机制的老毛病换了个地方重演。因此宁可在第一个文件上响亮地失败。

**顺带的效果**：不设 `APP_BASE_URL` 时它直接返回，不发任何请求，
`pnpm test` 的「不开服务也能跑」这条路完全不受影响（实测 31s / 0 fail）。

### 4.3 为什么**没有**采用的方案

| 方案 | 为什么不采用 |
|---|---|
| 独立 namespace / 每文件一份 store | 仓储通过 `getMockStore(name, create)` 取存储，**拿不到请求上下文**。按请求做命名空间要把 context 穿进每一个仓储和事务，是伤筋动骨的重构，远超「最小隔离方案」 |
| `--test-global-setup`（Node 24 有这个开关） | **实测在本机不生效**：写了 `globalSetup` 具名导出与默认导出两种写法，都没有被调用、也没有任何报错。没有可依赖的行为就不能拿它当机制 |
| 每个测试文件起一个自己的服务 | 24 个文件 × 一次 `next start`，构建/启动成本远高于重置一次内存 |
| 只放宽 `http-smoke` 那条断言（改成「翻到有券的那一页」） | 治的是**症状**，而且 `01-prompt.md` 明文禁止「删断言」。真正的问题是「服务端状态没人管」，不是「这一条断得太死」 |
| 文件头再写一遍「请重启服务」 | 那就是旧机制本身 |

---

## 五、为什么不改变业务行为

**逐条对照 `01-prompt.md` 的禁令：**

| 禁令 | 本轮 |
|---|---|
| 删断言 | **没有**。新增了 6 条断言（`tests/httpIsolation.test.mjs`），**一条都没删** |
| skip | **没有**。`skipped` 的来源只有既有的「未设 `APP_BASE_URL` 就跳过 HTTP 用例」，本轮没加任何 skip |
| retry-until-green | **没有**。门禁 5 次是**连跑**，中间不做「失败就重跑」的筛选；失败会原样记进 `03-delivery.md` |
| 单纯放大 timeout | **没有**。所有超时设置一个字都没动 |
| 改业务规则 | **没有**。见下 |

**业务代码的改动面**（可直接核对 diff）：

1. `lib/data/mockStore.ts` **新增一个导出函数**，没有改任何既有函数的签名或语义。
   它的文档明确写着「**只给自动化测试用**：业务代码不要调用它」——与既有的
   `resetMockStore` 同一条纪律。**全仓业务代码对它零调用**：唯一的调用方是
   `lib/services/mockStores.ts`，而后者只被 `app/api/debug/reset` 调用。
2. `lib/services/mockStores.ts`、`app/api/debug/reset/route.ts` 是**两个新增文件**，
   都属于 Mock 层，与 `/api/auth/mock-login`、`/api/payments/mock-confirm` 同类：
   接真实后端时**一起删掉**，删它们不影响任何业务接口。
   分两层是刻意的——`architecture-rules.md` §2.1 禁止 `app/` 直接 import `lib/data`，
   且 §六 明文「新代码不得以仓库里已有的破例为由模仿」，因此 Route 只能调 service
   （服务层只有一个转发，不含任何业务）。
3. `tests/httpIsolation.test.mjs` 是**新增测试**。
4. 23 个既有 HTTP 用例文件各加 **5 行**（一个 import、一行顶格 `await`、3 行说明注释），
   **没有任何一条既有断言被改动**（其中 22 个在 `git status` 里可见为 `M`，
   第 23 个 `adminCouponTemplates.test.mjs` 是 P1-6 新建、本轮补的；
   第 24 个 HTTP 文件 `httpIsolation.test.mjs` 为本轮新建，天生带这一行）。
5. `package.json` 只加了 `--test-concurrency=1`。

**业务规则、状态机、金额、权限、DTO 一律未动**：本轮不碰 `lib/services/**` 的业务逻辑、
不碰 `lib/data/**` 的事务、不碰任何 `app/api/**` 下已有接口的 handler。

**测试语义也没有被削弱，反而更强**：改动前，HTTP 用例读到的是「前面几十个文件攒下来的
状态」——断言是否成立取决于**运行顺序**；改动后，每个文件都从预置状态出发。
`http-smoke` 那条「领券中心至少有一张券」现在**恒真**，因为在它之前所有写操作都被清掉了。

### 5.1 新机制的有效性由一条**门禁**盯着

`tests/httpIsolation.test.mjs` 有 5 条断言，专盯「这套机制会不会被悄悄拆掉」：

1. `resetAllMockStores()` 真的把存储丢掉、重建后只剩预置内容；
2. 它**只**动 `__youmuMockStore__*`，`globalThis` 上别的键原样保留；
3. **每一个**读 `process.env.APP_BASE_URL` 的测试文件都必须调了 `resetServerStores()`
   ——新增 HTTP 文件忘了接上会**立刻变红**；
4. `package.json` 里必须有 `--test-concurrency=1`——被删掉也会**立刻变红**；
5. 真实服务上 `POST /api/debug/reset` 确实把存储丢掉了（不只是回一个 200）、
   且**只导出 POST**。

第 3 条**已做红绿验证**：临时放进一个不接重置的假 HTTP 文件 → 该条变红并指名道姓，
删掉后复绿。
