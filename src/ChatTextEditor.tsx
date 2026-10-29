import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { CopyAction } from "./CopyAction";
import { SheetHeader, useUi } from "./ui";
import { layout, space } from "./theme";

export type TextSelection = { start: number; end: number };
export function ChatTextEditor({ text, onText, editable = true, maxLength, initialSelection, onSelection, onClose }: {
  text: string; onText?: (text: string) => void; editable?: boolean; maxLength?: number;
  initialSelection?: TextSelection; onSelection?: (selection: TextSelection) => void; onClose: () => void;
}) {
  const { s, colors } = useUi();
  const [selection, setSelection] = useState(initialSelection);
  return <Modal visible onRequestClose={onClose} animationType="slide">
    <SafeAreaView style={s.root}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <SheetHeader title={onText ? "编辑消息" : "选取文字"} onClose={onClose} />
        {onText ? <TextInput autoFocus accessibilityLabel="完整消息" multiline value={text} editable={editable}
          placeholder="说说你的想法…" placeholderTextColor={colors.muted} maxLength={maxLength}
          selection={selection} onSelectionChange={e => { setSelection(e.nativeEvent.selection); onSelection?.(e.nativeEvent.selection); }}
          onChangeText={onText} style={[s.text, { flex: 1, textAlignVertical: "top", padding: layout.gutter, fontSize: 16 }]} />
          : <ScrollView contentContainerStyle={{ padding: layout.gutter }}><Text selectable style={s.text}>{text}</Text></ScrollView>}
        <View style={{ paddingHorizontal: layout.gutter, paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: colors.line }}>
          {onText ? <Text style={s.muted}>收起后继续编辑，附件保留在输入框中。</Text> : <CopyAction text={text} label="复制全文" />}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}
