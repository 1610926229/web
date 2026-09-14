import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { getMessageRepository } from "../lib/data/messageRepository.ts";
import { resetMockStore } from "../lib/data/mockStore.ts";
import { getStaffRepository } from "../lib/data/staffRepository.ts";
import {
  listConversationsForUser,
  markConversationReadForUser,
  sendMessageForUser,
} from "../lib/services/conversations.ts";
import {
  listConversationsForStaff,
  markStaffConversationRead,
  resolveStaffConversationListQuery,
  sendMessageForStaff,
} from "../lib/services/staffConversations.ts";

/**
 * 跨角色回归：**双向已读互不干扰**。
 *
 * ⚠️ 这个文件的存在理由是一次人工验收失败，而且这次失败**不是数据错了**：
 * 客服发消息后用户侧 `unreadCount` 算得对、标记已读也真的写进了仓储，
 * 但用户从会话页返回 `/service` 时红点不消失（客服侧 `unread=1` 同理）。
 * 根因在浏览器侧的前进/后退缓存复用了旧快照，属于 `.tsx` 客户端组件范畴，
 * 本仓库的测试架构**覆盖不了**（Node 不做 JSX 转译，见 CLAUDE.md）——
 * 那一半只能靠人工复验与真实浏览器，修法与证据见验收说明。
 *
 * 那为什么还要加这个文件？因为排查时**没有一条测试能回答**「两侧的已读到底是不是
 * 独立的」。已有的用例各自只验证一侧：`service.test.mjs` 只读用户侧，
 * `staff.test.mjs` 只读客服侧，没有一个把两位读者的动作**交错**排在一起。
 * 于是「客服读一下把用户未读也清了」这种最危险的回归，全绿也发现不了。
 *
 * 这里按用户验收要求组织三条链：
 *
 * - **Case 1**：客服发 → 用户读。用户未读归零，客服未读不受影响。
 * - **Case 2**：用户发 → 客服读。客服未读归零、且**退出 `unread=1` 列表**，
 *   用户未读不受影响。
 * - **Case 3（交错，最重要）**：双方互发 → 用户先读 → 客服后读，
 *   每一步都断言「另一侧原地不动」。
 *
 * ⚠️ 口径（§三）：未读是 `发送者不是当前读者 AND 消息位置晚于当前读者的已读位置`，
 * 是**每位读者各自一条游标**，不是按最后一条消息 / `updatedAt` / 双方共用一个布尔标记。
 * 因此每个用例结尾都会断言「读完之后对方再发一条，未读会重新长回来」——
 * 共用标记或「读完就置一个 flag」的实现过不了这一关。
 *
 * ⚠️ 已读是**独立元数据**：标记已读不删除、不改写任何一条消息。
 * 最后一条用例用字符串指纹把这一点钉死。
 */

const USER = "u-1001";
const STAFF = "staff-1";
const SURFACE = "server";

/** 有会话、三种发送者都出现过的一单：双向发消息都走它。 */
const ORDER = "ord-seed-1001-04";
/** 另一单有会话的订单：验证「读这一单不影响那一单」。 */
const OTHER_ORDER = "ord-seed-1001-03";

function key() {
  return crypto.randomUUID();
}

function page(params = {}) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

function listQuery(overrides = {}) {
  return resolveStaffConversationListQuery(page(overrides), true);
}

/** 服务层读的那份客服会话：只拼 `requireStaff()` 返回里真正被用的字段。 */
async function staffSessionOf(staffId) {
  const account = await getStaffRepository().findStaffById(staffId);
  assert.ok(account, `预置客服账号缺失：${staffId}`);
  return { id: account.id, displayName: account.displayName, avatarUrl: account.avatarUrl };
}

/** 用户侧某一单的未读数。`null` = 这一单根本不在用户的会话列表里。 */
async function userUnreadOf(orderId) {
  const rows = await listConversationsForUser(USER, undefined, SURFACE);
  return rows.find((row) => row.orderId === orderId)?.unreadCount ?? null;
}

/**
 * 客服侧某一单的未读数。
 *
 * ⚠️ 取的是**不筛未读**的完整列表，而不是 `unread=1` 那一页：
 * 只从未读页里找，会把「这一单读掉了」和「这一单压根不在列表里」混为一谈。
 */
async function staffUnreadOf(orderId) {
  const data = await listConversationsForStaff(STAFF, listQuery(), undefined, SURFACE);
  return data.items.find((item) => item.orderId === orderId)?.unreadCount ?? null;
}

/** 客服点「只看未读」那一页真实看到的订单号，顺序按服务端（最后消息时间倒序）。 */
async function staffUnreadOrderIds() {
  const params = page({ unread: 1 });
  const data = await listConversationsForStaff(
    STAFF,
    resolveStaffConversationListQuery(params, true),
    params,
    SURFACE,
  );
  return data.items.map((item) => item.orderId);
}

