import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { BottomSheet } from "./BottomSheet";
import { BrandIcon } from "./BrandIcon";
import { colors, radius, space } from "./theme";
import { request, type Connection, type ModelCatalog } from "./api";
import { ModelPicker } from "./ModelPicker";
import { ActionLink, IconAction, PageHeading, PageScrollView, SettingsGroup, StatusPill, humanError, s } from "./ui";

const roles = [
  { id: "chat", label: "聊天", hint: "主知行新对话的默认模型", icon: "chatbubbles-outline" },
  { id: "task", label: "执行", hint: "任务与委托的默认模型", icon: "checkmark-circle-outline" },
  { id: "memory", label: "记忆整理", hint: "用于后台整理长期记忆", icon: "library-outline" },
] as const;

export function ModelsPanel({
  connection, catalog, onCatalog,
}: {
  connection: Connection;
  catalog: ModelCatalog | null;
  onCatalog: (catalog: ModelCatalog) => void;
}) {
  const [selectedRole, setSelectedRole] = useState<(typeof roles)[number]["id"] | null>(null);
  const [error, setError] = useState("");
  async function refresh() {
    setError("");
    try {
      onCatalog(await request<ModelCatalog>(connection, "/models"));
    } catch (e) {
      setError(humanError(e));
    }
  }
  return (
    <>
      <PageScrollView>
        <PageHeading title="默认模型" description="为聊天、执行和记忆选择合适的模型。" />
        {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
        {!catalog ? (
          <View style={s.card}>
            <Text style={s.text}>服务尚未提供模型目录。请更新服务后重试。</Text>
            <ActionLink icon="refresh-outline" onPress={() => { void refresh(); }}>重试</ActionLink>
          </View>
        ) : (
          <>
            <SettingsGroup title="模型分工">{roles.map((role) => {
              const model = catalog.items.find((item) => item.id === catalog.roles[role.id]);
              return (
                <Pressable key={role.id} accessibilityRole="button" accessibilityLabel={`选择${role.label}模型`} onPress={() => setSelectedRole(role.id)} style={[styles.role, role.id !== "memory" && styles.divider]}>
                  <View style={[styles.roleIcon, { backgroundColor: role.id === "chat" ? colors.purpleSoft : role.id === "task" ? colors.greenSoft : colors.goldSoft }]}><Ionicons name={role.icon} size={20} color={role.id === "chat" ? colors.purple : role.id === "task" ? colors.green : colors.gold} /></View>
                  <View style={s.headingCopy}><Text style={s.itemTitle}>{role.label}</Text><Text numberOfLines={1} style={s.muted}>{model?.name ?? "尚未配置"}</Text><Text style={s.small}>{role.hint}</Text></View>
                  <BrandIcon name={model ? `${model.model} ${model.provider}` : ""} size={23} /><Ionicons name="chevron-forward" size={16} color={colors.muted} />
                </Pressable>
              );
            })}</SettingsGroup>
            <Text style={s.muted}>更改后用于新的聊天和任务；已排队的任务保持原来的模型。</Text>
            <Pressable accessibilityRole="button" onPress={() => { void refresh(); }} style={styles.refresh}><Ionicons name="refresh-outline" size={16} color={colors.muted} /><Text style={s.description}>刷新目录</Text></Pressable>
          </>
        )}
      </PageScrollView>
      <ModelPicker
        visible={selectedRole !== null}
        title={`选择${roles.find((item) => item.id === selectedRole)?.label ?? ""}模型`}
        connectionUrl={connection.url}
        models={catalog?.items ?? []}
        selectedId={selectedRole ? catalog?.roles[selectedRole] ?? null : null}
        onSelect={async (modelId) => {
          if (!selectedRole) return;
          await request(connection, `/models/roles/${selectedRole}`, { method: "PUT", body: { model_id: modelId } });
          onCatalog(await request<ModelCatalog>(connection, "/models"));
        }}
        onClose={() => setSelectedRole(null)}
      />
    </>
  );
}


export function ProvidersPanel({ connection, catalog, onCatalog }: {
  connection: Connection;
  catalog: ModelCatalog | null;
  onCatalog: (catalog: ModelCatalog) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const providers = [...new Set(catalog?.items.map((item) => item.provider) ?? [])];
  const filtered = providers.filter((provider) =>
    catalog?.items.some((item) => item.provider === provider && `${provider} ${item.name} ${item.model}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),
  );
  const selectedModels = catalog?.items.filter((item) => item.provider === selected) ?? [];
  async function refresh() {
    setBusy(true); setError("");
    try { onCatalog(await request<ModelCatalog>(connection, "/models")); }
    catch (e) { setError(humanError(e)); }
    finally { setBusy(false); }
  }
  return <>
    <PageScrollView>
      <PageHeading title="模型供应商" description="查看已接入的服务与模型能力。" action={<IconAction icon="refresh-outline" label="刷新供应商" tone="purple" disabled={busy} onPress={() => { void refresh(); }} />} />
      <View style={styles.search}>
        <Ionicons name="search-outline" size={19} color={colors.muted} />
        <TextInput accessibilityLabel="搜索供应商或模型" placeholder="搜索供应商或模型" placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} style={styles.searchInput} autoCapitalize="none" autoCorrect={false} maxLength={100} />
        {query ? <IconAction icon="close-circle" label="清空供应商搜索" onPress={() => setQuery("")} /> : null}
      </View>
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      {busy ? <Text style={s.muted}>正在刷新…</Text> : null}
      {filtered.length ? <SettingsGroup title={`已接入 · ${filtered.length}`}>
        {filtered.map((provider, index) => {
          const models = catalog?.items.filter((item) => item.provider === provider) ?? [];
          const ready = models.filter((item) => item.ready).length;
          return <Pressable key={provider} accessibilityRole="button" accessibilityLabel={`查看供应商 ${provider}`} onPress={() => setSelected(provider)} style={({ pressed }) => [styles.provider, index < filtered.length - 1 && styles.divider, pressed && s.pressed]}>
            <BrandIcon name={`${provider} ${models[0]?.model ?? ""}`} size={30} />
            <View style={s.headingCopy}><Text style={s.itemTitle}>{provider}</Text><Text style={s.muted}>{models.length} 个模型 · {ready === models.length ? "密钥已配置" : `${models.length - ready} 个待配置`}</Text></View>
            <Ionicons name="chevron-forward" size={17} color={colors.muted} />
          </Pressable>;
        })}
      </SettingsGroup> : <Text style={s.description}>{query.trim() ? "没有匹配的供应商或模型" : catalog ? "还没有接入模型供应商" : "暂时无法读取供应商目录，请刷新重试。"}</Text>}
      <Text style={s.muted}>供应商地址和模型密钥由知行服务端管理。添加或修改后，在这里刷新目录；默认模型可回到设置中选择。</Text>
    </PageScrollView>
    <BottomSheet visible={selected !== null} title={selected ?? "模型供应商"} subtitle={`${selectedModels.length} 个模型`} onClose={() => setSelected(null)}>
      <ScrollView contentContainerStyle={styles.detail}>
        <View style={s.settingsGroup}>{selectedModels.map((model, index) => <View key={model.id} style={[styles.model, index < selectedModels.length - 1 && styles.divider]}>
          <View style={s.row}><BrandIcon name={`${model.model} ${model.provider}`} size={24} /><Text style={[s.itemTitle, s.grow]}>{model.name}</Text></View>
          <Text selectable style={s.muted}>{model.model}</Text>
          <View style={s.wrap}>
            <StatusPill tone={model.ready ? "green" : "neutral"}>{model.ready ? "密钥已配置" : "密钥未配置"}</StatusPill>
            <StatusPill>{model.protocol === "gemini" ? "Gemini" : model.protocol === "responses" ? "Responses" : "OpenAI 兼容"}</StatusPill>
            {model.image_input ? <StatusPill tone="blue">图片理解</StatusPill> : null}
            {model.reasoning_levels.length ? <StatusPill tone="gold">可调思考</StatusPill> : null}
          </View>
        </View>)}</View>
        <Text style={s.muted}>能力来自服务端配置。密钥已配置不代表已验证供应商连通性。</Text>
      </ScrollView>
    </BottomSheet>
  </>;
}

const styles = StyleSheet.create({
  role: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 76, paddingVertical: space.sm },
  roleIcon: { width: 34, height: 34, borderRadius: 11, backgroundColor: colors.neutral, alignItems: "center", justifyContent: "center" },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  search: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, minHeight: 48, backgroundColor: colors.white, borderRadius: radius.control, borderWidth: 1, borderColor: colors.line },
  searchInput: { flex: 1, minWidth: 0, color: colors.ink, paddingVertical: space.md, fontSize: 15 },
  provider: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 72, paddingVertical: space.md },
  detail: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.md },
  model: { gap: space.sm, paddingVertical: space.md },
  refresh: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 44 },
});
