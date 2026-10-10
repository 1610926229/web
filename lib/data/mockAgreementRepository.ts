import { agreementSeed } from "@/lib/mocks/fixtures/agreementSeed";
import type { Agreement, AgreementSection } from "@/lib/types/agreement";
import { getMockStore } from "./mockStore";
import type {
  AgreementPatch,
  AgreementRepository,
  AgreementWriteResult,
} from "./agreementRepository";

/**
 * 协议记录的**进程内** Mock 存储（P8E-1 起**可写**）。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后回到预置内容；
 * 不写 localStorage、不写文件、不写数据库。将来由真实数据库替换，
 * 本文件的删除不影响上层接口。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`。
 *
 * 建仓时把预置数据**逐字段、逐层复制**进 Map，而不是把 `agreementSeed` 里的对象
 * 直接放进去：后台会改这些记录，如果 Map 里存的就是模块级常量里的那个对象，
 * 一次编辑就把常量改了——测试之间互相污染，热更新后也再也回不到初始数据。
 * `sections` 是二维结构，因此要**连段落数组再复制一层**：只复制外层的话，
 * 一次「往第 1 节加一段」会写进种子文件里的那个数组
 * （与 `mockCatalogRepository` / `mockContentRepository` 同）。
 *
 * 并发安全的前提：Node 是单线程的，本文件里每个写入方法内部都没有 `await`，
 * 因此它们各自是一个原子动作；而「重放判定 + 写业务 + 写审计」这三件事合起来的
 * 原子性由 `lib/data/adminAgreementTransaction.ts` 保证。
 *
 * ⚠️ `agreementStore()` 是**导出**的：后台写操作要在一段不可打断的同步区段里
 * 同时写「业务记录 + 审计」，那段伪事务在 `lib/data/adminAgreementTransaction.ts`。
 * 除它以外不要从别处取这个 store。
 */

type MockAgreementStore = {
  agreements: Map<string, Agreement>;
};

/** 段落深拷贝。事务层也要用，因此**导出**——「一份协议的深拷贝是什么意思」只应有一处定义。 */
export function cloneSections(sections: readonly AgreementSection[]): AgreementSection[] {
  return sections.map((section) => ({
    heading: section.heading,
    paragraphs: [...section.paragraphs],
  }));
}

/** 整条记录的深拷贝。返回的是新对象，调用方改它不会动到 store 里那一份。 */
export function cloneAgreement(record: Agreement): Agreement {
  return { ...record, sections: cloneSections(record.sections) };
}

function createStore(): MockAgreementStore {
  const agreements = new Map<string, Agreement>(
    agreementSeed.map((record) => [record.id, cloneAgreement(record)]),
  );
  if (agreements.size !== agreementSeed.length) {
    throw new Error("预置协议存在重复 id");
  }
  return { agreements };
}

export function agreementStore(): MockAgreementStore {
  return getMockStore("agreement", createStore);
}

/** 本文件内部取 store 的短名字。 */
function store(): MockAgreementStore {
  return agreementStore();
}

export const mockAgreementRepository: AgreementRepository = {
  async listAgreements() {
    return [...store().agreements.values()].map(cloneAgreement);
  },

  async findAgreementById(id) {
    const found = store().agreements.get(id);
    return found ? cloneAgreement(found) : null;
  },

  /**
   * 覆盖式更新：返回改动前后的两份**副本**。
   *
   * `previous` 必须是复制出来的：如果返回 Map 里那个对象本身，调用方紧接着的一次写入
   * 会把 `previous` 一起改掉——审计快照里的 before 于是变成了 after，
   * 而「这次改了什么」正是审计唯一要回答的问题。
   */
  async updateAgreement(id, patch: AgreementPatch): Promise<AgreementWriteResult | null> {
    const existing = store().agreements.get(id);
    if (!existing) return null;

    const previous = cloneAgreement(existing);
    const next: Agreement = {
      // 身份字段显式写回来：它们不可能来自 patch（类型上就没有），
      // 这里再写一次是为了让「改不掉的字段」看得见
      id: existing.id,
      type: existing.type,
      title: patch.title,
      // 深拷贝：store 与调用方手上的数组从此互不影响
      sections: cloneSections(patch.sections),
      version: patch.version,
      updatedAt: patch.at,
      enabled: patch.enabled,
    };

    store().agreements.set(id, next);
    return { previous, updated: cloneAgreement(next) };
  },

  /**
   * 只改启用状态。
   *
   * 已经是目标状态时**原样返回**（`previous` 与 `updated` 值相等），不刷新 `updatedAt`：
   * 「点了一次已经停用的停用按钮」不该在记录上留下一次改动痕迹——那会让后台看到
   * 「最后修改时间刚刚变过」，而实际上什么都没改。
   *
   * ⚠️ 这条路径**不动 `version`**：启用状态不是正文的版本
   * （理由见 `lib/data/agreementRepository.ts`）。
   */
  async setAgreementEnabled(id, enabled, at): Promise<AgreementWriteResult | null> {
    const existing = store().agreements.get(id);
    if (!existing) return null;

    if (existing.enabled === enabled) {
      const copy = cloneAgreement(existing);
      return { previous: copy, updated: cloneAgreement(existing) };
    }

    const previous = cloneAgreement(existing);
    const next: Agreement = { ...previous, enabled, updatedAt: at };
    store().agreements.set(id, next);
    return { previous, updated: cloneAgreement(next) };
  },
};
