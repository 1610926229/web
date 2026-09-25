import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  COMPLAINT_WINDOW_DEFAULT_MINUTES,
  COMPLETION_AUTO_APPROVAL_DEFAULT_MINUTES,
  COMPLETION_AUTO_APPROVAL_MAX_MINUTES,
  COMPLETION_AUTO_APPROVAL_MIN_MINUTES,
  PLATFORM_CONFIG_EMPTY_PATCH_MESSAGE,
  PLATFORM_CONFIG_ID,
  PLATFORM_CONFIG_INVALID_COMPLETION_AUTO_APPROVAL_MESSAGE,
  PLATFORM_CONFIG_INVALID_TIMEOUT_MESSAGE,
  PLATFORM_CONFIG_MISSING_IDEMPOTENCY_KEY_MESSAGE,
  PLATFORM_CONFIG_OPERATION_CONFLICT_MESSAGE,
  PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES,
  PUBLIC_POOL_TIMEOUT_MAX_MINUTES,
  PUBLIC_POOL_TIMEOUT_MIN_MINUTES,
  isValidCompletionAutoApprovalMinutes,
  isValidPublicPoolTimeoutMinutes,
} from "../lib/constants/platformConfig.ts";
import { getAdminAuditRepository } from "../lib/data/adminAuditRepository.ts";
import { updatePlatformConfig } from "../lib/data/adminPlatformConfigTransaction.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import {
  mockPlatformConfigRepository,
  readPlatformConfig,
  writePlatformConfig,
} from "../lib/data/mockPlatformConfigRepository.ts";
import { getPlatformConfigRepository } from "../lib/data/platformConfigRepository.ts";
import {
  getAdminPlatformConfig,
  updateAdminPlatformConfig,
} from "../lib/services/adminPlatformConfig.ts";

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
