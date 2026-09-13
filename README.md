# 用户端网站（移动优先）

平台普通用户（老板）使用的移动端网页。手机端优先，微信内置浏览器是主要运行环境，桌面端使用居中的移动端容器。

管理后台是另一个独立网站，不在本仓库内。

## 开发

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm lint
pnpm typecheck  # next typegen && tsc --noEmit
pnpm build
```

`typecheck` 会先执行 `next typegen`：`PageProps` / `LayoutProps` 等路由类型由 Next.js 生成，新增路由后必须先重新生成，否则 `tsc` 会报找不到类型。

## 技术约定

- **Next.js 16 App Router**：`params` / `searchParams` / `cookies()` / `headers()` 均为 Promise，必须 `await`。本版本的破坏性变更与旧版本差异较大，编码前先查阅 `node_modules/next/dist/docs/`。
- **Tailwind CSS v4**：CSS-first 配置，设计令牌写在 `app/globals.css` 的 `@theme` 中，没有 `tailwind.config.js`。
- **路由结构**：一级 Tab 页面在 `app/(tabs)/`，共用底部导航；需登录的一级页（订单/客服/我的）在 `app/(tabs)/(protected)/`；不显示底部导航的页面（`app/product/[id]` 商品详情、`app/checkout` 结算）放在 `(tabs)` 之外。
- **取数必须分层**：**页面和组件不得直接 `fetch`，也不得 import `lib/mocks/*`**。两条链路共用同一个 service，只有最底层实现不同：

  ```
  Server Component ─┐
                    ├─→ lib/services/* ─→ lib/data/source.ts ─→ Mock 数据源（当前）
  Route Handler ────┘                                       └─→ 数据库（将来）
  Browser ─→ lib/api/client.ts ─→ Route Handler ────────────┘
  ```

  服务端**不**通过 HTTP 请求本项目自身的 Route Handler：那会带来构建期自请求、部署地址依赖和多一次无意义的网络跳转。服务端走 `lib/data/source.ts`，浏览器端走 `lib/api/client.ts`。
- **首屏用服务端渲染**：首页、分类页、商品详情页的主体都是 Server Component，数据随 HTML 一起输出；只有确实需要浏览器状态的部分（公告自动轮播、图片加载失败占位、规格选择、类目/搜索切换、登录浮层）才拆成 Client Component。不要把整页标成 `"use client"`。
- **客户端取数走接口，服务端取数不走**：分类页首屏由服务端取好传给客户端组件，客户端**不在挂载时重复请求**；之后每一次取数都由用户操作触发（搜索、切类目、加载更多），经 `/api/catalog/products` 调用与页面同一个 service。
- **登录判断只写一次**：需登录的页面包在 `lib/auth/RequireAuth.tsx` 内，页面自身不写鉴权。未登录时渲染统一的 `LoginGate`，**地址不变**，登录后 `router.refresh()` 回到原页面。
- **占位页**：有入口但尚无原型的页面统一跳转 `/placeholder?title=...`，保证不出现 404。不要为缺少原型的页面自行设计正式 UI。

## 环境变量

Mock 能力由两个开关控制，取值必须**显式等于字符串 `true`** 才开启；留空、`false` 或删除该行都等同于关闭。

| 变量 | 作用 |
|---|---|
| `ENABLE_MOCK_AUTH` | 模拟登录：`/api/auth/mock-login`、`/api/auth/logout`、`mock_user_id` 会话 Cookie、拦截页上的「模拟微信登录」按钮 |
| `ENABLE_MOCK_DEBUG` | 调试查询参数：`mockError` / `mockEmpty` / `mockDelay` |

```bash
cp .env.example .env.local   # .env.local 已被 .gitignore 忽略
```

**正式部署不要设置这两个变量**。关闭时无需改动任何代码：

- 未开启 `ENABLE_MOCK_AUTH`：两个认证接口返回 404；`mock_user_id` Cookie 不再产生登录身份（伪造该 Cookie 只会看到登录拦截页）；拦截页上不出现任何模拟登录控件。
- 未开启 `ENABLE_MOCK_DEBUG`：三个调试查询参数被完全忽略，数据与延迟都不受影响，首页照常渲染。

开关在**服务端运行时**读取（`lib/config/env.ts` 用动态 key 访问 `process.env`，刻意避免被构建期内联成常量），因此「构建时开、运行时关」也能正确生效。

## Mock 阶段

Mock 数据在 `lib/mocks/`，接入真实后端后整个目录删除。

### 故障注入（需 `ENABLE_MOCK_DEBUG=true`）

| 参数 | 效果 |
|---|---|
| `?mockError=1` | 取数抛错 → 页面走 `error.tsx`（加载失败 + 重试）；接口返回 500 错误信封 |
| `?mockError=api` | **只让浏览器端的请求失败**（服务端取数照常），用于观察分类页列表区域这类**局部**错误态与重试；页面本身不会被打挂 |
| `?mockEmpty=<范围>` | 按范围清空首页对应模块（见下） |
| `?mockDelay=<ms>` | 覆盖模拟延迟（默认 400ms，上限 5000） |

`mockEmpty` 的范围取值——首页各模块是独立段落，空态也按模块区分，**任何单一模块为空都不会替换整页**：

| 取值 | 效果 |
|---|---|
| `1` 或 `sections` | 只在商品区域显示「暂无商品」，公告/活动图/快捷入口照常 |
| `announcements` | 隐藏公告区域，其余照常 |
| `activity` | 隐藏活动展示图，其余照常 |
| `shortcuts` | 隐藏快捷入口，其余照常 |
| `all` | 四个模块都为空 → 整页「暂无内容」空态（底部导航保留） |
| 其他/缺省 | 不生效 |

页面地址与接口地址都支持这些参数，两者共用同一个 service，行为一致：

```
http://localhost:3000/?mockEmpty=1
http://localhost:3000/api/home?mockEmpty=1
```

浏览器端由 `lib/api/client.ts` 自动把当前地址上的同名参数透传给接口，页面代码无需感知；服务端由 `lib/mocks/debug.ts` 读取。

### Mock 认证（需 `ENABLE_MOCK_AUTH=true`）

**不调用任何真实微信接口，不使用任何凭据**：会话是名为 `mock_user_id` 的 Cookie，值为 Mock 用户 id。

```bash
# 默认用户登录
curl -i -X POST http://localhost:3000/api/auth/mock-login
# 切换为第二个 Mock 用户（用于验证「切换用户后个人信息随之变化」）
curl -i -X POST -H 'content-type: application/json' \
  -d '{"userId":"u-1002"}' http://localhost:3000/api/auth/mock-login
curl -X POST http://localhost:3000/api/auth/logout
```

### 浏览链路与测试数据

首页 → 分类页 → 商品详情页：

```
首页商品卡片 ──→ /product/[id]          商品详情
首页「查看更多」──→ /category            分类页（默认第一个游戏 + 第一个类目）
分类页商品卡片 ──→ /product/[id]
详情页「立即购买」登录后 ──→ /checkout   结算占位页（P4 实现，不生成订单、不结算、不支付）
```

分类页支持用查询参数直接指定初始状态，便于人工核对与分享链接：

```
/category?gameId=g-valorant&categoryId=c-v-rank
```

Mock 数据中有几个**只能通过直链访问**的商品，不出现在任何列表里：

| 地址 | 用途 |
|---|---|
| `/product/p-off-1` | 已下架商品：列表中被过滤，直链可打开并显示「已下架」、不可购买 |
| `/product/p-debug-broken-image` | 封面地址刻意写错，用于验证「主图加载失败」占位 |
| `/product/不存在的 id` | 商品不存在 → 404 + 明确的「商品不存在」状态 |

列表层面的其它场景：`c-loss` 有 6 个上架商品、默认每页 4 条，因此能看到「加载更多」与「没有更多了」；搜索 `绝密` 有结果、搜索任意不存在的词命中空状态（只替换列表区域，搜索框与左侧类目栏照常）。

## 数据与约束

- 金额一律以**分为单位的整数**存储；展示统一为**两位小数**（`2990` → `¥29.90`），走 `lib/utils/format.ts` 的 `formatYuan`。
- 商品**名称与价格是两个独立字段**，名称中不得包含价格前缀。原型中的商品名带价格前缀（如「29.9机密400万」），属于原型数据的写法，**不沿用**。
- 规格当前为**单组、单选**：不同规格可以有不同价格，切换后页面价格同步变化；不做多属性组合 SKU，也没有库存与限购。
- `k` / `w` 数值缩写使用**截断**而非四舍五入，且必须带 `+` 后缀；统一走 `lib/utils/format.ts`，页面组件不得重复实现。
- 平台名称集中在 `lib/constants/site.ts`。当前值 `超哥电竞` **不是**最终完成工商确认的主体名称，仅为开发阶段占位。
- 公告区域仅做图片循环展示，**不支持点击跳转**，数据结构中不含 `link` 字段。
- 图片全部使用 `public/` 下的本地资源；当前不接入对象存储/CDN，**不要**配置 `remotePatterns`。
- 微信授权与支付当前均为 Mock；**不要**添加 AppID、AppSecret、商户号、API 密钥或回调地址等凭据。

## 当前进度

P1 已完成：项目基础布局与全局样式、桌面端居中容器、底部安全区适配、五项底部 TabBar、首页视觉还原。

P2 已完成（含修订）：领域类型、统一取数边界、域服务、可替换数据源、Mock Route Handler、Mock 认证适配层、免登录/需登录边界。

- 首页主体为 Server Component，商品等首屏数据直接输出到 HTML；公告轮播单独为 Client Component。
- 加载态由 `app/(tabs)/loading.tsx` 兜底，错误态由 `app/(tabs)/error.tsx` 兜底，空态按模块独立判断。
- Mock 能力由 `ENABLE_MOCK_AUTH` / `ENABLE_MOCK_DEBUG` 两个环境开关隔离，默认关闭。
- 「我的」已接入登录态；订单、客服仍为骨架。

P3 已完成：分类页 `/category`、商品详情页 `/product/[id]`，以及首页 → 分类 → 详情之间的浏览链路。

- 分类页：搜索框（按名称搜索，按钮/回车触发，不做逐字符请求）、游戏切换、**左侧竖向类目栏**、双列商品卡片、数量提示、列表级加载/空/错误三态、「加载更多」与结束状态。切类目或切游戏会清空搜索并回到该类目的浏览状态；搜索与切换都只替换列表区域，不白屏。
- 详情页：顶部返回导航、合规提示条、主图（含加载失败占位）、名称、副标题、月售、游戏标签、两位小数价格、规格选择（切换同步改价）、底部客服/收藏/立即购买操作栏、商品不存在（404）与已下架状态。该页不在 `(tabs)` 内，**不显示底部 TabBar**。
- 游客可浏览、搜索、切类目、切规格；收藏 / 客服 / 立即购买走统一的登录流程（`LoginSheet` 复用 `LoginGate`），登录后回到当前页面并继续原操作。P4 未开始，「立即购买」登录后只进入 `/checkout` 占位页。
- 仅有的两条改动到 P1 已确认视觉的地方：`ProductCard` 增加可选 `compact`（分类页右侧一列在 375px 下只有约 130px 宽，首页那套「立即购买 + 箭头圆标」会把价格挤到重叠，故缩小字号并简化为「购买」）；首页不传该参数，默认分支未变。分类页左侧栏的选中强调色沿用品牌红，而非原型里的紫色。

未开始：P4 下单与 Mock 支付、P5 订单与售后、P6 个人中心，以及真实微信授权/支付与真实数据库。

相关占位说明：`/activities`、`/help` 为统一占位页；订单、客服仍为骨架页；`/checkout` 为结算占位页。
