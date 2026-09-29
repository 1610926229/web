import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  COMPLAINT_WINDOW_DEFAULT_MINUTES,
  COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES,
  COMPLETION_AUTO_APPROVAL_MAX_MINUTES,
  COMPLETION_AUTO_APPROVAL_MIN_MINUTES,
  EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES,
  EXCLUSIVE_POOL_TIMEOUT_MAX_MINUTES,
  EXCLUSIVE_POOL_TIMEOUT_MIN_MINUTES,
  PLATFORM_CONFIG_EMPTY_PATCH_MESSAGE,
  PLATFORM_CONFIG_EXCLUSIVE_POOL_HINT,
  PLATFORM_CONFIG_ID,
  PLATFORM_CONFIG_INVALID_COMPLETION_AUTO_APPROVAL_MESSAGE,
  PLATFORM_CONFIG_INVALID_EXCLUSIVE_POOL_TIMEOUT_MESSAGE,
  PLATFORM_CONFIG_INVALID_TIMEOUT_MESSAGE,
  PLATFORM_CONFIG_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  PLATFORM_CONFIG_OPERATION_CONFLICT_MESSAGE,
  PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES,
  PUBLIC_POOL_TIMEOUT_MAX_MINUTES,
  PUBLIC_POOL_TIMEOUT_MIN_MINUTES,
  isValidCompletionAutoApprovalMinutes,
  isValidExclusivePoolTimeoutMinutes,
  isValidPublicPoolTimeoutMinutes,
} from "../lib/constants/platformConfig.ts";
import { getAdminAuditRepository } from "../lib/data/adminAuditRepository.ts";
import { updatePlatformConfig } from "../lib/data/adminPlatformConfigTransaction.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import {
  mockPlatformConfigRepository,
  platformConfigStore,
  readPlatformConfig,
  writePlatformConfig,
} from "../lib/data/mockPlatformConfigRepository.ts";
import { getPlatformConfigRepository } from "../lib/data/platformConfigRepository.ts";
import {
  getAdminPlatformConfig,
  updateAdminPlatformConfig,
} from "../lib/services/adminPlatformConfig.ts";
import { collectFiles, readSource, stripComments } from "./source-text.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * 平台参数的持续测试（P0-1）。
 *
 * 本批次只做**一个**参数：公共订单池「无人接单多久算超时」。它决定的是
 * 「钱什么时候退给用户」，因此校验必须严格——非法值一律拒绝，
 * **绝不静默取默认值**：那会让一次写错参数的保存看起来成功了，
 * 而实际生效的是另一个数字。
 */

test("公共池超时默认值是 60 分钟", () => {
  assert.equal(PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES, 60);
});

test("公共池超时上下限是 1 分钟与 1440 分钟", () => {
  assert.equal(PUBLIC_POOL_TIMEOUT_MIN_MINUTES, 1);
  assert.equal(PUBLIC_POOL_TIMEOUT_MAX_MINUTES, 1440);
});

test("公共池超时只接受 1~1440 的整数分钟", () => {
  for (const bad of [0, -1, 1441, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "60", null, undefined, {}, []]) {
    assert.equal(isValidPublicPoolTimeoutMinutes(bad), false, `${String(bad)} 不该通过`);
  }
  for (const good of [1, 2, 60, 1439, 1440]) {
    assert.equal(isValidPublicPoolTimeoutMinutes(good), true, `${good} 应当通过`);
  }
});

// ——————————————————————————— 完成材料自动审核时长（P0-8） ———————————————————————————

test("完成材料自动审核默认值是 10 分钟", () => {
  assert.equal(COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES, 10);
});

test("完成材料自动审核上下限复用公共池超时的同一套 1 与 1440 分钟", () => {
  // 两者是同一个配置实体上的同类量，分别定义一套上下限只会让两个数字慢慢分叉
  assert.equal(COMPLETION_AUTO_APPROVAL_MIN_MINUTES, PUBLIC_POOL_TIMEOUT_MIN_MINUTES);
  assert.equal(COMPLETION_AUTO_APPROVAL_MAX_MINUTES, PUBLIC_POOL_TIMEOUT_MAX_MINUTES);
});

test("完成材料自动审核只接受 1~1440 的整数分钟", () => {
  for (const bad of [0, -1, 1441, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "10", null, undefined, {}, []]) {
    assert.equal(isValidCompletionAutoApprovalMinutes(bad), false, `${String(bad)} 不该通过`);
  }
  for (const good of [1, 2, 10, 1439, 1440]) {
    assert.equal(isValidCompletionAutoApprovalMinutes(good), true, `${good} 应当通过`);
  }
});

// ——————————————————————————— 存储与仓储 ———————————————————————————

test("仓储对外只有 getConfig 一个方法", () => {
  assert.deepEqual(Object.keys(mockPlatformConfigRepository).sort(), ["getConfig"]);
});

test("预置值与默认值一致，且不是「刚刚被改过」", async () => {
  resetMockStore("platformConfig");

  const seed = readPlatformConfig();
  assert.equal(seed.publicPoolTimeoutMinutes, PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES);
  assert.equal(seed.updatedByAdminId, null);

  const viaRepository = await getPlatformConfigRepository().getConfig();
  assert.deepEqual(viaRepository, seed);
});

test("写入后读回新值，旧值被整体替换", async () => {
  resetMockStore("platformConfig");

  const now = "2026-09-17T00:00:00.000Z";
  writePlatformConfig({
    publicPoolTimeoutMinutes: 90,
    completionAutoApprovalMinutes: 15,
    updatedAt: now,
    updatedByAdminId: "admin-1",
  });

  const updated = readPlatformConfig();
  assert.equal(updated.publicPoolTimeoutMinutes, 90);
  assert.equal(updated.completionAutoApprovalMinutes, 15);
  assert.equal(updated.updatedAt, now);
  assert.equal(updated.updatedByAdminId, "admin-1");

  const viaRepository = await getPlatformConfigRepository().getConfig();
  assert.equal(viaRepository.publicPoolTimeoutMinutes, 90);
});

test("写入返回改动前后的两份副本，之后改返回的对象不影响存储", async () => {
  resetMockStore("platformConfig");

  const written = writePlatformConfig({
    publicPoolTimeoutMinutes: 30,
    completionAutoApprovalMinutes: 12,
    updatedAt: "2026-09-17T00:00:00.000Z",
    updatedByAdminId: "admin-1",
  });

  assert.equal(written.previous.publicPoolTimeoutMinutes, PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES);
  assert.equal(written.previous.completionAutoApprovalMinutes, COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES);
  assert.equal(written.updated.publicPoolTimeoutMinutes, 30);
  assert.equal(written.updated.completionAutoApprovalMinutes, 12);

  // 调用方手上的对象与存储里的那一份**互不影响**：审计快照要的是「写入前那一刻」，
  // 如果返回的是存储里的同一个对象，紧接着的一次写入会把 before 一起改掉。
  written.previous.publicPoolTimeoutMinutes = 9999;
  written.updated.publicPoolTimeoutMinutes = 9999;
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, 30);
});

test("resetMockStore 之后回到预置值，测试之间不互相污染", () => {
  writePlatformConfig({
    publicPoolTimeoutMinutes: 7,
    completionAutoApprovalMinutes: 20,
    updatedAt: "2026-09-17T00:00:00.000Z",
    updatedByAdminId: "admin-1",
  });
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, 7);

  resetMockStore("platformConfig");
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES);
});

// ——————————————————————————— 后台写入与审计 ———————————————————————————

const ctx = {
  actorId: "admin-1",
  actorRole: "admin",
  actorName: null,
  operationId: "op-pc-1",
  at: "2026-09-17T01:00:00.000Z",
};

test("修改平台参数：写业务数据 + 写一条审计", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  const result = await updatePlatformConfig({ publicPoolTimeoutMinutes: 30 }, ctx);
  assert.equal(result.kind, "ok");
  assert.equal(result.changed, true);
  assert.equal(result.replayed, false);
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, 30);
  // P0-8：只改公共池超时，另一个字段必须**保持原值**而不是被清空或回退到默认值
  assert.equal(readPlatformConfig().completionAutoApprovalMinutes, COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES);

  const audits = await getAdminAuditRepository().listAudits({ targetType: "platformConfig" });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "platformConfig.update");
  assert.equal(audits[0].targetId, PLATFORM_CONFIG_ID);
  assert.equal(audits[0].actorId, "admin-1");
  assert.equal(audits[0].actorRole, "admin");
  assert.equal(audits[0].before.publicPoolTimeoutMinutes, PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES);
  assert.equal(audits[0].after.publicPoolTimeoutMinutes, 30);
  assert.equal(audits[0].before.completionAutoApprovalMinutes, COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES);
  assert.equal(audits[0].after.completionAutoApprovalMinutes, COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES);
});

