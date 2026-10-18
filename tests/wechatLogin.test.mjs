import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isMockWechatLoginEnabled,
  isRealWechatLoginConfigured,
  readRealWechatConfig,
  WECHAT_NOT_CONFIGURED_MESSAGE,
} from "../lib/auth/wechat/config.ts";
import { WechatLoginFlowError } from "../lib/auth/wechat/errors.ts";
import {
  MOCK_WECHAT_APP_ID,
  MOCK_WECHAT_IDENTITIES,
  findMockWechatIdentity,
  mockWechatOpenId,
} from "../lib/auth/wechat/mockProvider.ts";
import {
  buildWechatAuthorizeUrl,
  exchangeWechatCode,
} from "../lib/auth/wechat/realProvider.ts";
import { errorPageUrl, requestUrl } from "../lib/auth/wechat/redirect.ts";
import {
  createWechatStateToken,
  hashWechatState,
  isPlausibleWechatState,
  sanitizeRedirectPath,
  statesMatch,
  WECHAT_STATE_TTL_SECONDS,
} from "../lib/auth/wechat/stateToken.ts";
import { isPublicPreviewPath } from "../lib/config/publicPreview.ts";
import {
  WechatPayNotConfiguredError,
  disabledWechatPayProvider,
  isRealWechatPayEnabled,
} from "../lib/services/wechatPayProvider.ts";

