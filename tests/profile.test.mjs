import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  AVATAR_INVALID_MESSAGE,
  AVATAR_REQUIRED_MESSAGE,
  BIO_MAX_LENGTH,
  BIO_TOO_LONG_MESSAGE,
  MOCK_AVATAR_OPTIONS,
  NICKNAME_MAX_LENGTH,
  NICKNAME_REQUIRED_MESSAGE,
  NICKNAME_TOO_LONG_MESSAGE,
  countProfileCharacters,
  isAllowedAvatar,
  normalizeBio,
  normalizeNickname,
  profileFieldErrors,
} from "../lib/constants/profile.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { toSessionUser } from "../lib/data/userRepository.ts";
import { getDataSource } from "../lib/data/source.ts";
import { userSeed } from "../lib/mocks/fixtures/seed.ts";
import { getUserProfile, toUserProfile, updateUserProfile } from "../lib/services/profile.ts";
import { countCharacters } from "../lib/utils/text.ts";

/**
 * 用户资料的持续测试。
 *
 * 跑的是**真实实现**：真实的 Mock 仓储 + 真实的 `lib/services/profile.ts`，
 * 因此「只能改自己的资料」「请求体里的用户标识无效」「昵称必填、去空格、限长」
 * 「头像只接受白名单」「改完能重新读到」「不污染种子常量」这些规则每次提交都会被重新验证，
 * 而不是一次性脚本。
 *
 * 每个用例开始前重建用户 store（拿到干净的预置数据）。
 */
const USER_A = "u-1001";
const USER_B = "u-1002";

/** 当前用户已经存着的头像：用来验证「不换头像也必须能保存」。 */
const CURRENT_AVATAR = MOCK_AVATAR_OPTIONS[0];

function profileBody(overrides = {}) {
  return {
    nickname: "改过的昵称",
    avatarUrl: CURRENT_AVATAR,
    bio: "改过的简介",
    ...overrides,
  };
}

async function expectApiError(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  });
}

beforeEach(() => {
  resetMockStore("user");
});

test("资料 DTO 就是五项公开字段：不含微信身份与内部角色", async () => {
  const profile = await getUserProfile(USER_A, undefined, "server");

  assert.deepEqual(
    Object.keys(profile).sort(),
    ["avatarUrl", "bio", "displayId", "id", "nickname"],
  );

  // 显式挑字段的转换函数：记录上将来多出任何字段都不会顺势外泄
  const record = await getDataSource().findUserById(USER_A);
  const derived = toUserProfile({ ...record, displayId: record.id, bio: "" });
  assert.deepEqual(
    Object.keys(derived).sort(),
    ["avatarUrl", "bio", "displayId", "id", "nickname"],
  );

  // 会话用户 DTO 只有三项，同样不含内部身份
  assert.deepEqual(Object.keys(toSessionUser(userSeed[0])).sort(), ["avatarUrl", "id", "nickname"]);
});

test("displayId 是平台自己的编号，与用户 id 不是同一个值", () => {
  for (const seed of userSeed) {
    assert.ok(seed.displayId, `${seed.id} 缺少 displayId`);
    assert.notEqual(seed.displayId, seed.id);
  }
});

test("修改资料后重新读取保持一致，且会话里看到的昵称同步更新", async () => {
  const updated = await updateUserProfile(
    USER_A,
    profileBody({ nickname: "  新昵称  ", bio: "  新简介  " }),
    undefined,
    "server",
  );

  // 去掉了首尾空格
  assert.equal(updated.nickname, "新昵称");
  assert.equal(updated.bio, "新简介");

  // 重新读取（相当于刷新页面）：同一进程内数据仍然在，内容一致
  const reread = await getUserProfile(USER_A, undefined, "server");
  assert.deepEqual(reread, updated);

  // 会话读的是同一个 store，因此不会出现「页面改了、会话还是旧昵称」
  const session = await getDataSource().findUserById(USER_A);
  assert.equal(session.nickname, "新昵称");
  assert.equal(session.avatarUrl, updated.avatarUrl);
});

test("请求体里的用户标识无效：伪造 userId / id / displayId 都改不到别人", async () => {
  const beforeB = await getUserProfile(USER_B, undefined, "server");

  const updated = await updateUserProfile(
    USER_A,
    profileBody({
      nickname: "A 的新昵称",
      userId: USER_B,
      id: USER_B,
      displayId: "伪造的平台编号",
    }),
    undefined,
    "server",
  );

  // 改的只有 A
  assert.equal(updated.id, USER_A);
  assert.equal(updated.nickname, "A 的新昵称");
  // 平台编号不可编辑，因此伪造值被忽略，原值保留
  assert.notEqual(updated.displayId, "伪造的平台编号");
  assert.equal(updated.displayId, userSeed[0].displayId);

  // B 一个字都没变
  assert.deepEqual(await getUserProfile(USER_B, undefined, "server"), beforeB);
});

