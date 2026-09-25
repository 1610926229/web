/* eslint-disable @next/next/no-img-element -- Mock 阶段使用 public/mock 下的本地 SVG 占位图，
   不经 next/image 优化器（优化器默认不支持 SVG）。接入对象存储后统一替换为 next/image。 */

import Link from "next/link";
import { DetailRow, FieldBlock, Section } from "@/components/admin/AdminDetailSection";
import AdminStatusBadge, { ORDER_STATUS_TONE } from "@/components/admin/AdminStatusBadge";
import { STAFF_ORDER_READONLY_NOTICE } from "@/lib/constants/staff";
import type { StaffComplaintListItem } from "@/lib/types/complaint";
import type { StaffCompletionListItem } from "@/lib/types/completion";
import type { OrderStatus, OrderTimelineEntry } from "@/lib/types/order";
import type { StaffRefundListItem } from "@/lib/types/refund";
import type { StaffOrderDetail, StaffOrderDispatchSummary } from "@/lib/types/staff";
import { formatDateTime, formatYuan } from "@/lib/utils/format";

/**
 * 客服工作台订单详情（`/staff/orders/[id]`）的各摘要区。
 *
 * 单独成文件而不是塞进页面：页面只负责「鉴权 → 取一条 → 404」，
 * 展示部分有七个互相独立的区块（订单信息 / 用户 / 下单内容 / 金额 / 派单 / 售后 / 时间轴），
 * 每个区块都有自己的边界说明；合进页面会变成两百多行、读不出结构的一段。
 * 与 `app/staff/(console)/refunds/[id]/page.tsx` 的划分方式一致（那一页也把
 * `SummarySection` / `AmountSection` / … 放在页面文件里，只是因为它的区块更少）。
 *
 * ⚠️ 整份文件**只读**：没有 `"use client"`、没有任何输入框 / 按钮 / 表单，
 * 也没有任何取数——所有值都由服务端在 `StaffOrderDetail` 里算好。
 * 因此这里也不可能「顺手」写出一个改状态或退款的入口：本轮（P0-10）客服一个动作都没有。
 *
 * ⚠️ 排版件复用 `components/admin/AdminDetailSection` 的 `Section` / `DetailRow` / `FieldBlock`，
 * 与客服退款详情、投诉详情同一套：「只读字段长什么样」在本项目里只有一份实现。
 */

/**
 * 第 1 块：订单身份。订单号 + 状态徽章，以及一句「客服不能改订单」。
 *
 * ⚠️ 状态徽章用 `ORDER_STATUS_TONE`：状态色只有这一个来源，页面不写死颜色。
 * 一句话说明放在这一块里（`STAFF_ORDER_READONLY_NOTICE`），而不是散在各处——
 * 客户这一轮能做的事只有「看」，这句话必须出现在他最可能去找按钮的地方。
 */
export function StaffOrderIdentitySection({ detail }: { detail: StaffOrderDetail }) {
  return (
    <Section title="订单信息">
      <div className="flex flex-col gap-1">
        <div className="flex gap-3 py-1.5">
          <span className="w-20 shrink-0 text-[13px] text-ink-3">状态</span>
          <span className="min-w-0 flex-1">
            {/* `StaffOrderSummary.orderStatus` 在共享 DTO 里被声明成 `string`
                （它同时被会话摘要使用，那里不需要订单状态联合类型），
                但服务端写入的就是 `OrderStatus`（`toStaffOrderSummary` 直接搬 `order.status`），
                因此这里按订单状态取语气是安全的 */}
            <AdminStatusBadge
              label={detail.order.orderStatusLabel}
              tone={ORDER_STATUS_TONE[detail.order.orderStatus as OrderStatus]}
            />
          </span>
        </div>
        <DetailRow label="订单号" value={detail.order.orderNo} />
      </div>

      {/* 下单 / 支付 / 接单这些时刻不在这里重复一遍：它们由页尾的**状态时间轴**
          按发生顺序给出（`buildOrderTimeline` 与用户端、管理端同一口径）。
          摘要里再列一份，会出现「两处时间不一致时以哪个为准」的问题，
          而它们本来就从同一个订单字段推导。 */}
      <p className="mt-2 text-[12px] leading-4 text-ink-3">
        下单、支付与接单等时刻见页尾的状态时间轴。
      </p>

      <p className="mt-2 text-[12px] leading-4 text-ink-3">{STAFF_ORDER_READONLY_NOTICE}</p>
    </Section>
  );
}

