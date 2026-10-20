Round ID: P1-5
Title: 打手排行榜闭环
Status: AWAITING_ACCEPTANCE   # 2026-09-29 夜间批次交付；等待产品负责人人工验收（见 04-acceptance.md）。⚠️ Claude 不得自行 DONE
Blocked On:            # 2026-09-29 晚段已全部解除
Depends On:
- 现有 rank 模块（用户消费榜）—— 周期与 UTC+8 实现**只读复用**，不得改写
- Earning 领域（P0-9 / P0-15）—— 收入榜真值源
- Companion 公开信息（`enabled` / `removedAt`）
- Dispatch 领域（P0-6 / P0-11）—— 接单事件
Goal: 补齐真正的 Companion Ranking（接单榜 / 完成榜 / 收入榜）；**当前用户消费榜不能冒充打手榜，且不得被污染**
Primary Domain: 打手排行榜闭环
Primary State Transition: 无
Started At: 2026-09-29
Development Completed At: 2026-09-29
Accepted At:            # 待产品负责人人工验收后填写
Git Commit:            # 用户提交前留空
