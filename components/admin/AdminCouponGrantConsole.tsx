"use client";

import { useRef, useState } from "react";
import EmptyState from "@/components/common/EmptyState";
import {
  fetchAdminCouponGrantOptions,
  grantAdminCoupon,
  searchAdminGrantTargets,
} from "@/lib/services/adminHttp";
import type { AdminCouponGrantOption, AdminGrantTargetUser } from "@/lib/types/coupon";
import { formatDateTime } from "@/lib/utils/format";

/**
 * 优惠券发放（`/admin/coupons/grant`）：管理员挑一张券模板，发给指定用户。
 *
 * ⚠️ 路径在 P1-6 从 `/admin/coupons` 挪到了这里——`/admin/coupons` 现在是**券模板管理**
 * （列表 → 详情 → 编辑，写 `Coupon`）。这个组件与它的接口一个字节都没改：
 * 它写的是 `CouponClaim`，与模板的增删改是两件事。
 *
 * ## 这一页只有一件事：产生一张券
 *
 * 它**不改任何既有记录**——不碰订单、不产生退款、不动订单金额。
 * 发出去的券与用户自己领的落在**同一份记录**上（`source: "admin_grant"`），
 * 因此用户端「我的优惠券」不需要任何同步动作就能看到它。
 *
 * ## 可以重复发，所以页面上没有「他已经领过了」这种拦截
 *
 * 发放**不受**「同一用户对同一模板只能领一次」的限制。这不是漏掉的一条校验，
 * 而是刻意的：平台经常要给同一个人补发、连发。真正该做的是让管理员**看得见**
 * 对方手上已经有几张（搜索结果里的「已持有 N 张」），而不是替他挡住。
 *
 * 对象也因此**在发放成功后不清空**：连续给同一个人发几张是常见操作，
 * 每发一张都要重新搜一次人、重新点一次模板，是把工具做成阻力。
 *
 * ## 不在有效期内的模板照样能选，但必须说出来
 *
 * 服务端只按 `enabled` 过滤（P1-4 裁定 §四.2）。一张 `enabled` 但有效期已经过去
 * （或尚未开始）的券，发出去也是废的。页面**不替服务端加一条它没有的硬规则**
 * （否则将来想发一张「明天开始」的券时会变成拦路石），但要把事实摆在选它的人眼前
 * ——模板行与确认发放区各警示一次，避免管理员在不知情的情况下发废券。
 *
 * ## 幂等键：一次发放意图一个键，失败重试沿用同一个
 *
 * ⚠️ 这一条在本页比别处更要紧。发券是**允许重复**的，服务端没有
 * 「一人一模板一张」的唯一索引兜底；如果「请求已到达服务端、回执丢了、
 * 管理员再点一次」时换了键，就会**真的多发一张**。因此键在第一次点击时生成、
 * 失败时**保留**、只有「成功了」或「换了发放对象」才作废
 * （与 `AdminPlatformConfigConsole` 同一套写法，见 `lib/services/adminHttp.ts` 开头的说明）。
 *
 * ## 首屏不闪、三种状态都不白屏
 *
 * 券模板由 Server Component 取好后传进来（`initialOptions`），本组件**不在挂载时
 * 再请求一次**。首屏取数失败时服务端会把错误消息一并传进来（`initialError`），
 * 这里先显示错误与「重试」，而不是整页崩掉——重试走浏览器请求。
 *
 * 搜索区四种状态分开：`idle`（还没搜过）与 `ready` 但零结果**不是一回事**，
 * 后者要能说出「没有匹配的用户」，前者该说的是「输入关键词后点搜索」；
 * 而「空关键词」这一种又不等于「查无此人」——服务端对空关键词明确返回空列表。
 */
