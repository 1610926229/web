-- PROD-1A · 竖切片 2/2：意见反馈
--
-- 与 0001 同一套路，但这里的唯一键是**幂等键**而不是业务键——这是 `C2` 里
-- 「内存幂等索引 → 数据库唯一约束」那一类里最简单的一个。
--
-- `mockSuggestionRepository` 用 `suggestionIdByKey`（`${userId}:${idempotencyKey}`）
-- 做防重，而服务层 `createSuggestionForUser` 在写之前**还会先查一次**：
--
--     const byKey = await repository.findSuggestionByKey(userId, idempotencyKey);
--     if (byKey) return { suggestionId: byKey.id, created: false };
--
-- 那个 `await` 就是竞态窗口：两个并发请求会双双查空、双双创建。
-- 唯一约束把判定权收到数据库手里，写侧改成 INSERT ... ON CONFLICT DO NOTHING + 读回。
--
-- ## idempotency_key 可以为 NULL，而且这是**刻意的**
--
-- Mock 建仓时只把 `suggestionSeed` 塞进 `suggestions`，**不往 `suggestionIdByKey` 里放东西**
-- （见 `createStore()`）。也就是说预置反馈在 Mock 里是「查不到幂等键」的。
--
-- 这里用 NULL 精确复刻那个语义：PostgreSQL 的 UNIQUE 默认 NULLS DISTINCT，
-- 多行 NULL 互不冲突，`findSuggestionByKey` 也永远匹配不到它们。
-- 两个实现对同一份种子数据因此给出**完全相同**的结果——这正是竖切片要证明的东西。
-- 将来预置数据退场、键改成 NOT NULL 时，这条注释就是那时候要删掉的说明。
--
-- 时间列与排序规则的理由见 0001 的文件头，此处不重复。

CREATE TABLE suggestions (
  id              text COLLATE "C" NOT NULL,
  user_id         text            NOT NULL,
  type_key        text            NOT NULL,
  -- 类型文案**快照**：类型将来改名或下架，历史反馈的展示不变
  type_label      text            NOT NULL,
  content         text            NOT NULL,
  -- 选填。类型上是 string（没有填就是空串），所以这里 NOT NULL DEFAULT '' 而不是可空
  contact         text            NOT NULL DEFAULT '',
  -- 凭证数组整块存 jsonb：它只被整体读写，从不按内部字段查询。
  -- 拆成独立表会引入一个本阶段根本不需要的连接。
  evidence        jsonb           NOT NULL DEFAULT '[]'::jsonb,
  status          text            NOT NULL,
  reply           text            NOT NULL DEFAULT '',
  -- 平台侧字段：没有回复时为 NULL（类型上是 `string | null`，不是空串）
  replied_at      timestamptz,
  created_at      timestamptz     NOT NULL,
  -- 见文件头：NULL 表示「这条不是从接口提交来的」（预置/后台），不参与幂等判重
  idempotency_key text,

  CONSTRAINT suggestions_pkey PRIMARY KEY (id),
  CONSTRAINT suggestions_user_idempotency_key UNIQUE (user_id, idempotency_key)
);

CREATE INDEX suggestions_user_created_idx
  ON suggestions (user_id, created_at DESC, id DESC);
