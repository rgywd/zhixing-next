import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { ApiError, request, type Connection, type DiscoveredModel, type ManagedModel, type ModelCatalog, type ModelProbe, type ModelProvider } from "./api";
import { BottomSheet } from "./BottomSheet";
import { BrandIcon } from "./BrandIcon";
import { Choice, ManagedModelForm, ProviderForm } from "./ProviderForms";
import { matchesModel, modelInput, protocolLabels } from "./providerEditing";
import type { ThemeColors } from "./theme";
import { radius, space } from "./theme";
import { useThemedStyles } from "./ThemeProvider";
import { ActionLink, Button, Field, IconAction, PageHeading, PageScrollView, SettingsGroup, StatusPill, humanError, useUi } from "./ui";

type ProvidersProps = { connection: Connection; catalog: ModelCatalog | null; onCatalog: (catalog: ModelCatalog) => void };
export function ProvidersPanel(props: ProvidersProps) {
  return <ProviderManager key={props.connection.url} {...props} />;
}
function ProviderManager({ connection, onCatalog }: ProvidersProps) {
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [supported, setSupported] = useState(true);
  const refresh = useCallback((signal?: AbortSignal) => request<{ items: ModelProvider[] }>(connection, "/providers", { signal })
    .then((result) => { if (!signal?.aborted) { setProviders(result.items); setSupported(true); } })
    .catch((e) => { if (!signal?.aborted) { setSupported(!(e instanceof ApiError && e.status === 404)); setError(e instanceof ApiError && e.status === 404 ? "当前服务尚不支持供应商管理，请先更新知行服务。" : humanError(e)); } })
    .finally(() => { if (!signal?.aborted) setLoading(false); }), [connection]);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  async function refreshCatalog() {
    try { onCatalog(await request<ModelCatalog>(connection, "/models")); }
    catch { setError("配置已保存，但聊天目录刷新失败，请点击刷新后重试。"); }
  }
  async function accept(provider: ModelProvider) {
    setProviders((items) => items.some((item) => item.id === provider.id) ? items.map((item) => item.id === provider.id ? provider : item) : [...items, provider]);
    await refreshCatalog();
  }
  const selected = providers.find((item) => item.id === selectedId);
  const filtered = providers.filter((item) => matchesModel(query, item.name, ...item.models.map((model) => `${model.name} ${model.model}`)));
  return <>
    <PageScrollView>
      <PageHeading title="模型供应商" description="连接服务，添加你想用的模型。" action={<View style={s.row}><IconAction icon="refresh-outline" label="刷新供应商" disabled={loading} onPress={() => { setLoading(true); setError(""); void refresh().then(refreshCatalog); }} /><IconAction icon="add" label="添加供应商" tone="gold" disabled={!supported || loading} onPress={() => setCreating(true)} /></View>} />
      <Field label="搜索供应商或模型" placeholder="名称、模型 ID" value={query} onChangeText={setQuery} autoCorrect={false} autoCapitalize="none" maxLength={100} />
      {loading ? <ActivityIndicator color={colors.gold} /> : null}
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      {filtered.length ? <SettingsGroup title={`供应商 · ${filtered.length}`}>{filtered.map((provider, index) => <Pressable key={provider.id} accessibilityRole="button" accessibilityLabel={`管理供应商 ${provider.name}`} onPress={() => setSelectedId(provider.id)} style={({ pressed }) => [styles.row, index < filtered.length - 1 && s.rowDivider, pressed && s.pressed]}>
        <BrandIcon name={`${provider.name} ${provider.models[0]?.model ?? ""}`} size={29} />
        <View style={s.headingCopy}><Text style={s.itemTitle}>{provider.name}</Text><Text numberOfLines={1} style={s.muted}>{protocolLabels[provider.protocol]} · {provider.models.filter((model) => model.enabled).length} 个模型</Text></View>
        {!provider.enabled ? <StatusPill>已停用</StatusPill> : !provider.has_api_key ? <StatusPill tone="gold">待配置</StatusPill> : null}
        <Ionicons name="chevron-forward" size={17} color={colors.muted} />
      </Pressable>)}</SettingsGroup> : !loading && !error ? <View style={styles.empty}><Text style={s.description}>{query.trim() ? "没有匹配的供应商或模型" : "添加供应商后，可获取模型列表或手动输入模型 ID。"}</Text>{!query.trim() ? <ActionLink icon="add" onPress={() => setCreating(true)}>添加第一个供应商</ActionLink> : null}</View> : null}
    </PageScrollView>
    <BottomSheet visible={creating || !!selected} title={creating ? "添加供应商" : selected?.name ?? "供应商"} subtitle={selected ? `${protocolLabels[selected.protocol]} · ${selected.models.length} 个模型` : "选择协议，填写连接信息"} tall onClose={() => { setCreating(false); setSelectedId(null); }}>
      {creating ? <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}><ProviderForm onSave={async (input) => {
        const created = await request<ModelProvider>(connection, "/providers", { method: "POST", body: input });
        await accept(created); setCreating(false); setSelectedId(created.id);
      }} /></ScrollView> : selected ? <ProviderDetail key={selected.id} provider={selected} connection={connection} onChange={accept} onDelete={async () => {
        await request(connection, `/providers/${selected.id}?revision=${selected.revision}`, { method: "DELETE" });
        setProviders((items) => items.filter((item) => item.id !== selected.id)); setSelectedId(null); await refreshCatalog();
      }} /> : null}
    </BottomSheet>
  </>;
}