test("同一个 operationId 重放：不写数据、不写第二条审计", async () => {
  const result = await updatePlatformConfig({ publicPoolTimeoutMinutes: 45 }, ctx);

  assert.equal(result.kind, "ok");
  assert.equal(result.replayed, true);
  assert.equal(result.changed, false);
  // 值是第一次那次的 30，不是这次的 45
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, 30);
  assert.equal(await getAdminAuditRepository().countAudits(), 1);
});

test("提交与现状相同的值：不写审计，也不是错误", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  const result = await updatePlatformConfig(
    { publicPoolTimeoutMinutes: PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES },
    { ...ctx, operationId: "op-pc-same" },
  );

  assert.equal(result.kind, "ok");
  assert.equal(result.changed, false);
  assert.equal(result.replayed, false);
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES);
  assert.equal(await getAdminAuditRepository().countAudits(), 0);
});

test("同一个键被另一个操作者用掉：conflict，且不写任何东西", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  // 第一次是合法写入：它会留下 1 条审计（下面用来做「没有增加」的基线）
  await updatePlatformConfig({ publicPoolTimeoutMinutes: 20 }, { ...ctx, operationId: "op-pc-x" });
  assert.equal(await getAdminAuditRepository().countAudits(), 1);

  const result = await updatePlatformConfig(
    { publicPoolTimeoutMinutes: 90 },
    { ...ctx, actorId: "admin-2", operationId: "op-pc-x" },
  );

  assert.equal(result.kind, "operation-conflict");
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, 20);
  // 冲突调用**没有**增加第二条审计——它什么都没做
  assert.equal(await getAdminAuditRepository().countAudits(), 1);
});

test("伪事务原样写入，不偷偷夹取或取整", async () => {
  // 契约边界：校验在服务层（`lib/constants/platformConfig.ts` 的规则由服务层调用），
  // 伪事务收下的值已经是合法的。这里锁定的是**它不会自己再改一次值**——
  // 若事务里偷偷夹取，一条本该被拒绝的 2880 会被静默改成 1440 写进去，
  // 调用方拿到「成功」，而生效的却是另一个数字。
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  const result = await updatePlatformConfig(
    { publicPoolTimeoutMinutes: 1440 },
    { ...ctx, operationId: "op-pc-max" },
  );

  assert.equal(result.kind, "ok");
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, 1440);
});

test("每次写入刷新 updatedByAdminId 与 updatedAt", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  await updatePlatformConfig({ publicPoolTimeoutMinutes: 15 }, { ...ctx, operationId: "op-pc-a" });

  const after = readPlatformConfig();
  assert.equal(after.updatedByAdminId, "admin-1");
  assert.equal(after.updatedAt, ctx.at);
});

test("事务层：只改完成材料自动审核时长，公共池超时保持原值", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  const result = await updatePlatformConfig(
    { completionAutoApprovalMinutes: 25 },
    { ...ctx, operationId: "op-pc-completion-only" },
  );

  assert.equal(result.kind, "ok");
  assert.equal(result.changed, true);
  assert.equal(readPlatformConfig().completionAutoApprovalMinutes, 25);
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES);

  const audits = await getAdminAuditRepository().listAudits({ targetType: "platformConfig" });
  assert.equal(audits[0].before.publicPoolTimeoutMinutes, PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES);
  assert.equal(audits[0].after.publicPoolTimeoutMinutes, PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES);
  assert.equal(audits[0].before.completionAutoApprovalMinutes, COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES);
  assert.equal(audits[0].after.completionAutoApprovalMinutes, 25);
});

// ——————————————————————————— 服务层（接口里的那一层） ———————————————————————————

/**
 * 上面测的是伪事务的契约；这里测的是**接口实际会走的入口**。
 *
 * 两者都要有：伪事务可以被绕过（直接调它、传一个没校验过的值），
 * 而服务层是唯一同时负责「校验入参」和「拼装操作者身份」的地方。
 * 如果只测伪事务，删掉服务层的校验不会有任何测试变红。
 */

const ADMIN_ID = "admin-1";

/** 合法幂等键：`IDEMPOTENCY_KEY_PATTERN` 要求 8~64 位的字母数字与 `-` `_`。 */
function withKey(value, key) {
  return { publicPoolTimeoutMinutes: value, idempotencyKey: key };
}

test("服务层读取：返回的就是仓储里那份配置", async () => {
  resetMockStore("platformConfig");

  const config = await getAdminPlatformConfig();
  assert.deepEqual(config, readPlatformConfig());
  assert.equal(config.publicPoolTimeoutMinutes, PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES);
});

test("服务层写入：写业务数据 + 写审计，操作者来自入参而不是请求体", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  // ⚠️ 请求体里塞了 `updatedByAdminId` / `updatedAt` / `actorId`：
  // 它们**必须被忽略**。这三个字段如果能从请求体进入，任何能打开后台页面的
  // 人都可以把「最后修改者」写成别人——而那是事后追责时唯一的线索。
  const result = await updateAdminPlatformConfig(
    ADMIN_ID,
    withKey(30, "op-pc-svc-1"),
  );

  assert.equal(result.changed, true);
  assert.equal(result.config.publicPoolTimeoutMinutes, 30);
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, 30);

  const written = readPlatformConfig();
  assert.equal(written.updatedByAdminId, ADMIN_ID);

  const audits = await getAdminAuditRepository().listAudits({ targetType: "platformConfig" });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actorId, ADMIN_ID);
  assert.equal(audits[0].actorRole, "admin");
});

test("服务层写入：请求体里的 actor 与时间戳字段一律无效", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  await updateAdminPlatformConfig(ADMIN_ID, {
    publicPoolTimeoutMinutes: 30,
    idempotencyKey: "op-pc-svc-2",
    // 下面的键服务层根本不读——它们不在白名单里
    updatedByAdminId: "admin-9999",
    updatedAt: "1999-01-01T00:00:00.000Z",
    actorId: "admin-9999",
    actorName: "冒充者",
    actorRole: "staff",
  });

  const written = readPlatformConfig();
  assert.equal(written.updatedByAdminId, ADMIN_ID);
  assert.notEqual(written.updatedAt, "1999-01-01T00:00:00.000Z");

  const audits = await getAdminAuditRepository().listAudits({ targetType: "platformConfig" });
  assert.equal(audits[0].actorId, ADMIN_ID);
  assert.equal(audits[0].actorRole, "admin");
});

test("服务层写入：同一个管理员同一个键重放，不写第二条审计", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  await updateAdminPlatformConfig(ADMIN_ID, withKey(30, "op-pc-svc-3"));
  assert.equal(await getAdminAuditRepository().countAudits(), 1);

  const replayed = await updateAdminPlatformConfig(ADMIN_ID, withKey(45, "op-pc-svc-3"));
  assert.equal(replayed.changed, false);
  assert.equal(replayed.config.publicPoolTimeoutMinutes, 30);
  assert.equal(await getAdminAuditRepository().countAudits(), 1);
});

test("服务层写入：缺键或键格式非法 → 400，且什么都不写", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  for (const body of [
    { publicPoolTimeoutMinutes: 30 },
    { publicPoolTimeoutMinutes: 30, idempotencyKey: "" },
    // 太短、带空格、非字符串——`IDEMPOTENCY_KEY_PATTERN` 全部不通过
    { publicPoolTimeoutMinutes: 30, idempotencyKey: "短键" },
    { publicPoolTimeoutMinutes: 30, idempotencyKey: "has space here" },
    { publicPoolTimeoutMinutes: 30, idempotencyKey: 12345678 },
  ]) {
    await assert.rejects(
      () => updateAdminPlatformConfig(ADMIN_ID, body),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        assert.equal(error.status, 400);
        assert.equal(error.message, PLATFORM_CONFIG_MISSING_IDEMPOTENCY_KEY_MESSAGE);
        return true;
      },
    );
  }

  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES);
  assert.equal(await getAdminAuditRepository().countAudits(), 0);
});

