import { useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import {
  normalizeServerUrl,
  request,
  type Assistant,
  type Connection,
  type ServiceStatus,
} from "./api";
import { saveConnection } from "./storage";
import { Button, Field, humanError, s } from "./ui";

export function ConnectionForm({
  initial,
  onConnect,
}: {
  initial?: Connection;
  onConnect: (connection: Connection) => void;
}) {
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
    <View style={{ gap: 18 }}>
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
        仅保存连接服务所需的令牌，使用手机安全存储。模型密钥在服务器上配置。
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={s.error}>
          {error}
        </Text>
      ) : null}
      <Button
        disabled={busy}
        onPress={() => {
          void connect();
        }}
      >
        {busy ? "正在验证连接…" : "保存并连接"}
      </Button>
    </View>
  );
}
export function SettingsPanel({
  connection,
  assistant,
  onAssistant,
  onConnect,
  onDisconnect,
  onExplore,
}: {
  connection: Connection;
  assistant: Assistant;
  onAssistant: (assistant: Assistant) => void;
  onConnect: (connection: Connection) => void;
  onDisconnect: () => void;
  onExplore: () => void;
}) {
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
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[s.content, s.tabContent]}
    >
      <Text style={s.heading}>慢慢熟悉彼此</Text>
      <Text style={s.muted}>称呼、表达方式和相处习惯，都可以随时调整。</Text>
      <View style={s.card}>
        <Field
          label="助手的名字"
          value={name}
          onChangeText={setName}
          maxLength={80}
        />
        <Field
          label="你希望我们怎样相处"
          placeholder="例如：自然直接，先给结论；遇到不确定的事坦诚说明。可以称呼我…"
          multiline
          value={persona}
          onChangeText={setPersona}
          maxLength={20000}
          style={{ minHeight: 190 }}
        />
        {error ? <Text style={s.error}>{error}</Text> : null}
        {notice ? <Text style={s.muted}>{notice}</Text> : null}
        <Button
          disabled={busy || !name.trim()}
          onPress={() => {
            void save();
          }}
        >
          {busy ? "保存中…" : "保存人格设定"}
        </Button>
      </View>
      <View style={s.card}>
        <Text style={s.title}>认识运行环境</Text>
        <Text style={s.muted}>
          创建一次可追踪的只读任务，了解实际可访问的目录和工具。结果保留在独立会话中。
        </Text>
        <Button secondary onPress={onExplore}>
          探索我的运行环境
        </Button>
      </View>
      <View style={s.card}>
        <Text style={s.title}>连接服务</Text>
        <ConnectionForm initial={connection} onConnect={onConnect} />
        <Button
          secondary
          danger
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
        >
          断开并移除令牌
        </Button>
      </View>
    </ScrollView>
  );
}
