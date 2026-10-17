"use client";

/* eslint-disable @next/next/no-img-element -- 与 components/home/AnnouncementCarousel.tsx 同一条理由：
   素材是 public/mock 下的本地 SVG 占位图，不经 next/image 优化器（优化器默认不处理 SVG）。
   接入对象存储后统一换成 next/image，此处只需改这一个标签。 */

import AdminStatusBadge, { CONTENT_STATUS_TONE } from "@/components/admin/AdminStatusBadge";
import {
  CONTENT_STATUS_FILTER_LABELS,
  CONTENT_STATUS_FILTERS,
  contentFilterCount,
  contentStatusOf,
  type ContentCounts,
  type ContentStatusFilter,
} from "@/components/admin/adminContentFilter";

/**
 * 图片公告的后台列表。
 *
 * ⚠️ 公告与活动 Banner 的列表**只有一份实现**（本文件导出的 `ImageMaterialTable`）：
 * 两者在数据形状上确实是同一种东西——一张图 + 一个后台标题 + 一句读屏说明 +
 * 排序 + 启用（见 `lib/constants/adminContent.ts` 的说明）。差别只在用户端怎么用，
 * 因此 Banner 的默认导出（`AdminBannerTable.tsx`）只是把类别名与口径说明绑上去。
 * 复制一份实现的代价是两张会各自漂移的界面——而它们本就该同步，运营也分不出
 * 「公告的排序」和「Banner 的排序」有什么理由不一样。
 *
 * ⚠️ 本表**不做分页**：这类运营内容是个位数到几十条，加分页会带来
 * 「改完第 3 页的排序、第 1 页没变」这类纯由分页制造的问题。
 */

/** 列表能看到的一行。公告与 Banner 的形状完全相同，因此只定义一份。 */
export type ImageMaterialRow = {
  id: string;
  title: string;
  imageUrl: string;
  alt: string;
  enabled: boolean;
  sortOrder: number;
  updatedAt: string;
  removed: boolean;
};

export type ImageMaterialTableProps = {
  /** 中文类别名（「图片公告」/「活动 Banner」），只用在表格下方的口径说明里 */
  noun: string;
  listTitle: string;
  /** 这一组内容在用户端怎么用（决定 `sortOrder` 与 `enabled` 的含义） */
  listDescription: string;
  rows: ImageMaterialRow[];
  counts: ContentCounts;
  filter: ContentStatusFilter;
  loading: boolean;
  /** 列表取数失败时的中文错误；非空时表格整体让位给错误块 */
  error: string;
  /** 有写操作正在进行：此时行内按钮全部禁用，避免在飞行中再发一次 */
  busy: boolean;
  emptyMessage: string;
  removedEmptyMessage: string;
  /** 表格下方的一句口径说明（各模块不同） */
  footerNote: string;
  onFilterChange: (filter: ContentStatusFilter) => void;
  onRetry: () => void;
  onEdit: (row: ImageMaterialRow) => void;
  onToggleEnabled: (row: ImageMaterialRow) => void;
  onRemove: (row: ImageMaterialRow) => void;
};

