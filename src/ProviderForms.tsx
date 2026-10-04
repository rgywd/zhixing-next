import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ManagedModel, ManagedModelInput, ModelProtocol, ModelProvider, ProviderInput, ReasoningEffort } from "./api";
import { reasoningLabel } from "./ModelPicker";
import { modelInput, protocolLabels, protocolUrls, providerInput } from "./providerEditing";
import { ActionLink, Button, Field, SettingsGroup, SwitchRow, humanError, useUi } from "./ui";

export function Choice({ label, selected, disabled, onPress, multiple = false, accessibilityLabel = label }: { label: string; selected: boolean; disabled?: boolean; onPress: () => void; multiple?: boolean; accessibilityLabel?: string }) {
  const { s, colors } = useUi();
  return <Pressable accessibilityRole={multiple ? "checkbox" : "radio"} accessibilityLabel={accessibilityLabel} accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [{ minHeight: 44, paddingHorizontal: 13, justifyContent: "center", borderRadius: 12, borderWidth: 1, borderColor: selected ? colors.gold : colors.line, backgroundColor: selected ? colors.goldSoft : colors.surfaceRaised }, pressed && s.pressed]}>
    <Text style={[s.text, { color: selected ? colors.gold : colors.ink }]}>{label}</Text>
  </Pressable>;
}

export function ProviderForm({ provider, onSave, onDelete }: {
  provider?: ModelProvider; onSave: (input: ProviderInput) => Promise<void>; onDelete?: () => void;
}) {
  const { s } = useUi();
  const [form, setForm] = useState<ProviderInput>(() => ({ name: provider?.name ?? "", protocol: provider?.protocol ?? "chat_completions", base_url: provider?.base_url ?? protocolUrls.chat_completions, enabled: provider?.enabled ?? true }));
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  function edit(next: Partial<ProviderInput>) { setForm({ ...form, ...next }); setSaved(false); }
  async function save() {
    if (busy) return;
    setBusy(true); setError(""); setSaved(false);
    try { await onSave(providerInput(provider, form, key, clearKey)); setKey(""); setClearKey(false); setSaved(true); }
    catch (e) { setError(humanError(e)); }
    finally { setBusy(false); }
  }
  return <>
    <View style={s.wrap}>{(Object.keys(protocolLabels) as ModelProtocol[]).map((protocol) => <Choice key={protocol} label={protocolLabels[protocol]} selected={form.protocol === protocol} disabled={busy} onPress={() => edit({ protocol, base_url: Object.values(protocolUrls).includes(form.base_url) ? protocolUrls[protocol] : form.base_url })} />)}</View>
    <Field label="供应商名称" value={form.name} onChangeText={(name) => edit({ name })} placeholder="例如：阿里云百炼" maxLength={100} editable={!busy} />
    <Field label="API 地址" value={form.base_url} onChangeText={(base_url) => edit({ base_url })} autoCapitalize="none" autoCorrect={false} keyboardType="url" maxLength={2000} editable={!busy} />
    <Field label={provider?.has_api_key ? "替换 API 密钥" : "API 密钥"} value={key} onChangeText={(value) => { setKey(value); setClearKey(false); setSaved(false); }} placeholder={provider?.has_api_key ? "留空保留已保存的密钥" : "粘贴供应商密钥"} secureTextEntry autoCapitalize="none" autoCorrect={false} maxLength={1000} editable={!busy} />
    <Text style={s.muted}>{provider?.credential_source === "environment" ? "当前密钥来自服务端环境变量。填写新密钥后将替换此引用。" : "密钥仅提交到你的知行服务，不保存在手机，也不会再次显示。"}</Text>
    <SwitchRow label="启用供应商" value={form.enabled} disabled={busy} onValueChange={(enabled) => edit({ enabled })} />
    {provider?.has_api_key ? <SwitchRow label="清除已保存密钥" value={clearKey} disabled={busy} onValueChange={(value) => { setClearKey(value); if (value) setKey(""); setSaved(false); }} /> : null}
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    {saved ? <Text accessibilityLiveRegion="polite" style={s.muted}>已保存，对新的请求生效。</Text> : null}
    <View style={s.row}>{onDelete ? <ActionLink icon="trash-outline" disabled={busy} onPress={onDelete}>删除供应商</ActionLink> : null}<View style={s.grow} /><Button small disabled={busy} onPress={() => { void save(); }}>{busy ? "保存中…" : provider ? "保存配置" : "添加供应商"}</Button></View>
  </>;
}

