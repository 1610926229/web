import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLIC_POOL_TIMEOUT_DEFAULT_MINUTES,
  PUBLIC_POOL_TIMEOUT_MAX_MINUTES,
  PUBLIC_POOL_TIMEOUT_MIN_MINUTES,
  isValidPublicPoolTimeoutMinutes,
} from "../lib/constants/platformConfig.ts";
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