test("昵称为空、纯空格、超长都会被拒绝，且不留下任何修改", async () => {
  const before = await getUserProfile(USER_A, undefined, "server");

  await expectApiError(
    updateUserProfile(USER_A, profileBody({ nickname: "" }), undefined, "server"),
    "BAD_REQUEST",
    NICKNAME_REQUIRED_MESSAGE,
  );
  await expectApiError(
    updateUserProfile(USER_A, profileBody({ nickname: "   " }), undefined, "server"),
    "BAD_REQUEST",
    NICKNAME_REQUIRED_MESSAGE,
  );
  await expectApiError(
    updateUserProfile(
      USER_A,
      profileBody({ nickname: "字".repeat(NICKNAME_MAX_LENGTH + 1) }),
      undefined,
      "server",
    ),
    "BAD_REQUEST",
    NICKNAME_TOO_LONG_MESSAGE,
  );

  // 刚好等于上限是合法的（边界不能少一个字符）
  const atLimit = await updateUserProfile(
    USER_A,
    profileBody({ nickname: "字".repeat(NICKNAME_MAX_LENGTH) }),
    undefined,
    "server",
  );
  assert.equal(atLimit.nickname.length, NICKNAME_MAX_LENGTH);

  // 被拒绝的提交不能改动其他字段（头像与简介保持原值）
  assert.equal(atLimit.avatarUrl, before.avatarUrl);
});

test("简介超长被拒绝；留空合法并回落为空串", async () => {
  await expectApiError(
    updateUserProfile(
      USER_A,
      profileBody({ bio: "字".repeat(BIO_MAX_LENGTH + 1) }),
      undefined,
      "server",
    ),
    "BAD_REQUEST",
    BIO_TOO_LONG_MESSAGE,
  );

  const empty = await updateUserProfile(USER_A, profileBody({ bio: "   " }), undefined, "server");
  assert.equal(empty.bio, "");

  const atLimit = await updateUserProfile(
    USER_A,
    profileBody({ bio: "字".repeat(BIO_MAX_LENGTH) }),
    undefined,
    "server",
  );
  assert.equal(atLimit.bio.length, BIO_MAX_LENGTH);
});

test("头像只接受白名单内或当前值：本地路径与编造的远程地址都被拒绝", async () => {
  const before = await getUserProfile(USER_A, undefined, "server");

  for (const avatarUrl of [
    "C:\\Users\\someone\\photo.png",
    "/Users/someone/photo.png",
    "https://example.com/avatar.png",
    "",
  ]) {
    await expectApiError(
      updateUserProfile(USER_A, profileBody({ avatarUrl }), undefined, "server"),
      "BAD_REQUEST",
      avatarUrl === "" ? AVATAR_REQUIRED_MESSAGE : AVATAR_INVALID_MESSAGE,
    );
  }

  // 原头像没被改动
  const after = await getUserProfile(USER_A, undefined, "server");
  assert.equal(after.avatarUrl, before.avatarUrl);

  // 白名单内的另一个头像可以保存
  const switched = await updateUserProfile(
    USER_A,
    profileBody({ avatarUrl: MOCK_AVATAR_OPTIONS[2] }),
    undefined,
    "server",
  );
  assert.equal(switched.avatarUrl, MOCK_AVATAR_OPTIONS[2]);
});

test("用户只能改自己的资料：改别人的 id 不做任何事（不存在就 404）", async () => {
  await expectApiError(
    updateUserProfile("u-does-not-exist", profileBody(), undefined, "server"),
    "NOT_FOUND",
  );
  await expectApiError(
    updateUserProfile("", profileBody(), undefined, "server"),
    "NOT_FOUND",
  );

  // 不存在的用户读不到资料，也不会编一份出来
  assert.equal(await getUserProfile("u-does-not-exist", undefined, "server"), null);
});

test("编辑资料不修改导入的种子常量（避免测试之间互相污染）", async () => {
  const seedBefore = { ...userSeed[0] };

  await updateUserProfile(USER_A, profileBody({ nickname: "不该写回种子" }), undefined, "server");

  assert.deepEqual({ ...userSeed[0] }, seedBefore);
  assert.notEqual(userSeed[0].nickname, "不该写回种子");
});

