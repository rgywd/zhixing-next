import { ScrollView, Text, TextInput, View } from "react-native";
import { BottomSheet } from "./BottomSheet";
import { ActionLink, Button, useUi } from "./ui";
import { layout, space } from "./theme";
import type { DshAttachment } from "./dshProtocol";

export type MessageRevision = { id: string; kind: "edit" | "retry"; seq: number; version: string; text: string;
  attachments: DshAttachment[]; submitted?: boolean };

export function MessageRevisionSheet({ visible, value, busy, error, onChange, onSubmit, onCancel, onClose }: {
  visible: boolean; value?: MessageRevision; busy: boolean; error: string;
  onChange: (value: MessageRevision) => void; onSubmit: () => void; onCancel: () => void; onClose: () => void;
}) {
  const { s, colors } = useUi();
  const edit = value?.kind === "edit";
  return <BottomSheet visible={visible && !!value} title={edit ? "编辑消息" : "重新回答"} tall={edit} onClose={() => { if (!busy) onClose(); }}>
    {value ? <><ScrollView keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }} contentContainerStyle={[s.content, { gap: space.md }]}>
      <Text style={s.description}>{edit ? "修改这条消息，并从这里重新回答。" : "使用这条回复对应的用户消息，从这里重新回答。"}旧消息和后续回复保留在原版本，可随时切换查看。</Text>
      <Text style={s.muted}>此前已经执行的文件修改和其他操作不会撤销；新回答可能再次调用工具。</Text>
      {edit ? <TextInput accessibilityLabel="编辑原消息" multiline value={value.text} editable={!busy && !value.submitted}
        onChangeText={text => onChange({ ...value, text })} placeholder="输入修改后的消息" placeholderTextColor={colors.muted}
        style={[s.input, { minHeight: 140, maxHeight: 300, textAlignVertical: "top" }]} /> : null}
      {edit ? value.attachments.map((a, i) => <View key={`${a.id}:${i}`} style={s.row}>
        <Text style={[s.description, { flex: 1 }]}>{a.type === "image" ? "图片" : "文件"} · {a.name}</Text>
        <ActionLink disabled={busy || !!value.submitted} onPress={() => onChange({ ...value, attachments: value.attachments.filter(file => file.id !== a.id) })}>移除附件</ActionLink>
      </View>) : null}
      {value.submitted && !busy ? <Text style={s.muted}>提交已发出，重试会核对同一次操作。放弃重试不会撤销已经开始的回复。</Text> : null}
    </ScrollView><View style={{ paddingHorizontal: layout.gutter, paddingTop: space.sm, gap: space.xs }}>
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      <Button disabled={busy || (edit && !value.text.trim() && !value.attachments.length)} onPress={onSubmit}>
        {busy ? "正在提交…" : value.submitted ? "重试提交" : edit ? "保存并重新回答" : "重新回答"}
      </Button>
      <ActionLink disabled={busy} onPress={onCancel}>{value.submitted ? "放弃重试" : edit ? "放弃本次编辑" : "取消重答"}</ActionLink>
    </View></> : null}
  </BottomSheet>;
}