/**
 * 第 2 块：用户摘要。
 *
 * `StaffOrderUserSummary` 只有昵称、头像与两串标识——都是客服要能对上话所必需的，
 * **没有** OpenID / UnionID / 手机号，也没有任何支付相关字段。
 * 两串标识都用等宽小字，与列表的「用户」列同一处写法。
 *
 * ⚠️ **两串标识不能都叫「平台 ID」**：管理端订单详情给 `label="平台 ID"` 的是
 * `displayId`（用户资料页上那串），本组件必须与它同一个口径——否则「客服这边的
 * 平台 ID」和「管理端那边的平台 ID」会是两个不同的值，而用户手上只有其中一个。
 * 内部 ID 单列一行，是客服从会话页粘过来时用的。
 */
export function StaffOrderUserSection({ detail }: { detail: StaffOrderDetail }) {
  return (
    <Section title="用户">
      <div className="flex items-center gap-3">
        <img
          src={detail.user.avatarUrl}
          alt=""
          className="h-10 w-10 shrink-0 rounded-full border border-admin-line object-cover"
        />
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-ink">{detail.user.nickname || "—"}</p>
          {/* 平台 ID = 用户资料页上那串，客服要靠它跟用户对上话；它不是任何可登录的凭据。
              用户记录缺失时为空串——那一行不渲染，不编一个值出来 */}
          {detail.user.displayId ? (
            <p className="font-mono text-[12px] text-ink-3">平台 ID {detail.user.displayId}</p>
          ) : null}
          <p className="font-mono text-[12px] text-ink-3">内部 ID {detail.user.id}</p>
        </div>
      </div>
    </Section>
  );
}

/**
 * 第 3 块：下单内容快照（商品 / 规格 / 封面 / 游戏 / 大区 / 单价 × 数量 / 增值服务）。
 *
 * ⚠️ 全部是**下单时的快照**，不是当前商品目录：商品改名改价、游戏下架之后，
 * 这一单显示的仍然是用户当初买的那份。因此这里不能去查商品详情，
 * 也不能「顺手」把目录里的现价显示出来——两者不一致时没人说得清以哪个为准。
 *
 * ⚠️ **不含游戏账号与用户备注**：客服履职不需要它们（数据最小化），
 * 它们在管理端订单详情里。要看得先改 DTO，那是一次有意识的边界变更。
 *
 * 增值服务为空数组时整块不渲染（与退出历史同一条取舍：绝大多数订单没有增值服务，
 * 空占位会变成一页装饰）。
 */
