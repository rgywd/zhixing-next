import { useCallback, useEffect, useState, type ComponentProps } from "react";
import { ActivityIndicator, BackHandler, Pressable, Text, View } from "react-native";
import { pauseHealthNotificationsForToday } from "./healthNotifications";
import { allowNotifications } from "./deviceCapabilities";
import type { ServicePageProps } from "./FinanceDashboard";
import { useNotice } from "./Notice";
import { readHealthSummary, type HealthMeal, type HealthProfile, type HealthRecommendation, type HealthReminders, type HealthRule, type HealthSteps, type HealthWeight, type ServiceMutation } from "./serviceApi";
import { localDate, localTime, localTimestamp, mealLabels, parseReminderSlots, positiveNumber, requireDate, requireTime, textLines, useServiceEditor, useServiceSnapshot, validDate, type ServiceDraft } from "./serviceForms";
import { ActionLink, BackLink, Button, CardHeader, Empty, Field, PageHeading, PageHero, PageScrollView, StatusPill, SwitchRow, useUi } from "./ui";

const ruleKinds = { guideline: "饮食约定", restriction: "必须遵守的限制", preference: "偏好" };
const ruleStates = { active: "生效", paused: "暂停", proposed: "待采纳" };
const feedbackLabels = { accepted: "已采纳", replaced: "希望替换", declined: "这次不采用" };
export function HealthPage({ connection, onChat, onChanged, refreshKey }: ServicePageProps) {
  const { s } = useUi();
  const { show } = useNotice();
  const [date, setDate] = useState(localDate());
  const [showAllWeights, setShowAllWeights] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [expandedRecommendations, setExpandedRecommendations] = useState<Record<string, boolean>>({});
  const read = useCallback(() => readHealthSummary(connection, date), [connection, date]);
  const snapshot = useServiceSnapshot(connection, `health:${date}`, read, refreshKey);
  const editor = useServiceEditor(connection, "health", (saved) => {
    show({ message: saved.kind === "reminders" ? "提醒偏好已保存，正在同步本机排期" : "健康数据已保存", tone: "success" });
    void snapshot.reload(); onChanged?.();
    if (saved.kind === "feedback" && saved.fields.action === "replaced") onChat("请根据我刚保存的替换原因和当前饮食约定，重新推荐这顿饭，并保存新的建议供我选择。");
  });
  useEffect(() => {
    if (!editor.visible) return;
    const handler = BackHandler.addEventListener("hardwareBackPress", () => { editor.close(); return true; });
    return () => handler.remove();
  }, [editor]);
  const data = snapshot.data;
  const openMeal = (item?: HealthMeal, recommendation?: HealthRecommendation, option?: HealthRecommendation["options"][number]) => {
    const occurred = item ? new Date(item.occurred_at) : new Date();
    editor.open("meal", { date: item ? localDate(occurred) : recommendation?.target_date ?? date, time: localTime(occurred), meal_type: item?.meal_type ?? recommendation?.meal_type ?? "other", description: item?.description ?? (option ? `${option.title}${option.description ? `，${option.description}` : ""}` : ""), portion: item?.portion ?? option?.portion ?? "", status: item?.status ?? "recorded", note: item?.note ?? "" }, { record: item ?? null, recommendation_id: item?.recommendation_id ?? recommendation?.id ?? null });
  };
  const openMeasure = (kind: "weight" | "steps", item?: HealthWeight | HealthSteps) => {
    const measured = item ? new Date(item.measured_at) : new Date();
    editor.open(kind, { date: item ? localDate(measured) : date, time: localTime(measured), value: item ? String(item.value) : "", unit: item && "unit" in item ? item.unit : "kg", note: item?.note ?? "" }, { record: item ?? null });
  };
  const openRule = (item?: HealthRule) => editor.open("rule", { content: item?.content ?? "", kind: item?.kind ?? "guideline", status: item?.status ?? "active", scope: item?.effective_from && item.effective_from === item.effective_until ? "once" : item?.effective_from || item?.effective_until ? "range" : "ongoing", from: item?.effective_from ?? date, until: item?.effective_until ?? "", excluded_terms: item?.excluded_terms.join("\n") ?? "" }, { record: item ?? null });
  const openProfile = () => {
    if (!data) return;
    const p = data.profile;
    editor.open("profile", { height_cm: p.height_cm == null ? "" : String(p.height_cm), activity_limitations: p.activity_limitations.join("\n"), food_allergies: p.food_allergies.join("\n"), food_exclusions: p.food_exclusions.join("\n"), preferences: p.preferences.join("\n"), goals: p.goals.join("\n") }, { profile: p });
  };
  const openReminders = () => {
    if (!data) return;
    const r = data.reminders;
    editor.open("reminders", { enabled: r.enabled ? "yes" : "no", timezone: r.timezone, slots: r.slots.map((slot) => `${slot.time} ${slot.kind === "review" ? "回顾" : mealLabels[slot.meal_type]}`).join("\n"), quiet_start: r.quiet_start ?? "", quiet_end: r.quiet_end ?? "", max_per_day: String(r.max_per_day), paused_dates: r.paused_dates.join("\n") }, { reminders: r });
  };
  const openFeedback = (recommendation: HealthRecommendation, action: "accepted" | "replaced" | "declined", optionId = "") => editor.open("feedback", { action, option_id: optionId, note: "" }, { recommendation });
  const openDelete = (kind: "meal" | "weight" | "steps" | "rule", record: HealthMeal | HealthWeight | HealthSteps | HealthRule, description: string) => editor.open("delete", { description }, { resource: kind === "meal" ? "meals" : kind === "weight" ? "weights" : kind === "steps" ? "steps" : "rules", record });
  const shiftDate = (offset: number) => { const next = new Date(`${date}T12:00:00`); next.setDate(next.getDate() + offset); setDate(localDate(next)); };
  if (editor.visible && editor.draft) {
    const draft = editor.draft;
    const f = draft.fields;
    const editable = !editor.locked;
    const input = (name: string, label: string, extra: Partial<ComponentProps<typeof Field>> = {}) => <Field label={label} value={f[name] ?? ""} onChangeText={(value) => editor.set(name, value)} editable={editable} {...extra} />;
    const choices = (name: string, options: Record<string, string>) => <View style={s.wrap}>{Object.entries(options).map(([value, label]) => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected: f[name] === value, disabled: !editable }} disabled={!editable} onPress={() => editor.set(name, value)} style={[s.chip, f[name] === value && s.chipActive]}><Text style={[s.chipText, f[name] === value && s.chipActiveText]}>{label}</Text></Pressable>)}</View>;
    const titles: Record<string, string> = { meal: draft.context.record ? "纠正饮食记录" : "记录实际饮食", weight: "记录体重", steps: "记录步数", profile: "身体资料与限制", rule: "饮食规范", reminders: "用餐与回顾提醒", feedback: "这次怎么选择", delete: "删除这条记录" };
    return <View style={s.body}>
      <BackLink label="健康" onPress={editor.close} />
      <PageScrollView tabs>
        <PageHeading title={titles[draft.kind]} description={draft.kind === "feedback" ? "选择建议和实际吃下的食物分别记录。" : "按实际情况填写，之后可以随时调整。"} />
        <View style={s.form}>
          {draft.kind === "meal" ? <>
            <Text style={s.label}>餐次</Text>{choices("meal_type", mealLabels)}
            {input("date", "发生日期", { placeholder: "YYYY-MM-DD" })}{input("time", "发生时间", { placeholder: "HH:mm" })}
            <Text style={s.label}>实际情况</Text>{choices("status", { recorded: "吃过，记录内容", skipped: "明确没有吃这顿" })}
            {input("description", f.status === "skipped" ? "情况说明（可选）" : "吃了什么", { multiline: true, placeholder: "食物、做法；不必精确到克" })}
            {input("portion", "实际份量与剩余（可选）", { placeholder: "例如一碗，米饭剩一半" })}
            {input("note", "备注（可选）", { multiline: true, placeholder: "饥饿感、用餐困难或其他情况" })}
          </> : null}
          {draft.kind === "weight" || draft.kind === "steps" ? <>
            {input("value", draft.kind === "weight" ? "测量体重" : "实际步数", { keyboardType: draft.kind === "weight" ? "decimal-pad" : "number-pad", placeholder: "实际测量值" })}
            {draft.kind === "weight" ? choices("unit", { kg: "公斤 kg", lb: "磅 lb" }) : null}
            {input("date", "测量日期", { placeholder: "YYYY-MM-DD" })}{input("time", "测量时间", { placeholder: "HH:mm" })}
            {input("note", "备注（可选）", { placeholder: "例如晨起、饭后或不同设备" })}
          </> : null}
          {draft.kind === "profile" ? <>
            {input("height_cm", "不穿鞋身高（cm，可选）", { keyboardType: "decimal-pad" })}
            {input("activity_limitations", "活动限制", { multiline: true, placeholder: "例如医生要求避免的动作；每行一项" })}
            {input("food_allergies", "食物过敏", { multiline: true, placeholder: "每行一种；不清楚可留空" })}
            {input("food_exclusions", "必须避开的食物", { multiline: true, placeholder: "每行一种" })}
            {input("preferences", "口味和用餐条件", { multiline: true, placeholder: "口味、外卖或做饭条件等，每行一项" })}
            {input("goals", "当前目标", { multiline: true, placeholder: "用自己的话说明；不自动设置热量或减重速度" })}
          </> : null}
          {draft.kind === "rule" ? <>
            {input("content", "规范内容", { multiline: true, placeholder: "用你的话说明想遵循的安排" })}
            <Text style={s.label}>规范性质</Text>{choices("kind", ruleKinds)}
            <Text style={s.label}>当前状态</Text>{choices("status", ruleStates)}
            <Text style={s.label}>生效范围</Text>{choices("scope", { ongoing: "长期沿用", once: "仅一天", range: "指定日期范围" })}
            {f.scope !== "ongoing" ? input("from", f.scope === "once" ? "生效日期" : "起始日期", { placeholder: "YYYY-MM-DD" }) : null}
            {f.scope === "range" ? input("until", "截至日期（可留空）", { placeholder: "YYYY-MM-DD" }) : null}
            {f.kind === "restriction" ? input("excluded_terms", "必须避开的食物关键词（可选）", { multiline: true, placeholder: "用于排除冲突候选，每行一个食物名称" }) : null}
            <Text style={s.muted}>待采纳的建议不会自动变成你的约定。暂停后不再作为当前要求。</Text>
          </> : null}
          {draft.kind === "feedback" ? <>
            <Text style={s.label}>这次选择</Text>{choices("action", feedbackLabels)}
            {choices("option_id", { "": "未选具体方案", ...(draft.context.recommendation as HealthRecommendation).options.reduce((all, option) => ({ ...all, [option.id]: option.title }), {}) })}
            {input("note", "原因或遇到的困难（可选）", { multiline: true, placeholder: "例如只有外卖、太饿、价格偏高或食材买不到" })}
            {f.action === "replaced" ? <Text style={s.description}>保存后进入健康对话，按你的原因重新推荐。</Text> : null}
          </> : null}
          {draft.kind === "reminders" ? <>
            <SwitchRow label="启用用餐和回顾提醒" description="保存后同步这台手机；系统通知权限仍影响送达。" value={f.enabled === "yes"} disabled={!editable} onValueChange={(value) => editor.set("enabled", value ? "yes" : "no")} />
            {input("slots", "提醒时段", { multiline: true, placeholder: "每行：12:00 午餐\n可选早餐、午餐、晚餐、加餐、其他、回顾" })}
            {input("timezone", "时区", { autoCapitalize: "none", placeholder: "例如 Asia/Shanghai" })}
            {input("max_per_day", "每天最多提醒次数", { keyboardType: "number-pad" })}
            {input("quiet_start", "安静时间开始（可选）", { placeholder: "HH:mm" })}{input("quiet_end", "安静时间结束（可选）", { placeholder: "HH:mm" })}
            {input("paused_dates", "暂停提醒的日期（可选）", { multiline: true, placeholder: "每行一个 YYYY-MM-DD，可随时增删" })}
            <Text style={s.muted}>没有记录不表示没有吃饭。已同步时段可在普通退出 App 后由系统提醒，打开后读取最新内容。</Text>
          </> : null}
          {draft.kind === "delete" ? <View style={s.card}><Text style={s.text}>{f.description}</Text><Text style={s.description}>删除后更新记录和趋势。请确认这条内容确实不应保留。</Text></View> : null}
        </View>
        {editor.locked && !editor.busy ? <Text style={s.description}>上次提交结果尚未确认。输入已保留，重试会核对同一笔请求。</Text> : null}
        {editor.storageError ? <View style={s.stack}><Text accessibilityRole="alert" style={s.error}>{editor.storageError}</Text>{!editor.ready ? <ActionLink onPress={editor.retryRead}>重新读取本机草稿</ActionLink> : null}</View> : null}
        {editor.error ? <Text accessibilityRole="alert" style={s.error}>{editor.error}</Text> : null}
        <Button disabled={editor.busy || !editor.ready} danger={draft.kind === "delete"} onPress={() => void editor.submit(buildHealthMutation, async (source) => { if (source.kind === "reminders" && source.fields.enabled === "yes") await allowNotifications(); })}>{editor.busy ? "正在保存…" : editor.locked ? "重试原请求" : draft.kind === "delete" ? "确认删除" : "保存"}</Button>
        {!editor.locked ? <ActionLink tone="neutral" onPress={editor.discard}>放弃这次编辑</ActionLink> : null}
      </PageScrollView>
    </View>;
  }
  const trend = data?.review.weight_trend;
  return <PageScrollView tabs>
    <PageHero eyebrow="HEALTH" title="健康" description="聊出适合你的饮食安排，记录变化，一起调整。" />
    <View style={s.spread}><ActionLink icon="chevron-back" tone="neutral" onPress={() => shiftDate(-1)}>前一天</ActionLink><ActionLink tone="neutral" onPress={() => setDate(localDate())}>{date === localDate() ? "今天" : date}</ActionLink><ActionLink icon="chevron-forward" tone="neutral" onPress={() => shiftDate(1)}>后一天</ActionLink></View>
    {snapshot.loading && !data ? <ActivityIndicator accessibilityLabel="正在读取健康数据" /> : null}
    {snapshot.error ? <View style={s.notice}><Text accessibilityRole="alert" style={s.error}>{data ? "当前显示上次同步的数据。" : "健康摘要尚未读取。"}{snapshot.error}</Text><ActionLink disabled={snapshot.loading} onPress={() => void snapshot.reload()}>重新连接并刷新</ActionLink></View> : null}
    {editor.storageError ? <View style={s.stack}><Text accessibilityRole="alert" style={s.error}>{editor.storageError}</Text>{!editor.ready ? <ActionLink onPress={editor.retryRead}>重新读取本机草稿</ActionLink> : null}</View> : null}
    {editor.draft ? <Button secondary onPress={editor.resume}>继续尚未完成的编辑</Button> : null}
    <View style={s.card}>
      <CardHeader icon="restaurant-outline" title="吃什么，一起想" tone="gold" />
      <Text style={s.description}>根据当前饮食约定、实际记录和用餐条件，挑选能做到的一顿。</Text>
      <Button icon="chatbubble-ellipses-outline" onPress={() => onChat(`请结合我的当前资料、有效饮食规范和最近实际记录，推荐 ${date} 的下一餐。先使用健康工具读取依据，给少量可执行选项并保存建议；缺少真实商家或价格时不要编造。`)}>聊聊下一餐</Button>
      <View style={s.wrap}><ActionLink disabled={!editor.ready} onPress={() => openMeal()}>记录饮食</ActionLink><ActionLink disabled={!editor.ready} onPress={() => openMeasure("weight")}>记录体重</ActionLink><ActionLink onPress={() => onChat()}>健康对话</ActionLink></View>
    </View>
    {(data?.recommendations ?? []).filter((item) => item.target_date === date).slice(0, 3).map((recommendation) => <View key={recommendation.id} style={s.card}>
      <CardHeader icon="sparkles-outline" title={`${recommendation.target_date} ${mealLabels[recommendation.meal_type]}建议`} tone="gold" />
      {recommendation.latest_feedback ? <StatusPill>{`历史选择 · ${feedbackLabels[recommendation.latest_feedback.action]}`}</StatusPill> : recommendation.status === "stale" ? <><StatusPill>依据已变化</StatusPill><Text style={s.muted}>请按最新规范重新推荐。</Text><ActionLink onPress={() => onChat("我的资料或饮食规范已变化，请读取最新依据，更新这顿饭的建议并保存。")}>更新建议</ActionLink></> : null}
      {recommendation.note ? <Text style={s.description}>{recommendation.note}</Text> : null}
      {recommendation.options.map((option) => <View key={option.id} style={s.stack}>
        <Text style={s.itemTitle}>{option.title}</Text><Text style={s.text}>{option.description}</Text>
        {option.portion ? <Text style={s.description}>份量：{option.portion}</Text> : null}
        {option.reason ? <Text style={s.description}>{option.reason}</Text> : null}
        {option.substitutions.length ? <Text style={s.muted}>可替换：{option.substitutions.join("；")}</Text> : null}
        {option.estimated_energy ? <Text style={s.muted}>估计 {option.estimated_energy.minimum}–{option.estimated_energy.maximum} kcal；依据：{option.estimated_energy.basis}</Text> : null}
        {option.cost_note ? <Text style={s.muted}>费用说明：{option.cost_note}</Text> : null}
        {option.note ? <Text style={s.muted}>{option.note}</Text> : null}
        <View style={s.wrap}><ActionLink disabled={!editor.ready || recommendation.status === "stale" || Boolean(recommendation.latest_feedback)} onPress={() => openFeedback(recommendation, "accepted", option.id)}>采纳这个</ActionLink><ActionLink tone="neutral" disabled={!editor.ready} onPress={() => openMeal(undefined, recommendation, option)}>实际吃过，记下来</ActionLink></View><View style={s.divider} />
      </View>)}
      {recommendation.latest_feedback ? <Text style={s.muted}>{feedbackLabels[recommendation.latest_feedback.action]}{recommendation.latest_feedback.note ? `：${recommendation.latest_feedback.note}` : ""}。采纳不代表已吃。</Text> : null}
      <View style={s.wrap}><ActionLink disabled={!editor.ready} onPress={() => openFeedback(recommendation, "replaced")}>换个建议</ActionLink><ActionLink tone="neutral" disabled={!editor.ready} onPress={() => openFeedback(recommendation, "declined")}>这次不采用</ActionLink></View>
      {recommendation.context ? <>
        <ActionLink tone="neutral" onPress={() => setExpandedRecommendations((old) => ({ ...old, [recommendation.id]: !old[recommendation.id] }))}>{expandedRecommendations[recommendation.id] ? "收起建议依据" : "查看建议依据"}</ActionLink>
        {expandedRecommendations[recommendation.id] ? <Text style={s.description}>{recommendation.context}</Text> : null}
      </> : null}
    </View>)}
    <View style={s.card}>
      <CardHeader icon="nutrition-outline" title={`${date === localDate() ? "今天" : date}的饮食`} action={<ActionLink disabled={!editor.ready} onPress={() => openMeal()}>补记</ActionLink>} />
      {data?.meals.length ? data.meals.map((item) => <View key={item.id} style={s.stack}>
        <Text style={s.itemTitle}>{mealLabels[item.meal_type]} · {localTime(new Date(item.occurred_at))}{item.status === "skipped" ? " · 明确未吃" : ""}</Text>
        {item.description ? <Text style={s.text}>{item.description}</Text> : null}{item.estimated_energy ? <Text style={s.muted}>估计 {item.estimated_energy.minimum}–{item.estimated_energy.maximum} kcal；依据：{item.estimated_energy.basis}</Text> : null}{item.portion ? <Text style={s.description}>{item.portion}</Text> : null}{item.note ? <Text style={s.muted}>{item.note}</Text> : null}
        <View style={s.wrap}><ActionLink tone="neutral" onPress={() => openMeal(item)} disabled={!editor.ready}>纠正</ActionLink><ActionLink disabled={!editor.ready} onPress={() => openDelete("meal", item, item.description || `${mealLabels[item.meal_type]}未吃记录`)}>删除</ActionLink></View><View style={s.divider} />
      </View>) : <Empty compact title="还没有这一天的饮食记录">没记录只表示未知；随手补一顿就能开始。</Empty>}
      <ActionLink onPress={() => onChat(`请读取截至 ${date} 的健康记录、建议选择和困难反馈，做一次饮食回顾。只根据真实记录说明情况，并给下一餐的一项调整。`)}>回顾饮食与困难</ActionLink>
      {data?.review.recent_choices.filter((item) => item.latest_feedback?.note).slice(0, 3).map((item) => <Text key={item.id} style={s.muted}>{item.target_date} 的反馈：{item.latest_feedback?.note}</Text>)}
    </View>
    <View style={s.card}>
      <CardHeader icon="scale-outline" title="体重与活动记录" action={<ActionLink disabled={!editor.ready} onPress={() => openMeasure("weight")}>记体重</ActionLink>} tone="blue" />
      <Text style={s.heading}>{trend?.latest_kg != null ? `${trend.latest_kg} kg` : "等待测量"}</Text>
      {trend && trend.count >= 2 && trend.change_kg != null ? <Text style={s.description}>{trend.first_date} 至 {trend.last_date}，{trend.count} 次测量变化 {trend.change_kg > 0 ? "+" : ""}{trend.change_kg} kg。</Text> : <Text style={s.muted}>积累更多同口径测量后再观察变化；不把单次波动当作趋势。</Text>}
      {(showAllWeights ? data?.weights : data?.weights.slice(0, 5))?.map((item) => <View key={item.id} style={s.stack}>
        <Text style={s.text}>{localDate(new Date(item.measured_at))} {localTime(new Date(item.measured_at))}　{item.value} {item.unit}</Text>
        {item.note ? <Text style={s.muted}>{item.note}</Text> : null}
        <View style={s.wrap}><ActionLink tone="neutral" onPress={() => openMeasure("weight", item)} disabled={!editor.ready}>纠正</ActionLink><ActionLink onPress={() => openDelete("weight", item, `${item.value} ${item.unit}`)} disabled={!editor.ready}>删除</ActionLink></View>
      </View>)}
      {data && data.weights.length > 5 ? <ActionLink tone="neutral" onPress={() => setShowAllWeights(!showAllWeights)}>{showAllWeights ? "收起测量记录" : "展开近期测量记录"}</ActionLink> : null}
      {data?.steps.map((item) => <View key={item.id} style={s.stack}><Text style={s.description}>{localTime(new Date(item.measured_at))} 记录步数：{item.value}{item.note ? ` · ${item.note}` : ""}</Text><View style={s.wrap}><ActionLink tone="neutral" onPress={() => openMeasure("steps", item)} disabled={!editor.ready}>纠正</ActionLink><ActionLink onPress={() => openDelete("steps", item, `${item.value} 步`)} disabled={!editor.ready}>删除</ActionLink></View></View>)}
      <ActionLink tone="blue" disabled={!editor.ready} onPress={() => openMeasure("steps")}>记录步数</ActionLink>
      <Text style={s.muted}>活动按身体限制安排，记录步数不会自动增加运动要求。</Text>
    </View>
    <View style={s.card}>
      <CardHeader icon="leaf-outline" title="当前饮食规范" action={<ActionLink disabled={!editor.ready} onPress={() => openRule()}>添加</ActionLink>} />
      {data?.all_rules.length ? data.all_rules.map((item) => <View key={item.id} style={s.stack}>
        <View style={s.wrap}><StatusPill tone={item.status === "active" ? "gold" : "neutral"}>{ruleStates[item.status]}</StatusPill><StatusPill>{ruleKinds[item.kind]}</StatusPill></View>
        <Text style={s.text}>{item.content}</Text><Text style={s.muted}>{item.effective_from || "立即"}起 · {item.effective_until ? `截至 ${item.effective_until}` : "持续沿用"}</Text>
        <View style={s.wrap}><ActionLink tone="neutral" disabled={!editor.ready} onPress={() => openRule(item)}>修改／暂停</ActionLink><ActionLink disabled={!editor.ready} onPress={() => openDelete("rule", item, item.content)}>删除</ActionLink></View><View style={s.divider} />
      </View>) : <Empty compact title="从一条做得到的约定开始">可以直接添加，也可以先与健康助手讨论。</Empty>}
      <ActionLink onPress={() => onChat("我想结合自己的身体情况、口味和用餐条件，一起整理适合我的饮食规范。明确是我要求的可以保存，新增建议先让我采纳。")}>一起聊出饮食规范</ActionLink>
    </View>
    <View style={s.card}>
      <CardHeader icon="person-outline" title="资料与跟进" tone="blue" />
      {data?.profile.activity_limitations.length ? <Text style={s.description}>活动限制：{data.profile.activity_limitations.join("；")}</Text> : null}
      {data?.profile.food_allergies.length ? <Text style={s.description}>过敏：{data.profile.food_allergies.join("；")}</Text> : null}
      <ActionLink tone="blue" disabled={!data || !editor.ready} onPress={openProfile}>编辑身体资料、限制和偏好</ActionLink>
      <ActionLink tone="blue" disabled={!data || !editor.ready} onPress={openReminders}>{data?.reminders.enabled ? "调整或暂停提醒" : "设置用餐与回顾提醒"}</ActionLink>
      <ActionLink tone="neutral" disabled={pausing} onPress={() => { if (pausing) return; setPausing(true); void pauseHealthNotificationsForToday(connection).then(() => show({ message: "今天这台手机的健康提醒已暂停", tone: "success" })).catch((reason: unknown) => show({ message: reason instanceof Error ? reason.message : "暂停尚未完成，请重试", tone: "error" })).finally(() => setPausing(false)); }}>{pausing ? "正在暂停…" : "今天不提醒这台手机"}</ActionLink>
      <Text style={s.muted}>{data?.reminders.enabled ? `已开启 ${data.reminders.slots.length} 个时段；每天最多 ${data.reminders.max_per_day} 次。` : "提醒尚未开启。"}本机权限和排期结果会单独反馈。</Text>
      <ActionLink tone="neutral" disabled={snapshot.loading} onPress={() => void snapshot.reload()}>刷新数据</ActionLink>
    </View>
  </PageScrollView>;
}