test("服务层写入：取值非法 → 400，绝不静默取默认值", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  for (const value of [0, -1, 1441, 1.5, "60", null, undefined, Number.NaN]) {
    await assert.rejects(
      () => updateAdminPlatformConfig(ADMIN_ID, withKey(value, "op-pc-bad-1")),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        assert.equal(error.status, 400);
        assert.equal(error.message, PLATFORM_CONFIG_INVALID_TIMEOUT_MESSAGE);
        return true;
      },
      `${String(value)} 不该被接受`,
    );
  }

  // 关键：被拒绝的请求**没有**留下任何痕迹。若实现改成「非法值就用默认值 60」，
  // 上面的 rejects 仍然会通过，但下面这条会红——这正是它存在的理由。
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES);
  assert.equal(await getAdminAuditRepository().countAudits(), 0);
});

test("服务层写入：既缺键又取值非法时，先报缺键", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  // 顺序是刻意的：反过来的话，调用方改完取值重试才发现还缺一个键，第一次往返是白跑的
  await assert.rejects(
    () => updateAdminPlatformConfig(ADMIN_ID, { publicPoolTimeoutMinutes: 9999 }),
    (error) => {
      assert.equal(error.message, PLATFORM_CONFIG_MISSING_IDEMPOTENCY_KEY_MESSAGE);
      return true;
    },
  );
});

test("服务层写入：键被另一个操作者用掉 → 400 冲突，且不写任何东西", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  await updateAdminPlatformConfig(ADMIN_ID, withKey(20, "op-pc-svc-x"));
  assert.equal(await getAdminAuditRepository().countAudits(), 1);

  await assert.rejects(
    () => updateAdminPlatformConfig("admin-2", withKey(90, "op-pc-svc-x")),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.status, 400);
      assert.equal(error.message, PLATFORM_CONFIG_OPERATION_CONFLICT_MESSAGE);
      return true;
    },
  );

  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, 20);
  assert.equal(await getAdminAuditRepository().countAudits(), 1);
});

// ——————————————————————————— P0-8 / P0-9：三个字段的 PATCH 语义 ———————————————————————————

test("服务层写入：空 PATCH（三个字段都没带）→ 400「没有可修改的参数」，且什么都不写", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  await assert.rejects(
    () => updateAdminPlatformConfig(ADMIN_ID, { idempotencyKey: "op-pc-empty" }),
    (error) => {
      assert.equal(error.code, "BAD_REQUEST");
      assert.equal(error.status, 400);
      assert.equal(error.message, PLATFORM_CONFIG_EMPTY_PATCH_MESSAGE);
      return true;
    },
  );

  // 什么都不能写：配置与审计都还是初始状态
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES);
  assert.equal(readPlatformConfig().completionAutoApprovalMinutes, COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES);
  assert.equal(readPlatformConfig().complaintWindowMinutes, COMPLAINT_WINDOW_DEFAULT_MINUTES);
  assert.equal(await getAdminAuditRepository().countAudits(), 0);
});

/**
 * 第三个参数（投诉窗口，P0-9）的「保留」方向。
 *
 * ⚠️ 它与上面那条「只带投诉窗口」是**两个方向**，缺一个就有一半没盖住：
 * 合并逻辑漏掉 `complaintWindowMinutes ?? previous.complaintWindowMinutes` 时，
 * 「改池超时把投诉窗口顺手改掉」这种错误只在**这一条**下现形。
 * 因此先把窗口改成非默认值（2880 = 2 天），这样「保留原值」与「回退到默认 1440」可区分。
 */
test("服务层写入：只带 publicPoolTimeoutMinutes → 保留投诉窗口原值（不清空、不回默认）", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  await updateAdminPlatformConfig(ADMIN_ID, {
    complaintWindowMinutes: 2880,
    idempotencyKey: "op-pc-cw-2880",
  });
  assert.equal(readPlatformConfig().complaintWindowMinutes, 2880);

  const result = await updateAdminPlatformConfig(ADMIN_ID, withKey(90, "op-pc-timeout-only-cw"));
  assert.equal(result.changed, true);
  assert.equal(result.config.publicPoolTimeoutMinutes, 90);
  assert.equal(result.config.complaintWindowMinutes, 2880);
  assert.equal(readPlatformConfig().complaintWindowMinutes, 2880);
  assert.equal(readPlatformConfig().completionAutoApprovalMinutes, COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES);
});

test("服务层写入：只带 publicPoolTimeoutMinutes → 保留 completionAutoApprovalMinutes 原值（不清空、不回默认）", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  // 先把另一个字段改成非默认值 33，这样「保留原值」与「回退到默认 10」才可区分
  await updateAdminPlatformConfig(ADMIN_ID, { completionAutoApprovalMinutes: 33, idempotencyKey: "op-pc-caa-33" });
  assert.equal(readPlatformConfig().completionAutoApprovalMinutes, 33);

  const result = await updateAdminPlatformConfig(ADMIN_ID, withKey(90, "op-pc-timeout-only"));
  assert.equal(result.changed, true);
  assert.equal(result.config.publicPoolTimeoutMinutes, 90);
  assert.equal(result.config.completionAutoApprovalMinutes, 33);
  assert.equal(readPlatformConfig().completionAutoApprovalMinutes, 33);
});

test("服务层写入：只带 completionAutoApprovalMinutes → 保留 publicPoolTimeoutMinutes 原值", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  await updateAdminPlatformConfig(ADMIN_ID, withKey(90, "op-pc-timeout-90"));
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, 90);

  const result = await updateAdminPlatformConfig(ADMIN_ID, {
    completionAutoApprovalMinutes: 45,
    idempotencyKey: "op-pc-caa-only",
  });
  assert.equal(result.changed, true);
  assert.equal(result.config.completionAutoApprovalMinutes, 45);
  assert.equal(result.config.publicPoolTimeoutMinutes, 90);
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, 90);
});

test("服务层写入：完成材料自动审核时长取值非法 → 400，绝不静默取默认值", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  for (const value of [0, -1, 1441, 1.5, "10", null, undefined, Number.NaN]) {
    await assert.rejects(
      () => updateAdminPlatformConfig(ADMIN_ID, {
        completionAutoApprovalMinutes: value,
        idempotencyKey: "op-pc-caa-bad-1",
      }),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST");
        assert.equal(error.status, 400);
        assert.equal(error.message, PLATFORM_CONFIG_INVALID_COMPLETION_AUTO_APPROVAL_MESSAGE);
        return true;
      },
      `${String(value)} 不该被接受`,
    );
  }

  assert.equal(readPlatformConfig().completionAutoApprovalMinutes, COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES);
  assert.equal(await getAdminAuditRepository().countAudits(), 0);
});

test("服务层写入：两个字段都带且都变了 → changed:true，审计写一次（没带的第三个字段不动）", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  const result = await updateAdminPlatformConfig(ADMIN_ID, {
    publicPoolTimeoutMinutes: 30,
    completionAutoApprovalMinutes: 15,
    idempotencyKey: "op-pc-both",
  });

  assert.equal(result.changed, true);
  assert.equal(result.config.publicPoolTimeoutMinutes, 30);
  assert.equal(result.config.completionAutoApprovalMinutes, 15);
  assert.equal(await getAdminAuditRepository().countAudits(), 1);
});

