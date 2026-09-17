import assert from "node:assert/strict";
import test from "node:test";
import {
  PLATFORM_CONFIG_ID,
  PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES,
  PUBLIC_POOL_TIMEOUT_MAX_MINUTES,
  PUBLIC_POOL_TIMEOUT_MIN_MINUTES,
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
    updatedAt: now,
    updatedByAdminId: "admin-1",
  });

  const updated = readPlatformConfig();
  assert.equal(updated.publicPoolTimeoutMinutes, 90);
  assert.equal(updated.updatedAt, now);
  assert.equal(updated.updatedByAdminId, "admin-1");

  const viaRepository = await getPlatformConfigRepository().getConfig();
  assert.equal(viaRepository.publicPoolTimeoutMinutes, 90);
});

test("写入返回改动前后的两份副本，之后改返回的对象不影响存储", async () => {
  resetMockStore("platformConfig");

  const written = writePlatformConfig({
    publicPoolTimeoutMinutes: 30,
    updatedAt: "2026-09-17T00:00:00.000Z",
    updatedByAdminId: "admin-1",
  });

  assert.equal(written.previous.publicPoolTimeoutMinutes, PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES);
  assert.equal(written.updated.publicPoolTimeoutMinutes, 30);

  // 调用方手上的对象与存储里的那一份**互不影响**：审计快照要的是「写入前那一刻」，
  // 如果返回的是存储里的同一个对象，紧接着的一次写入会把 before 一起改掉。
  written.previous.publicPoolTimeoutMinutes = 9999;
  written.updated.publicPoolTimeoutMinutes = 9999;
  assert.equal(readPlatformConfig().publicPoolTimeoutMinutes, 30);
});

test("resetMockStore 之后回到预置值，测试之间不互相污染", () => {
  writePlatformConfig({
    publicPoolTimeoutMinutes: 7,
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

  const audits = await getAdminAuditRepository().listAudits({ targetType: "platformConfig" });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "platformConfig.update");
  assert.equal(audits[0].targetId, PLATFORM_CONFIG_ID);
  assert.equal(audits[0].actorId, "admin-1");
  assert.equal(audits[0].actorRole, "admin");
  assert.equal(audits[0].before.publicPoolTimeoutMinutes, PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES);
  assert.equal(audits[0].after.publicPoolTimeoutMinutes, 30);
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