export function buildHealthMutation(draft: ServiceDraft): ServiceMutation {
  const f = draft.fields;
  const record = draft.context.record as { id: string; revision: number } | null;
  if (draft.kind === "delete") return { method: "DELETE", path: `/health/${draft.context.resource}/${encodeURIComponent(record!.id)}?revision=${record!.revision}` };
  if (draft.kind === "profile") {
    const profile = draft.context.profile as HealthProfile;
    return { method: "PUT", path: "/health/profile", body: { revision: profile.revision, height_cm: f.height_cm.trim() ? positiveNumber(f.height_cm, "身高") : null, activity_limitations: textLines(f.activity_limitations), food_allergies: textLines(f.food_allergies), food_exclusions: textLines(f.food_exclusions), preferences: textLines(f.preferences), goals: textLines(f.goals), note: profile.note ?? "" } };
  }
  if (draft.kind === "reminders") {
    const reminders = draft.context.reminders as HealthReminders;
    if (!f.timezone.trim()) throw new Error("请填写时区。");
    try { new Intl.DateTimeFormat("en", { timeZone: f.timezone.trim() }); } catch { throw new Error("时区无效，请使用例如 Asia/Shanghai 的名称。"); }
    if (f.quiet_start) requireTime(f.quiet_start); if (f.quiet_end) requireTime(f.quiet_end);
    if (Boolean(f.quiet_start) !== Boolean(f.quiet_end)) throw new Error("安静时间的开始和结束请一起填写，或同时留空。");
    const slots = parseReminderSlots(f.slots, reminders.slots);
    if (f.enabled === "yes" && !slots.length) throw new Error("开启提醒前请至少填写一个时段。");
    const maximum = positiveNumber(f.max_per_day, "每天提醒次数", true);
    if (maximum > 12) throw new Error("每天提醒次数不能超过 12。");
    return { method: "PUT", path: "/health/reminders", body: { revision: reminders.revision, enabled: f.enabled === "yes", timezone: f.timezone.trim(), slots, quiet_start: f.quiet_start || null, quiet_end: f.quiet_end || null, tone: reminders.tone ?? "温和提醒", max_per_day: maximum, paused_dates: textLines(f.paused_dates).map((day) => requireDate(day, "暂停日期")) } };
  }
  if (draft.kind === "feedback") {
    const recommendation = draft.context.recommendation as HealthRecommendation;
    if (f.action === "accepted" && !f.option_id) throw new Error("请先选择采纳的方案。");
    return { method: "POST", path: `/health/recommendations/${encodeURIComponent(recommendation.id)}/feedback`, body: { id: draft.id, action: f.action, option_id: f.option_id || null, note: f.note.trim() } };
  }
  let resource = ""; let body: Record<string, unknown>;
  if (draft.kind === "rule") {
    if (!f.content.trim()) throw new Error("请填写规范内容。");
    const from = f.scope === "ongoing" ? null : requireDate(f.from, "生效日期");
    const until = f.scope === "once" ? from : f.scope === "range" && f.until ? requireDate(f.until, "截至日期") : null;
    if (from && until && until < from) throw new Error("截至日期不能早于生效日期。");
    resource = "rules"; body = { content: f.content.trim(), kind: f.kind, status: f.status, effective_from: from, effective_until: until, excluded_terms: f.kind === "restriction" ? textLines(f.excluded_terms) : [], origin: (record as HealthRule | null)?.origin ?? "user", confirmed: f.status === "active" };
  } else if (draft.kind === "meal") {
    if (f.status !== "skipped" && !f.description.trim()) throw new Error("请填写实际吃过的食物。");
    resource = "meals"; body = { occurred_at: localTimestamp(f.date, f.time), meal_type: f.meal_type, description: f.description.trim(), portion: f.portion.trim(), status: f.status, recommendation_id: draft.context.recommendation_id ?? null, note: f.note.trim(), estimated_energy: f.status === "recorded" ? (record as HealthMeal | null)?.estimated_energy ?? null : null };
  } else {
    if (!validDate(f.date)) throw new Error("测量日期请使用有效的 YYYY-MM-DD。");
    resource = draft.kind === "weight" ? "weights" : "steps";
    const value = draft.kind === "steps" && f.value.trim() === "0" ? 0 : positiveNumber(f.value, draft.kind === "weight" ? "体重" : "步数", draft.kind === "steps");
    body = { measured_at: localTimestamp(f.date, f.time), value, note: f.note.trim(), ...(draft.kind === "weight" ? { unit: f.unit } : {}) };
  }
  return record ? { method: "PUT", path: `/health/${resource}/${encodeURIComponent(record.id)}`, body: { ...body, revision: record.revision } } : { method: "POST", path: `/health/${resource}`, body: { ...body, id: draft.id } };
}