export function ImageMaterialTable({
  noun,
  listTitle,
  listDescription,
  rows,
  counts,
  filter,
  loading,
  error,
  busy,
  emptyMessage,
  removedEmptyMessage,
  footerNote,
  onFilterChange,
  onRetry,
  onEdit,
  onToggleEnabled,
  onRemove,
}: ImageMaterialTableProps) {
  return (
    <section className="flex flex-col">
      {/* 状态筛选：四个可点的数字，兼作这一页的「共有多少条」 */}
      <div className="flex flex-wrap items-center gap-2">
        {CONTENT_STATUS_FILTERS.map((item) => {
          const active = item === filter;
          return (
            <button
              key={item}
              type="button"
              aria-pressed={active}
              onClick={() => onFilterChange(item)}
              className={`rounded-lg border px-3 py-1.5 text-[13px] ${
                active
                  ? "border-admin-accent bg-brand-blue-soft text-ink"
                  : "border-admin-line text-ink-2 hover:bg-page"
              }`}
            >
              {CONTENT_STATUS_FILTER_LABELS[item]}
              <span className="ml-1 tabular-nums text-ink-3">
                （{contentFilterCount(counts, item)}）
              </span>
            </button>
          );
        })}

        {loading ? (
          <span role="status" aria-live="polite" className="text-[12px] text-ink-3">
            加载中…
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="mt-3 flex flex-col items-start gap-2 rounded-xl border border-admin-line bg-surface p-4">
          <p role="alert" className="text-[13px] leading-5 text-brand-red">
            {error}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page"
          >
            重试
          </button>
        </div>
      ) : null}

      {!error && rows.length === 0 ? (
        <div className="mt-3 rounded-xl border border-admin-line bg-surface p-8 text-center">
          <p className="text-[13px] text-ink-2">
            {filter === "removed" ? removedEmptyMessage : emptyMessage}
          </p>
        </div>
      ) : null}

      {!error && rows.length > 0 ? (
        // 窄屏只在**内容区**横向滚动，页面本身不横向滚，侧栏与顶栏始终在位
        <div className="mt-3 overflow-x-auto rounded-xl border border-admin-line bg-surface">
          <table className="w-full min-w-[900px] border-collapse text-[13px]">
            <caption className="sr-only">
              {listTitle}，当前筛选下 {rows.length} 条。{listDescription}
            </caption>
            <thead>
              <tr className="border-b border-admin-line text-left text-[12px] text-ink-3">
                <th scope="col" className="px-4 py-3 font-medium">
                  缩略图
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  名称
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  排序
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  状态
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  更新时间
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const status = contentStatusOf(row);

                return (
                  <tr key={row.id} className="border-b border-admin-line last:border-b-0">
                    <td className="px-4 py-3">
                      {/* `alt=""`：缩略图右边就是名称，读屏再念一遍图注只是噪音。
                          图片本身的意义写在表单的「图片说明」里，用户端会用到 */}
                      <img
                        src={row.imageUrl}
                        alt=""
                        className="h-10 w-24 rounded border border-admin-line bg-page object-cover"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <span className="block text-ink">{row.title}</span>
                      <span className="block font-mono text-[12px] text-ink-3">
                        {row.id} · {row.imageUrl}
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-ink-2">{row.sortOrder}</td>
                    <td className="px-4 py-3">
                      {/* 状态不只有颜色：label 与 description 都是必填的（§十一） */}
                      <AdminStatusBadge
                        label={status.label}
                        description={status.description}
                        tone={CONTENT_STATUS_TONE[status.key]}
                      />
                    </td>
                    <td className="px-4 py-3 text-[12px] text-ink-3">{row.updatedAt}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      {row.removed ? (
                        // 已移除是终态：服务端会拒绝改动它（事务层的 `removed` 分支），
                        // 因此这里不给按钮，只把原因写出来——灰按钮不解释自己
                        <span className="text-[12px] leading-4 text-ink-3">已移除，只能回查</span>
                      ) : (
                        <span className="flex flex-wrap gap-3">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onEdit(row)}
                            className="text-[13px] text-admin-accent underline-offset-2 hover:underline disabled:opacity-40"
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onToggleEnabled(row)}
                            className="text-[13px] text-ink-2 underline-offset-2 hover:underline disabled:opacity-40"
                          >
                            {row.enabled ? "停用" : "启用"}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onRemove(row)}
                            className="text-[13px] text-status-danger underline-offset-2 hover:underline disabled:opacity-40"
                          >
                            移除
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="mt-2 text-[12px] leading-4 text-ink-3">{footerNote}</p>

      {/* 「已启用 / 已停用」这两个筛选是在**当前已载入的那一批**里分的，
          与「已移除」不是同一层筛选。这句话必须写出来，否则运营会以为
          「全部（3）」与「已移除（2）」加起来应当等于总数 */}
      <p className="mt-1 text-[12px] leading-4 text-ink-3">
        「全部 / 已启用 / 已停用」在同一批未移除的记录里分，只有切到「已移除」会重新查一次。
        {`${noun}共 ${counts.all} 条，其中已移除 ${counts.removed} 条。`}
      </p>
    </section>
  );
}

/**
 * 由列表实现的**注入形状**：调用方（`ImageMaterialConsole`）只给行为与数据，
 * 类别名与口径说明由各模块自己补——两句话说的是「这组内容在用户端怎么用」，
 * 只有模块自己知道。
 */
export type ImageMaterialTableBodyProps = Omit<
  ImageMaterialTableProps,
  "noun" | "listTitle" | "listDescription" | "footerNote"
>;

/** 公告列表：把公告自己的类别名与两句口径说明绑上去（实现只有一份，理由见文件头）。 */
export default function AdminAnnouncementTable(props: ImageMaterialTableBodyProps) {
  return (
    <ImageMaterialTable
      {...props}
      noun="图片公告"
      listTitle="图片公告"
      listDescription={
        "用户在首页看到的是一张张自动轮播的公告图。" +
        "公告**只做图片滚动展示、不响应点击**，因此它没有可填的目标地址——" +
        "想清楚这一点再改素材：这里能调的只有图片、顺序和启用状态。"
      }
      footerNote={
        "排序值越小越靠前，用户端的轮播顺序与这里的列表顺序完全一致；" +
        "停用或移除后，用户端下一次刷新就不再轮播它。"
      }
    />
  );
}