export default function AdminCouponGrantConsole({
  /** 服务端首屏取到的券模板（只有已启用的）。 */
  initialOptions,
  /** 服务端首屏取数失败时的消息；成功时为空串。**消息原样显示，不在前端重编**。 */
  initialError,
}: {
  initialOptions: AdminCouponGrantOption[];
  initialError: string;
}) {
  const [options, setOptions] = useState(initialOptions);
  const [optionsStatus, setOptionsStatus] = useState<OptionsStatus>(
    initialError ? "error" : "ready",
  );
  const [optionsError, setOptionsError] = useState(initialError);

  const [input, setInput] = useState("");
  /** 上一次**真正发出去**的关键词。用它区分「搜完没结果」与「输入框里刚改过字」 */
  const [searchedKeyword, setSearchedKeyword] = useState("");
  const [users, setUsers] = useState<AdminGrantTargetUser[]>([]);
  const [searchStatus, setSearchStatus] = useState<SearchStatus>("idle");
  const [searchError, setSearchError] = useState("");

  const [selectedCoupon, setSelectedCoupon] = useState<AdminCouponGrantOption | null>(null);
  const [selectedUser, setSelectedUser] = useState<AdminGrantTargetUser | null>(null);

  const [busy, setBusy] = useState(false);
  const [grantError, setGrantError] = useState("");
  const [grantMessage, setGrantMessage] = useState("");

  /** 竞态：每次取数领一个自增序号，回来时序号不是最新的就丢弃。 */
  const optionsTicketRef = useRef(0);
  const searchTicketRef = useRef(0);
  /** 幂等键。`null` 表示「下一次点击是新的一次发放意图」。 */
  const keyRef = useRef<string | null>(null);

  async function loadOptions() {
    const ticket = ++optionsTicketRef.current;
    setOptionsStatus("loading");
    setOptionsError("");

    try {
      const next = await fetchAdminCouponGrantOptions();
      if (ticket !== optionsTicketRef.current) return;
      setOptions(next);
      setOptionsStatus("ready");
    } catch (cause) {
      if (ticket !== optionsTicketRef.current) return;
      setOptionsStatus("error");
      setOptionsError(cause instanceof Error ? cause.message : "券模板加载失败，请稍后重试。");
    }
  }

  async function search() {
    const ticket = ++searchTicketRef.current;
    const keyword = input.trim();
    setSearchStatus("loading");
    setSearchError("");

    try {
      const next = await searchAdminGrantTargets(keyword);
      if (ticket !== searchTicketRef.current) return;
      setUsers(next);
      setSearchedKeyword(keyword);
      setSearchStatus("ready");
    } catch (cause) {
      if (ticket !== searchTicketRef.current) return;
      setSearchStatus("error");
      setSearchError(cause instanceof Error ? cause.message : "搜索失败，请稍后重试。");
    }
  }

  /** 换发放对象 = 另一次发放意图：上一条幂等键随之作废，上一次的结果提示也不再成立。 */
  function invalidateIntent() {
    keyRef.current = null;
    setGrantError("");
    setGrantMessage("");
  }

  async function handleGrant() {
    if (busy) return;
    if (!selectedCoupon || !selectedUser) return;

    setBusy(true);
    setGrantError("");
    setGrantMessage("");

    // 失败重试沿用同一个键：这一次意图可能已经到达服务端，只是回执丢了。
    if (keyRef.current === null) keyRef.current = crypto.randomUUID();

    try {
      const result = await grantAdminCoupon({
        userId: selectedUser.id,
        couponId: selectedCoupon.id,
        idempotencyKey: keyRef.current,
      });

      // 成功了才作废：下一次点击应当是**新的一次发放**（允许给同一个人连发几张）
      keyRef.current = null;

      setGrantMessage(
        result.created
          ? `已向 ${selectedUser.nickname} 发放【${selectedCoupon.name}】。` +
              "该用户可在自己的「我的优惠券」中立即看到。"
          : "这是重复提交，未重复发放：这次提交与上一次是同一个幂等键，服务端没有第二次写入。" +
              `${selectedUser.nickname} 手上仍是那一次发出的【${selectedCoupon.name}】。` +
              "该用户可在自己的「我的优惠券」中立即看到。",
      );
    } catch (cause) {
      // 服务端说的原因（已停用 / 用户不存在 / 缺少字段）原样显示，前端不自己编一句
      setGrantError(cause instanceof Error ? cause.message : "发放失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  const canGrant = selectedCoupon !== null && selectedUser !== null && !busy;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {/* —— 券模板 —— */}
        <section className="flex flex-col gap-3 rounded-xl border border-admin-line bg-surface p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[14px] font-medium text-ink">选择优惠券模板</h2>
            <span className="text-[12px] text-ink-3">只列出已启用的模板</span>
          </div>

          {optionsStatus === "loading" ? (
            <p className="py-6 text-center text-[13px] text-ink-3">加载中…</p>
          ) : null}

          {optionsStatus === "error" ? (
            <div className="flex flex-col items-start gap-2 py-2">
              <p role="alert" className="text-[13px] leading-5 text-brand-red">
                {optionsError}
              </p>
              <button
                type="button"
                onClick={() => void loadOptions()}
                className="rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page"
              >
                重试
              </button>
            </div>
          ) : null}

          {optionsStatus === "ready" && options.length === 0 ? (
            <div className="py-6">
              <EmptyState
                title="暂无可发放的优惠券"
                description="当前没有已启用的优惠券模板。券模板的配置不在本页，本页只负责发放。"
              />
            </div>
          ) : null}

          {optionsStatus === "ready" && options.length > 0 ? (
            <div className="flex flex-col gap-2">
              {options.map((option) => {
                const active = selectedCoupon?.id === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setSelectedCoupon(option);
                      invalidateIntent();
                    }}
                    className={`flex w-full flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left ${
                      active
                        ? "border-admin-accent bg-brand-blue-soft"
                        : "border-admin-line hover:bg-page"
                    }`}
                  >
                    <span className="text-[13px] font-medium text-ink">{option.name}</span>
                    <span className="text-[12px] leading-4 text-ink-2">
                      {option.valueLabel} · {option.formLabel} · {option.conditionLabel}
                    </span>
                    <span className="text-[12px] leading-4 text-ink-3">
                      有效期 {formatDate(option.validFrom)} 至 {formatDate(option.validTo)}
                    </span>
                    {/* 不在有效期内的模板**仍然可选**（裁定只要求 enabled），但必须让选它的人看见这件事 */}
                    {option.withinValidity ? null : (
                      <span className="text-[12px] leading-4 text-status-pending">
                        {OUT_OF_VALIDITY_WARNING}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : null}
        </section>

        {/* —— 目标用户 —— */}
        <section className="flex flex-col gap-3 rounded-xl border border-admin-line bg-surface p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[14px] font-medium text-ink">选择发放目标用户</h2>
            <span className="text-[12px] text-ink-3">按用户号 / 昵称搜索</span>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-[220px] flex-1 flex-col gap-1">
              <span className="text-[12px] text-ink-3">关键词</span>
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void search();
                }}
                placeholder="输入用户号或昵称"
                className="h-9 rounded-lg border border-admin-line px-3 text-[13px] text-ink outline-none focus:border-admin-accent"
              />
            </label>

            <button
              type="button"
              onClick={() => void search()}
              disabled={searchStatus === "loading"}
              className="h-9 rounded-lg bg-ink px-5 text-[13px] font-medium text-white disabled:opacity-60"
            >
              {searchStatus === "loading" ? "搜索中…" : "搜索"}
            </button>
          </div>

          <p
            role="status"
            aria-live="polite"
            className="min-h-[18px] text-[12px] leading-[18px] text-ink-3"
          >
            {searchStatus === "loading"
              ? "加载中…"
              : searchStatus === "ready" && searchedKeyword !== ""
                ? `关键词「${searchedKeyword}」匹配到 ${users.length} 位用户`
                : ""}
          </p>

          {searchStatus === "idle" ? (
            <p className="py-4 text-center text-[13px] text-ink-3">
              输入用户号或昵称后点击「搜索」（回车同样可以）。
            </p>
          ) : null}

          {searchStatus === "error" ? (
            <div className="flex flex-col items-start gap-2 py-2">
              <p role="alert" className="text-[13px] leading-5 text-brand-red">
                {searchError}
              </p>
              <button
                type="button"
                onClick={() => void search()}
                className="rounded-lg border border-admin-line px-4 py-1.5 text-[13px] text-ink-2 hover:bg-page"
              >
                重试
              </button>
            </div>
          ) : null}

          {searchStatus === "ready" && users.length === 0 ? (
            <div className="py-4">
              {/* 「空关键词」与「没搜到这个人」是两件事：前者不是搜索失败，
                  后者才是「查无此人」。合成一句会让管理员反复重试同一个空关键词。 */}
              {searchedKeyword === "" ? (
                <EmptyState
                  title="请先输入关键词"
                  description="空关键词不会返回全部用户，请输入用户号或昵称后搜索。"
                />
              ) : (
                <EmptyState title="没有匹配的用户" description="换一个用户号或昵称再试。" />
              )}
            </div>
          ) : null}

          {searchStatus === "ready" && users.length > 0 ? (
            <div className="flex flex-col gap-2">
              {users.map((user) => {
                const active = selectedUser?.id === user.id;
                return (
                  <button
                    key={user.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setSelectedUser(user);
                      invalidateIntent();
                    }}
                    className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left ${
                      active
                        ? "border-admin-accent bg-brand-blue-soft"
                        : "border-admin-line hover:bg-page"
                    }`}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="line-clamp-1 text-[13px] font-medium text-ink">
                        {user.nickname}
                      </span>
                      <span className="font-mono text-[12px] text-ink-3">{user.displayId}</span>
                    </span>
                    {/* 「他已经有几张券」是挑人时最需要知道的一件事——发放允许重复，不靠拦 */}
                    <span className="shrink-0 text-[12px] text-ink-3">
                      已持有 {user.ownedCount} 张
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </section>
      </div>

      {/* —— 确认发放 —— */}
      <section className="flex flex-col gap-3 rounded-xl border border-admin-line bg-surface p-4">
        <h2 className="text-[14px] font-medium text-ink">确认发放</h2>

        <dl className="flex flex-col gap-2 text-[13px] leading-5">
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-ink-3">优惠券</dt>
            <dd className="text-ink">
              {selectedCoupon
                ? `${selectedCoupon.name}（${selectedCoupon.valueLabel}）`
                : "尚未选择"}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-ink-3">发放对象</dt>
            <dd className="text-ink">
              {selectedUser ? `${selectedUser.nickname}（${selectedUser.displayId}）` : "尚未选择"}
            </dd>
          </div>
        </dl>

        {/* 选中的模板不在有效期内时在这里再警示一次：确认前那一眼是最后一眼 */}
        {selectedCoupon && !selectedCoupon.withinValidity ? (
          <p className="text-[12px] leading-4 text-status-pending">{OUT_OF_VALIDITY_WARNING}</p>
        ) : null}

        {grantError ? (
          <p role="alert" className="text-[13px] leading-5 text-brand-red">
            {grantError}
          </p>
        ) : null}

        {grantMessage ? (
          <p role="status" className="text-[13px] leading-5 text-status-success">
            {grantMessage}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 border-t border-admin-line pt-4">
          <button
            type="button"
            disabled={!canGrant}
            onClick={() => void handleGrant()}
            className="rounded-lg bg-ink px-5 py-2 text-[13px] font-medium text-white disabled:opacity-60"
          >
            {busy ? "发放中…" : "确认发放"}
          </button>
          <span className="text-[12px] leading-4 text-ink-3">
            需要同时选中一个券模板与一位目标用户。发放成功后不会清空已选对象与模板，
            方便给同一个人连续发放；同一个人可以收到同一模板的多张券，各自核销一次。
          </span>
        </div>
      </section>
    </div>
  );
}

/** 券模板区域的三种状态：加载与失败只替换这一块，页面其余部分照常在位。 */
type OptionsStatus = "ready" | "loading" | "error";

/**
 * 目标用户区域的四种状态。
 *
 * ⚠️ `idle` 与「`ready` 但零结果」必须分开：前者是「还没搜过」，
 * 后者是「搜过了，没有这个人」——两句话完全不同，合并成一个空态会让人
 * 以为搜索没生效。
 */
type SearchStatus = "idle" | "loading" | "ready" | "error";

/**
 * 模板当前不在有效期内时的提示（`withinValidity === false`）。
 *
 * ⚠️ 写的是「发出的券将无法使用」而不是「不能发放」：页面**不拦**这件事
 * （服务端只按 `enabled` 过滤），只是把后果说清楚。
 *
 * ⚠️ 措辞刻意是「不在有效期内」而**不是**「已过有效期」：
 * `withinValidity` 的判定是 `now >= validFrom && now <= validTo`，
 * 因此它同时覆盖**尚未开始**的那种（种子里的「双十一预告券」就是——今天离它生效
 * 还有一个多月）。写成「已过有效期」，在那张券上就是一句错话，
 * 而管理员会照着这句话去改一个根本没错的配置。
 */
const OUT_OF_VALIDITY_WARNING = "⚠️ 不在有效期内，发出的券将无法使用";

/** 只取日期部分（有效期按天看就够，写全时间反而更难读）。与用户端券卡片同一口径。 */
function formatDate(iso: string): string {
  return formatDateTime(iso).slice(0, 10);
}