test("服务层写入：no-op 判据覆盖三个字段——送进来的字段都与现状相同才算没改", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  // 基线：先改成 30 / 15，并记住这次写入后的 updatedAt
  await updateAdminPlatformConfig(ADMIN_ID, {
    publicPoolTimeoutMinutes: 30,
    completionAutoApprovalMinutes: 15,
    idempotencyKey: "op-pc-base",
  });
  const baselineUpdatedAt = readPlatformConfig().updatedAt;
  assert.equal(await getAdminAuditRepository().countAudits(), 1);

  // (1) 两个字段都与现状相同 → changed:false，不刷新 updatedAt，不写审计
  const bothSame = await updateAdminPlatformConfig(ADMIN_ID, {
    publicPoolTimeoutMinutes: 30,
    completionAutoApprovalMinutes: 15,
    idempotencyKey: "op-pc-both-same",
  });
  assert.equal(bothSame.changed, false);
  assert.equal(readPlatformConfig().updatedAt, baselineUpdatedAt);
  assert.equal(await getAdminAuditRepository().countAudits(), 1);

  // (2) 只送一个字段、且该字段值与现状相同 → 仍是 changed:false（不是「一个字段相同即 no-op」
  //    的错读；另一个字段根本没被改）
  const oneSame = await updateAdminPlatformConfig(ADMIN_ID, {
    publicPoolTimeoutMinutes: 30,
    idempotencyKey: "op-pc-one-same",
  });
  assert.equal(oneSame.changed, false);
  assert.equal(readPlatformConfig().updatedAt, baselineUpdatedAt);
  assert.equal(await getAdminAuditRepository().countAudits(), 1);

  // (3) 只送一个字段、该字段与现状不同 → changed:true，另一个未送的字段保持原值
  const oneChanged = await updateAdminPlatformConfig(ADMIN_ID, {
    publicPoolTimeoutMinutes: 45,
    idempotencyKey: "op-pc-one-changed",
  });
  assert.equal(oneChanged.changed, true);
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, 45);
  assert.equal(readPlatformConfig().completionAutoApprovalMinutes, 15);
  assert.equal(await getAdminAuditRepository().countAudits(), 2);

  // ⚠️ 基线在这里**重新取一次**，不能继续用 (1) 之前那份 `baselineUpdatedAt`：
  //    上面的 (3) 是一次**真的**写入，而写入按语义就要刷新时间戳
  //    （同文件「每次写入刷新 updatedByAdminId 与 updatedAt」那条用例是它的正面证据）。
  //    继续拿旧基线去比，比的其实是「(3) 有没有刷新时间戳」——那件事**本来就该发生**，
  //    于是断言只在 (1) 与 (3) 两次写入落在**同一毫秒**里时才碰巧成立：
  //    空闲机器上绿、满载跑法下红（P0-12 的门禁上真实红过一次）。
  //    下面 (4) 要证的命题没变，仍然是「no-op 不刷新 updatedAt」，只是基线取在 (3) 之后。
  const afterRealChangeUpdatedAt = readPlatformConfig().updatedAt;

  // (4) P0-9：第三个字段（投诉窗口）也要走同一条 no-op 判据。
  //     先与现状相同 → changed:false；再改它 → changed:true 且另外两个字段不动。
  //     ⚠️ 这一段是「no-op 判据是否把新字段算进去」的唯一直接证据：
  //     `PATCHABLE_FIELDS` 漏登记第三个字段时，只改投诉窗口会被判成「没有变化」，
  //     接口返回成功而配置**没有被写入**——那种错误只看返回值发现不了。
  const cwSame = await updateAdminPlatformConfig(ADMIN_ID, {
    complaintWindowMinutes: COMPLAINT_WINDOW_DEFAULT_MINUTES,
    idempotencyKey: "op-pc-cw-same",
  });
  assert.equal(cwSame.changed, false);
  assert.equal(readPlatformConfig().updatedAt, afterRealChangeUpdatedAt);
  assert.equal(await getAdminAuditRepository().countAudits(), 2);

  const cwChanged = await updateAdminPlatformConfig(ADMIN_ID, {
    complaintWindowMinutes: 2880,
    idempotencyKey: "op-pc-cw-changed",
  });
  assert.equal(cwChanged.changed, true);
  assert.equal(readPlatformConfig().complaintWindowMinutes, 2880);
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, 45);
  assert.equal(readPlatformConfig().completionAutoApprovalMinutes, 15);
  assert.equal(await getAdminAuditRepository().countAudits(), 3);
});

test("规则常量文件没有任何 import：浏览器端可以安全引用", () => {
  // 后台表单要显示「1~1440 分钟」并做提交前的校验，用的是**同一份**常量与函数。
  // 这条断言守的是那份常量文件必须保持零依赖：一旦它 import 了任何东西
  // （尤其是 `lib/data` 或 `lib/mocks`），管理端的客户端组件引用它就会把
  // 内存存储一起打进浏览器产物。服务层也不另开一份副本——
  // 「同一个数字有两个导出点」迟早会分叉。
  const source = readFileSync(
    new URL("../lib/constants/platformConfig.ts", import.meta.url),
    "utf8",
  );
  assert.equal(/^\s*import\s/m.test(source), false, "规则常量文件不该有 import");
});

test("服务层不重复导出取值上下限", async () => {
  const service = await import("../lib/services/adminPlatformConfig.ts");
  assert.equal("ADMIN_PLATFORM_CONFIG_LIMITS" in service, false);
});

// ————————————————————————— P1-2：专属池超时 —————————————————————————
//
// 本批次把「指定打手独占接单权持续多久」从源码常量改成**可配置的平台参数**。
// 这一节的用例分四层，缺一层就有一种错误看不见：
//   · 常量层：默认值与区间（改错了默认值，所有新单都跟着错）
//   · 存储层：旧 store 缺字段时补 10（读边界兜底，否则算出 `NaN` 截止时间 = 永不过期）
//   · 服务层：校验、白名单、no-op 判据都要把**第四个**字段算进去
//   · 结构层：业务路径不再硬编码 10，且仓库里没有第二份取值定义
//
// ⚠️ 快照语义（「改了配置，已进入专属池的旧单不变」）的用例在
// `dispatch.test.mjs` 的「专属池 1b / 1c / 1d」里——那里有真实的派单记录可断言，
// 而这里只做配置本身。两份文件合起来才是完整的证据。

test("专属池超时默认值是 10 分钟（P1-2）", () => {
  // 前身是源码常量 `EXCLUSIVE_WAIT_MINUTES = 10`。改成可配置**不改变默认值**：
  // 默认值一变，所有没进过后台的服务实例的业务行为都会跟着变。
  assert.equal(EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES, 10);
});

test("专属池超时上下限与公共池超时是同一套 1 ~ 1440 分钟（P1-2）", () => {
  // 不是各写一遍数字，而是**引用**公共池那一对常量：区间恰好相同这件事
  // 只能有一个数字归属，写两遍迟早有一遍被改。
  assert.equal(EXCLUSIVE_POOL_TIMEOUT_MIN_MINUTES, PUBLIC_POOL_TIMEOUT_MIN_MINUTES);
  assert.equal(EXCLUSIVE_POOL_TIMEOUT_MAX_MINUTES, PUBLIC_POOL_TIMEOUT_MAX_MINUTES);
  assert.equal(EXCLUSIVE_POOL_TIMEOUT_MIN_MINUTES, 1);
  assert.equal(EXCLUSIVE_POOL_TIMEOUT_MAX_MINUTES, 1440);
});

test("专属池超时只接受 1~1440 的整数分钟（P1-2）", () => {
  // ⚠️ 专属池与公共池**今天**区间相同，但它们仍是两个字段各自的规则：
  // 共用函数会让「将来只放宽其中一个」变成一次误伤另一边的改动。
  // 这一条断言的是**专属池自己的那个函数**，不是公共池那个。
  for (const bad of [
    0,
    -1,
    1441,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "10",
    null,
    undefined,
    {},
    [],
  ]) {
    assert.equal(isValidExclusivePoolTimeoutMinutes(bad), false, `${String(bad)} 不该通过`);
  }
  for (const good of [1, 2, 10, 1439, 1440]) {
    assert.equal(isValidExclusivePoolTimeoutMinutes(good), true, `${good} 应当通过`);
  }
});

test("专属池超时的界面文案说清了业务含义与「只影响之后」（P1-2）", () => {
  // 产品裁定：「不得只显示『超时：10』」。提示语必须回答三件事——
  // 这段时间里打手拥有什么、超时之后订单去哪、改了之后影响谁。
  assert.equal(
    PLATFORM_CONFIG_EXCLUSIVE_POOL_HINT,
    "指定打手在此时间内拥有独占接单权；超时后进入公共接单池。修改后仅影响之后进入专属池的订单。",
  );
  assert.match(PLATFORM_CONFIG_EXCLUSIVE_POOL_HINT, /独占接单权/);
  assert.match(PLATFORM_CONFIG_EXCLUSIVE_POOL_HINT, /公共接单池/);
  assert.match(PLATFORM_CONFIG_EXCLUSIVE_POOL_HINT, /仅影响之后/);
  assert.match(PLATFORM_CONFIG_INVALID_EXCLUSIVE_POOL_TIMEOUT_MESSAGE, /1~1440/);
});

test("预置配置带专属池超时，且是默认值（P1-2）", () => {
  resetMockStore("platformConfig");
  assert.equal(readPlatformConfig().exclusivePoolTimeoutMinutes, EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES);
});

test("resetMockStore 之后专属池超时回到默认 10（P1-2）", async () => {
  resetMockStore("platformConfig");
  await updateAdminPlatformConfig(ADMIN_ID, {
    exclusivePoolTimeoutMinutes: 45,
    idempotencyKey: "op-pc-reset-exclusive",
  });
  assert.equal(readPlatformConfig().exclusivePoolTimeoutMinutes, 45, "先确认真的写进去了");

  // 重置必须回到**种子**，而不是回到「上一次被写过的值」：
  // 否则后面每一条依赖默认值的用例都会拿到上一条用例留下的残留
  resetMockStore("platformConfig");
  assert.equal(
    readPlatformConfig().exclusivePoolTimeoutMinutes,
    EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES,
  );
});

