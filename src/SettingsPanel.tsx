import { useUi, ActionLink, Button, Field, PageHeading, PageScrollView, SettingsGroup, StatusPill, humanError } from "./ui";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import {
  normalizeServerUrl,
  request,
  type Assistant,
  type Connection,
  type ServiceStatus,
} from "./api";
import { saveConnection } from "./storage";

export function ConnectionForm({
  initial,
  onConnect,
}: {
  initial?: Connection;
  onConnect: (connection: Connection) => void;
}) {
  const { s } = useUi();
  const [url, setUrl] = useState(initial?.url ?? "");
  const [token, setToken] = useState(initial?.token ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function connect() {
    setError("");
    setBusy(true);
    try {
      const connection = {
        url: normalizeServerUrl(url, __DEV__),
        token: token.trim(),
      };
      if (connection.token.length < 24)
        throw new Error("请输入后端配置的服务访问令牌（至少 24 个字符）。");
      await request<ServiceStatus>(connection, "/status");
      await saveConnection(connection);
      onConnect(connection);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={s.form}>
      <Field
        label="服务地址"
        placeholder="https://assistant.example.com"
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        maxLength={300}
        editable={!busy}
      />
      <Field
        label="服务访问令牌"
        placeholder="由你的后端服务生成"
        value={token}
        onChangeText={setToken}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={1024}
        editable={!busy}
      />
      <Text style={s.muted}>
        仅保存连接服务所需的令牌，使用手机安全存储。供应商密钥仅保存在服务端。
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={s.error}>
          {error}
        </Text>
      ) : null}
      <Button
        disabled={busy}
        style={{ alignSelf: "flex-start" }}
        onPress={() => {
          void connect();
        }}
      >
        {busy ? "正在验证连接…" : "保存并连接"}
      </Button>
    </View>
  );
}
export function PersonaSettingsPanel({
  connection,
  assistant,
  onAssistant,
}: {
  connection: Connection;
  assistant: Assistant;
  onAssistant: (assistant: Assistant) => void;
}) {
  const { s } = useUi();
  const [name, setName] = useState(assistant.name);
  const [persona, setPersona] = useState(assistant.persona);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const updated = await request<Assistant>(connection, "/assistant", {
        method: "PUT",
        body: { name: name.trim(), persona },
      });
      onAssistant(updated);
      setNotice("已保存，后续运行使用这份人格设定。");
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <PageScrollView>
      <PageHeading title="人格偏好" description="称呼、表达方式和相处习惯，都可以随时调整。" />
      <View style={s.form}>
        <Field
          label="助手的名字"
          value={name}
          onChangeText={(value) => { setName(value); setNotice(""); }}
          maxLength={80}
          editable={!busy}
        />
        <Field
          label="你希望我们怎样相处"
          placeholder="例如：自然直接，先给结论；遇到不确定的事坦诚说明。可以称呼我…"
          multiline
          value={persona}
          onChangeText={(value) => { setPersona(value); setNotice(""); }}
          maxLength={20000}
          editable={!busy}
          style={{ minHeight: 132 }}
        />
        {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
        {notice ? <StatusPill tone="green">已保存</StatusPill> : null}
        <Button
          disabled={busy || !name.trim()}
          style={{ alignSelf: "flex-start" }}
          onPress={() => {
            void save();
          }}
        >
          {busy ? "保存中…" : "保存人格设定"}
        </Button>
      </View>
    </PageScrollView>
  );
}

export function ConnectionSettingsPanel({ connection, onConnect, onDisconnect, onExplore }: {
  connection?: Connection;
  onConnect: (connection: Connection) => void;
  onDisconnect?: () => void;
  onExplore?: () => void;
}) {
  const { s } = useUi();
  return (
    <PageScrollView>
      <PageHeading title="服务连接" description="连接你的知行，继续聊天与工作。" />
      <ConnectionForm initial={connection} onConnect={onConnect} />
      {onExplore ? <SettingsGroup title="运行环境">
        <ActionLink icon="compass-outline" tone="blue" onPress={onExplore}>探索运行环境</ActionLink>
        <Text style={[s.muted, { paddingBottom: 12 }]}>了解可访问的目录和工具，结果会保留在一段新对话中。</Text>
      </SettingsGroup> : null}
      {onDisconnect ? (
        <ActionLink
          icon="log-out-outline"
          onPress={() =>
            Alert.alert(
              "断开当前服务？",
              "本机将移除服务令牌。服务器上的会话、计划和执行中的任务会保留。",
              [
                { text: "取消", style: "cancel" },
                { text: "断开", style: "destructive", onPress: onDisconnect },
              ],
            )
          }
        >断开并移除令牌</ActionLink>
      ) : null}
    </PageScrollView>
  );
}