/**
 * 等到「下一个毫秒」再发下一条消息。
 *
 * ⚠️ 未读口径是 `createdAt > 已读位置`（**严格大于**），同一个时间点不算未读——
 * 这是既有且刻意的语义，`staff.test.mjs`「同一个时间点不算未读」那条用例钉着它。
 * 标记已读写入的是真实当前时间，紧接着发的消息若落在同一毫秒，就不会被算成未读。
 * 真实链路上两者之间隔着一次 HTTP 往返，不可能同毫秒；测试里不显式推一下时间，
 * 「读完之后新消息重新变成未读」这条断言就会随机红。
 */
async function nextMillisecond() {
  const start = Date.now();
  while (Date.now() === start) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function staffSends(staff, body, orderId = ORDER) {
  return sendMessageForStaff(staff, orderId, { body, idempotencyKey: key() }, undefined, SURFACE);
}

async function userSends(body, orderId = ORDER) {
  return sendMessageForUser(USER, orderId, { body, idempotencyKey: key() }, undefined, SURFACE);
}

beforeEach(() => {
  resetMockStore("message");
  resetMockStore("staff");
});

// ───────────────────────── Case 1：客服发 → 用户读 ─────────────────────────

test("Case 1：客服发消息后用户未读 +1；用户读过只清自己，客服未读不受影响", async () => {
  const staff = await staffSessionOf(STAFF);

  const userBefore = await userUnreadOf(ORDER);
  const staffBefore = await staffUnreadOf(ORDER);
  assert.equal(typeof userBefore, "number", `${ORDER} 应当本来就在用户的会话列表里`);

  // 客服发一条 → 用户侧应当多一条未读
  await staffSends(staff, "跨角色回归：你的订单已受理，稍后安排。");
  assert.equal(
    await userUnreadOf(ORDER),
    userBefore + 1,
    "客服发来的消息没有算进用户未读",
  );
  assert.equal(
    await staffUnreadOf(ORDER),
    staffBefore,
    "客服自己发消息不该让自己的未读变化",
  );

  // 用户读过 → 自己的未读归零
  assert.equal(await markConversationReadForUser(USER, ORDER), true);
  assert.equal(await userUnreadOf(ORDER), 0, "用户标记已读后自己的未读没有归零");

  // ⚠️ 硬要求：用户读**不**影响客服侧
  assert.equal(
    await staffUnreadOf(ORDER),
    staffBefore,
    "用户读了自己的未读，把客服侧的未读一起清掉了——两侧必须独立",
  );

  // 再来的新消息必须重新变成未读：未读是「位置」算出来的，不是读完后置的一个标记
  await nextMillisecond();
  await staffSends(staff, "跨角色回归：护航已经接单。");
  assert.equal(
    await userUnreadOf(ORDER),
    1,
    "读完之后客服再发一条，用户未读没有重新长回来（未读被实现成了布尔标记？）",
  );
});

// ───────────────────────── Case 2：用户发 → 客服读 ─────────────────────────

test("Case 2：用户发消息后客服未读 +1 且进入 unread=1；客服读过只清自己，用户未读不受影响", async () => {
  const userBefore = await userUnreadOf(ORDER);
  const staffBefore = await staffUnreadOf(ORDER);

  // 用户发一条 → 客服侧应当多一条未读
  await userSends("跨角色回归：请问还要多久？");
  assert.equal(
    await staffUnreadOf(ORDER),
    staffBefore + 1,
    "用户发来的消息没有算进客服未读",
  );
  assert.equal(await userUnreadOf(ORDER), userBefore, "用户自己发消息不该让自己的未读变化");

  // §七：`unread=1` 必须是 repository/query 的结论，不是前端临时藏行
  assert.ok(
    (await staffUnreadOrderIds()).includes(ORDER),
    `${ORDER} 有未读，却没有出现在客服的 unread=1 列表里`,
  );

  // 客服读过 → 自己的未读归零，并且**退出** unread=1
  assert.equal(await markStaffConversationRead(STAFF, ORDER), true);
  assert.equal(await staffUnreadOf(ORDER), 0, "客服标记已读后自己的未读没有归零");
  assert.equal(
    (await staffUnreadOrderIds()).includes(ORDER),
    false,
    "客服读过了，会话却还留在 unread=1 列表里",
  );

  // ⚠️ 硬要求：客服读**不**影响用户侧
  assert.equal(
    await userUnreadOf(ORDER),
    userBefore,
    "客服读了自己的未读，把用户侧的未读一起清掉了——两侧必须独立",
  );

  // 同上：新消息要能重新变成未读
  await nextMillisecond();
  await userSends("跨角色回归：补充一下，订单号在上面。");
  assert.equal(
    await staffUnreadOf(ORDER),
    1,
    "读完之后用户再发一条，客服未读没有重新长回来",
  );
});

// ───────────────────── Case 3：交错（最重要的一条）─────────────────────

test("Case 3（交错）：双方互发后各自读自己的，任何一步都不动对方", async () => {
  const staff = await staffSessionOf(STAFF);

  // 种子里本来就有未读，因此这里记**基线**、只断言增量：
  // 写死数字等于把种子抄进断言，改一次种子就要改一堆用例。
  const userBase = await userUnreadOf(ORDER);
  const staffBase = await staffUnreadOf(ORDER);

  // 双方各说各的，顺序交替：客服 → 用户 → 客服 → 用户
  await staffSends(staff, "跨角色回归：在的，请讲。");
  await userSends("跨角色回归：护航掉线了。");
  await staffSends(staff, "跨角色回归：我核实一下。");
  await userSends("跨角色回归：好的，等你消息。");

  // 此刻：用户多了两处未读（两条客服消息），客服多了两处（两条用户消息）
  assert.equal(
    await userUnreadOf(ORDER),
    userBase + 2,
    "交错发完，用户未读的增量不等于客服发来的条数",
  );
  assert.equal(
    await staffUnreadOf(ORDER),
    staffBase + 2,
    "交错发完，客服未读的增量不等于用户发来的条数",
  );

  // —— 用户先读 ——
  await markConversationReadForUser(USER, ORDER);
  assert.equal(await userUnreadOf(ORDER), 0, "用户读过之后自己的未读没有归零");
  assert.equal(
    await staffUnreadOf(ORDER),
    staffBase + 2,
    "用户读了自己的未读，把客服侧的一起清了——这是本用例要挡住的回归",
  );
  assert.ok(
    (await staffUnreadOrderIds()).includes(ORDER),
    "用户读完之后，客服的 unread=1 列表里这一单不该消失",
  );

  // —— 客服后读 ——
  await markStaffConversationRead(STAFF, ORDER);
  assert.equal(await staffUnreadOf(ORDER), 0, "客服读过之后自己的未读没有归零");
  assert.equal(
    (await staffUnreadOrderIds()).includes(ORDER),
    false,
    "客服读过了，会话却还留在 unread=1 列表里",
  );
  assert.equal(
    await userUnreadOf(ORDER),
    0,
    "客服读了自己的未读，把用户侧的未读又改了（用户侧此刻本来就该是 0，但必须是被用户自己读掉的）",
  );

  // —— 交错再来一轮：两侧的游标都停在「读到这里」，新消息从游标之后再算 ——
  await nextMillisecond();
  await staffSends(staff, "跨角色回归：已恢复，继续。");
  assert.equal(await userUnreadOf(ORDER), 1, "新一轮客服消息没有变成用户未读");
  assert.equal(await staffUnreadOf(ORDER), 0, "客服自己发的新消息让自己变成未读了");

  await nextMillisecond();
  await userSends("跨角色回归：收到。");
  assert.equal(await userUnreadOf(ORDER), 1, "用户自己发的新消息让自己变成未读了");
  assert.equal(await staffUnreadOf(ORDER), 1, "新一轮用户消息没有变成客服未读");

  // 读其中一单不能顺带清掉另一单
  assert.equal(typeof (await userUnreadOf(OTHER_ORDER)), "number");
  const otherBefore = await userUnreadOf(OTHER_ORDER);
  await markConversationReadForUser(USER, ORDER);
  assert.equal(
    await userUnreadOf(OTHER_ORDER),
    otherBefore,
    "读 A 单把 B 单的未读也清了——已读游标必须按会话独立",
  );
});

// ──────────────── 已读是独立元数据：不碰消息历史（§九）────────────────

test("标记已读不动消息：条数、正文、发送者、时间与顺序在双向标记前后完全一致", async () => {
  const staff = await staffSessionOf(STAFF);
  await staffSends(staff, "跨角色回归：历史保真度检查（客服）。");
  await userSends("跨角色回归：历史保真度检查（用户）。");

  // 取**字符串快照**而不是对象引用：仓储若原地改写对象，引用比较会永远相等，
  // 这条断言就成了摆设（与同目录「订单指纹」用例同一做法）。
  const fingerprint = async () =>
    JSON.stringify(await getMessageRepository().listMessages(USER, ORDER));

  const before = await fingerprint();
  assert.ok(
    JSON.parse(before).length > 0,
    `${ORDER} 应当有预置消息（没有消息，这条指纹用例什么也守不住）`,
  );

  await markConversationReadForUser(USER, ORDER);
  await markStaffConversationRead(STAFF, ORDER);

  assert.equal(
    await fingerprint(),
    before,
    "标记已读改动了消息历史——已读必须是独立元数据，不删除、不改写任何一条消息",
  );

  // 顺序仍然按时间先后，没有因为写入已读位置而重排
  const messages = await getMessageRepository().listMessages(USER, ORDER);
  for (let i = 1; i < messages.length; i += 1) {
    assert.ok(
      messages[i - 1].createdAt <= messages[i].createdAt,
      "标记已读之后消息不再按时间先后排列",
    );
  }
});
