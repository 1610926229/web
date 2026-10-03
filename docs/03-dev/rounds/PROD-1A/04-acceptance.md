# Acceptance

Round: PROD-1A
Status: PASSED

> ⚠️ 下面是**人工验收步骤**。自动化门禁（`lint` / `typecheck` / `build` / `pnpm test` /
> `pnpm test:pg`）已在 `03-delivery.md` §5 记录为实测结果，不在此重复。
> 这里只列**自动化测不到或不便覆盖**的部分。

---

## 〇、验收前你需要知道的一件事

**本轮交付后，应用默认仍然跑在 Mock 上。** `DATA_SOURCE` 不设置即为 Mock，
所以「打开页面看有没有变化」这个动作**看不出任何区别**——这是预期，不是漏做。
本轮能验收的是**数据库工具链与守卫**，不是页面。

---

## Manual Acceptance Checklist

### A. 工具链：迁移与预置数据

- [ ] **A1** 在仓库根执行 `pnpm db:health --target=test`

  **预期**：一行摘要，形如
  `数据库可用：chaoge_esports_test（PostgreSQL 18.6，Nms）｜迁移 2 条已执行 / 0 条待执行｜postgresql://postgres:***@localhost:5432/chaoge_esports_test…`
  **重点看两处**：① 密码位置是 `***`，**不是真密码**；② 「2 条已执行 / 0 条待执行」。

- [ ] **A2** 再执行一次 `pnpm db:migrate --target=test`

  **预期**：`迁移完成：本次执行 0 条，跳过 2 条。` 底下两行 `· 0001（已是最新，跳过）`。
  **要验的是「幂等」**——重复执行不重复建表、不报错。

- [ ] **A3** 用 psql 或任意客户端连上测试库，执行 `\d favorites` 与 `\d suggestions`

  **预期**：能看到 `favorites_user_product_key UNIQUE (user_id, product_id)` 与
  `suggestions_user_idempotency_key UNIQUE (user_id, idempotency_key)` 两条约束，
  以及各自的 `*_user_created_idx` 索引。时间列类型是 **`timestamp with time zone`**。

- [ ] **A4** 查看 `favorites.created_at` 的实际取值

  **预期**：形如 `2026-09-12 21:18:00+08`（按服务器时区渲染），
  而从这里读出来给到应用的是 `2026-09-12T21:18:00.000Z`（ISO / UTC）。
  **这是 C8 裁定的落地**：库里存时间点，应用侧一律 ISO 字符串。

### B. 守卫：破坏性操作应当走不通

> ⚠️ 这一组是**本轮最重要的验收项**。每条都应当是**失败**的，请确认它确实失败。

- [ ] **B1** 执行 `pnpm db:reset --target=app`

  **预期**：**被拒绝**，exit code 1，打印用法说明，**完全没有碰数据库**。
  （理由：`reset` 只允许对测试库执行。）

- [ ] **B2** 执行 `NODE_ENV=production pnpm db:reset --target=test`

  **预期**：`[db] 失败：生产环境不允许清空数据（reset）。…`，exit 1。

- [ ] **B3** 执行 `NODE_ENV=production pnpm db:seed --target=test`

  **预期**：`[db] 失败：生产环境不允许写入预置数据（seed）。…`，exit 1。

- [ ] **B4** 把测试库指向一个**名字不以 `_test` 结尾**的库再 reset：

  ```bash
  TEST_DATABASE_URL="postgresql://postgres:<你的密码>@localhost:5432/chaoge_esports_dev" \
    pnpm db:reset --target=test
  ```

  **预期**：`[db] 失败：拒绝执行：连接串指向的库是「chaoge_esports_dev」，库名不以 _test 结尾。…`
  **重点**：判据是**实际要连的那个库的名字**，不是变量名叫什么。

- [ ] **B5**（可选，最直观）连上测试库，手动把一条收藏的 `(user_id, product_id)` 改成与另一条重复

  **预期**：数据库**直接拒绝**，报 `duplicate key value violates unique constraint "favorites_user_product_key"`。
  **要验的是「约束在数据库里，不在应用里」**——绕过应用一样拦得住。

- [ ] **B6** 用一个**连不上 / 口令错**的测试库跑一次全量：

  ```bash
  APP_BASE_URL=http://127.0.0.1:3000 \
  TEST_DATABASE_URL="postgresql://postgres:wrong@localhost:5432/chaoge_esports_test" \
    node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/alias-hook.mjs \
      --test-concurrency=1 --test "tests/*.test.mjs"
  ```

  **预期**：**明确失败**（`password authentication failed` / 连接被拒），**不是**「48 条全跳过」。
  **要验的是一条容易被忽略的纪律**：`TEST_DATABASE_URL` **没有设置**时 pg 用例会 skip
  （所以裸跑 `pnpm test` 不会因为没数据库而红）；但**设置了一个错的**时候必须硬失败。
  「连不上就当我没测」和「连不上就报错」在测试报告里长得几乎一样，后者才是对的。

