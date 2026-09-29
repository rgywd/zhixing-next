import { useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { request, type Agent, type AgentTool, type Connection } from "./api";
import { Button, CardHeader, Field, PageHeading, PageScrollView, humanError, s } from "./ui";

const TOOL_LABELS: { id: AgentTool; label: string }[] = [
  { id: "inspect_environment", label: "查看运行环境" },
  { id: "list_directory", label: "列目录" },
  { id: "read_text_file", label: "读取文本" },
  { id: "read_document", label: "读取文档" },
  { id: "view_image", label: "查看图片" },
  { id: "write_text_file", label: "写入文本" },
  { id: "fetch_public_page", label: "读取公开网页" },
];
const SERVICE_TOOL_LABELS: Record<string, string> = {
  record_finance_observation: "记录明确金额",
  list_finance_observations: "读取财务记录",
  remove_finance_observation: "修正记录",
};
type Form = Pick<Agent, "name" | "description" | "instructions" | "tools" | "visible">;
const blank: Form = { name: "", description: "", instructions: "", tools: [], visible: true };

export function AgentsPanel({ connection, agents, onChanged, onChat, onNewChat }: {
  connection: Connection;
  agents: Agent[];
  onChanged: () => void;
  onChat: (id: string) => void;
  onNewChat: (id: string) => void;
}) {
  const [editing, setEditing] = useState<Agent | "new" | null>(null);
  const [form, setForm] = useState<Form>(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function edit(agent: Agent | "new") {
    setEditing(agent);
    setForm(agent === "new" ? blank : {
      name: agent.name, description: agent.description, instructions: agent.instructions,
      tools: agent.tools, visible: agent.visible,
    });
    setError("");
  }
  async function save() {
    if (!editing || busy) return;
    setBusy(true);
    setError("");
    try {
      await request(connection, editing === "new" ? "/agents" : `/agents/${editing.id}`, {
        method: editing === "new" ? "POST" : "PUT",
        body: { ...form, name: form.name.trim(), description: form.description.trim() },
      });
      setEditing(null);
      onChanged();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    setError("");
    try {
      await request(connection, `/agents/${id}`, { method: "DELETE" });
      setEditing(null);
      onChanged();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <PageScrollView>
      <PageHeading title="子智能体" description="主知行可以按需委托它们；你也可以直接聊。工具权限由服务端限制。" />
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      {editing ? (
        <View style={s.card}>
          <CardHeader icon="person-outline" title={editing === "new" ? "创建助手" : `设置 ${editing.name}`} />
          <Field label="名称" value={form.name} onChangeText={(name) => setForm({ ...form, name })} maxLength={200} />
          <Field label="擅长什么" value={form.description} onChangeText={(description) => setForm({ ...form, description })} maxLength={1000} multiline />
          <Field label="具体要求" value={form.instructions} onChangeText={(instructions) => setForm({ ...form, instructions })} maxLength={20000} multiline />
          {editing === "new" || editing.kind === "custom" ? (
            <View style={s.stack}>
              <Text style={s.label}>可用工具</Text>
              <Text style={s.muted}>仅选择确实需要的工具。宿主目录仍受服务器授权范围约束。</Text>
              {TOOL_LABELS.map((tool) => (
                <Pressable key={tool.id} accessibilityRole="checkbox" accessibilityState={{ checked: form.tools.includes(tool.id) }}
                  onPress={() => setForm({ ...form, tools: form.tools.includes(tool.id) ? form.tools.filter((item) => item !== tool.id) : [...form.tools, tool.id] })}
                  style={s.row}>
                  <Text style={s.text}>{form.tools.includes(tool.id) ? "☑" : "□"} {tool.label}</Text>
                </Pressable>
              ))}
            </View>
          ) : <Text style={s.muted}>服务专用工具由服务绑定；可根据文字和清晰截图记录金额；截图需要支持视觉的模型，不能读取真实账户。</Text>}
          <Pressable accessibilityRole="switch" accessibilityState={{ checked: form.visible }} onPress={() => setForm({ ...form, visible: !form.visible })}>
            <Text style={s.text}>{form.visible ? "☑" : "□"} 在助手列表中显示</Text>
          </Pressable>
          <Button disabled={busy || !form.name.trim() || !form.description.trim()} onPress={() => { void save(); }}>保存</Button>
          <Button secondary onPress={() => setEditing(null)}>返回列表</Button>
          {editing !== "new" && editing.kind === "custom" ? (
            <Button secondary danger disabled={busy} onPress={() => Alert.alert("删除这个助手？", "已有对话会保留，并转为主知行对话。", [
              { text: "取消", style: "cancel" },
              { text: "删除", style: "destructive", onPress: () => { void remove(editing.id); } },
            ])}>删除助手</Button>
          ) : null}
        </View>
      ) : (
        <>
          {agents.filter((agent) => agent.visible).map((agent) => (
            <View key={agent.id} style={s.card}>
              <CardHeader icon="person-outline" title={`${agent.name}${agent.kind === "service" ? " · 服务助手" : ""}`} description={agent.description} />
              <Text style={s.muted}>工具：{agent.tools.length ? agent.tools.map((id) => TOOL_LABELS.find((tool) => tool.id === id)?.label ?? SERVICE_TOOL_LABELS[id] ?? id).join("、") : "暂无专用工具"}</Text>
              <Button onPress={() => onChat(agent.id)}>继续对话</Button>
              <Button secondary onPress={() => onNewChat(agent.id)}>新对话</Button>
              <Button secondary onPress={() => edit(agent)}>设置</Button>
            </View>
          ))}
          {agents.some((agent) => !agent.visible) ? (
            <View style={s.card}>
              <Text style={s.label}>已隐藏</Text>
              {agents.filter((agent) => !agent.visible).map((agent) => (
                <Button key={agent.id} secondary onPress={() => edit(agent)}>{agent.name} · 设置</Button>
              ))}
            </View>
          ) : null}
          <Button secondary onPress={() => edit("new")}>创建自定义助手</Button>
        </>
      )}
    </PageScrollView>
  );
}