export function StaffOrderContentSection({ detail }: { detail: StaffOrderDetail }) {
  return (
    <Section title="下单内容（快照）">
      <div className="flex gap-4">
        <img
          src={detail.productCoverUrl}
          alt=""
          className="h-24 w-24 shrink-0 rounded-lg border border-admin-line object-cover"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <DetailRow label="商品" value={detail.order.productTitle} />
          <DetailRow label="规格" value={detail.order.specName} />
          <DetailRow label="数量" value={String(detail.order.quantity)} />
          <DetailRow label="游戏" value={detail.gameName} />
          <DetailRow label="大区" value={detail.region} />
          {/* 单价与数量都来自服务端，这里只做展示——页面不算任何金额 */}
          <DetailRow label="单价" value={`¥${formatYuan(detail.unitPrice)}`} />
        </div>
      </div>

      {detail.addons.length > 0 ? (
        <div className="mt-3">
          <p className="text-[13px] text-ink-3">增值服务</p>
          <ul className="mt-1 flex flex-col">
            {detail.addons.map((addon) => (
              <li
                key={addon.id}
                className="flex items-baseline justify-between gap-3 py-1 text-[13px]"
              >
                <span className="min-w-0 break-words text-ink-2">{addon.name}</span>
                <span className="shrink-0 tabular-nums text-ink-2">¥{formatYuan(addon.price)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[12px] leading-4 text-ink-3">
            增值服务按单计费，不随数量变化；名称与价格都是下单时的快照。
          </p>
        </div>
      ) : null}
    </Section>
  );
}

/**
 * 第 4 块：必要金额。**只读，且是本页的数据边界所在**。
 *
 * 展示的是「用户侧的钱」：渠道实收、商品与增值服务各是多少、原价、券抵扣、实付、已退。
 * 这些对客服是**履职必需**的——要判断「这一单还能退多少」，就必须知道实付与已退
 * （`StaffRefundListItem.amount` 早已把退款金额给过客服，因此这不构成新的暴露）。
 *
 * ⚠️ **本页不展示分账比例与平台收入**（`companionRateSnapshot` / `companionBaseIncome` /
 * `clubNetIncome` 都不在 `StaffOrderDetail` 里）。理由有两条：
 * 用户权限表 §7.1 §7.2 明确禁止客服查看分账比例、客服不拥有资金最终裁决权；
 * 而这三个数是同一个数的三种写法，给出其中一个等于给出全部。
 * 这句话必须**写在这一块里**而不是只写在文档里：客服看得到实付，就一定会想知道分账，
 * 一句说明让他知道「不是没查到，是不该看」。
 */
export function StaffOrderAmountSection({ detail }: { detail: StaffOrderDetail }) {
  return (
    <Section title="金额">
      <div className="flex flex-col gap-1">
        <DetailRow label="渠道实收" value={`¥${formatYuan(detail.order.totalAmount)}`} />
        <DetailRow label="商品金额" value={`¥${formatYuan(detail.itemsAmount)}`} />
        <DetailRow label="增值服务" value={`¥${formatYuan(detail.addonsAmount)}`} />
        <DetailRow label="原价" value={`¥${formatYuan(detail.originalAmount)}`} />
        <DetailRow label="优惠券抵扣" value={`¥${formatYuan(detail.couponDiscountAmount)}`} />
        <DetailRow label="实付金额" value={`¥${formatYuan(detail.actualPaidAmount)}`} />
        <DetailRow label="已退款金额" value={`¥${formatYuan(detail.refundedAmount)}`} />
      </div>

      {/* ⚠️ 页面上的字是纯文本渲染的，出现 `**` 会原样显示成两个星号：
          强调要靠措辞（「本页不展示……」）而不是 Markdown 记号 */}
      <p className="mt-2 text-[12px] leading-4 text-ink-3">
        金额由服务端计算，本页只做展示。本页不展示分账比例与平台收入：
        分账、护航收益与平台净收入不属于客服的履职范围（用户权限表 §7.1 / §7.2）。
      </p>
    </Section>
  );
}

/**
 * 第 5 块：派单摘要（P0-5 的派单记录）。
 *
 * 无派单记录时给一句明确的话而不是空白——订单可能是本轮之前创建的，
 * 也可能根本没进过派单流程；一片空白区分不了「没有」与「没查」。
 *
 * ⚠️ 只列时间事实，不解释策略：**专属池** / 公共池的时长与超时规则在派单域，
 * 这里抄一份就会在规则改动后变成错误说明。
 */
export function StaffOrderDispatchSection({
  dispatch,
}: {
  dispatch: StaffOrderDispatchSummary | null;
}) {
  if (dispatch === null) {
    return (
      <Section title="派单记录">
        <p className="text-[13px] text-ink-3">没有派单记录</p>
        <p className="mt-2 text-[12px] leading-4 text-ink-3">
          这一单没有进过派单流程（或派单记录早于本功能），因此没有池子与时限可展示。
        </p>
      </Section>
    );
  }

  return (
    <Section title="派单记录">
      <div className="flex flex-col gap-1">
        <DetailRow label="派单状态" value={dispatch.stateLabel} />
        {/* ⚠️ 叫**专属池**，不叫「独家池」：`lib/constants/dispatch.ts` 的
            `DISPATCH_STATE_LABELS` / `COMPANION_EXCLUSIVE_PAGE_TITLE` 与打手端页面
            用的都是「专属池」。同一件事两种叫法，读的人只会以为它们是两件事。 */}
        <DetailRow
          label="进专属池"
          value={dispatch.exclusiveEnteredAt ? formatDateTime(dispatch.exclusiveEnteredAt) : ""}
        />
        <DetailRow
          label="专属池截止"
          value={dispatch.exclusiveDeadlineAt ? formatDateTime(dispatch.exclusiveDeadlineAt) : ""}
        />
        <DetailRow
          label="进公共池"
          value={dispatch.publicPoolEnteredAt ? formatDateTime(dispatch.publicPoolEnteredAt) : ""}
        />
        <DetailRow
          label="公共池截止"
          value={dispatch.publicDeadlineAt ? formatDateTime(dispatch.publicDeadlineAt) : ""}
        />
        <DetailRow
          label="接单时间"
          value={dispatch.acceptedAt ? formatDateTime(dispatch.acceptedAt) : ""}
        />
        {/* ⚠️ 叫**关闭时间**，不叫「超时时间」：派单关闭有两种来路（公共池到点无人接，
            或订单在开始服务前被用户直接退款 P0-12）。写成「超时」，客服就会把
            用户取消的单说成无人接单——而这一行的上面那行「接单时间」往往还是有值的。 */}
        <DetailRow
          label="关闭时间"
          value={dispatch.timedOutAt ? formatDateTime(dispatch.timedOutAt) : ""}
        />
      </div>

      <p className="mt-2 text-[12px] leading-4 text-ink-3">
        只列已经发生的时间节点；空着的行表示那一刻还没有到来。派单记录只读，客服不能改派单状态。
      </p>
    </Section>
  );
}

/**
 * 第 6 块：三份售后摘要（退款 / 投诉 / 完成材料）。
 *
 * ⚠️ 只回答「有没有、到哪一步了」，**正文不在这里**：退款说明、投诉正文、完成材料凭证
 * 各自属于它们自己的模块，在这里复制一份等于让订单详情页也承担一次隐私暴露，
 * 而且两份迟早不一致。要读正文就点进各自的详情页。
 *
 * 三个入口都链到**各自模块的详情**（`/staff/refunds/[id]` 等），不是链回订单——
 * 链回订单等于什么也没说。
 */
export function StaffOrderAfterSaleSection({ detail }: { detail: StaffOrderDetail }) {
  return (
    <Section title="售后摘要">
      <div className="flex flex-col gap-4">
        <RefundSummary refund={detail.refund} />
        <ComplaintSummary complaints={detail.complaints} />
        <CompletionSummary completion={detail.completion} />
      </div>

      <p className="mt-3 text-[12px] leading-4 text-ink-3">
        这里只有「有没有、到哪一步了」；退款说明、投诉正文与完成材料凭证都在各自的页面里，
        本页不复制那部分内容。
      </p>
    </Section>
  );
}

/** 退款：一条或没有。有值时链到客服退款详情（那一页才有说明、凭证与处理入口）。 */
function RefundSummary({ refund }: { refund: StaffRefundListItem | null }) {
  if (refund === null) {
    return (
      <div>
        <p className="text-[13px] text-ink-3">退款申请</p>
        <p className="mt-1 text-[13px] text-ink-2">无退款申请</p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-[13px] text-ink-3">退款申请</p>
      <div className="mt-1 flex flex-col gap-1">
        <DetailRow label="退款单号" value={refund.refundNo} />
        <DetailRow label="退款状态" value={refund.statusLabel} />
        {/* 退款金额是「用户侧的钱」，客服要能判断这一单还能退多少 */}
        <DetailRow label="退款金额" value={`¥${formatYuan(refund.amount)}`} />
        <DetailRow label="申请时间" value={formatDateTime(refund.createdAt)} />
        <div className="flex gap-3 py-1.5">
          <span className="w-20 shrink-0 text-[13px] text-ink-3">处理入口</span>
          <Link
            href={`/staff/refunds/${refund.id}`}
            className="min-w-0 flex-1 break-words text-[13px] text-admin-accent underline-offset-2 hover:underline"
          >
            打开退款详情
          </Link>
        </div>
      </div>
    </div>
  );
}

/** 投诉：可能有多条（同一单被多次投诉），逐条列出并各自链到投诉详情。 */
function ComplaintSummary({ complaints }: { complaints: StaffComplaintListItem[] }) {
  if (complaints.length === 0) {
    return (
      <div>
        <p className="text-[13px] text-ink-3">投诉</p>
        <p className="mt-1 text-[13px] text-ink-2">无投诉记录</p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-[13px] text-ink-3">投诉（{complaints.length} 条）</p>
      <ul className="mt-1 flex flex-col">
        {complaints.map((complaint, index) => (
          <li
            key={complaint.id}
            className={`border-admin-line ${index > 0 ? "border-t pt-2" : ""} ${
              index > 0 ? "mt-2" : ""
            }`}
          >
            <DetailRow label="投诉单号" value={complaint.complaintNo} />
            <DetailRow label="投诉原因" value={complaint.typeLabel} />
            <DetailRow label="投诉状态" value={complaint.statusLabel} />
            <DetailRow label="提交时间" value={formatDateTime(complaint.createdAt)} />
            <div className="flex gap-3 py-1.5">
              <span className="w-20 shrink-0 text-[13px] text-ink-3">处理入口</span>
              <Link
                href={`/staff/complaints/${complaint.id}`}
                className="min-w-0 flex-1 break-words text-[13px] text-admin-accent underline-offset-2 hover:underline"
              >
                打开投诉详情
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 完成材料：一条或没有。通过它是订单进入 completed 的唯一入口，因此客服要能看到它在哪一步。 */
function CompletionSummary({ completion }: { completion: StaffCompletionListItem | null }) {
  if (completion === null) {
    return (
      <div>
        <p className="text-[13px] text-ink-3">完成材料</p>
        <p className="mt-1 text-[13px] text-ink-2">无完成材料</p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-[13px] text-ink-3">完成材料</p>
      <div className="mt-1 flex flex-col gap-1">
        <DetailRow label="审核状态" value={completion.statusLabel} />
        <DetailRow label="提交打手" value={completion.companionName} />
        <DetailRow label="提交时间" value={formatDateTime(completion.submittedAt)} />
        <DetailRow
          label="自动通过截止"
          value={formatDateTime(completion.autoApprovalDeadlineAt)}
        />
        <div className="flex gap-3 py-1.5">
          <span className="w-20 shrink-0 text-[13px] text-ink-3">审核入口</span>
          <Link
            href={`/staff/completions/${completion.id}`}
            className="min-w-0 flex-1 break-words text-[13px] text-admin-accent underline-offset-2 hover:underline"
          >
            打开完成材料详情
          </Link>
        </div>
      </div>
      <div className="mt-2">
        {/* 打手写的一句话：原样展示、保留换行、不截断（与客服投诉 / 退款详情同一口径） */}
        <FieldBlock title="提交说明" content={completion.summary} />
      </div>
    </div>
  );
}

/**
 * 第 7 块：状态时间轴。**只列已经发生的节点**，不补占位、不推测时间。
 *
 * 渲染方式照抄管理端订单详情（`app/admin/(console)/orders/[id]/page.tsx`）：
 * `OrderTimelineEntry` 只有 `key` / `label` / `at`，没有说明文案，
 * 因此这里也只给「节点名 + 北京时间」两样。
 */
export function StaffOrderTimelineSection({ timeline }: { timeline: OrderTimelineEntry[] }) {
  return (
    <Section title="状态时间轴">
      <ol className="flex flex-col gap-3">
        {timeline.map((entry) => (
          <li key={entry.key} className="flex gap-3">
            <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-admin-accent" />
            <div className="min-w-0">
              <p className="text-[13px] text-ink">
                {entry.label}
                <span className="ml-2 text-[12px] text-ink-3">{formatDateTime(entry.at)}</span>
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
