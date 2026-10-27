import { useUi, ActionLink, humanError } from "./ui";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { Connection, Resource } from "./api";

import { shareResource } from "./resources";
import { ResourcePreview } from "./ResourcePreview";
import { MessagePhotos } from "./PhotoAttachments";

export function Attachments({ connection, items = [], remove }: {
  connection: Connection;
  items?: Resource[];
  remove?: (id: string) => void;
}) {
  const { s, colors } = useUi();
  const [selected, setSelected] = useState<Resource | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!items.length) return null;
  const photos = items.filter((item) => item.mime_type.startsWith("image/"));
  const files = items.filter((item) => !item.mime_type.startsWith("image/"));
  return <>
    {photos.length ? <MessagePhotos connection={connection} items={photos} /> : null}
    {files.length ? <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingVertical: 6 }}>
      {files.map((item) => <View key={item.id} style={{ padding: 8, borderRadius: 12, backgroundColor: colors.blueSoft, maxWidth: 170, minWidth: 130, gap: 4 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`打开文件 ${item.name}`} onPress={() => setSelected(item)} style={{ minHeight: 44, justifyContent: "center" }}>
          <Ionicons name="document-text-outline" size={22} color={colors.blue} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`查看附件 ${item.name}`} onPress={() => setSelected(item)} style={{ minHeight: 44, justifyContent: "center" }}>
          <Text numberOfLines={2} style={s.muted}>{item.name}</Text>
        </Pressable>
        {remove ? <ActionLink icon="close" tone="blue" onPress={() => remove(item.id)}>移除</ActionLink> : <ActionLink icon="share-outline" tone="blue" disabled={busy} onPress={() => {
          setBusy(true); setError("");
          void shareResource(connection, item).catch((e) => setError(humanError(e))).finally(() => setBusy(false));
        }}>下载分享</ActionLink>}
      </View>)}
    </ScrollView> : null}
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    <ResourcePreview connection={connection} resource={selected} onClose={() => setSelected(null)} />
  </>;
}
