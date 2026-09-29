import { useState } from "react";
import { Text, View } from "react-native";
import { request, type Connection, type ModelCatalog } from "./api";
import { ModelPicker } from "./ModelPicker";
import { Button, CardHeader, PageHeading, PageScrollView, humanError, s } from "./ui";

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
  const providers = [...new Set(catalog?.items.map((item) => item.provider) ?? [])];
  return (
    <>
      <PageScrollView>
        <PageHeading title="供应商与模型" description="供应商地址和密钥留在服务器配置，手机只选择已接入的模型。" />
        {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
        {!catalog ? (
          <View style={s.card}>
            <Text style={s.text}>服务尚未提供模型目录。请更新服务后重试。</Text>
            <Button secondary onPress={() => { void refresh(); }}>重试</Button>
          </View>
        ) : (
          <>
            <Text style={s.title}>默认分工</Text>
            {roles.map((role) => {
              const model = catalog.items.find((item) => item.id === catalog.roles[role.id]);
              return (
                <View key={role.id} style={s.card}>
                  <CardHeader icon={role.icon} title={role.label} description={role.hint} />
                  <Text style={s.text}>{model ? `${model.name} · ${model.provider}` : "尚未配置"}</Text>
                  <Button secondary onPress={() => setSelectedRole(role.id)}>选择模型</Button>
                </View>
              );
            })}
            <Text style={s.title}>已接入的供应商</Text>
            {providers.length ? providers.map((provider) => (
              <View key={provider} style={s.card}>
                <CardHeader icon="server-outline" title={provider} />
                {catalog.items.filter((item) => item.provider === provider).map((item) => (
                  <View key={item.id} style={s.spread}>
                    <Text numberOfLines={1} style={[s.text, s.grow]}>{item.name}</Text>
                    <Text style={[s.caption, item.ready ? s.accentText : s.danger]}>
                      {item.ready ? "密钥已配置" : "密钥未就绪"}
                    </Text>
                  </View>
                ))}
              </View>
            )) : <Text style={s.muted}>服务器尚未配置模型。</Text>}
            <Button secondary onPress={() => { void refresh(); }}>刷新目录</Button>
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
