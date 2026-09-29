import type { ThemeColors } from "./theme";
import { useUi, ActionLink, PageHeading, PageScrollView, SettingsGroup, humanError } from "./ui";
import { useThemedStyles } from "./ThemeProvider";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { BrandIcon } from "./BrandIcon";
import { space } from "./theme";
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
                  <View style={[styles.roleIcon, { backgroundColor: role.id === "chat" ? colors.pale : role.id === "task" ? colors.blueSoft : colors.goldSoft }]}><Ionicons name={role.icon} size={20} color={role.id === "chat" ? colors.accent : role.id === "task" ? colors.blue : colors.gold} /></View>
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

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  role: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 76, paddingVertical: space.sm },
  roleIcon: { width: 34, height: 34, borderRadius: 11, backgroundColor: colors.neutral, alignItems: "center", justifyContent: "center" },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  refresh: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 44 },
});
