import { AppearanceControl } from "./AppearanceControl";
import { AppUpdateSettings } from "./AppUpdateSettings";
import { ActionRow, PageHero, PageScrollView, SettingsGroup } from "./ui";

export type SettingsDestination = "host" | "connection" | "device" | "vault" | "chat";

export function SettingsHome({ connectionUrl, onOpen }: {
  connectionUrl?: string;
  onOpen: (destination: SettingsDestination) => void;
}) {
  return <PageScrollView tabs>
    <PageHero eyebrow="SETTINGS" title="设置" description="把知行调成你习惯的样子。" />
    <SettingsGroup title="通用"><AppearanceControl row />
      <ActionRow icon="chatbubbles-outline" title="对话设置" description="回复中的消息发送方式" tone="gold" compact onPress={() => onOpen("chat")} />
      <ActionRow icon="phone-portrait-outline" title="手机能力" description="通知、系统日历与一次定位" tone="blue" compact last onPress={() => onOpen("device")} />
    </SettingsGroup>
    <SettingsGroup title="工具箱">
      <ActionRow icon="lock-closed-outline" title="密码管理" description="本机加密保存账号、密码与密保资料" tone="gold" compact last onPress={() => onOpen("vault")} />
    </SettingsGroup>
    <SettingsGroup title="模型与服务">
      <ActionRow icon="extension-puzzle-outline" title="模型与插件" tone="gold" compact last
        description="使用 DSH 的模型、搜索、记忆与其他能力" onPress={() => onOpen("host")} />
    </SettingsGroup>
    <SettingsGroup title="数据与连接">
      <ActionRow icon="link-outline" title="服务连接" description={connectionUrl ? new URL(connectionUrl).host : "连接你的知行服务"} tone="neutral" compact last onPress={() => onOpen("connection")} />
    </SettingsGroup>
    <AppUpdateSettings />
  </PageScrollView>;
}