test("纯规则函数：昵称与简介的规范化", () => {
  assert.deepEqual(normalizeNickname("  abc  "), { ok: true, nickname: "abc" });
  assert.deepEqual(normalizeNickname("   "), { ok: false, message: NICKNAME_REQUIRED_MESSAGE });
  assert.deepEqual(normalizeNickname(""), { ok: false, message: NICKNAME_REQUIRED_MESSAGE });
  assert.equal(normalizeNickname("字".repeat(NICKNAME_MAX_LENGTH + 1)).ok, false);
  assert.equal(normalizeNickname("字".repeat(NICKNAME_MAX_LENGTH)).ok, true);

  assert.deepEqual(normalizeBio(""), { ok: true, bio: "" });
  assert.deepEqual(normalizeBio("  hi  "), { ok: true, bio: "hi" });
  assert.equal(normalizeBio("字".repeat(BIO_MAX_LENGTH + 1)).ok, false);

  assert.equal(isAllowedAvatar(MOCK_AVATAR_OPTIONS[1], CURRENT_AVATAR), true);
  assert.equal(isAllowedAvatar(CURRENT_AVATAR, CURRENT_AVATAR), true);
  assert.equal(isAllowedAvatar("https://example.com/a.png", CURRENT_AVATAR), false);
  // 空串永远不接受，即便「当前值」恰好是空串
  assert.equal(isAllowedAvatar("", ""), false);
});

// ——————————————— 字符计数：前端计数、服务端校验、测试三方共用 ———————————————

test("字符计数：汉字、字母、数字都算 1，普通 Emoji 也只算 1", () => {
  assert.equal(countCharacters(""), 0);
  assert.equal(countCharacters("中"), 1);
  assert.equal(countCharacters("a"), 1);
  assert.equal(countCharacters("7"), 1);
  assert.equal(countCharacters("abc"), 3);

  // 关键一条：😀 在 UTF-16 里占两个 code unit，但用户眼里就是一个字符
  assert.equal("😀".length, 2);
  assert.equal(countCharacters("😀"), 1);
  assert.equal(countCharacters("😀😀😀"), 3);

  // 中文 + 英文 + Emoji 混排
  assert.equal(countCharacters("老王abc😀"), 6);
});

test("长度上限是 15 个字符，文案与产品要求逐字一致", () => {
  assert.equal(NICKNAME_MAX_LENGTH, 15);
  assert.equal(NICKNAME_REQUIRED_MESSAGE, "请输入昵称");
  assert.equal(NICKNAME_TOO_LONG_MESSAGE, "昵称不能超过15个字符");
  assert.equal(BIO_TOO_LONG_MESSAGE, `个人简介不能超过${BIO_MAX_LENGTH}个字符`);
});

test("昵称边界：15 个字符合法、16 个被拒，中英文与 Emoji 同一套计数", async () => {
  for (const unit of ["字", "a", "😀"]) {
    // 恰好 15：必须能保存下来（Emoji 那条正是「按 code point 计数」的意义所在）
    const saved = await updateUserProfile(
      USER_A,
      profileBody({ nickname: unit.repeat(NICKNAME_MAX_LENGTH) }),
      undefined,
      "server",
    );
    assert.equal(countCharacters(saved.nickname), NICKNAME_MAX_LENGTH);

    // 第 16 个：服务端拒绝，文案与前端一致（客户端拦不住时也走这条）
    await expectApiError(
      updateUserProfile(
        USER_A,
        profileBody({ nickname: unit.repeat(NICKNAME_MAX_LENGTH + 1) }),
        undefined,
        "server",
      ),
      "BAD_REQUEST",
      NICKNAME_TOO_LONG_MESSAGE,
    );
  }

  // 全是空格（含制表符与换行）同样被拒，提示的是「请输入昵称」
  for (const raw of ["   ", "\t\n", "　　"]) {
    await expectApiError(
      updateUserProfile(USER_A, profileBody({ nickname: raw }), undefined, "server"),
      "BAD_REQUEST",
      NICKNAME_REQUIRED_MESSAGE,
    );
  }

  // 被拒绝之后，资料仍然是上一次成功保存的那份
  const current = await getUserProfile(USER_A, undefined, "server");
  assert.equal(current.nickname, "😀".repeat(NICKNAME_MAX_LENGTH));
});

test("简介边界：恰好到达上限合法、超一个字符被拒，Emoji 同样只算一个", async () => {
  const atLimit = await updateUserProfile(
    USER_A,
    profileBody({ bio: "😀".repeat(BIO_MAX_LENGTH) }),
    undefined,
    "server",
  );
  assert.equal(countCharacters(atLimit.bio), BIO_MAX_LENGTH);

  await expectApiError(
    updateUserProfile(
      USER_A,
      profileBody({ bio: "😀".repeat(BIO_MAX_LENGTH + 1) }),
      undefined,
      "server",
    ),
    "BAD_REQUEST",
    BIO_TOO_LONG_MESSAGE,
  );

  // 简介的首尾空白统一去掉；中间换行保留（不擅自改动用户的排版）
  const trimmed = await updateUserProfile(
    USER_A,
    profileBody({ bio: "  第一行\n第二行  " }),
    undefined,
    "server",
  );
  assert.equal(trimmed.bio, "第一行\n第二行");
});

