import type { ThemeColors } from "./theme";
import { useUi, ActionLink, PageHeading, PageScrollView, StatusPill, humanError } from "./ui";
import { useThemedStyles } from "./ThemeProvider";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { BrandIcon } from "./BrandIcon";
import { radius, space } from "./theme";
import { request, type Connection, type ModelCatalog } from "./api";
import { ModelPicker } from "./ModelPicker";

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
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
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
  const providers = [...new Set(catalog?.items.map((item) => item.provider) ?? [])];
  return (
    <>
      <PageScrollView>
        <PageHeading title="供应商与模型" description="为聊天、执行和记忆选择合适的模型。" />
        {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
        {!catalog ? (
          <View style={s.card}>
            <Text style={s.text}>服务尚未提供模型目录。请更新服务后重试。</Text>
            <ActionLink icon="refresh-outline" onPress={() => { void refresh(); }}>重试</ActionLink>
          </View>
        ) : (
          <>
            <Text style={s.title}>默认分工</Text>
            <View style={styles.roles}>{roles.map((role) => {
              const model = catalog.items.find((item) => item.id === catalog.roles[role.id]);
              return (
                <Pressable key={role.id} accessibilityRole="button" accessibilityLabel={`选择${role.label}模型`} onPress={() => setSelectedRole(role.id)} style={[styles.role, role.id !== "memory" && styles.divider]}>
                  <View style={[styles.roleIcon, { backgroundColor: role.id === "chat" ? colors.pale : role.id === "task" ? colors.blueSoft : colors.goldSoft }]}><Ionicons name={role.icon} size={20} color={role.id === "chat" ? colors.accent : role.id === "task" ? colors.blue : colors.gold} /></View>
                  <View style={s.headingCopy}><Text style={s.itemTitle}>{role.label}</Text><Text numberOfLines={1} style={s.muted}>{model?.name ?? "尚未配置"}</Text></View>
                  <BrandIcon name={model ? `${model.model} ${model.provider}` : ""} size={23} /><Ionicons name="chevron-forward" size={16} color={colors.muted} />
                </Pressable>
              );
            })}</View>
            <Text style={s.title}>已接入的供应商</Text>
            {providers.length ? <View style={s.card}>{providers.map((provider, index) => (
              <View key={provider} style={[styles.providerGroup, index > 0 && styles.providerDivider]}>
                <Text style={s.caption}>{provider}</Text>
                {catalog.items.filter((item) => item.provider === provider).map((item) => (
                  <View key={item.id} style={[s.spread, { minHeight: 46 }]}>
                    <View style={[s.row, s.grow]}><BrandIcon name={`${item.model} ${item.provider}`} size={22} /><Text numberOfLines={1} style={[s.itemTitle, s.grow]}>{item.name}</Text></View>
                    <StatusPill tone={item.ready ? "green" : "neutral"}>{item.ready ? "就绪" : "未就绪"}</StatusPill>
                  </View>
                ))}
              </View>
            ))}</View> : <Text style={s.muted}>服务器尚未配置模型。</Text>}
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

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  roles: { backgroundColor: colors.surfaceRaised, borderRadius: radius.item, paddingHorizontal: space.md },
  role: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 65 },
  roleIcon: { width: 34, height: 34, borderRadius: 11, backgroundColor: colors.neutral, alignItems: "center", justifyContent: "center" },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  providerGroup: { gap: 3, paddingVertical: space.sm },
  providerDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  refresh: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 44 },
});
