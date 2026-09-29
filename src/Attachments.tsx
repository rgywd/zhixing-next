import { useState } from "react";
import { Image, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Connection, Resource } from "./api";
import { Button, colors, humanError, s } from "./ui";
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
      {items.map((item) => <View key={item.id} style={{ padding: 8, borderRadius: 12, backgroundColor: colors.pale, maxWidth: 170, gap: 4 }}>
        {item.mime_type.startsWith("image/") ? <Pressable accessibilityRole="button" accessibilityLabel={`查看图片 ${item.name}`} onPress={() => setSelected(item)}>
          <Image source={source(item)} accessibilityLabel={item.name} style={{ width: 140, height: 95, borderRadius: 8 }} resizeMode="cover" />
        </Pressable> : null}
        <Text numberOfLines={2} style={s.muted}>{item.name}</Text>
        {remove ? <Button secondary small onPress={() => remove(item.id)}>移除</Button> : <Button secondary small disabled={busy} onPress={() => {
          setBusy(true); setError("");
          void shareResource(connection, item).catch((e) => setError(humanError(e))).finally(() => setBusy(false));
        }}>下载分享</Button>}
      </View>)}
    </ScrollView>
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    <Modal visible={!!selected} onRequestClose={() => setSelected(null)}>
      <SafeAreaView style={s.root}>
        <View style={s.header}><Text style={[s.title, s.grow]}>{selected?.name}</Text><Button secondary onPress={() => setSelected(null)}>关闭</Button></View>
        {selected ? <Image source={source(selected)} accessibilityLabel={selected.name} resizeMode="contain" style={{ flex: 1, width: "100%" }} /> : null}
      </SafeAreaView>
    </Modal>
  </>;
}