### C. 数据源切换（可选，会改变运行行为）

> ⚠️ 这一组会真的把应用切到 PostgreSQL。**做完请把 `DATA_SOURCE` 去掉**，否则后续开发都在库上跑。

- [ ] **C1** 在 `.env.local` 里加 `DATA_SOURCE=postgres`，`pnpm dev`，登录后打开「我的收藏」

  **预期**：页面正常，内容与切换前**一致**（因为 Pg 与 Mock 读的是同一批预置数据）。

- [ ] **C2** 在页面上取消一条收藏、再重新收藏

  **预期**：行为与 Mock 下**完全一样**；`favorites` 表里确实多/少了一行。

- [ ] **C3** **故意把 `DATABASE_URL` 改成一个连不上的地址**（例如端口 `5433`），再打开「我的收藏」

  **预期**：**报错**，而不是显示一个空列表。
  **这是「fail-fast」那条要求的落地**——空列表和「真的没有收藏」在页面上长得一模一样，
  那是最难查的一类故障，所以本项目宁可让请求直接失败。

- [ ] **C4** 验收完成后**移除 `DATA_SOURCE`**，确认应用回到 Mock

### D. 回归：既有功能没有被本轮影响

- [ ] **D1** `pnpm dev`，随便走一遍既有的用户端 / 管理端 / 客服端 / 打手端主流程

  **预期**：与 PROD-1A 之前**没有任何可观察差异**。
  （本轮只新增了「另一份实现」和一个开关，默认关闭。）

- [ ] **D2** 确认浏览器控制台与网络面板里**没有** `pg` / `postgres` 相关的东西

  **预期**：干净。（构建产物已实测：`pg` 只在服务端 chunk 里，客户端 chunk 里没有任何痕迹。）

---

## User Result

2026-10-03 用户逐项执行并确认通过。实际执行路径与结果：

| 项 | 用户实际操作 | 结果 |
|---|---|---|
| A | 校验 `public` 下三张表与迁移历史 | 通过 |
| B | 收藏 `p-400w`；**停进程 → 重启 → 回页面** | 页面仍显示 1 条；库中同一行逐字段不变 |
| C | 唯一约束与并发 | 通过 |
| D | 事务 COMMIT / ROLLBACK | 通过 |
| E | 六项破坏性守卫 | 6/6 全部被拒 |

**过程中出现的一次疑问（非缺陷）**：用户在 pgAdmin 中找不到 `favorites` 表。
原因是 pgAdmin 对象树缓存 + 未展开到 `public` 层。经 Query Tool 复核
（`current_database()` / `current_user` / `inet_server_port()` 三值与预期一致），
确认为工具侧显示问题，数据库本身自始正常。**未因此改动任何代码。**

## Issues Found

无代码缺陷。三条观察记录如下，**均未触发代码改动**：

1. **NOTE** — pgAdmin 对象树缓存导致「表不见了」的误判（见上）。属工具行为，非项目问题。
2. **MINOR（仅本地，不入库）** — `.env` 仍留有 4 行 Prisma 时代的注释，
   连接串带 `?schema=public`。`.env` 被 `.gitignore:34` 的 `.env*` 忽略，**不会提交**；
   已跟踪的 `.env.example` 是干净的。`pg` 会忽略未知参数，无功能影响。
3. **NOTE（凭据卫生）** — 本地 PostgreSQL 口令与本机 git 用户名是**同一个值**。
   该值只存在于被忽略的 `.env`，**不在 git 历史中**（已用 `git log -S` 全历史核验为 0）。
   建议后续换一个独立口令。

## Rework

无返工。

## Final Result

PASSED

## Git Commit

b9588cd   # `P1-6、P1-7、P1-8 归档 + PROD-1A：PostgreSQL 基础层与竖切片`（用户执行）
          # ⚠️ 四轮合并提交：本轮开工时工作区已带着 P1-6/P1-7/P1-8 的未提交内容，
          #    且 `docs/02-tech-design/*` 等被多轮共同修改，无法按轮次干净拆分。
          #    本 Round 的状态更新见其后的 `docs: PROD-1A 关闭（DONE）`。

---

## ⚠️ 附：DONE 的双重门槛（协议 §四 / §十七）

```
① 用户明确说「人工验收通过」
② 用户已自行完成 Git commit（提供 hash 或明确表示提交完成）
```

**两个条件同时满足**才可以把状态改为 `DONE` 并记录 `Git Commit`。
缺任何一个，Round 都停在 `AWAITING_ACCEPTANCE`。

**本轮 Claude 未执行任何 Git 写操作**，改动全部保留在工作区。

**⚠️ 另请注意**：本轮开工时工作区**已经**带着 P1-6 / P1-7 / P1-8 的未提交内容
（65 个已修改的受跟踪文件）。如果你希望 PROD-1A 单独成一个提交，
需要先决定那批内容怎么处理——**这件事不该由 Claude 替你决定**。
见 `03-delivery.md` §2.4。
