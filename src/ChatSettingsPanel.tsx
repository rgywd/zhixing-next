import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { useChatPreferences, type ChatDefaultIntent } from "./chatPreferences";
import { ActionLink, PageHeading, PageScrollView, SettingsGroup, useUi } from "./ui";
import { layout } from "./theme";

export function ChatSettingsPanel() {
  const { s, colors } = useUi();
  const preferences = useChatPreferences();
  const options: { value: ChatDefaultIntent; title: string; description: string }[] = [
    { value: "queue", title: "接着处理", description: "等当前回复结束后，再处理新消息。" },
    { value: "steer", title: "补充当前回复", description: "把新消息补充给正在回复的助手。" },
  ];
  return <PageScrollView>
    <PageHeading title="对话设置" description="选择回复中收到新消息时的处理方式。" />
    <SettingsGroup title="回复过程中发送消息">
      {options.map((option) => <Pressable key={option.value} accessibilityRole="radio"
        accessibilityLabel={`${option.title}，${option.description}`}
        accessibilityState={{ checked: preferences.defaultIntent === option.value, disabled: !preferences.ready || preferences.saving }}
        disabled={!preferences.ready || preferences.saving}
        onPress={() => { void preferences.setDefaultIntent(option.value).catch(() => undefined); }}
        style={[s.row, { minHeight: layout.touchTarget, paddingVertical: 12, paddingHorizontal: 14 }]}>
        <View style={s.headingCopy}><Text style={s.label}>{option.title}</Text><Text style={s.muted}>{option.description}</Text></View>
        <Ionicons name={preferences.defaultIntent === option.value ? "radio-button-on" : "radio-button-off"} size={22} color={preferences.defaultIntent === option.value ? colors.gold : colors.muted} />
      </Pressable>)}
    </SettingsGroup>
    {!preferences.ready && !preferences.error ? <Text style={s.muted}>正在读取对话偏好…</Text> : null}
    {preferences.saving ? <Text style={s.muted}>正在保存…</Text> : null}
    {preferences.error ? <View style={s.stack}><Text accessibilityRole="alert" style={s.error}>{preferences.error}</Text><ActionLink icon="refresh-outline" onPress={preferences.retry}>重新读取偏好</ActionLink></View> : null}
    <Text style={s.muted}>默认方式用于新开始编辑的消息；已编辑的内容保留原方式，也可在当前对话设置中调整。没有进行中的回复时，会直接发送为新消息。此设置保存在这台手机，对主知行与子助手通用。</Text>
  </PageScrollView>;
}
