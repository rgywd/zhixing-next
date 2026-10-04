import { useUi, ActionLink, humanError } from "./ui";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { Connection, Resource } from "./api";

import { shareResource } from "./resources";
import { ResourceImage, ResourcePreview } from "./ResourcePreview";

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
  return <>
    <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingVertical: 6 }}>
      {items.map((item) => <View key={item.id} style={{ padding: 8, borderRadius: 12, backgroundColor: colors.blueSoft, maxWidth: 170, minWidth: 130, gap: 4 }}>
        {item.mime_type.startsWith("image/") ? <Pressable accessibilityRole="button" accessibilityLabel={`查看图片 ${item.name}`} onPress={() => setSelected(item)}>
          <ResourceImage connection={connection} resource={item} style={{ width: 140, height: 95 }} />
        </Pressable> : <Ionicons name="document-outline" size={22} color={colors.blue} />}
        <Text numberOfLines={2} style={s.muted}>{item.name}</Text>
        {remove ? <ActionLink icon="close" tone="blue" onPress={() => remove(item.id)}>移除</ActionLink> : <ActionLink icon="share-outline" tone="blue" disabled={busy} onPress={() => {
          setBusy(true); setError("");
          void shareResource(connection, item).catch((e) => setError(humanError(e))).finally(() => setBusy(false));
        }}>下载分享</ActionLink>}
      </View>)}
    </ScrollView>
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    <ResourcePreview connection={connection} resource={selected} onClose={() => setSelected(null)} />
  </>;
}
