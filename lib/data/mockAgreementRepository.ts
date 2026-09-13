import { agreementSeed } from "@/lib/mocks/fixtures/agreementSeed";
import type { Agreement, AgreementSection } from "@/lib/types/agreement";
import { getMockStore } from "./mockStore";
import type { AgreementRepository } from "./agreementRepository";

/**
 * 协议记录的**进程内** Mock 存储 —— 只读。
 *
 * ⚠️ 仅用于本地开发：数据只在内存里，开发服务器重启后回到预置内容；
 * 不写 localStorage、不写文件、不写数据库。
 *
 * store 的挂载与建仓语义见 `lib/data/mockStore.ts`。本仓储没有任何写入方法
 * （原因见 `lib/data/agreementRepository.ts`）。
 *
 * 建仓时深拷贝到段落级：调用方拿到的正文与种子数据不共享可变对象，
 * 一次渲染期间的改写不会污染后续请求。
 */

type MockAgreementStore = {
  agreements: Map<string, Agreement>;
};

function cloneSections(sections: readonly AgreementSection[]): AgreementSection[] {
  return sections.map((section) => ({
    heading: section.heading,
    paragraphs: [...section.paragraphs],
  }));
}

function cloneAgreement(record: Agreement): Agreement {
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

function store(): MockAgreementStore {
  return getMockStore("agreement", createStore);
}

export const mockAgreementRepository: AgreementRepository = {
  async listAgreements() {
    return [...store().agreements.values()].map(cloneAgreement);
  },
};