function ProviderDetail({ provider, connection, onChange, onDelete }: { provider: ModelProvider; connection: Connection; onChange: (provider: ModelProvider) => Promise<void>; onDelete: () => Promise<void> }) {
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
  const [view, setView] = useState<"models" | "config" | "add" | "edit" | "discover">(provider.models.length ? "models" : "config");
  const [editing, setEditing] = useState<ManagedModel | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [tested, setTested] = useState<{ model: string; revision: number; result: ModelProbe } | null>(null);
  function open(next: typeof view, model?: ManagedModel) { setView(next); setEditing(model); setError(""); }
  async function action(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(humanError(e)); } finally { setBusy(false); }
  }
  function remove(model?: ManagedModel) {
    Alert.alert(model ? `删除 ${model.name}？` : `删除 ${provider.name}？`, "相关默认选择会清除；聊天记录和已排队任务保留。", [
      { text: "取消", style: "cancel" },
      { text: "删除", style: "destructive", onPress: () => { void action(async () => {
        if (model) await onChange(await request<ModelProvider>(connection, `/providers/${provider.id}/models/${model.id}?revision=${provider.revision}`, { method: "DELETE" }));
        else await onDelete();
      }); } },
    ]);
  }
  const models = provider.models.filter((model) => matchesModel(query, model.name, model.model));
  if (view === "discover") return <Discovery connection={connection} provider={provider} onBack={() => open("models")} onChange={onChange} />;
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    {view === "add" || view === "edit" ? <>
      <ActionLink icon="arrow-back" tone="neutral" onPress={() => open("models")}>返回模型列表</ActionLink>
      <ManagedModelForm key={editing?.id ?? "new"} model={editing} protocol={provider.protocol} onSave={async (input) => {
        const path = `/providers/${provider.id}/models${editing ? `/${editing.id}` : ""}`;
        await onChange(await request<ModelProvider>(connection, path, { method: editing ? "PUT" : "POST", body: editing ? { revision: provider.revision, model: input } : { revision: provider.revision, models: [input] } }));
        open("models");
      }} />
    </> : <>
      <View style={s.wrap}><Choice label="配置" selected={view === "config"} disabled={busy} onPress={() => open("config")} /><Choice label="模型" selected={view === "models"} disabled={busy} onPress={() => open("models")} /></View>
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      {view === "config" ? <ProviderForm key={provider.id} provider={provider} onDelete={() => remove()} onSave={async (input) => { await onChange(await request<ModelProvider>(connection, `/providers/${provider.id}`, { method: "PUT", body: input })); }} /> : <>
        <View style={s.row}><ActionLink icon="cloud-download-outline" tone="blue" disabled={busy || !provider.has_api_key} onPress={() => open("discover")}>获取模型</ActionLink><View style={s.grow} /><ActionLink icon="add" tone="gold" disabled={busy} onPress={() => open("add")}>手动添加</ActionLink></View>
        {provider.models.length > 5 ? <Field label="搜索模型" value={query} onChangeText={setQuery} placeholder="模型 ID 或显示名称" /> : null}
        {models.length ? <SettingsGroup title={`已添加 · ${provider.models.length}`}>{models.map((model, index) => <View key={model.id} style={[styles.row, index < models.length - 1 && s.rowDivider]}>
          <Pressable accessibilityRole="button" accessibilityLabel={`编辑模型 ${model.name}`} disabled={busy} onPress={() => open("edit", model)} style={styles.modelChoice}>
            <BrandIcon name={`${model.model} ${provider.name}`} size={24} />
            <View style={s.headingCopy}><Text style={s.itemTitle}>{model.name}</Text><Text numberOfLines={1} style={s.small}>{model.model}</Text><View style={s.wrap}>{!model.enabled ? <StatusPill>已停用</StatusPill> : null}{model.image_input ? <StatusPill tone="blue">图片</StatusPill> : null}{model.reasoning_levels.length ? <StatusPill tone="gold">思考</StatusPill> : null}</View></View>
          </Pressable>
          <IconAction icon="pulse-outline" label={`测试模型 ${model.name}`} disabled={busy || !provider.has_api_key} onPress={() => { void action(async () => {
            setTested(null);
            const result = await request<ModelProbe>(connection, `/providers/${provider.id}/models/${model.id}/test`, { method: "POST", timeoutMs: 50000 });
            setTested({ model: model.name, revision: provider.revision, result });
          }); }} />
          <IconAction icon="trash-outline" label={`删除模型 ${model.name}`} disabled={busy} onPress={() => remove(model)} />
        </View>)}</SettingsGroup> : <Text style={s.description}>{query ? "没有匹配的模型" : "从供应商获取模型列表，或手动添加模型 ID。"}</Text>}
        {!provider.has_api_key ? <Text style={s.muted}>先在“配置”中保存密钥，再获取或测试模型。</Text> : <Text style={s.muted}>测试会发送三个小请求，分别检查回复、流式输出与工具调用，可能产生少量费用。</Text>}
        {busy ? <View style={s.row}><ActivityIndicator color={colors.gold} /><Text style={s.muted}>正在处理，请稍候…</Text></View> : null}
        {tested && tested.revision === provider.revision ? <SettingsGroup title={`${tested.model} · 测试结果`}>{tested.result.checks.map((check) => <View key={check.kind} style={styles.check}>
          <Ionicons name={check.ok ? "checkmark-circle-outline" : "alert-circle-outline"} size={19} color={check.ok ? colors.green : colors.red} />
          <View style={s.headingCopy}><Text style={s.text}>{{ reply: "普通回复", stream: "流式回复", tools: "工具调用" }[check.kind]} · {check.ok ? "通过" : "未通过"}</Text>{check.message ? <Text style={s.muted}>{check.message}</Text> : null}</View><Text style={s.small}>{(check.elapsed_ms / 1000).toFixed(1)}s</Text>
        </View>)}</SettingsGroup> : null}
      </>}
    </>}
  </ScrollView>;
}

