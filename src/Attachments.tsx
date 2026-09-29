import { useState } from "react";
import { Image, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { Connection, Resource } from "./api";
import { ActionLink, SheetHeader, colors, humanError, s } from "./ui";
import { shareResource } from "./resources";

export function Attachments({ connection, items = [], remove }: {
  connection: Connection;
  items?: Resource[];
  remove?: (id: string) => void;
}) {
  const [selected, setSelected] = useState<Resource | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const source = (item: Resource) => ({
    uri: `${connection.url}/v1/resources/${encodeURIComponent(item.id)}/content?preview=true`,
    headers: { Authorization: `Bearer ${connection.token}` },
  });
  if (!items.length) return null;
  return <>
    <ScrollView horizontal contentContainerStyle={{ gap: 8, paddingVertical: 6 }}>
      {items.map((item) => <View key={item.id} style={{ padding: 8, borderRadius: 12, backgroundColor: colors.blueSoft, maxWidth: 170, minWidth: 130, gap: 4 }}>
        {item.mime_type.startsWith("image/") ? <Pressable accessibilityRole="button" accessibilityLabel={`查看图片 ${item.name}`} onPress={() => setSelected(item)}>
          <Image source={source(item)} accessibilityLabel={item.name} style={{ width: 140, height: 95, borderRadius: 8 }} resizeMode="cover" />
        </Pressable> : <Ionicons name="document-outline" size={22} color={colors.blue} />}
        <Text numberOfLines={2} style={s.muted}>{item.name}</Text>
        {remove ? <ActionLink icon="close" tone="blue" onPress={() => remove(item.id)}>移除</ActionLink> : <ActionLink icon="share-outline" tone="blue" disabled={busy} onPress={() => {
          setBusy(true); setError("");
          void shareResource(connection, item).catch((e) => setError(humanError(e))).finally(() => setBusy(false));
        }}>下载分享</ActionLink>}
      </View>)}
    </ScrollView>
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    <Modal visible={!!selected} onRequestClose={() => setSelected(null)}>
      <SafeAreaView style={s.root}>
        <SheetHeader title={selected?.name ?? "图片"} onClose={() => setSelected(null)} />
        {selected ? <Image source={source(selected)} accessibilityLabel={selected.name} resizeMode="contain" style={{ flex: 1, width: "100%" }} /> : null}
      </SafeAreaView>
    </Modal>
  </>;
}
