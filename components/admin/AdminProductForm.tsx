"use client";

/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import { useRef, useState } from "react";
import AdminCharacterCounter from "@/components/admin/AdminCharacterCounter";
import AdminConfirmDialog from "@/components/admin/AdminConfirmDialog";
import { AdminField, AdminToggleButton } from "@/components/admin/AdminFormField";
import AdminSpecEditor, {
  toAdminSpecRow,
  toProductSpecInput,
  type AdminSpecRow,
} from "@/components/admin/AdminSpecEditor";
import {
  ADMIN_PRODUCT_ACTION_LABELS,
  ADMIN_PRODUCT_CONFIRM_TEXTS,
  ADMIN_PRODUCT_EDIT_TITLE,
  ADMIN_PRODUCT_NEW_TITLE,
  DETAIL_IMAGE_MAX_COUNT,
  PRODUCT_DETAIL_TEXT_MAX_LENGTH,
  PRODUCT_FIELD_LABELS,
  PRODUCT_SORT_ORDER_MAX,
  PRODUCT_SORT_ORDER_MIN,
  PRODUCT_SUBTITLE_MAX_LENGTH,
  PRODUCT_TAG_TOO_LONG_MESSAGE,
  PRODUCT_TITLE_MAX_LENGTH,
  TAG_MAX_COUNT,
  TAG_MAX_LENGTH,
  firstProductProfileErrorField,
  hasProductProfileError,
  normalizeProductProfilePatch,
  productProfileFieldErrors,
  productSpecErrors,
  type ProductProfileField,
  type ProductProfileFieldErrors,
  type ProductProfileInput,
  type ProductSpecRowErrors,
} from "@/lib/constants/adminProducts";
import { createProduct, saveProductProfile } from "@/lib/services/adminHttp";
import type {
  AdminProductFormOptions,
  AdminProductListItem,
  AdminProductWriteResult,
} from "@/lib/types/product";
import { countCharacters } from "@/lib/utils/text";

/** 还没提交过时的逐行规格错误。`AdminSpecEditor` 按下标取，空数组等于「每一行都没错」。 */
const NO_SPEC_ROW_ERRORS: ProductSpecRowErrors = [];

/**
 * 商品表单 —— 新建与编辑共用一份（含单组规格编辑器）。
 *
 * 能改的字段就是下面这一整份：所属游戏与类目、标题、副标题、封面、标签、
 * 图文详情（文字 + 图片）、展示排序、推荐状态、上下架状态、**以及全部规格**。
 * `monthlySales`（销量）、`gameTag`、`createdAt`、`updatedAt`、`removedAt`、`id`
 * **在界面上没有输入框、在接口入参里也没有位置**——客户端多传一个不会有任何效果
 * （§八、§九），因为服务层根本没有读取它们的地方。
 *
 * 三条与其它管理端表单一致的做法：
 *
 * 1. **不用 HTML `maxLength` 静默截断**：可以一直输入，字数实时显示、超限变红，
 *    由校验给出明确错误。截断会让人以为「我已经写完了」。
 * 2. **错误贴在字段旁边**（`aria-invalid` + `aria-describedby` + `role="alert"`），
 *    并把**第一条**出错的字段聚焦过去。字段的 DOM 顺序刻意与
 *    `PRODUCT_FIELD_LABELS` 的键顺序一致，这样「第一条」就是「最靠上的那条」。
 * 3. **校验与服务端共用同一份函数**（`productProfileFieldErrors()` /
 *    `normalizeProductProfilePatch()`），而且提交出去的**就是归一化的产物本身**，
 *    服务端读的字段与这里写下的字段逐个对得上，不会出现「前端说能提交、服务端却拒绝」。
 *    ⚠️ 金额也不例外：产物里的规格行带的是 `priceYuan`（元文本），元转分只发生在
 *    服务端。这里曾经把归一化理解成「顺便把价格转成分」，于是发出去的是 `price`、
 *    服务端读的是 `priceYuan`，界面上填 `10` 会被判成非法单价、商品建不出来。
 *    与其它表单一样，错误在**提交时**才出现——边输入边标红会让「还没来得及填」
 *    看起来像「填错了」；字数上限是例外，它一直实时可见。
 *
 * ⚠️ 图片只能从**白名单**里选（封面单选、详情图多选），当前值额外放行：
 * 预置数据里有一条封面地址刻意写错的调试商品，不放行的话它连标题都改不动。
 * 这份「当前值」取自**服务端返回的记录**，不是请求体——否则白名单就等于没有。
 *
 * ⚠️ 商品与规格是**一次原子写入**：在一次保存里要么一起生效、要么都不生效，
 * 因此这里没有「先保存商品再保存规格」的两步操作。
 */