function Discovery({ connection, provider, onChange, onBack }: { connection: Connection; provider: ModelProvider; onChange: (provider: ModelProvider) => Promise<void>; onBack: () => void }) {
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
  const [items, setItems] = useState<DiscoveredModel[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void request<{ items: DiscoveredModel[]; truncated: boolean }>(connection, `/providers/${provider.id}/discover`, { method: "POST", timeoutMs: 25000, signal: controller.signal })
      .then((result) => { setItems(result.items); setTruncated(result.truncated); })
      .catch((e) => { if (!controller.signal.aborted) setError(humanError(e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [connection, provider.id, attempt]);
  const existing = new Set(provider.models.map((item) => item.model));
  const filtered = items.filter((item) => matchesModel(query, item.model, item.name));
  const selectable = filtered.filter((item) => !existing.has(item.model));
  async function add() {
    if (busy || !selected.length) return;
    setBusy(true); setError("");
    try {
      const models = items.filter((item) => selected.includes(item.model)).map((item) => ({ ...modelInput(), model: item.model, display_name: item.name }));
      await onChange(await request<ModelProvider>(connection, `/providers/${provider.id}/models`, { method: "POST", body: { revision: provider.revision, models } }));
      onBack();
    } catch (e) { setError(humanError(e)); } finally { setBusy(false); }
  }
  return <>
    <View style={styles.discoveryHeader}><ActionLink icon="arrow-back" tone="neutral" onPress={onBack}>返回模型列表</ActionLink><Field label="搜索可用模型" value={query} onChangeText={setQuery} placeholder="支持多个关键词" autoCorrect={false} autoCapitalize="none" /></View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      {loading ? <ActivityIndicator color={colors.gold} /> : null}
      {error ? <><Text accessibilityRole="alert" style={s.error}>{error}</Text><ActionLink icon="refresh-outline" disabled={loading || busy} onPress={() => { setLoading(true); setError(""); setAttempt((value) => value + 1); }}>重新获取</ActionLink></> : null}
      {truncated ? <Text style={s.muted}>列表已截断（最多 2000 个）；其余模型可手动添加。</Text> : null}
      {!loading && !error && !filtered.length ? <Text style={s.muted}>没有找到模型，可返回手动添加。</Text> : null}
      {selectable.length ? <ActionLink disabled={busy} onPress={() => setSelected(Array.from(new Set([...selected, ...selectable.map((item) => item.model)])).slice(0, 200))}>选中筛选结果（最多 200 个）</ActionLink> : null}
      {filtered.map((item) => <Pressable key={item.model} accessibilityRole="checkbox" accessibilityLabel={item.name} accessibilityState={{ checked: existing.has(item.model) || selected.includes(item.model), disabled: busy || existing.has(item.model) }} disabled={busy || existing.has(item.model)} onPress={() => setSelected((values) => values.includes(item.model) ? values.filter((id) => id !== item.model) : values.length < 200 ? [...values, item.model] : values)} style={styles.row}>
        <BrandIcon name={`${item.model} ${provider.name}`} size={25} /><View style={s.headingCopy}><Text style={s.text}>{item.name}</Text><Text style={s.small}>{item.model}</Text></View>{existing.has(item.model) ? <Text style={s.small}>已添加</Text> : <Ionicons name={selected.includes(item.model) ? "checkbox" : "square-outline"} size={22} color={selected.includes(item.model) ? colors.gold : colors.muted} />}
      </Pressable>)}
    </ScrollView>
    <View style={styles.discoveryFooter}><Button disabled={busy || !selected.length} onPress={() => { void add(); }}>{busy ? "添加中…" : `添加 ${selected.length} 个模型`}</Button></View>
  </>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.md },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 64, paddingVertical: space.sm },
  modelChoice: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 48 },
  check: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm },
  empty: { paddingVertical: space.lg, gap: space.md },
  discoveryHeader: { paddingHorizontal: space.lg, gap: space.sm, paddingBottom: space.md },
  discoveryFooter: { paddingHorizontal: space.lg, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: radius.control },
});
