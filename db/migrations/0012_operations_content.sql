-- PROD-1E · Wave A 3/7：运营内容（公告 / Banner / 快捷入口）与协议正文
--
-- ## 三张内容表为什么形状几乎一样却不合并
--
-- 公告、Banner、快捷入口在 Mock 里共享 `ManagedContentFields`
-- （`lib/types/content.ts:88`：`enabled` / `sortOrder` / `createdAt` / `updatedAt` / `removedAt`），
-- 但正文部分**不同**：公告与 Banner 是「图片 + alt」，快捷入口是「图标枚举 + 站内路径」。
-- 合成一张带 `kind` 判别列的宽表，会让「图片 URL 对快捷入口永远为 NULL」这种
-- **按 kind 才成立**的约束只能写进应用层——而应用层之外的写入（迁移脚本、运维手改）就绕过去了。
-- 三张窄表让每条 CHECK 都对整张表成立，不需要先看 `kind` 再判断。
--
-- 三张表**都没有自然键**（无重名约束），只有 `id`；id 生成前缀见
-- `adminContentTransaction.ts:126`（`an_` / `bn_` / `qe_`）。

CREATE TABLE announcements (
  id          text COLLATE "C" NOT NULL,
  -- 仅后台辨认用，**不进**用户端 DTO。
  title       text NOT NULL,
  image_url   text NOT NULL,
  -- 图片替代文本，进用户端 DTO。
  alt         text NOT NULL,

  enabled     boolean NOT NULL,
  sort_order  integer NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  removed_at  timestamptz,

  CONSTRAINT announcements_pkey PRIMARY KEY (id)
);

-- 用户端取可见公告：`enabled` 且未移除，按 `sortOrder` 升序、`id` 升序兜底
-- （`compareContentOrder`）。
CREATE INDEX announcements_visible_order_idx
  ON announcements (sort_order, id)
  WHERE enabled AND removed_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE banners (
  id          text COLLATE "C" NOT NULL,
  title       text NOT NULL,
  image_url   text NOT NULL,
  alt         text NOT NULL,

  enabled     boolean NOT NULL,
  sort_order  integer NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  removed_at  timestamptz,

  CONSTRAINT banners_pkey PRIMARY KEY (id)
);

CREATE INDEX banners_visible_order_idx
  ON banners (sort_order, id)
  WHERE enabled AND removed_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE quick_entries (
  id          text COLLATE "C" NOT NULL,
  label       text NOT NULL,
  -- ⚠️ 图标是**固定枚举**，不是图片地址：取值域来自 `QuickEntryIcon`。
  --    写成任意 text 会让一个拼错的图标名静默地渲染成空白方块。
  icon        text NOT NULL,
  -- 站内绝对路径（如 `/join`）。写入前必须过服务层的 `validateSafePath()`——
  -- 那条校验留在服务层，因为它是**跨字段**的业务规则（还要看路径是不是本项目的站内路由），
  -- 不是本表能表达的不变式。这里只保证非空。
  path        text NOT NULL,

  enabled     boolean NOT NULL,
  sort_order  integer NOT NULL,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  removed_at  timestamptz,

  CONSTRAINT quick_entries_pkey PRIMARY KEY (id),
  CONSTRAINT quick_entries_icon_check
    CHECK (icon IN ('service', 'benefits', 'join', 'complaint'))
);

CREATE INDEX quick_entries_visible_order_idx
  ON quick_entries (sort_order, id)
  WHERE enabled AND removed_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────

-- 协议正文。**没有 create、没有 remove**：协议类型是固定枚举，每个类型有且只有一条当前记录，
-- 前台五个页签永远都在（正文缺失时显示「内容暂未配置」）。
-- 因此这张表的写者只有「编辑正文」与「启停」两条路径。
CREATE TABLE agreements (
  id         text COLLATE "C" NOT NULL,
  type       text NOT NULL,
  title      text NOT NULL,
  -- 结构化正文段落（section → paragraphs[]）。**不是** HTML 字符串，因此没有注入面，
  -- 整份放 jsonb：它每次编辑都是整体替换，没有「改其中一段」这种局部更新。
  sections   jsonb NOT NULL,
  version    text NOT NULL,
  -- ⚠️ 只有 `updatedAt`，**没有** `createdAt`：Mock 的 `Agreement` 就没有
  --    （`lib/types/agreement.ts:44`）。停用的版本不下发，但在后台列表可见并可重新启用。
  updated_at timestamptz NOT NULL,
  enabled    boolean NOT NULL,

  CONSTRAINT agreements_pkey PRIMARY KEY (id),
  CONSTRAINT agreements_type_check
    CHECK (type IN ('user', 'privacy', 'companion', 'platform', 'version'))
);

-- ⚠️ **不建 `UNIQUE (type)`**：预置数据里同一个类型可以存在**多个版本**
--    （`agreementSeed` 里 `user` 与 `platform` 各有两条），`pickCurrentAgreements`
--    只挑「启用中版本号最高」的一条。`(type, version)` 才是真正的自然键。
CREATE UNIQUE INDEX agreements_type_version_key
  ON agreements (type, version);
