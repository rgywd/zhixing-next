import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { DshSettingsController } from "./useDshSettings";
import { permissionChoices } from "./dshPermissions";
import { ActionLink, PageHeading, PageScrollView, SettingsGroup, useUi } from "./ui";
import { layout, space } from "./theme";

export function ChatSettingsPanel({ controller }: { controller?: DshSettingsController }) {
  const { s, colors } = useUi();
  const settings = controller?.snapshot?.settings;
  const groups = [
    { key: "permission" as const, title: "新会话的默认权限", description: "只影响新建会话。已有会话保留各自的权限，也可在输入框旁单独调整。",
      choices: permissionChoices.map(option => ({ value: option.value, title: option.label, description: option.description })) },
    { key: "busy" as const, title: "繁忙时的发送行为", description: "主知行、财务和健康助手共用。空闲时直接发送新消息；单条消息也可单独选择发送方式。",
      choices: [{ value: "queue", title: "排队发送", description: "等当前回复完成，再处理新消息。" },
        { value: "steer", title: "插话发送", description: "将新要求加入正在进行的回复。" }] },
  ];
  return <PageScrollView>
    <PageHeading title="对话设置" description="与云端 DSH 共用，修改后在其他端也会生效。" />
    {!controller ? <Text style={s.muted}>连接服务后，可以查看和修改云端配置。</Text> : <>
      {controller.loading ? <Text style={s.muted}>{settings ? "正在同步…" : "正在读取云端配置…"}</Text> : null}
      {controller.saving ? <Text style={s.muted}>正在保存到云端…</Text> : null}
      {controller.error ? <Text accessibilityRole="alert" style={s.error}>{controller.error}</Text> : null}
      {controller.cacheWarning ? <Text style={s.muted}>{controller.cacheWarning}</Text> : null}
      {controller.snapshot ? <Text style={s.muted}>{controller.error ? "当前显示上次同步的配置 · " : "上次同步 · "}{new Date(controller.snapshot.checkedAt).toLocaleString()}</Text> : null}
      <ActionLink icon="refresh-outline" disabled={controller.loading || !!controller.saving} onPress={() => { void controller.refresh(true); }}>刷新云端配置</ActionLink>
      {settings && !settings.writable ? <Text style={s.muted}>当前服务配置只读。</Text> : null}
      {groups.map(group => {
        const item = settings?.[group.key];
        const choices = item?.options.map(value => group.choices.find(option => option.value === value)
          ?? { value, title: value, description: "DSH 自定义权限模式" }) ?? [];
        const disabled = !settings?.writable || !item || !!controller.saving;
        return <View key={group.key} style={s.stack}>
          <SettingsGroup title={group.title}>
            {choices.map(option => <Pressable key={option.value} accessibilityRole="radio"
              accessibilityLabel={`${option.title}，${option.description}`}
              accessibilityState={{ checked: item?.value === option.value, disabled }} disabled={disabled}
              onPress={() => { void controller.select(group.key, option.value); }}
              style={[s.row, { minHeight: layout.touchTarget, paddingVertical: space.md, paddingHorizontal: space.md }]}>
              <View style={s.headingCopy}><Text style={s.label}>{option.title}</Text><Text style={s.muted}>{option.description}</Text></View>
              <Ionicons name={item?.value === option.value ? "radio-button-on" : "radio-button-off"} size={22} color={item?.value === option.value ? colors.gold : colors.muted} />
            </Pressable>)}
            {settings && !item ? <Text style={s.muted}>当前 DSH 未提供这项配置。</Text> : null}
            {item && !item.options.includes(item.value) ? <Text style={s.muted}>当前云端值：{item.value}</Text> : null}
          </SettingsGroup>
          <Text style={s.muted}>{group.description}</Text>
        </View>;
      })}
    </>}
  </PageScrollView>;
}
