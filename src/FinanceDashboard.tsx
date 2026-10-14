import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, BackHandler, Pressable, Text, View } from "react-native";
import type { Connection } from "./api";
import { useNotice } from "./Notice";
import { readFinanceDashboard, type FinanceBudget, type FinanceCommitment, type FinanceTransaction, type ServiceMutation } from "./serviceApi";
import { localDate, moneyInput, moneyLabel, parseCommitments, requireDate, useServiceEditor, useServiceSnapshot, type ServiceDraft } from "./serviceForms";
import { ActionLink, BackLink, Button, CardHeader, Empty, Field, PageHeading, PageHero, PageScrollView, StatusPill, SwitchRow, useUi } from "./ui";

const kindLabels = { expense: "支出", income: "收入", transfer: "转账／还款", refund: "退款" } as const;
const assumptionLabels: Record<string, string> = {
  cumulative_total_includes_details_in_its_range: "累计汇总已包含覆盖期内的明细，不会重复相加。",
  expected_income_includes_received_income: "预计全月收入已包含已到账收入。",
  projection_uses_budget_not_observed_spending_rate: "记录覆盖尚未确认完整，剩余日常支出暂按预算安排估计。",
};
const bucketLabels = { daily: "日常", fixed: "固定", one_time: "一次性" } as const;
export type ServicePageProps = { connection: Connection; onChat: (prompt?: string) => void; onChanged?: () => void; refreshKey?: number };
export function FinanceDashboard({ connection, onChat, onChanged, refreshKey }: ServicePageProps) {
  const { s } = useUi();
  const { show } = useNotice();
  const [month, setMonth] = useState(localDate().slice(0, 7));
  const read = useCallback(() => readFinanceDashboard(connection, month), [connection, month]);
  const snapshot = useServiceSnapshot(connection, `finance:${month}`, read, refreshKey);
  const editor = useServiceEditor(connection, "finance", () => { show({ message: "财务数据已保存", tone: "success" }); void snapshot.reload(); onChanged?.(); });
  useEffect(() => {
    if (!editor.visible) return;
    const handler = BackHandler.addEventListener("hardwareBackPress", () => { editor.close(); return true; });
    return () => handler.remove();
  }, [editor]);
  const data = snapshot.data;
  const budget = data?.summary.budget;
  const openTransaction = (item?: FinanceTransaction) => editor.open("transaction", {
    kind: item?.kind ?? "expense", amount: item?.amount ?? "", date: item?.occurred_on ?? localDate(), bucket: item?.bucket ?? "daily",
    category: item?.category ?? "", note: item?.note ?? "", commitment: item?.commitment_key ?? "", related: item?.related_transaction_id ?? "",
  }, { record: item ?? null, commitments: budget?.commitments ?? [] });
  const openBudget = () => editor.open("budget", {
    month, income: budget?.expected_income ?? "", savings: budget?.savings_target ?? "", daily: budget?.daily_budget ?? "",
    recurring: (budget?.recurring ?? true) ? "yes" : "no", commitments: (budget?.commitments ?? []).map((item) => `${item.label} | ${item.amount} | ${item.kind === "fixed" ? "固定" : "大件"}`).join("\n"),
    from: budget?.coverage_start ?? "", through: budget?.coverage_through ?? "",
  }, { budget: budget ?? null });
  const shiftMonth = (offset: number) => {
    const date = new Date(`${month}-15T12:00:00`); date.setMonth(date.getMonth() + offset); setMonth(localDate(date).slice(0, 7));
  };
  if (editor.visible && editor.draft) {
    const draft = editor.draft;
    const f = draft.fields;
    const editable = !editor.locked;
    const input = (name: string, label: string, extra: Partial<React.ComponentProps<typeof Field>> = {}) => <Field label={label} value={f[name] ?? ""} onChangeText={(value) => editor.set(name, value)} editable={editable} {...extra} />;
    const choices = (name: string, options: Record<string, string>) => <View style={s.wrap}>{Object.entries(options).map(([value, label]) => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected: f[name] === value, disabled: !editable }} disabled={!editable} onPress={() => editor.set(name, value)} style={[s.chip, f[name] === value && s.chipActive]}><Text style={[s.chipText, f[name] === value && s.chipActiveText]}>{label}</Text></Pressable>)}</View>;
    const title = draft.kind === "budget" ? "预算与结余目标" : draft.kind === "delete" ? "删除这笔记录" : draft.context.record ? "纠正收支" : "记一笔收支";
    return <View style={s.body}>
      <BackLink label="财务" onPress={editor.close} />
      <PageScrollView tabs>
        <PageHeading title={title} description={draft.kind === "budget" ? "金额可留空。修改计划保留历史实际收支。" : "按真实发生日期入账；不依赖模型。"} />
        {draft.kind === "budget" ? <View style={s.form}>
          {input("month", "生效月份（返回财务页可切换）", { editable: false })}
          {input("income", "预计全月到手收入", { keyboardType: "decimal-pad", placeholder: "可暂不设置" })}
          {input("savings", "目标结余", { keyboardType: "decimal-pad", placeholder: "可暂不设置" })}
          {input("daily", "每月日常支出上限", { keyboardType: "decimal-pad", placeholder: "独立于结余目标，可暂不设置" })}
          <SwitchRow label="以后月份继续沿用" description="关闭后只修改所选月份。" value={f.recurring === "yes"} disabled={!editable} onValueChange={(value) => editor.set("recurring", value ? "yes" : "no")} />
          {input("commitments", "固定支出和计划大件", { multiline: true, placeholder: "每行：名称 | 金额 | 固定或大件" })}
          <Text style={s.muted}>实际支付时可关联这些安排，避免预留和支付重复计算。</Text>
          {input("from", "完整记账起始日期（可选）", { placeholder: "YYYY-MM-DD" })}
          {input("through", "完整记账截至日期（可选）", { placeholder: "YYYY-MM-DD" })}
          <Text style={s.muted}>只有确认这一段没有漏记时填写；其他时间仍视为记录不完整。</Text>
        </View> : draft.kind === "delete" ? <View style={s.card}>
          <Text style={s.text}>{f.description}</Text><Text style={s.description}>删除后重新计算摘要。请确认这笔记录确实不应保留。</Text>
        </View> : <View style={s.form}>
          <Text style={s.label}>收支类型</Text>{choices("kind", kindLabels)}
          {input("amount", "金额（元）", { keyboardType: "decimal-pad", placeholder: "实际金额" })}
          {input("date", "发生日期", { placeholder: "YYYY-MM-DD" })}
          {f.kind === "expense" ? <><Text style={s.label}>统计口径</Text>{choices("bucket", bucketLabels)}</> : null}
          {input("category", "类别", { placeholder: "例如餐饮、交通、购物" })}
          {input("note", "备注", { multiline: true, placeholder: "用途或需要说明的内容" })}
          {f.kind === "expense" && f.bucket !== "daily" ? <>
            <Text style={s.label}>关联预算安排（可选）</Text>
            {choices("commitment", { "": "不关联", ...(draft.context.commitments as FinanceCommitment[]).filter((item) => item.kind === f.bucket).reduce((all, item) => ({ ...all, [item.key]: `${item.label} · ${moneyLabel(item.amount)}` }), {}) })}
          </> : null}
          {f.kind === "refund" ? <>
            <Text style={s.label}>退回哪笔消费</Text>
            {choices("related", (data?.records.items ?? []).filter((item) => item.kind === "expense").reduce((all, item) => ({ ...all, [item.id]: `${item.occurred_on} ${item.category} ${moneyLabel(item.amount)}` }), {}))}
            {f.related && !(data?.records.items ?? []).some((item) => item.id === f.related) ? <Text style={s.muted}>保留此前关联的原消费。</Text> : null}
            <Text style={s.muted}>需要退回更早的消费时，先回到对应月份，在原消费旁选择“退款”；也可以和财务助手说明。</Text>
          </> : null}
        </View>}
        {editor.locked && !editor.busy ? <Text style={s.description}>上次提交结果尚未确认。输入已保留，重试会核对同一笔请求。</Text> : null}
        {editor.storageError ? <View style={s.stack}><Text accessibilityRole="alert" style={s.error}>{editor.storageError}</Text>{!editor.ready ? <ActionLink onPress={editor.retryRead}>重新读取本机草稿</ActionLink> : null}</View> : null}
        {editor.error ? <Text accessibilityRole="alert" style={s.error}>{editor.error}</Text> : null}
        <Button disabled={editor.busy || !editor.ready} danger={draft.kind === "delete"} onPress={() => void editor.submit(buildFinanceMutation)}>{editor.busy ? "正在保存…" : editor.locked ? "重试原请求" : draft.kind === "delete" ? "确认删除" : "保存"}</Button>
        {!editor.locked ? <ActionLink tone="neutral" onPress={editor.discard}>放弃这次编辑</ActionLink> : null}
      </PageScrollView>
    </View>;
  }
  return <PageScrollView tabs>
    <PageHero eyebrow="FINANCE" title="财务" description="记录实际开销，按当前目标安排接下来的生活。" />
    <View style={s.spread}><ActionLink icon="chevron-back" tone="neutral" onPress={() => shiftMonth(-1)}>上个月</ActionLink><Text style={s.itemTitle}>{month}</Text><ActionLink icon="chevron-forward" tone="neutral" onPress={() => shiftMonth(1)}>下个月</ActionLink></View>
    {snapshot.loading && !data ? <ActivityIndicator accessibilityLabel="正在读取财务" /> : null}
    {snapshot.error ? <View style={s.notice}><Text accessibilityRole="alert" style={s.error}>{data ? "当前显示上次同步的数据。" : "财务摘要尚未读取。"}{snapshot.error}</Text><ActionLink onPress={() => void snapshot.reload()} disabled={snapshot.loading}>重新连接并刷新</ActionLink></View> : null}
    {editor.storageError ? <View style={s.stack}><Text accessibilityRole="alert" style={s.error}>{editor.storageError}</Text>{!editor.ready ? <ActionLink onPress={editor.retryRead}>重新读取本机草稿</ActionLink> : null}</View> : null}
    {editor.draft ? <Button secondary onPress={editor.resume}>继续尚未完成的编辑</Button> : null}
    <View style={s.card}>
      <CardHeader icon="wallet-outline" title="本月安排" tone="gold" action={<ActionLink disabled={!editor.ready} onPress={openBudget}>调整</ActionLink>} />
      {data ? <>
        <Text style={s.description}>剩余日常额度</Text><Text style={s.heading}>{moneyLabel(data.summary.remaining.daily_budget)}</Text>
        <Text style={s.muted}>含已记消费及剩余固定／大件安排，受日常上限与结余目标共同约束。</Text>
        <View style={s.divider} />
        <Text style={s.text}>预计月底结余　{moneyLabel(data.summary.projection.savings)}</Text>
        <Text style={s.description}>目标结余　{moneyLabel(budget?.savings_target)}</Text>
        <Text style={s.description}>预计收入　{moneyLabel(budget?.expected_income)}　日常上限　{moneyLabel(budget?.daily_budget)}</Text>
        <Text style={s.muted}>{budget?.source_month && budget.source_month !== month ? `沿用 ${budget.source_month} 的预算` : budget?.recurring ? "预算会沿用到后续月份" : "本月独立设置"}</Text>
        {data.summary.projection.assumptions.filter((item) => assumptionLabels[item]).map((item, index) => <Text key={index} style={s.muted}>{assumptionLabels[item]}</Text>)}
      </> : <Empty compact title="先记账，也可以先定目标">收入和目标可稍后补充，未知额度不会当作零元。</Empty>}
      <Button icon="add" disabled={!editor.ready} onPress={() => openTransaction()}>记一笔收支</Button>
      <ActionLink icon="chatbubble-ellipses-outline" tone="gold" onPress={() => onChat()}>和财务助手聊聊</ActionLink>
    </View>
    {data ? <View style={s.card}>
      <CardHeader icon="bar-chart-outline" title="已记开销" tone="gold" />
      <Text style={s.text}>全部净支出　{moneyLabel(data.summary.totals.expense)}</Text>
      <View style={s.wrap}>{Object.entries(bucketLabels).map(([key, label]) => <StatusPill key={key} tone="neutral">{`${label} ${moneyLabel(data.summary.totals[key as keyof typeof bucketLabels])}`}</StatusPill>)}</View>
      {data.summary.daily_average.amount != null ? <Text style={s.description}>日常日均　{moneyLabel(data.summary.daily_average.amount)} · {data.summary.daily_average.from} 至 {data.summary.daily_average.through}</Text> : <Text style={s.muted}>日常日均待确认完整覆盖期后计算。</Text>}
      <Text style={s.description}>已收收入　{moneyLabel(data.summary.totals.income)}　待发生安排　{moneyLabel(data.summary.reservations.total)}</Text>
      <Text style={s.muted}>{data.summary.coverage.complete ? "已确认覆盖完整月份。" : "仅统计已记内容；漏记不代表没有消费。"}记录覆盖 {data.summary.coverage.recorded_days} 天。</Text>
      <ActionLink onPress={() => onChat("请根据已记的消费、当前预算及记录覆盖情况，回顾本月开销变化，并给一项可执行的调整建议。")}>回顾消费与下一步</ActionLink>
    </View> : null}
    <View style={s.card}>
      <CardHeader icon="receipt-outline" title="本月记录" description={data ? `${data.records.total} 笔` : undefined} tone="gold" />
      {data?.records.items.length ? data.records.items.map((item) => <View key={item.id} style={s.stack}>
        <View style={s.spread}><View style={s.headingCopy}><Text style={s.itemTitle}>{item.category || kindLabels[item.kind]}</Text><Text style={s.muted}>{item.occurred_on} · {kindLabels[item.kind]} · {bucketLabels[item.bucket]}</Text></View><Text style={s.itemTitle}>{item.kind === "expense" ? "−" : item.kind === "income" || item.kind === "refund" ? "+" : ""}{moneyLabel(item.amount)}</Text></View>
        {item.note ? <Text style={s.description}>{item.note}</Text> : null}
        <View style={s.wrap}><ActionLink tone="neutral" disabled={!editor.ready} onPress={() => openTransaction(item)}>纠正</ActionLink>{item.kind === "expense" ? <ActionLink tone="neutral" disabled={!editor.ready} onPress={() => editor.open("transaction", { kind: "refund", amount: "", date: localDate(), bucket: item.bucket, category: item.category, note: "", related: item.id, commitment: "" }, { record: null, commitments: budget?.commitments ?? [] })}>退款</ActionLink> : null}<ActionLink disabled={!editor.ready} onPress={() => editor.open("delete", { description: `${item.occurred_on} ${item.category} ${moneyLabel(item.amount)}` }, { record: item })}>删除</ActionLink></View><View style={s.divider} />
      </View>) : <Empty compact title="这个月还没有记录">可以直接记一笔，也可以发文字或账单截图给财务助手。</Empty>}
      {data && data.records.total > data.records.items.length ? <Text style={s.muted}>这里显示最近 {data.records.items.length} 笔；可让财务助手查询更早的记录。</Text> : null}
      <ActionLink onPress={() => void snapshot.reload()} disabled={snapshot.loading}>刷新数据</ActionLink>
    </View>
  </PageScrollView>;
}