test("超长与超限一律在服务端拒绝：客户端改不了规则", async () => {
  const before = await getUserProfile(USER_A, undefined, "server");

  // 直接照服务端的最小要求造请求体（模拟绕过前端校验的调用）
  await expectApiError(
    updateUserProfile(
      USER_A,
      { nickname: "x".repeat(NICKNAME_MAX_LENGTH + 1), avatarUrl: CURRENT_AVATAR, bio: "" },
      undefined,
      "server",
    ),
    "BAD_REQUEST",
    NICKNAME_TOO_LONG_MESSAGE,
  );
  await expectApiError(
    updateUserProfile(
      USER_A,
      { nickname: "合法昵称", avatarUrl: CURRENT_AVATAR, bio: "y".repeat(BIO_MAX_LENGTH + 1) },
      undefined,
      "server",
    ),
    "BAD_REQUEST",
    BIO_TOO_LONG_MESSAGE,
  );

  // 两次被拒都没有改动任何字段
  const after = await getUserProfile(USER_A, undefined, "server");
  assert.deepEqual(after, before);
});

// ——————————————— 表单即时反馈：全空格、超限、改回合法 ———————————————

test("表单即时错误：全空格提示「请输入昵称」，超限立刻提示，改回合法立即消失", () => {
  const at = (nickname, bio = "", attempted = false) =>
    profileFieldErrors({ nickname, bio, avatarUrl: CURRENT_AVATAR, attempted });

  // 还没点过保存：只报「超限」，不报「你还没填」——否则页面一打开就是一片红
  assert.equal(at("").nickname, null);
  assert.equal(at("   ").nickname, null);

  // 点过保存后：空串、纯空格（含制表符、换行、全角空格）都提示「请输入昵称」
  for (const raw of ["", "   ", "\t\n", "　　"]) {
    assert.equal(at(raw, "", true).nickname, NICKNAME_REQUIRED_MESSAGE);
  }

  // 超限不等提交：打进第 16 个字符就有反馈
  assert.equal(at("字".repeat(NICKNAME_MAX_LENGTH)).nickname, null);
  assert.equal(at("字".repeat(NICKNAME_MAX_LENGTH + 1)).nickname, NICKNAME_TOO_LONG_MESSAGE);
  assert.equal(at("😀".repeat(NICKNAME_MAX_LENGTH)).nickname, null);
  assert.equal(at("😀".repeat(NICKNAME_MAX_LENGTH + 1)).nickname, NICKNAME_TOO_LONG_MESSAGE);

  // 删回合法长度：错误自己消失（错误是推导出来的，不会留一份过期状态）
  assert.equal(
    at("字".repeat(NICKNAME_MAX_LENGTH + 1), "", true).nickname,
    NICKNAME_TOO_LONG_MESSAGE,
  );
  assert.equal(at("字".repeat(NICKNAME_MAX_LENGTH), "", true).nickname, null);

  // 首尾空格不计入：末尾多敲几个空格也不会被顶过上限
  assert.equal(at(`${"字".repeat(NICKNAME_MAX_LENGTH)}   `).nickname, null);

  // 简介走同一套规则
  assert.equal(at("合法昵称", "字".repeat(BIO_MAX_LENGTH)).bio, null);
  assert.equal(at("合法昵称", "字".repeat(BIO_MAX_LENGTH + 1)).bio, BIO_TOO_LONG_MESSAGE);
  assert.equal(at("合法昵称", "").bio, null);

  // 头像未选（正常流程下不会出现）同样按这一套提示
  assert.equal(
    profileFieldErrors({ nickname: "合法昵称", bio: "", avatarUrl: "", attempted: false }).avatar,
    null,
  );
  assert.equal(
    profileFieldErrors({ nickname: "合法昵称", bio: "", avatarUrl: "", attempted: true }).avatar,
    AVATAR_REQUIRED_MESSAGE,
  );
});

test("表单字数与保存后的值一致：去首尾空格、Emoji 算一个", () => {
  assert.equal(countProfileCharacters("  老板A  "), 3);
  assert.equal(countProfileCharacters(""), 0);
  assert.equal(countProfileCharacters("    "), 0);
  assert.equal(countProfileCharacters("😀".repeat(NICKNAME_MAX_LENGTH)), NICKNAME_MAX_LENGTH);
  assert.equal(countProfileCharacters("a".repeat(20)), 20);
});