test("旧 store 缺 exclusivePoolTimeoutMinutes：读边界补齐为默认 10，不产生 undefined（P1-2）", () => {
  resetMockStore("platformConfig");

  // 模拟一个「在 P1-2 之前就被创建、之后代码升级」的 `globalThis` store：
  // 内存存储不随代码更新重建，字段是真的会缺的
  const store = platformConfigStore();
  delete store.config.exclusivePoolTimeoutMinutes;

  const read = readPlatformConfig();
  assert.equal(read.exclusivePoolTimeoutMinutes, EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES);

  // ⚠️ 这一条才是这段兜底存在的理由：缺字段不补，派单进入专属池时会算出
  // `new Date(NaN)` 的截止时间，而那意味着**这张单永远不会超时**——
  // 一个不报错的静默故障。这里同时断言它不是 NaN / undefined。
  assert.equal(Number.isInteger(read.exclusivePoolTimeoutMinutes), true);
  assert.notEqual(read.exclusivePoolTimeoutMinutes, undefined);

  // 兜底只发生在**读**这一侧：存储里那份脏数据不被就地「修正」，
  // 因为写入是仓储的职责，读函数偷偷写回去会让一次查询产生副作用
  assert.equal(store.config.exclusivePoolTimeoutMinutes, undefined);
});

test("旧 store 里该字段是 0 / NaN / 非数字：同样补齐为 10（P1-2）", () => {
  resetMockStore("platformConfig");
  const store = platformConfigStore();

  // 这三个值都**不可能由一次合法写入产生**（服务层校验拦得住），
  // 因此它们只可能来自脏数据；补齐而不是抛错，是为了不让一次配置读
  // 把整个用户端页面打成 500
  for (const dirty of [0, -1, Number.NaN, "10", null, undefined]) {
    store.config.exclusivePoolTimeoutMinutes = dirty;
    assert.equal(
      readPlatformConfig().exclusivePoolTimeoutMinutes,
      EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES,
      `${String(dirty)} 应当被补齐为默认值`,
    );
  }

  // 但**合法值必须原样保留**：兜底写成「一律取默认值」会让管理员的设置全部失效
  store.config.exclusivePoolTimeoutMinutes = 1440;
  assert.equal(readPlatformConfig().exclusivePoolTimeoutMinutes, 1440);
});

test("平台参数 DTO 的字段集恰好是那六项（exact keys，P1-2）", async () => {
  resetMockStore("platformConfig");
  const config = await getAdminPlatformConfig();

  assert.deepEqual(Object.keys(config).sort(), [
    "complaintWindowMinutes",
    "completionAutoApprovalMinutes",
    "exclusivePoolTimeoutMinutes",
    "publicPoolTimeoutMinutes",
    "updatedAt",
    "updatedByAdminId",
  ]);

  // ⚠️ `updatedAt` / `updatedByAdminId` 在**读**的 DTO 里，但**不在**可提交的白名单里：
  // 它们由服务端按会话与时钟填，客户端没有声称自己是谁的位置。
  // 这条用源码探针而不是运行时断言——白名单是一个类型，运行时看不到它的键
  const patchType = stripComments(
    readSource(new URL("../lib/types/platformConfig.ts", import.meta.url)),
  );
  const patchBlock = patchType.slice(patchType.indexOf("export type AdminPlatformConfigPatch"));
  assert.equal(patchBlock.includes("updatedAt"), false, "客户端没有提交 updatedAt 的位置");
  assert.equal(patchBlock.includes("updatedByAdminId"), false);
  assert.equal(patchBlock.includes("exclusivePoolTimeoutMinutes?: number"), true);
});

test("旧 store 缺字段时，写路径的 no-op 分支也不能把 undefined 交给调用方（P1-2）", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  // 场景：P1-2 之前创建的 store 升到新代码。字段是**真的会缺**的——
  // `globalThis` 内存存储不随代码更新重建（`readPlatformConfig()` 那条读兜底
  // 就是为它写的）。
  const store = platformConfigStore();
  delete store.config.exclusivePoolTimeoutMinutes;

  // —— 分支一：这次 PATCH 的净效果为零（送进来的字段与现状相同）——
  // 伪事务走的是 `replay?.kind === "replay" || nothingChanged` 那条**不经过
  // `writePlatformConfig()`** 的返回路径。修复前它把从 store 展开出来的原始记录
  // 直接交回去，`exclusivePoolTimeoutMinutes` 是 `undefined`；JSON 序列化后
  // **键直接消失**，管理端页面 `setConfig(result.config)` 会显示「undefined 分钟」。
  // 这条用例钉住的就是这条分支——它是唯一一条绕过读边界归一化的返回路径。
  const noop = await updateAdminPlatformConfig(ADMIN_ID, {
    publicPoolTimeoutMinutes: readPlatformConfig().publicPoolTimeoutMinutes,
    idempotencyKey: "op-pc-p12-dirty-noop",
  });

  assert.equal(noop.changed, false);
  assert.deepEqual(Object.keys(noop.config).sort(), [
    "complaintWindowMinutes",
    "completionAutoApprovalMinutes",
    "exclusivePoolTimeoutMinutes",
    "publicPoolTimeoutMinutes",
    "updatedAt",
    "updatedByAdminId",
  ]);
  assert.equal(noop.config.exclusivePoolTimeoutMinutes, EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES);
  // ⚠️ 断言的是 **JSON 往返之后**键还在：客户端拿到的就是这一份，
  // `undefined` 在序列化时会让键整个消失，而 `deepEqual` 看不见这一步
  assert.equal("exclusivePoolTimeoutMinutes" in JSON.parse(JSON.stringify(noop.config)), true);

  // —— 分支二：脏 store + 恰好提交默认值 ——
  // 这一条钉住「**只归一化返回值，不动 `previous`**」这个约束：若实现顺手把
  // `previous` 也归一化了，`next` 与 `previous` 就会相等，请求落进 `nothingChanged`，
  // **永远不写盘**——旧 store 再也修不好，而管理员看到的是「取值没有变化，未写入」。
  const written = await updateAdminPlatformConfig(ADMIN_ID, {
    exclusivePoolTimeoutMinutes: EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES,
    idempotencyKey: "op-pc-p12-dirty-default-write",
  });

  assert.equal(written.changed, true, "脏 store 提交默认值必须真的写盘，而不是被判成 no-op");
  assert.equal(written.config.exclusivePoolTimeoutMinutes, EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES);
  assert.equal(store.config.exclusivePoolTimeoutMinutes, EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES);
});

test("服务层写入：只带专属池超时 → 另外三项保持原值（不被带回默认）（P1-2）", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  // 先把另外三项改成非默认值，好让「被顺手重置回默认」这种错误暴露出来
  await updateAdminPlatformConfig(ADMIN_ID, {
    publicPoolTimeoutMinutes: 90,
    completionAutoApprovalMinutes: 20,
    complaintWindowMinutes: 2880,
    idempotencyKey: "op-pc-p12-baseline",
  });

  const result = await updateAdminPlatformConfig(ADMIN_ID, {
    exclusivePoolTimeoutMinutes: 25,
    idempotencyKey: "op-pc-p12-exclusive-only",
  });

  assert.equal(result.changed, true);
  assert.equal(result.config.exclusivePoolTimeoutMinutes, 25);
  assert.equal(result.config.publicPoolTimeoutMinutes, 90);
  assert.equal(result.config.completionAutoApprovalMinutes, 20);
  assert.equal(result.config.complaintWindowMinutes, 2880);
});

