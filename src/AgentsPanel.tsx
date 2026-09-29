import { useUi, ActionLink, ActionRow, Button, CardHeader, Field, IconAction, PageHeading, PageScrollView, StatusPill, humanError } from "./ui";
import { useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { request, type Agent, type AgentTool, type Connection } from "./api";

const TOOL_LABELS: { id: AgentTool; label: string }[] = [
  { id: "inspect_environment", label: "查看运行环境" },
  { id: "list_directory", label: "列目录" },
  { id: "read_text_file", label: "读取文本" },
  { id: "read_document", label: "读取文档" },
  { id: "view_image", label: "查看图片" },
  { id: "write_text_file", label: "写入文本" },
  { id: "fetch_public_page", label: "读取公开网页" },
];
type Form = Pick<Agent, "name" | "description" | "instructions" | "tools" | "visible">;
const blank: Form = { name: "", description: "", instructions: "", tools: [], visible: true };

export function AgentsPanel({ connection, agents, onChanged, onChat, onNewChat }: {
  connection: Connection;
  agents: Agent[];
  onChanged: () => void;
  onChat: (id: string) => void;
  onNewChat: (id: string) => void;
}) {
  const { s, colors } = useUi();
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
      <PageHeading title="子智能体" description="各有所长，随时聊聊或交给知行委托。" />
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      {editing ? (
        <View style={s.card}>
          <CardHeader icon="person-outline" title={editing === "new" ? "创建助手" : `设置 ${editing.name}`} tone="gold" />
          <Field label="名称" value={form.name} onChangeText={(name) => setForm({ ...form, name })} maxLength={200} />
          <Field label="擅长什么" value={form.description} onChangeText={(description) => setForm({ ...form, description })} maxLength={1000} multiline />
          <Field label="具体要求" value={form.instructions} onChangeText={(instructions) => setForm({ ...form, instructions })} maxLength={20000} multiline />
          {editing === "new" || editing.kind === "custom" ? (
            <View style={s.stack}>
              <Text style={s.label}>可用工具</Text>
              <Text style={s.muted}>仅选择确实需要的工具。宿主目录仍受服务器授权范围约束。</Text>
              <View style={s.wrap}>{TOOL_LABELS.map((tool) => (
                <Pressable key={tool.id} accessibilityRole="checkbox" accessibilityState={{ checked: form.tools.includes(tool.id) }}
                  onPress={() => setForm({ ...form, tools: form.tools.includes(tool.id) ? form.tools.filter((item) => item !== tool.id) : [...form.tools, tool.id] })}
                  style={[s.chip, form.tools.includes(tool.id) && { backgroundColor: colors.goldSoft }, { flexDirection: "row", gap: 5 }]}>
                  <Ionicons name={form.tools.includes(tool.id) ? "checkmark-circle" : "ellipse-outline"} size={16} color={form.tools.includes(tool.id) ? colors.gold : colors.muted} />
                  <Text style={[s.chipText, form.tools.includes(tool.id) && { color: colors.gold }]}>{tool.label}</Text>
                </Pressable>
              ))}</View>
            </View>
          ) : <Text style={s.muted}>服务专用工具由服务绑定；可根据文字和清晰截图记录金额；截图需要支持视觉的模型，不能读取真实账户。</Text>}
          <Pressable accessibilityRole="switch" accessibilityState={{ checked: form.visible }} onPress={() => setForm({ ...form, visible: !form.visible })} style={[s.row, { minHeight: 44 }]}>
            <Ionicons name={form.visible ? "checkmark-circle" : "ellipse-outline"} size={20} color={form.visible ? colors.gold : colors.muted} />
            <Text style={s.label}>在助手列表中显示</Text>
          </Pressable>
          <View style={s.row}><Button disabled={busy || !form.name.trim() || !form.description.trim()} onPress={() => { void save(); }}>保存助手</Button><ActionLink onPress={() => setEditing(null)}>取消</ActionLink></View>
          {editing !== "new" && editing.kind === "custom" ? (
            <ActionLink icon="trash-outline" disabled={busy} onPress={() => Alert.alert("删除这个助手？", "已有对话会保留，并转为主知行对话。", [
              { text: "取消", style: "cancel" },
              { text: "删除", style: "destructive", onPress: () => { void remove(editing.id); } },
            ])}>删除助手</ActionLink>
          ) : null}
        </View>
      ) : (
        <>
          {agents.filter((agent) => agent.visible).map((agent) => (
            <View key={agent.id} style={s.card}>
              <CardHeader icon={agent.kind === "service" ? "wallet-outline" : "person-outline"} title={agent.name} description={agent.description} tone="gold" action={<IconAction icon="ellipsis-horizontal" label={`设置${agent.name}`} onPress={() => edit(agent)} />} />
              <View style={[s.row, { justifyContent: "flex-end", gap: 8 }]}>
                <Pressable accessibilityRole="button" accessibilityLabel={`与${agent.name}新建对话`} onPress={() => onNewChat(agent.id)} style={s.linkButton}><Ionicons name="create-outline" size={18} color={colors.muted} /><Text style={s.description}>新对话</Text></Pressable>
                <ActionLink icon="chatbubble-ellipses-outline" tone="gold" onPress={() => onChat(agent.id)}>继续聊</ActionLink>
              </View>
            </View>
          ))}
          {agents.some((agent) => !agent.visible) ? (
            <View style={s.card}>
              <View style={s.spread}><Text style={s.label}>已隐藏</Text><StatusPill>{String(agents.filter((agent) => !agent.visible).length)}</StatusPill></View>
              {agents.filter((agent) => !agent.visible).map((agent) => (
                <ActionRow key={agent.id} icon="eye-off-outline" title={agent.name} onPress={() => edit(agent)} last compact tone="neutral" />
              ))}
            </View>
          ) : null}
          <Pressable accessibilityRole="button" onPress={() => edit("new")} style={s.linkButton}><Ionicons name="add-circle-outline" size={20} color={colors.accent} /><Text style={s.link}>创建助手</Text></Pressable>
        </>
      )}
    </PageScrollView>
  );
}