/**
 * PROD-5 · 微信登录的**纯逻辑**用例——不需要数据库与浏览器，因此 `pnpm test` 永远会跑。
 *
 * 覆盖四件事：
 *
 * 1. **OAuth state**：随机、只存哈希、一次性（数据库行为见 `pgWechatIdentity.test.mjs`）、
 *    回跳地址只允许站内路径；
 * 2. **provider 隔离**：Mock 与真实微信的 provider 值 / appid / openid 前缀不同，
 *    真实回调的 import 图里没有 Mock 实现；真实配置缺失时**不会**假装成功；
 * 3. **真实适配器**：授权 URL 参数正确、AppSecret 只在服务端 token 请求里出现、
 *    微信错误码被分类成固定 reason 而不是原样透出；
 * 4. **真实支付仍关闭**：预留 provider 的每个方法都立刻抛错，没有路由/开关能绕过。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

/** 去掉注释后再断言：说明文字里提到某个词，不算代码里用了它。 */
function code(relative) {
  return source(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const ENV_KEYS = [
  "WECHAT_APP_ID",
  "WECHAT_APP_SECRET",
  "WECHAT_REDIRECT_URI",
  "DATA_SOURCE",
  "ENABLE_MOCK_AUTH",
];

/** 临时改环境变量，结束后原样恢复（包括「原本就没有这个变量」）。 */
async function withEnv(values, fn) {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;

  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const REAL_ENV = {
  WECHAT_APP_ID: "wx-test-appid",
  WECHAT_APP_SECRET: "test-app-secret-value",
  WECHAT_REDIRECT_URI: "https://staging.example.test/api/auth/wechat/callback",
};

/* ═══════════════════════ OAuth state ═══════════════════════ */

test("state：32 字节随机、43 字符 base64url，每次不同，数据库只存 SHA-256", () => {
  const first = createWechatStateToken();
  const second = createWechatStateToken();

  assert.equal(first.raw.length, 43);
  assert.match(first.raw, /^[A-Za-z0-9_-]{43}$/);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  assert.equal(first.hash, hashWechatState(first.raw));
  assert.equal(first.hash.includes(first.raw), false, "摘要里不能出现原文");

  assert.notEqual(first.raw, second.raw);
  assert.notEqual(first.hash, second.hash);
  assert.equal(WECHAT_STATE_TTL_SECONDS, 600, "state 有效期必须是 10 分钟");
});

test("state 形状校验：只放过 43 位 base64url，其余一律拒绝", () => {
  assert.equal(isPlausibleWechatState(createWechatStateToken().raw), true);
  assert.equal(isPlausibleWechatState("a".repeat(42)), false);
  assert.equal(isPlausibleWechatState("a".repeat(44)), false);
  assert.equal(isPlausibleWechatState(`${"a".repeat(42)}.`), false);
  assert.equal(isPlausibleWechatState(""), false);
  assert.equal(isPlausibleWechatState(null), false);
  assert.equal(isPlausibleWechatState(123), false);
});

test("state 比较：等长才逐一比较，任意一位不同都返回 false", () => {
  const a = "a".repeat(43);
  const b = `${"a".repeat(42)}b`;

  assert.equal(statesMatch(a, a), true);
  assert.equal(statesMatch(a, b), false);
  assert.equal(statesMatch(a, a.slice(0, 42)), false);
  assert.equal(statesMatch("", ""), true);
});

/* ═══════════════════════ 回跳地址 ═══════════════════════ */

test("回跳地址白名单：只允许站内路径，协议相对/反斜杠/接口路径/控制字符一律回首页", () => {
  for (const accepted of ["/", "/orders", "/orders?tab=paid", "/companion/orders", "/wechat-login?error=x"]) {
    assert.equal(sanitizeRedirectPath(accepted), accepted, `${accepted} 应当被接受`);
  }

  const rejected = [
    "https://evil.example.com",
    "//evil.example.com",
    "///evil.example.com",
    "/\\evil.example.com",
    "\\\\evil.example.com",
    "javascript:alert(1)",
    "/api",
    "/api/orders",
    "/api/auth/wechat/callback",
    `/orders${String.fromCharCode(10)}Set-Cookie: x=y`,
    `/orders${String.fromCharCode(0)}`,
    `/orders${String.fromCharCode(0x7f)}`,
  ];

  for (const value of rejected) {
    assert.equal(sanitizeRedirectPath(value), "/", `${JSON.stringify(value)} 不该被接受`);
  }

  // 去空白后是站内路径：允许（不会变成站外地址）
  assert.equal(sanitizeRedirectPath(" /orders "), "/orders");

  assert.equal(sanitizeRedirectPath(null), "/");
  assert.equal(sanitizeRedirectPath(undefined), "/");
  assert.equal(sanitizeRedirectPath(42), "/");
  assert.equal(sanitizeRedirectPath(""), "/");

  const long = `/${"a".repeat(600)}`;
  assert.equal(sanitizeRedirectPath(long).length, 500, "过长地址必须截断而不是原样进 Location");
});

test("回跳 URL 使用代理头构造：隧道/反代下协议与主机都以请求头为准", () => {
  const request = new Request("http://127.0.0.1:3000/api/auth/wechat/callback", {
    headers: {
      host: "127.0.0.1:3000",
      "x-forwarded-host": "staging.example.test",
      "x-forwarded-proto": "https",
    },
  });

  assert.equal(requestUrl(request, "/orders"), "https://staging.example.test/orders");
  assert.equal(
    errorPageUrl(request, "state-invalid"),
    "https://staging.example.test/wechat-login?error=state-invalid",
  );

  // 没有代理头时退回请求自身；未知协议值不被采信
  const direct = new Request("http://127.0.0.1:3000/api/auth/wechat/callback");
  assert.equal(requestUrl(direct, "/orders"), "http://127.0.0.1:3000/orders");

  const weird = new Request("http://127.0.0.1:3000/x", {
    headers: { "x-forwarded-proto": "file", host: "h.test" },
  });
  assert.equal(requestUrl(weird, "/orders"), "http://h.test/orders");
});

/* ═══════════════════════ 配置与开关 ═══════════════════════ */

test("真实微信配置三项必须齐全：缺任何一项都返回 null，绝不拼半成品配置", async () => {
  await withEnv({}, async () => {
    assert.equal(readRealWechatConfig(), null);
    assert.equal(isRealWechatLoginConfigured(), false);
  });

  await withEnv({ WECHAT_APP_ID: REAL_ENV.WECHAT_APP_ID }, async () => {
    assert.equal(readRealWechatConfig(), null);
  });

  await withEnv(
    { WECHAT_APP_ID: REAL_ENV.WECHAT_APP_ID, WECHAT_APP_SECRET: REAL_ENV.WECHAT_APP_SECRET },
    async () => {
      assert.equal(readRealWechatConfig(), null, "缺回调地址同样是未配置");
    },
  );

  await withEnv(
    { ...REAL_ENV, WECHAT_REDIRECT_URI: "not-a-url" },
    async () => {
      assert.equal(readRealWechatConfig(), null);
    },
  );

  await withEnv(
    { ...REAL_ENV, WECHAT_REDIRECT_URI: "javascript:alert(1)" },
    async () => {
      assert.equal(readRealWechatConfig(), null);
    },
  );

  await withEnv(REAL_ENV, async () => {
    assert.deepEqual(readRealWechatConfig(), {
      appId: REAL_ENV.WECHAT_APP_ID,
      appSecret: REAL_ENV.WECHAT_APP_SECRET,
      redirectUri: REAL_ENV.WECHAT_REDIRECT_URI,
    });
    assert.equal(isRealWechatLoginConfigured(), true);
  });
});

test("Mock 微信登录只在 PostgreSQL + ENABLE_MOCK_AUTH=true 时可用（两个条件缺一不可）", async () => {
  await withEnv({}, async () => assert.equal(isMockWechatLoginEnabled(), false));

  await withEnv({ DATA_SOURCE: "postgres" }, async () =>
    assert.equal(isMockWechatLoginEnabled(), false, "只有数据库还不够"),
  );

  await withEnv({ ENABLE_MOCK_AUTH: "true" }, async () =>
    assert.equal(isMockWechatLoginEnabled(), false, "Mock 数据源下没有身份表"),
  );

  await withEnv({ DATA_SOURCE: "postgres", ENABLE_MOCK_AUTH: "true" }, async () =>
    assert.equal(isMockWechatLoginEnabled(), true),
  );

  await withEnv({ DATA_SOURCE: "postgres", ENABLE_MOCK_AUTH: "TRUE" }, async () =>
    assert.equal(isMockWechatLoginEnabled(), false, "开关只认精确的 true"),
  );
});

test("未配置的提示必须明确说「尚未配置」，不能是「请稍后重试」这类含糊话", () => {
  assert.ok(WECHAT_NOT_CONFIGURED_MESSAGE.includes("尚未配置"));
  assert.ok(WECHAT_NOT_CONFIGURED_MESSAGE.includes("AppID"));
});

/* ═══════════════════════ 真实 provider ═══════════════════════ */

test("授权地址：参数齐全、scope 为网站应用扫码登录，且绝不带 AppSecret", async () => {
  await withEnv(REAL_ENV, async () => {
    const url = buildWechatAuthorizeUrl("s".repeat(43));
    const parsed = new URL(url);

    assert.equal(parsed.origin, "https://open.weixin.qq.com");
    assert.equal(parsed.pathname, "/connect/qrconnect");
    assert.equal(parsed.searchParams.get("appid"), REAL_ENV.WECHAT_APP_ID);
    assert.equal(parsed.searchParams.get("redirect_uri"), REAL_ENV.WECHAT_REDIRECT_URI);
    assert.equal(parsed.searchParams.get("response_type"), "code");
    assert.equal(parsed.searchParams.get("scope"), "snsapi_login");
    assert.equal(parsed.searchParams.get("state"), "s".repeat(43));
    assert.equal(url.endsWith("#wechat_redirect"), true);
    assert.equal(url.includes(REAL_ENV.WECHAT_APP_SECRET), false, "授权地址会进浏览器，不能带密钥");
  });

  await withEnv({}, async () => {
    assert.throws(
      () => buildWechatAuthorizeUrl("s".repeat(43)),
      (error) => error instanceof WechatLoginFlowError && error.reason === "not-configured",
    );
  });
});

/** 用假的 fetch 回答微信接口；返回调用过的 URL 列表。 */
async function withFakeWechatFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body, contentType = "application/json") {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

test("code 换身份：先 token 再 userinfo，openid/unionid/昵称/头像都来自服务端响应", async () => {
  await withEnv(REAL_ENV, async () => {
    await withFakeWechatFetch(
      (url) => {
        if (url.includes("/sns/oauth2/access_token")) {
          return jsonResponse(
            {
              access_token: "ACCESS-TOKEN-SHOULD-NOT-LEAK",
              openid: "openid-alpha-123456",
              unionid: "unionid-alpha-123456",
              expires_in: 7200,
            },
            "text/plain", // 微信历史上会以 text/plain 返回 JSON
          );
        }
        return jsonResponse({
          openid: "openid-alpha-123456",
          nickname: "微信昵称",
          headimgurl: "https://thirdwx.qlogo.cn/avatar.png",
          unionid: "unionid-alpha-123456",
        });
      },
      async (calls) => {
        const identity = await exchangeWechatCode("the-code");

        assert.equal(calls.length, 2);
        assert.ok(calls[0].includes("grant_type=authorization_code"));
        assert.ok(calls[0].includes(`secret=${encodeURIComponent(REAL_ENV.WECHAT_APP_SECRET)}`));
        assert.ok(calls[0].includes("code=the-code"));
        assert.equal(calls[1].includes(REAL_ENV.WECHAT_APP_SECRET), false, "userinfo 请求不带密钥");

        assert.deepEqual(identity, {
          openId: "openid-alpha-123456",
          unionId: "unionid-alpha-123456",
          nickname: "微信昵称",
          avatarUrl: "https://thirdwx.qlogo.cn/avatar.png",
        });

        const serialized = JSON.stringify(identity);
        assert.equal(serialized.includes(REAL_ENV.WECHAT_APP_SECRET), false);
        assert.equal(serialized.includes("ACCESS-TOKEN"), false, "access_token 不落库、不返回");
      },
    );
  });
});

test("昵称截断到平台上限 15 字，缺失时回落为「微信用户」", async () => {
  await withEnv(REAL_ENV, async () => {
    await withFakeWechatFetch(
      (url) =>
        url.includes("/sns/oauth2/access_token")
          ? jsonResponse({ access_token: "t", openid: "openid-length-check" })
          : jsonResponse({ openid: "openid-length-check" }),
      async () => {
        const identity = await exchangeWechatCode("code");
        assert.equal(identity.nickname, "微信用户");
        assert.equal(identity.unionId, null);
        assert.equal(identity.avatarUrl, "");
      },
    );

    await withFakeWechatFetch(
      (url) =>
        url.includes("/sns/oauth2/access_token")
          ? jsonResponse({ access_token: "t", openid: "openid-length-check" })
          : jsonResponse({ openid: "openid-length-check", nickname: "一二三四五六七八九十一二三四五六七" }),
      async () => {
        const identity = await exchangeWechatCode("code");
        assert.equal(Array.from(identity.nickname).length, 15);
      },
    );
  });
});

test("微信失败被分类为固定 reason：code 失效 / 网络 / 其他，绝不把 errcode 原样透出", async () => {
  await withEnv(REAL_ENV, async () => {
    for (const errcode of [40029, 40163]) {
      await withFakeWechatFetch(
        () => jsonResponse({ errcode, errmsg: `微信原始错误 ${errcode}` }),
        async () => {
          await assert.rejects(
            () => exchangeWechatCode("bad-code"),
            (error) => {
              assert.ok(error instanceof WechatLoginFlowError);
              assert.equal(error.reason, "code-invalid");
              assert.equal(error.message.includes(String(errcode)), false);
              assert.equal(error.message.includes("微信原始错误"), false);
              return true;
            },
          );
        },
      );
    }

    await withFakeWechatFetch(
      () => jsonResponse({ errcode: 45009, errmsg: "api freq out of limit" }),
      async () => {
        await assert.rejects(
          () => exchangeWechatCode("code"),
          (error) => error instanceof WechatLoginFlowError && error.reason === "failed",
        );
      },
    );

    await withFakeWechatFetch(
      () => {
        throw new TypeError("fetch failed");
      },
      async () => {
        await assert.rejects(
          () => exchangeWechatCode("code"),
          (error) => error instanceof WechatLoginFlowError && error.reason === "network",
        );
      },
    );

    await withFakeWechatFetch(
      () => new Response("<html>not json</html>", { status: 200 }),
      async () => {
        await assert.rejects(
          () => exchangeWechatCode("code"),
          (error) => error instanceof WechatLoginFlowError && error.reason === "network",
        );
      },
    );

    await withFakeWechatFetch(
      () => jsonResponse({ openid: "openid-no-token" }),
      async () => {
        await assert.rejects(
          () => exchangeWechatCode("code"),
          (error) => error instanceof WechatLoginFlowError && error.reason === "failed",
        );
      },
    );
  });

  await withEnv({}, async () => {
    await assert.rejects(
      () => exchangeWechatCode("code"),
      (error) => error instanceof WechatLoginFlowError && error.reason === "not-configured",
    );
  });
});

test("userinfo 返回的 openid 与 token 不一致时拒绝登录（不接受串号响应）", async () => {
  await withEnv(REAL_ENV, async () => {
    await withFakeWechatFetch(
      (url) =>
        url.includes("/sns/oauth2/access_token")
          ? jsonResponse({ access_token: "t", openid: "openid-from-token" })
          : jsonResponse({ openid: "openid-from-userinfo" }),
      async () => {
        await assert.rejects(
          () => exchangeWechatCode("code"),
          (error) => error instanceof WechatLoginFlowError && error.reason === "failed",
        );
      },
    );
  });
});

/* ═══════════════════════ Mock provider ═══════════════════════ */

test("Mock 身份表：key 稳定唯一、openid 带 mock 前缀、不携带任何角色字段", () => {
  const keys = MOCK_WECHAT_IDENTITIES.map((identity) => identity.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.length >= 2, "至少要有两个身份，才能验证「两个微信账号互相看不到订单」");

  for (const identity of MOCK_WECHAT_IDENTITIES) {
    assert.match(identity.nickname, /^微信用户/);
    assert.ok(identity.avatarUrl.startsWith("/mock/"));
    assert.equal("role" in identity, false, "Mock 身份不得携带角色");
    assert.equal(mockWechatOpenId(identity.key), `mock-openid-${identity.key}`);
    assert.equal(findMockWechatIdentity(identity.key)?.key, identity.key);
  }

  assert.equal(findMockWechatIdentity("not-a-identity"), null);
  assert.equal(findMockWechatIdentity(null), null);
  assert.equal(findMockWechatIdentity({ key: "alpha" }), null);

  // 真实 provider 的 appid 是环境变量，Mock 用固定占位值：两者不可能相等
  assert.equal(MOCK_WECHAT_APP_ID, "mock-wechat-staging");
  assert.ok(MOCK_WECHAT_APP_ID.startsWith("mock-"));
});

/* ═══════════════════════ 真实支付保持关闭 ═══════════════════════ */

test("真实微信支付开关恒为 false，预留 provider 的每个方法都立刻拒绝", async () => {
  assert.equal(isRealWechatPayEnabled(), false);

  const methods = [
    () => disabledWechatPayProvider.createUnifiedOrder({}),
    () => disabledWechatPayProvider.queryOrder("o"),
    () => disabledWechatPayProvider.closeOrder("o"),
    () => disabledWechatPayProvider.refund({}),
    () => disabledWechatPayProvider.verifyNotification(new Headers(), ""),
    () => disabledWechatPayProvider.handleNotification({}),
    () => disabledWechatPayProvider.reconcile("2026-01-01"),
  ];

  for (const call of methods) {
    await assert.rejects(call, (error) => error instanceof WechatPayNotConfiguredError);
  }
});

test("真实支付没有路由：没有任何 app/api 文件引用支付 provider 或读取商户配置", () => {
  const dir = path.join(ROOT, "app", "api");
  const offenders = [];
  const walk = (current) => {
    for (const entry of readdirSyncSafe(current)) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        const text = source(path.relative(ROOT, full));
        if (
          text.includes("wechatPayProvider") ||
          text.includes("WECHAT_PAY_") ||
          text.includes("createUnifiedOrder")
        ) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    }
  };
  walk(dir);
  assert.deepEqual(offenders, []);
});

function readdirSyncSafe(dir) {
  return readdirSync(dir, { withFileTypes: true });
}

/* ═══════════════════════ provider 隔离与边界 ═══════════════════════ */

test("真实回调的 import 图里没有 Mock：回调路由与真实服务都不引用 mock provider", () => {
  const callback = code("app/api/auth/wechat/callback/route.ts");
  for (const forbidden of ["mockProvider", "mockWechatLogin", "MOCK_WECHAT", "completeMockWechatLogin"]) {
    assert.equal(callback.includes(forbidden), false, `真实回调不该出现 ${forbidden}`);
  }

  const realService = code("lib/services/wechatLogin.ts");
  for (const forbidden of ["mockProvider", "MOCK_WECHAT", "completeMockWechatLogin", "findMockWechatIdentity"]) {
    assert.equal(realService.includes(forbidden), false, `真实登录服务不该引用 ${forbidden}`);
  }

  // 反向：Mock 服务不引用真实 provider（不需要 code 交换，也不该有降级路径）
  const mockService = code("lib/services/mockWechatLogin.ts");
  for (const forbidden of ["realProvider", "exchangeWechatCode", "WECHAT_APP_SECRET"]) {
    assert.equal(mockService.includes(forbidden), false, `Mock 服务不该引用 ${forbidden}`);
  }
});

test("微信登录不授予任何角色：两个登录服务都不引用客服/管理员/护航仓储", () => {
  for (const file of ["lib/services/wechatLogin.ts", "lib/services/mockWechatLogin.ts"]) {
    const text = code(file);
    for (const forbidden of [
      "authRepository",
      "staff",
      "admin",
      "companionRepository",
      "user_qualifications",
      "createRealSession(\"staff\"",
      "createRealSession(\"admin\"",
    ]) {
      assert.equal(text.includes(forbidden), false, `${file} 不该出现 ${forbidden}`);
    }
    assert.ok(text.includes('createRealSession("user"'), `${file} 只能创建普通用户会话`);
  }
});

test("客户端组件不引用服务端微信模块（密钥与会话代码不能进浏览器产物）", () => {
  // 客户端组件：只能引用 *Http 浏览器取数模块；类型导入会被擦除，允许
  for (const file of [
    "components/auth/WechatLoginButton.tsx",
    "components/auth/MockWechatLoginPanel.tsx",
  ]) {
    const text = code(file);
    for (const line of text.split("\n")) {
      if (!line.includes('from "@/')) continue;
      if (line.includes("import type")) continue;
      for (const forbidden of ["@/lib/auth/wechat", "@/lib/data/pg", "next/headers"]) {
        assert.equal(line.includes(forbidden), false, `${file} 引用服务端模块：${line.trim()}`);
      }
    }
    assert.equal(text.includes("WECHAT_APP_SECRET"), false);
    assert.ok(text.includes("wechatAuthHttp"), `${file} 应通过浏览器取数模块访问接口`);
  }

  // 两个服务端页面可以读开关，但不能直接访问数据库或密钥
  for (const file of [
    "app/(mobile)/wechat-mock/page.tsx",
    "app/(mobile)/wechat-login/page.tsx",
  ]) {
    const text = code(file);
    for (const forbidden of ["lib/data/pg", "WECHAT_APP_SECRET", "readRealWechatConfig"]) {
      assert.equal(text.includes(forbidden), false, `${file} 不该引用 ${forbidden}`);
    }
  }
});

test("状态接口只回布尔值，不下发 AppID / AppSecret / 回调地址", () => {
  const text = code("app/api/auth/wechat/status/route.ts");
  assert.ok(text.includes("getWechatLoginStatus"));
  for (const forbidden of ["WECHAT_APP_SECRET", "APP_SECRET", "readRealWechatConfig", "redirectUri", "appId"]) {
    assert.equal(text.includes(forbidden), false, `状态接口不该出现 ${forbidden}`);
  }
  assert.ok(text.includes("no-store"), "登录能力会随环境变化，不能被缓存");
});

test("Mock 页面在服务端按开关渲染：未启用时只显示「未启用」，不渲染选择控件", () => {
  const page = code("app/(mobile)/wechat-mock/page.tsx");
  assert.ok(page.includes("isMockWechatLoginEnabled"), "开关必须在服务端判断");
  assert.ok(page.includes("MockWechatLoginPanel"));

  const route = code("app/api/auth/wechat/mock/complete/route.ts");
  assert.ok(route.includes("completeMockWechatLogin"));
  assert.equal(route.includes("body.role"), false, "不接受角色字段");
  assert.equal(route.includes("body.userId"), false, "不接受用户 id");
  assert.equal(route.includes("body.openId"), false, "不接受 openid");
  assert.ok(route.includes("origin"), "必须做同源检查");
});

test("公网只读白名单没有因为微信登录而放宽", () => {
  for (const pathname of [
    "/wechat-mock",
    "/wechat-login",
    "/api/auth/wechat/status",
    "/api/auth/wechat/start",
    "/api/auth/wechat/callback",
    "/api/auth/wechat/mock/complete",
  ]) {
    assert.equal(isPublicPreviewPath(pathname), false, `${pathname} 绝不能出现在公网白名单里`);
  }
});
