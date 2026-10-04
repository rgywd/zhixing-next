import { AppearanceControl } from "./AppearanceControl";
import type { Assistant, ModelCatalog } from "./api";
import { ActionRow, PageHero, PageScrollView, SettingsGroup } from "./ui";

export type SettingsDestination = "providers" | "models" | "search" | "persona" | "agents" | "resources" | "connection" | "device";

export function SettingsHome({ assistant, catalog, connectionUrl, onOpen }: {
  assistant?: Assistant | null;
  catalog?: ModelCatalog | null;
  connectionUrl?: string;
  onOpen: (destination: SettingsDestination) => void;
}) {
  const chatModel = catalog?.items.find((item) => item.id === catalog.roles.chat);
  return <PageScrollView tabs>
    <PageHero eyebrow="SETTINGS" title="设置" description="把知行调成你习惯的样子。" />
    <SettingsGroup title="通用"><AppearanceControl row />
      <ActionRow icon="phone-portrait-outline" title="手机能力" description="通知、系统日历与一次定位" tone="blue" compact last onPress={() => onOpen("device")} />
    </SettingsGroup>
    <SettingsGroup title="模型与服务">
      <ActionRow icon="server-outline" title="模型供应商" tone="gold" compact
        description="管理供应商、密钥与模型" onPress={() => onOpen("providers")} />
      <ActionRow icon="sparkles-outline" title="默认模型" tone="gold" compact
        description={chatModel ? `聊天 · ${chatModel.name}` : "聊天、执行与记忆整理"} onPress={() => onOpen("models")} />
      <ActionRow icon="globe-outline" title="搜索服务" description="管理聊天中使用的联网搜索" tone="blue" compact last onPress={() => onOpen("search")} />
    </SettingsGroup>
    <SettingsGroup title="助手">
      <ActionRow icon="person-outline" title="人格偏好" description={`${assistant?.name ?? "知行"}的称呼、表达方式与相处习惯`} tone="gold" compact onPress={() => onOpen("persona")} />
      <ActionRow icon="people-outline" title="子智能体" description="服务助手与自定义助手" tone="gold" compact last onPress={() => onOpen("agents")} />
    </SettingsGroup>
    <SettingsGroup title="数据与连接">
      <ActionRow icon="albums-outline" title="资源库" description="图片、资料和交付文件" tone="blue" compact onPress={() => onOpen("resources")} />
      <ActionRow icon="link-outline" title="服务连接" description={connectionUrl ? new URL(connectionUrl).host : "连接你的知行服务"} tone="neutral" compact last onPress={() => onOpen("connection")} />
    </SettingsGroup>
  </PageScrollView>;
}