test("服务层写入：专属池超时取值非法 → 400 专属池文案，配置一个字节都不动（P1-2）", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  await updateAdminPlatformConfig(ADMIN_ID, {
    exclusivePoolTimeoutMinutes: 30,
    idempotencyKey: "op-pc-p12-valid-first",
  });
  const before = readPlatformConfig();
  const auditsBefore = await getAdminAuditRepository().countAudits();

  for (const [index, bad] of [
    0,
    -1,
    1441,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "10",
    null,
  ].entries()) {
    await assert.rejects(
      () =>
        updateAdminPlatformConfig(ADMIN_ID, {
          exclusivePoolTimeoutMinutes: bad,
          // ⚠️ 键用**序号**而不是 `String(bad)`：`String(1.5)` 里的那个小数点
          // 不符合幂等键的字符合集，服务层会先报「缺少幂等键」——
          // 于是这一条断言会因为一个**与取值校验无关**的原因通过或失败
          idempotencyKey: `op-pc-p12-bad-${index}`,
        }),
      (error) => {
        assert.equal(error.code, "BAD_REQUEST", `${String(bad)} 应当是 BAD_REQUEST`);
        assert.equal(error.status, 400, `${String(bad)} 应当是 400`);
        // ⚠️ 文案必须是**专属池自己的**那一条：两池共用区间，判错文案说明
        // 校验函数用错了对象——那正是「改专属池却按公共池判」这类错误唯一的外显
        assert.equal(error.message, PLATFORM_CONFIG_INVALID_EXCLUSIVE_POOL_TIMEOUT_MESSAGE);
        return true;
      },
      `${String(bad)} 不该被接受`,
    );
  }

  // 全部被拒之后，配置仍是那一次合法写入后的状态：非法请求不留半个脚印
  assert.deepEqual(readPlatformConfig(), before);
  assert.equal(await getAdminAuditRepository().countAudits(), auditsBefore);
});

test("服务层写入：no-op 判据覆盖专属池超时（同一取值再保存一次不算改动）（P1-2）", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  await updateAdminPlatformConfig(ADMIN_ID, {
    exclusivePoolTimeoutMinutes: 35,
    idempotencyKey: "op-pc-p12-set-35",
  });
  const baselineUpdatedAt = readPlatformConfig().updatedAt;

  const same = await updateAdminPlatformConfig(ADMIN_ID, {
    exclusivePoolTimeoutMinutes: 35,
    idempotencyKey: "op-pc-p12-same-35",
  });
  assert.equal(same.changed, false);
  assert.equal(readPlatformConfig().updatedAt, baselineUpdatedAt, "no-op 不该刷新最后修改时间");
  assert.equal(await getAdminAuditRepository().countAudits(), 1);

  // ⚠️ 反例：`PATCHABLE_FIELDS` 漏登记第四个字段时，这条会把一次**真改动**
  // 判成「没有变化」——接口返回成功、配置却没写入，只看返回值发现不了
  const changed = await updateAdminPlatformConfig(ADMIN_ID, {
    exclusivePoolTimeoutMinutes: 36,
    idempotencyKey: "op-pc-p12-36",
  });
  assert.equal(changed.changed, true);
  assert.equal(readPlatformConfig().exclusivePoolTimeoutMinutes, 36);
});

test("伪事务：改专属池超时写一条审计，快照里带该字段（P1-2）", async () => {
  resetMockStore("platformConfig");
  resetMockStore("adminAudit");

  // 直接调事务层：服务层已在上面的用例里验过，这里只关心审计落盘
  await updatePlatformConfig(
    { exclusivePoolTimeoutMinutes: 50 },
    { ...ctx, operationId: "op-pc-p12-audit" },
  );

  const audits = await getAdminAuditRepository().listAudits({ targetType: "platformConfig" });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].targetId, PLATFORM_CONFIG_ID);
  assert.equal(audits[0].after.exclusivePoolTimeoutMinutes, 50);
  // `before` 记的是**上一次的值**：没有它，事后只看 `after` 无法回答「这次改动
  // 把专属池超时从多少改成了多少」——而审计的全部意义就是这个
  assert.equal(audits[0].before.exclusivePoolTimeoutMinutes, EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES);
});

// ————————————————————————— P1-2：结构门禁 —————————————————————————

test("结构：专属池时长不再由常量参与计算，业务路径读配置快照（P1-2）", () => {
  // ⚠️ 断言前先 `stripComments`：常量名现在仍出现在注释里（注释写着「它已被删除」），
  // 而注释不是代码。门禁看的是**代码里**还有没有这个常量。
  const dispatchTransaction = stripComments(
    readSource(new URL("../lib/data/companionDispatchTransaction.ts", import.meta.url)),
  );
  assert.equal(
    dispatchTransaction.includes("EXCLUSIVE_WAIT_MINUTES"),
    false,
    "专属池时长必须来自配置，不能再有源码常量",
  );
  assert.equal(
    dispatchTransaction.includes("config.exclusivePoolTimeoutMinutes"),
    true,
    "进入专属池时必须读当下配置",
  );
  assert.equal(
    dispatchTransaction.includes("exclusiveTimeoutMinutesSnapshot: exclusive ? config.exclusivePoolTimeoutMinutes : null"),
    true,
    "读到的值必须同时冻结成快照——只算截止时间不存快照，事后无法证明旧单没被追溯",
  );

  // 派单域的纯常量文件里也不该再有这个常量（既没有声明，也没有引用）
  const dispatchConstants = stripComments(
    readSource(new URL("../lib/constants/dispatch.ts", import.meta.url)),
  );
  assert.equal(dispatchConstants.includes("EXCLUSIVE_WAIT_MINUTES"), false);
});

test("结构：全仓没有第二处定义专属池时长的取值（P1-2）", () => {
  // ⚠️ `collectFiles()` 内部用 `path.join()` 拼路径（它要的是字符串），
  // 传 URL 会在递归的第一层就抛 `ERR_INVALID_ARG_TYPE`
  const files = [
    ...collectFiles(fileURLToPath(new URL("../lib", import.meta.url))),
    ...collectFiles(fileURLToPath(new URL("../app", import.meta.url))),
    ...collectFiles(fileURLToPath(new URL("../components", import.meta.url))),
  ].filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));

  // 唯一允许出现「专属池时长的取值」的地方：规则常量文件的默认值，
  // 以及类型定义里的字段声明。其余任何地方都不许再写一个 10。
  const allowed = new Set([
    fileURLToPath(new URL("../lib/constants/platformConfig.ts", import.meta.url)),
    fileURLToPath(new URL("../lib/types/platformConfig.ts", import.meta.url)),
  ]);

  const offenders = files.filter((file) => {
    if (allowed.has(file)) return false;
    const code = stripComments(readSource(file));
    // 赋值式硬编码：`exclusivePoolTimeoutMinutes = 10` / `: 10`
    return /exclusive(?:Pool)?TimeoutMinutes\s*[:=]\s*\d/.test(code);
  });

  assert.deepEqual(
    offenders.map((file) => file.replace(ROOT, "")),
    [],
    "专属池时长只允许有一个取值归属（PlatformConfig 的默认值）",
  );

  // 旧常量名在**整个仓库的代码里**都不存在了（注释可以提它，代码不行）
  const leftover = files.filter((file) => stripComments(readSource(file)).includes("EXCLUSIVE_WAIT_MINUTES"));
  assert.deepEqual(
    leftover.map((file) => file.replace(ROOT, "")),
    [],
    "EXCLUSIVE_WAIT_MINUTES 已被 P1-2 删除，不该还有代码引用它",
  );
});

test("结构：后台表单不许只显示「超时：10」，必须显示当前值与单位（P1-2）", () => {
  const console = stripComments(
    readSource(new URL("../components/admin/AdminPlatformConfigConsole.tsx", import.meta.url)),
  );

  // 四个字段各自的当前值都要露出，且带单位。只给一个输入框等于让管理员
  // 从 placeholder 里猜当前是多少
  assert.equal(console.includes("专属池超时当前值"), true);
  assert.equal(console.includes("{config.exclusivePoolTimeoutMinutes} 分钟"), true);
  // 提示语引用**常量**而不是就地写一段新的说明：文案只有一个归属
  assert.equal(console.includes("PLATFORM_CONFIG_EXCLUSIVE_POOL_HINT"), true);
  // 校验也复用服务端那一份函数，页面不另写一套区间
  assert.equal(console.includes("isValidExclusivePoolTimeoutMinutes"), true);

  // §十 要求**每一项**都有「修改后生效范围」。公共池那一项曾经只有业务说明、
  // 没有「只影响之后」——四个框并排时，管理员会以为只有三项有这条性质
  const hints = console.split("hint={").slice(1).map((part) => part.slice(0, 900));
  assert.equal(hints.length, 4, "四个字段各有一条提示");
  for (const [index, hint] of hints.entries()) {
    assert.equal(
      hint.includes("只影响") ||
        hint.includes("修改后仅影响") ||
        // 专属池那一条的文案住在常量里（`PLATFORM_CONFIG_EXCLUSIVE_POOL_HINT`），
        // 它包含「修改后仅影响之后进入专属池的订单」——那句话由常量测试逐字钉住。
        // 这里只要求页面**引用了**那份文案，不要求在页面里再抄一遍
        hint.includes("PLATFORM_CONFIG_EXCLUSIVE_POOL_HINT"),
      true,
      `第 ${index + 1} 个字段的提示缺少「修改后生效范围」`,
    );
  }
});