export function ManagedModelForm({ model, protocol, onSave }: {
  model?: ManagedModel; protocol: ModelProtocol; onSave: (input: ManagedModelInput) => Promise<void>;
}) {
  const { s } = useUi();
  const [form, setForm] = useState(() => modelInput(model));
  const [advanced, setAdvanced] = useState(false);
  const [temperature, setTemperature] = useState(model?.temperature?.toString() ?? "");
  const [contextWindow, setContextWindow] = useState(model?.context_window?.toString() ?? "");
  const [timeout, setTimeoutValue] = useState((model?.timeout ?? 60).toString());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const detected = model?.model === form.model && model?.reasoning_kind && model.reasoning_kind !== "manual";
  const levels = detected ? model.reasoning_levels : (Object.keys(reasoningLabel) as ReasoningEffort[]).filter((item) => protocol !== "gemini" || !["none", "xhigh", "max"].includes(item));
  function edit(next: Partial<ManagedModelInput>) { setForm({ ...form, ...next }); }
  function toggleLevel(level: ReasoningEffort) {
    const reasoning_levels = form.reasoning_levels.includes(level) ? form.reasoning_levels.filter((item) => item !== level) : [...form.reasoning_levels, level];
    edit({ reasoning_levels, reasoning_effort: form.reasoning_effort && reasoning_levels.includes(form.reasoning_effort) ? form.reasoning_effort : null });
  }
  async function save() {
    if (busy) return;
    setError("");
    const next = { ...form, model: form.model.trim(), display_name: form.display_name?.trim() || null, temperature: temperature.trim() ? Number(temperature) : null, timeout: Number(timeout), context_window: contextWindow.trim() ? Number(contextWindow) : form.context_window === undefined ? undefined : null };
    if (!next.model) { setError("请填写供应商使用的实际模型 ID。"); return; }
    if ((next.temperature !== null && (!Number.isFinite(next.temperature) || next.temperature < 0 || next.temperature > 2)) || !Number.isFinite(next.timeout) || next.timeout <= 0 || next.timeout > 300) { setError("温度应在 0–2 之间，超时应在 1–300 秒之间。"); return; }
    if (next.context_window != null && (!Number.isInteger(next.context_window) || next.context_window < 4096 || next.context_window > 10000000)) { setError("上下文容量应为 4096–10000000 之间的整数。"); return; }
    setBusy(true);
    try { await onSave(next); } catch (e) { setError(humanError(e)); } finally { setBusy(false); }
  }
  return <>
    <Field label="模型 ID" value={form.model} onChangeText={(value) => edit({ model: value })} placeholder="供应商提供的实际模型 ID" autoCapitalize="none" autoCorrect={false} maxLength={200} editable={!busy} />
    <Field label="显示名称" value={form.display_name ?? ""} onChangeText={(display_name) => edit({ display_name })} placeholder="可选，留空使用模型 ID" maxLength={100} editable={!busy} />
    <SettingsGroup title="模型能力">
      <SwitchRow label="启用模型" value={form.enabled} disabled={busy} onValueChange={(enabled) => edit({ enabled })} />
      <SwitchRow label="图片理解" value={form.image_input} disabled={busy} onValueChange={(image_input) => edit({ image_input })} />
    </SettingsGroup>
    <Text style={s.label}>支持的思考档位</Text>
    <View style={s.wrap}>{levels.map((level) => <Choice key={level} multiple accessibilityLabel={`支持${model?.reasoning_labels?.[level] ?? reasoningLabel[level]}思考`} label={model?.reasoning_labels?.[level] ?? reasoningLabel[level]} selected={form.reasoning_levels.includes(level)} disabled={busy || !!detected} onPress={() => toggleLevel(level)} />)}</View>
    <Text style={s.muted}>{detected ? levels.length ? "已按模型 ID 适配思考选项。" : "此模型没有可调整的思考选项。" : "保存后按模型 ID 自动适配；未识别的模型使用这里的档位设置。模型列表不代表连接测试已通过。"}</Text>
    <ActionLink icon={advanced ? "chevron-up-outline" : "options-outline"} tone="neutral" onPress={() => setAdvanced(!advanced)}>高级参数</ActionLink>
    {advanced ? <>
      <Field label="温度" value={temperature} onChangeText={setTemperature} placeholder="模型默认" keyboardType="decimal-pad" editable={!busy} />
      <Field label="上下文容量（token）" value={contextWindow} onChangeText={setContextWindow} placeholder="留空使用模型资料" keyboardType="number-pad" editable={!busy} />
      <Text style={s.muted}>填写供应商实际支持的容量，供长对话自动压缩使用。</Text>
      <Field label="超时（秒）" value={timeout} onChangeText={setTimeoutValue} keyboardType="number-pad" editable={!busy} />
      {protocol !== "gemini" || detected ? <><Text style={s.label}>默认思考</Text><View style={s.wrap}><Choice label="模型默认" selected={!form.reasoning_effort} disabled={busy} onPress={() => edit({ reasoning_effort: null })} />{form.reasoning_levels.filter((item): item is Exclude<ReasoningEffort, "auto"> => item !== "auto").map((level) => <Choice key={level} label={model?.reasoning_labels?.[level] ?? reasoningLabel[level]} selected={form.reasoning_effort === level} disabled={busy} onPress={() => edit({ reasoning_effort: level })} />)}</View></> : null}
    </> : null}
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    <Button disabled={busy} onPress={() => { void save(); }}>{busy ? "保存中…" : model ? "保存模型" : "添加模型"}</Button>
  </>;
}
