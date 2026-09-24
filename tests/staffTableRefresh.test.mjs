import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 客服工作台列表页的回归门禁：**服务端快照必须能被客户端采纳**。
 *
 * 这一条守的是一次人工验收失败：`useState(initialResult)` 与页头的
 * `StaffRefreshButton`（`router.refresh()`）组合在一起，会让「刷新」变成一颗死按钮——
 * `refresh()` 会重新渲染 Server Component，却**刻意保留客户端 state**
 * （内置文档 `01-app/03-api-reference/04-functions/use-router.md`：
 * merge the updated RSC payload *without losing unaffected client-side React
 * (e.g. `useState`)*），而 `useState` 的初值只在首次挂载时生效。结果是：
 * 服务端重新查到了新数据、也把它发了下来，表格却继续显示打开页面时的那一份。
 *
 * ⚠️ **为什么是读源码而不是渲染**：这三张表是 `.tsx`，Node 只剥类型不剥 JSX，
 * `node --test` 加载不了客户端组件（见 CLAUDE.md），React 的 state 采纳行为在本仓库
 * **没有可执行的测法**。所以这里做的是**门禁**，不是行为测试：把「谁把 initialResult
 * 存进了 state」与「谁把新快照采纳回来」钉在一起——任何一张表少了后一半就直接失败。
 *
 * ⚠️ 它**证明不了** React 的行为，也证明不了点一下「刷新」真的会更新（那需要浏览器）。
 * 它证明的是：这个修法不会再被悄悄改回去。真正的复验步骤见验收说明。
 *
 * ⚠️ 管理端那 8 张列表页也有同样的 `useState(initialResult)`，但它们的页面**没有**刷新
 * 按钮，缺陷一直是休眠的；本门禁只覆盖客服侧有刷新按钮的四张表（P0-8 起加完成材料），
 * 不越界去改管理端。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAFF_COMPONENT_DIR = path.join(ROOT, "components", "staff");

/**
 * 预期存在「服务端快照 → useState」这个写法的文件清单。
 *
 * 与「管理接口清单」同一套做法：**清单是精确的**，多一个少一个都要在这里显式改一次——
 * 将来新加一张表时，这条断言会逼着人来确认它有没有一起把快照采纳回来。
 */
const TABLES_WITH_SERVER_SNAPSHOT = [
  "StaffComplaintTable.tsx",
  "StaffCompletionTable.tsx",
  "StaffConversationTable.tsx",
  "StaffRefundTable.tsx",
];

/** 采纳新快照的判据：拿 `initialResult` 的**引用**与已采纳的那一份比较。 */
const ADOPTS_SERVER_SNAPSHOT = /\bif\s*\(\s*\w+\s*!==\s*initialResult\s*\)/;
/** 采纳必须落到真正被渲染的那份数据上（只更新一个影子 state 等于没改）。 */
const ADOPTS_INTO_RESULT = /setResult\(initialResult\)/;

function source(file) {
  return readFileSync(path.join(STAFF_COMPONENT_DIR, file), "utf8");
}

test("客服侧把服务端快照存进 state 的表，就是这张清单（新增表必须显式确认）", () => {
  const found = readdirSync(STAFF_COMPONENT_DIR)
    .filter((name) => name.endsWith(".tsx"))
    .filter((name) => /useState\(\s*initialResult\s*\)/.test(source(name)))
    .sort();

  assert.deepEqual(
    found,
    [...TABLES_WITH_SERVER_SNAPSHOT].sort(),
    "有表把服务端快照存进了 useState，清单却没跟着更新——请确认它是否也需要采纳新快照",
  );
});

for (const file of TABLES_WITH_SERVER_SNAPSHOT) {
  test(`${file}：服务端重新取数后必须采纳新快照（否则「刷新」是死按钮）`, () => {
    const text = source(file);

    assert.match(
      text,
      ADOPTS_SERVER_SNAPSHOT,
      `${file} 把 initialResult 存进了 useState，却没有任何地方采纳新的服务端快照：` +
        "router.refresh() 保留客户端 state，客服点「刷新」将永远看不到新数据",
    );
    assert.match(
      text,
      ADOPTS_INTO_RESULT,
      `${file} 没有把新快照写回真正渲染的那份数据（setResult(initialResult)）`,
    );
  });
}

test("客服四张表的页面都有刷新按钮——所以那四张表都必须过上一组断言", () => {
  const pages = [
    "app/staff/(console)/complaints/(list)/page.tsx",
    "app/staff/(console)/completions/(list)/page.tsx",
    "app/staff/(console)/refunds/(list)/page.tsx",
    "app/staff/(console)/conversations/(list)/page.tsx",
  ];

  for (const page of pages) {
    const text = readFileSync(path.join(ROOT, page), "utf8");
    assert.match(text, /StaffRefreshButton/, `${page} 的刷新按钮不见了（本门禁的前提）`);
  }
});