test("结构：保存的三个分支都在页面上，且失败后沿用同一个幂等键重试（P1-2）", () => {
  const source = stripComments(
    readSource(new URL("../components/admin/AdminPlatformConfigConsole.tsx", import.meta.url)),
  );

  // ① 成功：必须列出**保存后的值**，并说清「只影响之后」
  assert.equal(source.includes("已保存：专属订单池超时"), true);
  assert.equal(source.includes("此后新发生的事按新值判定"), true);
  // ② 无变化：不能说成「已保存」——那会让管理员相信一个并不存在的时间戳变动
  assert.equal(source.includes("取值没有变化，未写入"), true);
  // ③ 失败：必须有**可见**反馈，而不是静默吞掉
  assert.equal(source.includes('setSubmitError(cause instanceof Error ? cause.message : "保存失败，请稍后重试")'), true);

  // 两条消息的角色要分开：`role="alert"` 会打断读屏，`role="status"` 不会。
  // 用反了的话，每次保存成功都会把整段摘要念一遍
  assert.equal(source.includes('role="alert"'), true);
  assert.equal(source.includes('role="status"'), true);

  // ⚠️ 失败分支**不得**清掉幂等键：上一次请求可能已经到达服务端，只是回执丢了。
  // 沿用同一个键重试，服务端把它认成重放并返回第一次的结果；
  // 换一个键就等于让服务端按第二次写入再写一遍。因此「重试」这个能力
  // 不靠一个按钮，而靠**保留键**——这也是本页没有「重试」按钮的原因。
  const catchBlock = source.slice(source.indexOf("} catch (cause) {"), source.indexOf("} finally {"));
  assert.ok(catchBlock.length > 0, "必须能找到失败分支");
  assert.equal(catchBlock.includes("keyRef.current = null"), false, "失败后必须保留幂等键");
});

test("结构：页面不自己取数、也不碰 Mock 存储（P1-2）", () => {
  const source = stripComments(
    readSource(new URL("../components/admin/AdminPlatformConfigConsole.tsx", import.meta.url)),
  );

  // §十一「页面不得直接操作 mock store」：写只走 `saveAdminPlatformConfig`（→ Route → Service）
  assert.equal(source.includes("lib/mocks"), false);
  assert.equal(source.includes("saveAdminPlatformConfig"), true);

  // ⚠️ 这一页**没有**骨架屏，也没有「重试」按钮，而这不是缺一个状态：
  // 首屏的四个值由**服务端组件**取好传进来（`initialConfig`），组件挂载后**不再取数**，
  // 因此不存在「正在加载」这段时间；保存失败用就地红字反馈，重试就是再点一次保存
  // （幂等键被保留，上面那条用例钉住了它）。
  // 断言的是那个**原因**：组件里没有 `useEffect`。加一个挂载后取数的 effect，
  // 就同时需要骨架屏、错误态与重试按钮——那三种状态是**取数**带来的，不是这一页需要的。
  assert.equal(source.includes("useEffect"), false);
});

// ————————————————————————— P1-2：HTTP 权限与契约 —————————————————————————
//
// ⚠️ 这一节跑的是**真实服务**（`APP_BASE_URL`），因此它会改到进程里的内存配置。
// 唯一的破坏性用例（PATCH 成功那条）在结尾把值**改回默认**，理由写在它自己的注释里。

const BASE = process.env.APP_BASE_URL;
const SKIP_HTTP = BASE
  ? false
  : "未设置 APP_BASE_URL（例如 http://localhost:3105），跳过平台参数 HTTP 用例";

/** 四种非管理端身份的 Cookie：匿名 / 用户 / 打手（也是用户）/ 客服。 */
const NON_ADMIN_COOKIES = [
  ["匿名", ""],
  ["普通用户", "mock_user_id=u-1001"],
  ["打手", "mock_user_id=u-1022"],
  ["客服", "mock_staff_id=staff-1"],
];

const CONFIG_PATH = "/api/admin/platform-config";