export default function AdminProductForm({
  record,
  options,
  message,
  onSaved,
}: {
  /** 编辑时的原始记录；**新建时显式传 `null`** */
  record: AdminProductListItem | null;
  /** 游戏、类目（含停用与已移除）、两组图片白名单，全部来自服务端 */
  options: AdminProductFormOptions;
  /** 上一次保存的结果，由父组件持有——保存成功后本表单会以服务端最新值重挂载 */
  message?: string;
  onSaved: (result: AdminProductWriteResult, message: string) => void;
}) {
  const isCreate = record === null;

  const [gameId, setGameId] = useState(record?.gameId ?? "");
  const [categoryId, setCategoryId] = useState(record?.categoryId ?? "");
  const [title, setTitle] = useState(record?.title ?? "");
  const [subtitle, setSubtitle] = useState(record?.subtitle ?? "");
  const [coverUrl, setCoverUrl] = useState(record?.coverUrl ?? options.coverOptions[0] ?? "");
  const [tags, setTags] = useState<string[]>(record?.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);
  const [detailText, setDetailText] = useState(record?.detailText ?? "");
  const [detailImages, setDetailImages] = useState<string[]>(record?.detailImages ?? []);
  const [sortOrder, setSortOrder] = useState(record ? String(record.sortOrder) : "0");
  const [recommended, setRecommended] = useState(record?.recommended ?? false);
  const [status, setStatus] = useState(record?.status ?? "off");
  const [specRows, setSpecRows] = useState<AdminSpecRow[]>(
    record ? record.specs.map(toAdminSpecRow) : [],
  );

  const [errors, setErrors] = useState<ProductProfileFieldErrors | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // 幂等键：**同一份意图**的重复提交复用同一个 key（保存失败后再点、确认框里连点两次），
  // 服务端因此只会写一次。换一次意图（改了字段重新提交）才换 key。
  const keyRef = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  // 逐行规格错误**实时**算：它必须与当前行一一对应，否则删掉一行之后
  // 旧下标会把「第 3 行的错」标到第 2 行上
  const liveSpecErrors = productSpecErrors(specRows.map(toProductSpecInput));

  /**
   * 把焦点移到出错的字段上（§十一：第一条错误自动聚焦）。
   *
   * ⚠️ 这里**不**用「每个字段一个 ref 回调、渲染期往 map 里写」的写法：
   * 那等于在渲染期改 ref，React 明确不允许。改成一次 DOM 查询——
   * 表单里每个字段都带 `data-product-field`；容器类字段（标签组、图片组、规格组）
   * 还要 `tabIndex={-1}` 才真的接得住焦点。
   */
  function focusField(field: ProductProfileField | null) {
    if (!field) return;
    formRef.current?.querySelector<HTMLElement>(`[data-product-field="${field}"]`)?.focus();
  }

  const titleCount = countCharacters(title.trim());
  const subtitleCount = countCharacters(subtitle.trim());
  const detailTextCount = countCharacters(detailText.trim());

  // 类目选项跟着所选游戏走；`gameId` 为空时不过滤（此时游戏的错误已经报出来了）
  const categoryOptions = options.categories.filter(
    (category) => gameId === "" || category.gameId === gameId,
  );
  const selectedCategory = categoryOptions.find((category) => category.id === categoryId) ?? null;
  const categoryUnusable =
    selectedCategory !== null && (selectedCategory.removedAt !== null || !selectedCategory.enabled);

  /**
   * 白名单之外、但**当前正在用**的那几张图。
   *
   * 必须显示出来：一条封面地址不在白名单里的既有商品，如果选择器里没有它，
   * 保存时要么被拒绝（人不知道为什么），要么被悄悄换成第一张图（更糟）。
   */
  const coverCandidates = [...options.coverOptions];
  if (coverUrl && !coverCandidates.includes(coverUrl)) coverCandidates.unshift(coverUrl);

  const detailImageCandidates = [...options.detailImageOptions];
  for (const url of detailImages) {
    if (!detailImageCandidates.includes(url)) detailImageCandidates.unshift(url);
  }

  function currentInput(): ProductProfileInput {
    const trimmed = sortOrder.trim();
    return {
      gameId,
      categoryId,
      title,
      subtitle,
      coverUrl,
      tags,
      detailText,
      detailImages,
      // 空串与非数字都变成 NaN：校验会给出「展示排序只能是…」，而不是静默当成 0 写进去
      sortOrder: trimmed === "" ? Number.NaN : Number(trimmed),
      recommended,
      status,
      specs: specRows.map(toProductSpecInput),
    };
  }

  function validationOptions() {
    return {
      games: options.games,
      categories: options.categories,
      // 白名单的例外只认**服务端存着的那份值**，不认界面上的当前值：
      // 否则「先选一张白名单外的、再把它当成当前值」就能绕过白名单
      currentCoverUrl: record?.coverUrl ?? "",
      currentDetailImages: record?.detailImages ?? [],
    };
  }

  async function save(key: string) {
    const patch = normalizeProductProfilePatch(currentInput(), validationOptions());
    if (patch === null) {
      // 正常路径上到不了这里（提交前已经校验并拦下）。留一条兜底，
      // 免得「忘了先校验」的时候把没校验过的数据发出去
      setSubmitError("表单校验未通过，请检查标红的字段");
      return;
    }

    setBusy(true);
    setSubmitError(null);

    try {
      const result =
        record === null
          ? await createProduct(key, patch)
          : await saveProductProfile(record.id, key, patch);

      keyRef.current = null;
      setConfirming(false);

      if (record === null) {
        onSaved(result, "已创建，用户端首页、分类页、详情与结算页立即生效");
        return;
      }
      onSaved(
        result,
        result.changed
          ? "已保存，用户端首页、分类页、详情与结算页立即生效；历史订单读的是下单快照，不受影响"
          : "没有需要保存的改动",
      );
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : "保存失败，请稍后重试。";
      // 确认框开着时错误显示在框里，否则显示在表单底部
      if (confirming) setConfirmError(text);
      else setSubmitError(text);
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    const next = productProfileFieldErrors(currentInput(), validationOptions());
    setErrors(next);
    setSubmitError(null);

    if (hasProductProfileError(next)) {
      // 字段顺序即页面顺序，所以「第一条」就是最靠上的那条
      focusField(firstProductProfileErrorField(next));
      return;
    }

    keyRef.current = crypto.randomUUID();

    // 上下架状态变了要二次确认：上架会让它立刻出现在用户端，下架会让它从列表里消失
    if (record !== null && status !== record.status) {
      setConfirmError(null);
      setConfirming(true);
      return;
    }

    void save(keyRef.current);
  }

  /** 字段级的公共属性：有错误就 `aria-invalid` + `aria-describedby` + 红框。 */
  function fieldProps(field: ProductProfileField) {
    const text = errors?.[field] ?? null;
    return {
      "aria-invalid": text ? true : undefined,
      "aria-describedby": text ? `product-${field}-error` : undefined,
      className: `rounded-lg border px-3 text-[13px] text-ink outline-none ${
        text ? "border-status-danger" : "border-admin-line focus:border-admin-accent"
      }`,
      message: text,
    };
  }

  function addTag() {
    const value = tagInput.trim();
    if (!value) return;
    // 标签输入框没有 `maxLength`：超长、重复、超条数都在这里给出明确说法，
    // 而不是让输入静默少几个字
    if (countCharacters(value) > TAG_MAX_LENGTH) {
      setTagError(PRODUCT_TAG_TOO_LONG_MESSAGE);
      return;
    }
    if (tags.includes(value)) {
      setTagError("这个标签已经加过了");
      return;
    }
    if (tags.length >= TAG_MAX_COUNT) {
      setTagError(`最多 ${TAG_MAX_COUNT} 个标签`);
      return;
    }
    setTags([...tags, value]);
    setTagInput("");
    setTagError(null);
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      noValidate
      className="flex flex-col gap-4 rounded-xl border border-admin-line bg-surface p-4"
    >
      <div>
        <h2 className="text-[15px] font-medium text-ink">
          {isCreate ? ADMIN_PRODUCT_NEW_TITLE : ADMIN_PRODUCT_EDIT_TITLE}
        </h2>
        <p className="mt-1 text-[12px] leading-4 text-ink-3">
          商品与它的全部规格一次保存、一起生效；保存后用户端读到的就是这份新值，
          历史订单读的是下单快照，不受影响。
        </p>
      </div>

      {/* 1 / 2 所属游戏与所属类目 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <AdminField
          label={PRODUCT_FIELD_LABELS.gameId}
          error={fieldProps("gameId").message}
          errorId="product-gameId-error"
          hint="换游戏会清空所属类目——类目必须与游戏一致"
          htmlFor="product-gameId"
        >
          <select
            id="product-gameId"
            data-product-field="gameId"
            value={gameId}
            onChange={(event) => {
              setGameId(event.target.value);
              // 类目必须属于所选游戏：不一起清掉的话，它会立刻变成「不属于所选游戏」，
              // 而人只是改了游戏，根本没动过类目
              setCategoryId("");
            }}
            aria-invalid={fieldProps("gameId")["aria-invalid"]}
            aria-describedby={fieldProps("gameId")["aria-describedby"]}
            className={`h-9 w-full ${fieldProps("gameId").className}`}
          >
            <option value="">请选择游戏</option>
            {options.games.map((game) => (
              <option key={game.id} value={game.id}>
                {game.name}
              </option>
            ))}
          </select>
        </AdminField>

        {/* 选项里含停用与已移除的类目：既有商品要能把自己的类目显示出来 */}
        <AdminField
          label={PRODUCT_FIELD_LABELS.categoryId}
          error={fieldProps("categoryId").message}
          errorId="product-categoryId-error"
          hint={
            categoryUnusable
              ? "当前类目已停用或已移除，保存前必须换一个可用类目（或先把那个类目启用）"
              : "停用或已移除的类目不能用于新建、编辑归属与上架"
          }
          htmlFor="product-categoryId"
        >
          <select
            id="product-categoryId"
            data-product-field="categoryId"
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            aria-invalid={fieldProps("categoryId")["aria-invalid"]}
            aria-describedby={fieldProps("categoryId")["aria-describedby"]}
            className={`h-9 w-full ${fieldProps("categoryId").className}`}
          >
            <option value="">请选择类目</option>
            {categoryOptions.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
                {category.removedAt !== null ? "（已移除）" : category.enabled ? "" : "（已停用）"}
              </option>
            ))}
          </select>
        </AdminField>
      </div>

      {/* 3 / 4 标题与副标题 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <AdminField
          label={PRODUCT_FIELD_LABELS.title}
          error={fieldProps("title").message}
          errorId="product-title-error"
          hint="价格写在规格里，标题里出现价格会被拒绝"
          counter={<AdminCharacterCounter current={titleCount} max={PRODUCT_TITLE_MAX_LENGTH} />}
          htmlFor="product-title"
        >
          <input
            id="product-title"
            data-product-field="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-invalid={fieldProps("title")["aria-invalid"]}
            aria-describedby={fieldProps("title")["aria-describedby"]}
            className={`h-9 w-full ${fieldProps("title").className}`}
          />
        </AdminField>

        <AdminField
          label={PRODUCT_FIELD_LABELS.subtitle}
          error={fieldProps("subtitle").message}
          errorId="product-subtitle-error"
          counter={
            <AdminCharacterCounter current={subtitleCount} max={PRODUCT_SUBTITLE_MAX_LENGTH} />
          }
          htmlFor="product-subtitle"
        >
          <input
            id="product-subtitle"
            data-product-field="subtitle"
            value={subtitle}
            onChange={(event) => setSubtitle(event.target.value)}
            aria-invalid={fieldProps("subtitle")["aria-invalid"]}
            aria-describedby={fieldProps("subtitle")["aria-describedby"]}
            className={`h-9 w-full ${fieldProps("subtitle").className}`}
          />
        </AdminField>
      </div>

      {/* 5 封面：单选，只能从白名单里挑 */}
      <AdminField
        label={PRODUCT_FIELD_LABELS.coverUrl}
        error={fieldProps("coverUrl").message}
        errorId="product-coverUrl-error"
        hint="只能从平台提供的 Mock 图片里选；当前封面即使不在白名单里也会列出来"
      >
        <div
          role="radiogroup"
          tabIndex={-1}
          data-product-field="coverUrl"
          aria-label={PRODUCT_FIELD_LABELS.coverUrl}
          aria-invalid={fieldProps("coverUrl")["aria-invalid"]}
          aria-describedby={fieldProps("coverUrl")["aria-describedby"]}
          className="flex flex-wrap gap-2"
        >
          {coverCandidates.map((option) => {
            const active = option === coverUrl;
            const allowed = options.coverOptions.includes(option);
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={`封面 ${option}`}
                onClick={() => setCoverUrl(option)}
                className={`rounded-lg border-2 p-0.5 ${
                  active ? "border-admin-accent" : "border-transparent"
                }`}
              >
                <img
                  src={option}
                  alt=""
                  className="h-14 w-20 rounded border border-admin-line object-cover"
                />
                {allowed ? null : (
                  <span className="block text-[11px] leading-4 text-ink-3">当前（不在白名单）</span>
                )}
              </button>
            );
          })}
        </div>
      </AdminField>

      {/* 6 标签：自由文本，回车添加 */}
      <AdminField
        label={PRODUCT_FIELD_LABELS.tags}
        error={fieldProps("tags").message ?? tagError}
        errorId="product-tags-error"
        hint={`最多 ${TAG_MAX_COUNT} 个，每个不超过 ${TAG_MAX_LENGTH} 个字；回车添加`}
      >
        <div
          role="group"
          tabIndex={-1}
          data-product-field="tags"
          aria-label={PRODUCT_FIELD_LABELS.tags}
          aria-describedby={fieldProps("tags")["aria-describedby"]}
          className="flex flex-col gap-2"
        >
          <div className="flex flex-wrap gap-2">
            {tags.length === 0 ? (
              <span className="text-[13px] text-ink-3">还没有标签</span>
            ) : (
              tags.map((tag) => (
                <span
                  key={tag}
                  className="flex items-center gap-2 rounded-lg border border-admin-line px-3 py-1 text-[13px] text-ink-2"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => setTags(tags.filter((item) => item !== tag))}
                    aria-label={`移除标签 ${tag}`}
                    className="text-ink-3 hover:text-ink"
                  >
                    ×
                  </button>
                </span>
              ))
            )}
          </div>
          <input
            value={tagInput}
            onChange={(event) => {
              setTagInput(event.target.value);
              setTagError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                // 回车是「加一个标签」，不是提交表单
                event.preventDefault();
                addTag();
              }
            }}
            aria-label="新增标签"
            aria-invalid={tagError ? true : undefined}
            className={`h-9 ${fieldProps("tags").className}`}
          />
        </div>
      </AdminField>

      {/* 7 图文详情（文字） */}
      <AdminField
        label={PRODUCT_FIELD_LABELS.detailText}
        error={fieldProps("detailText").message}
        errorId="product-detailText-error"
        counter={
          <AdminCharacterCounter current={detailTextCount} max={PRODUCT_DETAIL_TEXT_MAX_LENGTH} />
        }
        htmlFor="product-detailText"
      >
        <textarea
          id="product-detailText"
          data-product-field="detailText"
          value={detailText}
          onChange={(event) => setDetailText(event.target.value)}
          rows={4}
          aria-invalid={fieldProps("detailText")["aria-invalid"]}
          aria-describedby={fieldProps("detailText")["aria-describedby"]}
          className={`w-full resize-y py-2 ${fieldProps("detailText").className}`}
        />
      </AdminField>

      {/* 8 图文详情（图片，多选，白名单） */}
      <AdminField
        label={PRODUCT_FIELD_LABELS.detailImages}
        error={fieldProps("detailImages").message}
        errorId="product-detailImages-error"
        hint={`最多 ${DETAIL_IMAGE_MAX_COUNT} 张，只能从 Mock 图片里选`}
        counter={
          <AdminCharacterCounter current={detailImages.length} max={DETAIL_IMAGE_MAX_COUNT} />
        }
      >
        <div
          role="group"
          tabIndex={-1}
          data-product-field="detailImages"
          aria-label={PRODUCT_FIELD_LABELS.detailImages}
          aria-describedby={fieldProps("detailImages")["aria-describedby"]}
          className="flex flex-wrap gap-2"
        >
          {detailImageCandidates.map((option) => {
            const active = detailImages.includes(option);
            const allowed = options.detailImageOptions.includes(option);
            return (
              <button
                key={option}
                type="button"
                aria-pressed={active}
                aria-label={`详情图 ${option}`}
                onClick={() =>
                  setDetailImages(
                    active
                      ? detailImages.filter((item) => item !== option)
                      : [...detailImages, option],
                  )
                }
                className={`rounded-lg border-2 p-0.5 ${
                  active ? "border-admin-accent" : "border-transparent"
                }`}
              >
                <img
                  src={option}
                  alt=""
                  className="h-14 w-20 rounded border border-admin-line object-cover"
                />
                {allowed ? null : (
                  <span className="block text-[11px] leading-4 text-ink-3">当前（不在白名单）</span>
                )}
              </button>
            );
          })}
        </div>
      </AdminField>

      {/* 9 / 10 / 11 展示排序、推荐状态、上下架状态 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <AdminField
          label={PRODUCT_FIELD_LABELS.sortOrder}
          error={fieldProps("sortOrder").message}
          errorId="product-sortOrder-error"
          hint={`${PRODUCT_SORT_ORDER_MIN} 到 ${PRODUCT_SORT_ORDER_MAX}，越小越靠前`}
          htmlFor="product-sortOrder"
        >
          <input
            id="product-sortOrder"
            data-product-field="sortOrder"
            value={sortOrder}
            inputMode="numeric"
            onChange={(event) => setSortOrder(event.target.value)}
            aria-invalid={fieldProps("sortOrder")["aria-invalid"]}
            aria-describedby={fieldProps("sortOrder")["aria-describedby"]}
            className={`h-9 w-full ${fieldProps("sortOrder").className}`}
          />
        </AdminField>

        <AdminField
          label={PRODUCT_FIELD_LABELS.recommended}
          hint="只影响后台标记与首页推荐位，不改变列表排序"
        >
          <div
            role="radiogroup"
            tabIndex={-1}
            data-product-field="recommended"
            aria-label={PRODUCT_FIELD_LABELS.recommended}
            className="flex gap-2"
          >
            <AdminToggleButton
              active={recommended}
              onClick={() => setRecommended(true)}
              label="推荐"
            />
            <AdminToggleButton
              active={!recommended}
              onClick={() => setRecommended(false)}
              label="不推荐"
            />
          </div>
        </AdminField>

        <AdminField
          label={PRODUCT_FIELD_LABELS.status}
          error={fieldProps("status").message}
          errorId="product-status-error"
          hint="上架要求至少有一条有效规格；下架后直链仍显示「已下架」但不能结算"
        >
          <div
            role="radiogroup"
            tabIndex={-1}
            data-product-field="status"
            aria-label={PRODUCT_FIELD_LABELS.status}
            aria-invalid={fieldProps("status")["aria-invalid"]}
            aria-describedby={fieldProps("status")["aria-describedby"]}
            className="flex gap-2"
          >
            <AdminToggleButton active={status === "on"} onClick={() => setStatus("on")} label="上架" />
            <AdminToggleButton
              active={status === "off"}
              onClick={() => setStatus("off")}
              label="下架"
            />
          </div>
        </AdminField>
      </div>

      {/* 12 规格：与商品一起原子写入 */}
      <AdminSpecEditor
        rows={specRows}
        // 逐行错误在**提交时**才出现，与其它字段一致：刚点出来的空行不该立刻变红。
        // 但错误内容始终按当前行实时算——删掉一行之后，旧下标不能把
        // 「第 3 行的错」标到第 2 行上
        errors={errors === null ? NO_SPEC_ROW_ERRORS : liveSpecErrors.rows}
        groupError={fieldProps("specs").message}
        disabled={busy}
        onChange={setSpecRows}
      />

      <div className="flex flex-wrap items-center gap-3 border-t border-admin-line pt-4">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-ink px-5 py-2 text-[13px] font-medium text-white disabled:opacity-60"
        >
          {busy
            ? "保存中…"
            : isCreate
              ? ADMIN_PRODUCT_ACTION_LABELS.create
              : ADMIN_PRODUCT_ACTION_LABELS.save}
        </button>
        <span className="text-[12px] leading-4 text-ink-3">
          销量、平台标签、创建时间由系统维护，这里没有它们。
        </span>
      </div>

      {message ? (
        <p role="status" className="text-[13px] leading-5 text-status-success">
          {message}
        </p>
      ) : null}

      {submitError ? (
        <p role="alert" className="text-[13px] leading-5 text-brand-red">
          {submitError}
        </p>
      ) : null}

      <AdminConfirmDialog
        open={confirming}
        title={`${status === "on" ? "上架" : "下架"}这件商品`}
        description={
          status === "on"
            ? ADMIN_PRODUCT_CONFIRM_TEXTS.publish
            : ADMIN_PRODUCT_CONFIRM_TEXTS.unpublish
        }
        confirmLabel={`确认${status === "on" ? "上架" : "下架"}`}
        // 上架是可恢复的常规动作，下架会让商品从用户端列表消失——两个色调刻意不同
        tone={status === "on" ? "primary" : "danger"}
        pending={busy}
        error={confirmError}
        onConfirm={() => {
          const key = keyRef.current;
          if (key) void save(key);
        }}
        onCancel={() => {
          if (busy) return;
          // 取消后丢掉这个幂等键：下次提交是一次**新的意图**，不是这次的重试
          keyRef.current = null;
          setConfirming(false);
          setConfirmError(null);
        }}
      />
    </form>
  );
}