export function buildFinanceMutation(draft: ServiceDraft): ServiceMutation {
  const f = draft.fields;
  const record = draft.context.record as FinanceTransaction | null;
  if (draft.kind === "delete") return { method: "DELETE", path: `/finance/transactions/${encodeURIComponent(record!.id)}?idempotency_key=${encodeURIComponent(draft.id)}` };
  if (draft.kind === "budget") {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(f.month)) throw new Error("生效月份请使用 YYYY-MM。");
    const previous = draft.context.budget as FinanceBudget | null;
    if (f.from) requireDate(f.from, "起始日期"); if (f.through) requireDate(f.through, "截至日期");
    if (f.from && f.through && f.from > f.through) throw new Error("截至日期不能早于起始日期。");
    return { method: "PUT", path: "/finance/budget", body: { month: f.month, recurring: f.recurring === "yes", idempotency_key: draft.id, expected_revision: previous?.revision ?? 0, expected_source_month: previous?.source_month ?? null, expected_income: moneyInput(f.income, "预计收入", true), savings_target: moneyInput(f.savings, "目标结余", true), daily_budget: moneyInput(f.daily, "日常上限", true), commitments: parseCommitments(f.commitments, previous?.commitments ?? []), coverage_start: f.from || null, coverage_through: f.through || null } };
  }
  const amount = moneyInput(f.amount, "金额"); if (Number(amount) <= 0) throw new Error("金额应大于零。");
  if (f.kind === "refund" && !f.related) throw new Error("请关联原消费，确保退款进入正确统计口径。");
  const body = { idempotency_key: draft.id, kind: f.kind, amount, occurred_on: requireDate(f.date), bucket: f.bucket, category: f.category.trim() || "其他", note: f.note.trim(), commitment_key: f.kind === "expense" && f.bucket !== "daily" ? f.commitment || null : null, related_transaction_id: f.kind === "refund" ? f.related : null, ...(record ? { expected_revision: record.revision } : {}) };
  return record ? { method: "PATCH", path: `/finance/transactions/${encodeURIComponent(record.id)}`, body } : { method: "POST", path: "/finance/transactions", body };
}