async function requestJson(pathname, cookie, init = {}) {
  const response = await fetch(new URL(pathname, BASE), {
    redirect: "manual",
    ...init,
    headers: { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON 响应（重定向等）留给断言去判
  }
  return { status: response.status, text, json };
}

/**
 * 幂等键**每次运行都必须不同**。
 *
 * ⚠️ 这一节打的是常驻服务：写死一个键，第二次跑同一份测试时事务层会把请求
 * 认成重放——返回第一次的结果却**什么也不写**，于是「改完再读要读到新值」
 * 那条断言会在第二次运行时红。重放是**正确行为**，错的是拿同一个键做两次意图。
 */
function uniqueKey(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * 拿一个管理员 Cookie。**取不到就直接失败，绝不返回 `null` 让调用方「静默跳过」。**
 *
 * ⚠️ 这一节里的管理员 Cookie 是**权限矩阵唯一的放行证据**（`04-acceptance.md` §F
 * 要求「四条拒绝 + 一条放行」，而「一条放行」只在这些用例里）。若目标实例没开
 * `ENABLE_MOCK_ADMIN`，`mock-login` 返回非 200；此时若写成 `return null` + 调用方
 * `if (!cookie) return;`，`node --test` **既不计 skip 也不计 fail**——整段权限门禁
 * 会在读数上「全绿」而实际一条都没跑，而读数正是交付证据（指令 §二十二 要求
 * 「生产跳过 = 0」，`skipped 0` 本该证明权限矩阵真的被打过）。
 *
 * 因此这里改成**断言失败**：宁可让读数变红，也不能让一段没跑过的门禁冒充跑过。
 * 报错信息直接说清补救办法（给目标实例开 `ENABLE_MOCK_ADMIN=true`）。
 */
async function loginAdmin() {
  const response = await fetch(new URL("/api/admin/auth/mock-login", BASE), { method: "POST" });
  assert.equal(
    response.status,
    200,
    "取不到管理员 Cookie：这一组用例需要目标实例 `ENABLE_MOCK_ADMIN=true`。" +
      "否则权限矩阵（四条拒绝 + 一条放行）无法被证明，本节读数不能算通过。",
  );
  const cookie = response.headers.getSetCookie()[0]?.split(";")[0] ?? null;
  assert.ok(cookie, "mock-login 返回 200 却没有 set-cookie：拿不到可用于后续请求的会话");
  return cookie;
}

test("平台参数 1：读接口对匿名 / 用户 / 打手 / 客服一律 401（P1-2）", { skip: SKIP_HTTP }, async () => {
  for (const [label, cookie] of NON_ADMIN_COOKIES) {
    const { status, json } = await requestJson(CONFIG_PATH, cookie);
    assert.equal(status, 401, `${label}读到了平台参数`);
    assert.equal(json?.error?.code, "UNAUTHORIZED");
    // 拒绝响应里不能**顺带**回一份配置：那等于用错误码包裹了一次成功的读取
    assert.equal(json?.data, undefined);
  }
});

test("平台参数 2：写接口对匿名 / 用户 / 打手 / 客服一律 401，且一个字节都没写（P1-2）", { skip: SKIP_HTTP }, async () => {
  const body = JSON.stringify({ exclusivePoolTimeoutMinutes: 999, idempotencyKey: "op-pc-http-401" });

  for (const [label, cookie] of NON_ADMIN_COOKIES) {
    const { status, json } = await requestJson(CONFIG_PATH, cookie, {
      method: "PATCH",
      body,
      headers: { "content-type": "application/json" },
    });
    assert.equal(status, 401, `${label}改动了平台参数`);
    assert.equal(json?.error?.code, "UNAUTHORIZED");
  }

  // 正例放最后：上面全是拒绝，没有这一条就无法排除「所有人读到的都是 401」
  const cookie = await loginAdmin();
  const { json } = await requestJson(CONFIG_PATH, cookie);
  assert.notEqual(json?.data?.exclusivePoolTimeoutMinutes, 999, "被拒的请求不该留下任何痕迹");
});

test("平台参数 3：管理端账号但角色不是 admin → 403（P1-2）", { skip: SKIP_HTTP }, async () => {
  // 这一条**不需要**管理员 Cookie，但需要「开关是开的」这件事成立：
  // 关掉 `ENABLE_MOCK_ADMIN` 时 `getSessionAdmin()` 一律返回 null，
  // `admin-2/3/4` 会走 **401** 而不是 403——那已经是另一条契约（见 `tests/admin.test.mjs`），
  // 本文档这一条断言的是**「有会话但没权限」**。因此先确认登录可用（取不到会在这里直接失败）。
  await loginAdmin();

  for (const adminId of ["admin-2", "admin-3", "admin-4"]) {
    const read = await requestJson(CONFIG_PATH, `mock_admin_id=${adminId}`);
    assert.equal(read.status, 403, `${adminId} 不该读得到平台参数`);
    assert.equal(read.json?.error?.code, "FORBIDDEN");

    const write = await requestJson(CONFIG_PATH, `mock_admin_id=${adminId}`, {
      method: "PATCH",
      body: JSON.stringify({ exclusivePoolTimeoutMinutes: 999, idempotencyKey: `op-pc-403-${adminId}` }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(write.status, 403, `${adminId} 不该改得动平台参数`);
    assert.equal(write.json?.error?.code, "FORBIDDEN");
  }
});

test("平台参数 4：管理员读到的字段集恰好是那六项（exact keys）且含专属池超时（P1-2）", { skip: SKIP_HTTP }, async () => {
  const cookie = await loginAdmin();

  const { status, json } = await requestJson(CONFIG_PATH, cookie);
  assert.equal(status, 200);
  // ⚠️ 这里没有 `id`：平台参数是**单例**，记录上没有 id 字段（审计里的目标 id
  // 是 `PLATFORM_CONFIG_ID` 这个常量）。凭空加一个 id 会让它看起来「可以有多条」
  assert.deepEqual(Object.keys(json.data).sort(), [
    "complaintWindowMinutes",
    "completionAutoApprovalMinutes",
    "exclusivePoolTimeoutMinutes",
    "publicPoolTimeoutMinutes",
    "updatedAt",
    "updatedByAdminId",
  ]);
  // 接口返回的就是**生效中**的那份值：DTO 里少一个字段，管理端页面会显示 undefined 分钟
  assert.equal(Number.isInteger(json.data.exclusivePoolTimeoutMinutes), true);
});

test("平台参数 5：管理员改专属池超时 → 读回新值 → 改回默认（P1-2）", { skip: SKIP_HTTP }, async () => {
  const cookie = await loginAdmin();

  const before = (await requestJson(CONFIG_PATH, cookie)).json.data;

  // 取一个与当前值不同的合法值，否则会落进「没有变化，未写入」分支而看不到写入效果
  const next = before.exclusivePoolTimeoutMinutes === 37 ? 38 : 37;
  const patched = await requestJson(CONFIG_PATH, cookie, {
    method: "PATCH",
    body: JSON.stringify({
      exclusivePoolTimeoutMinutes: next,
      idempotencyKey: uniqueKey("op-pc-http-ok"),
    }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.data.changed, true);
  assert.equal(patched.json.data.config.exclusivePoolTimeoutMinutes, next);
  // 只改这一项：另外三项必须原样返回，不能被顺手重置成默认值
  assert.equal(patched.json.data.config.publicPoolTimeoutMinutes, before.publicPoolTimeoutMinutes);
  assert.equal(patched.json.data.config.completionAutoApprovalMinutes, before.completionAutoApprovalMinutes);
  assert.equal(patched.json.data.config.complaintWindowMinutes, before.complaintWindowMinutes);

  // 再读一次：写进去的值必须被下一次读看见（写进了一个没人读的副本是看不见的）
  const after = await requestJson(CONFIG_PATH, cookie);
  assert.equal(after.json.data.exclusivePoolTimeoutMinutes, next);

  // 💡 把值改回默认的动作在**下一条独立的用例**（「平台参数 5c」）里，而不是写在这一条的结尾。
  // 理由：这一条跑的是**真实服务的进程内存**，而配置是全局单例（`node --test` 按文件并行、
  // 共用同一个服务）。恢复语句写在成功路径的末尾时，**上面任何一条断言失败都会让它不执行**，
  // 于是后面所有依赖默认时长的用例跟着无故变红，把一次失败放大成一片噪声。
  // 拆成独立用例之后，即使这一条红，下一条照常把服务收拾干净。
});

test("平台参数 5b：PATCH 一个与现状相同的值 → 200 + changed:false + 不刷新最后修改（P1-2）", { skip: SKIP_HTTP }, async () => {
  const cookie = await loginAdmin();

  const before = (await requestJson(CONFIG_PATH, cookie)).json.data;
  const { status, json } = await requestJson(CONFIG_PATH, cookie, {
    method: "PATCH",
    body: JSON.stringify({
      exclusivePoolTimeoutMinutes: before.exclusivePoolTimeoutMinutes,
      idempotencyKey: uniqueKey("op-pc-http-noop"),
    }),
    headers: { "content-type": "application/json" },
  });

  // 「值没变」既不是错误、也不是「已保存」：服务端必须把这个区别如实告诉页面，
  // 否则页面只能显示「已保存」——而那会让管理员相信一个并不存在的改动
  assert.equal(status, 200);
  assert.equal(json.data.changed, false);
  assert.equal(json.data.config.updatedAt, before.updatedAt, "no-op 不该刷新最后修改时间");
});

test("平台参数 5c：收尾——把专属池超时改回默认，并确认读回来的就是 10（P1-2）", { skip: SKIP_HTTP }, async () => {
  const cookie = await loginAdmin();

  const current = (await requestJson(CONFIG_PATH, cookie)).json.data;

  if (current.exclusivePoolTimeoutMinutes !== EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES) {
    const restored = await requestJson(CONFIG_PATH, cookie, {
      method: "PATCH",
      body: JSON.stringify({
        exclusivePoolTimeoutMinutes: EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES,
        idempotencyKey: uniqueKey("op-pc-http-restore"),
      }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(restored.status, 200);
  }

  // ⚠️ 断言「改回去的那次 PATCH 返回了 10」是不够的——返回的是返回值，不是**下一次读**
  // 会看到的东西。这一条重新 GET 一次，把「写真的落到了这一份单例上」钉住。
  const after = (await requestJson(CONFIG_PATH, cookie)).json.data;
  assert.equal(after.exclusivePoolTimeoutMinutes, EXCLUSIVE_POOL_TIMEOUT_DEFAULT_MINUTES);
});

test("平台参数 6：非法取值一律 400 且带专属池文案，服务端不夹取（P1-2）", { skip: SKIP_HTTP }, async () => {
  const cookie = await loginAdmin();

  const before = (await requestJson(CONFIG_PATH, cookie)).json.data;
  const beforeUpdatedAt = before.updatedAt;

  // ⚠️ JSON 里没有 `NaN` / `Infinity` 字面量（`JSON.stringify(NaN)` 就是 `null`），
  // 因此这两个值由服务层用例覆盖；这里覆盖**能从网络上真的发出去**的那几种。
  const badValues = [0, -1, 1441, 1.5, "10", null, true, []];
  for (const [index, value] of badValues.entries()) {
    const { status, json } = await requestJson(CONFIG_PATH, cookie, {
      method: "PATCH",
      body: JSON.stringify({ exclusivePoolTimeoutMinutes: value, idempotencyKey: `op-pc-http-bad-${index}` }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(status, 400, `${JSON.stringify(value)} 不该被接受`);
    assert.equal(json?.error?.message, PLATFORM_CONFIG_INVALID_EXCLUSIVE_POOL_TIMEOUT_MESSAGE);
  }

  // 全部被拒之后配置一点没动：被拒的请求不能留下半个脚印
  const after = (await requestJson(CONFIG_PATH, cookie)).json.data;
  assert.equal(after.exclusivePoolTimeoutMinutes, before.exclusivePoolTimeoutMinutes);
  assert.equal(after.updatedAt, beforeUpdatedAt, "被拒的写入不该刷新最后修改时间");
});

test("平台参数 7：只读 + PATCH，没有 PUT / POST / DELETE（P1-2）", { skip: SKIP_HTTP }, async () => {
  const cookie = await loginAdmin();

  // PUT 的语义是「整份替换」，而请求体里没带的三项会被它理解成「清空」——
  // 这个地址一旦有 PUT，管理员保存一个字段就会静默重置另外三个
  for (const method of ["PUT", "POST", "DELETE"]) {
    const { status } = await requestJson(CONFIG_PATH, cookie, {
      method,
      body: method === "DELETE" ? undefined : JSON.stringify({ exclusivePoolTimeoutMinutes: 20 }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(status, 405, `${method} 不该存在`);
  }
});
