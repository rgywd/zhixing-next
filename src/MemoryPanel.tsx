import { useEffect, useState } from "react";
import { Alert, Modal, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { request, type Connection, type Page } from "./api";
import { ActionLink, Empty, PageScrollView, SheetHeader, humanError, s } from "./ui";

type Memory = { id: string; content: string; seq: number };

export function MemoryPanel({ connection, onClose }: {
  connection: Connection;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Memory[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void request<Page<Memory>>(connection, "/memories?limit=100")
      .then((page) => { if (active) { setItems(page.items); setCursor(page.next_cursor); setError(""); } })
      .catch((e) => { if (active) setError(humanError(e)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [connection]);
  async function more() {
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const page = await request<Page<Memory>>(connection, `/memories?cursor=${encodeURIComponent(cursor)}&limit=100`);
      setItems((old) => [...old, ...page.items]);
      setCursor(page.next_cursor);
    } catch (e) { setError(humanError(e)); }
    finally { setBusy(false); }
  }
  function forget(item: Memory) {
    Alert.alert("忘记这件事？", "删除后，知行后续不会再使用这条记忆。原对话仍会保留。", [
      { text: "取消", style: "cancel" },
      { text: "忘记", style: "destructive", onPress: () => {
        setBusy(true);
        void request(connection, `/memories/${item.id}`, { method: "DELETE" })
          .then(() => setItems((old) => old.filter((value) => value.id !== item.id)))
          .catch((e) => setError(humanError(e)))
          .finally(() => setBusy(false));
      } },
    ]);
  }
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={s.root}>
        <SheetHeader title="知行记得" onClose={onClose} />
        <PageScrollView>
          <Text style={s.muted}>你可以直接在对话里告诉知行要记住、纠正或忘记什么。</Text>
          {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
          {!busy && !items.length && !error ? <Empty compact icon="library-outline" title="还没有整理出记忆" /> : null}
          {items.map((item) => <View key={item.id} style={s.card}><Text selectable style={s.text}>{item.content}</Text><ActionLink icon="trash-outline" disabled={busy} onPress={() => forget(item)}>忘记这条</ActionLink></View>)}
          {cursor ? <ActionLink icon="chevron-down" disabled={busy} onPress={() => { void more(); }}>{busy ? "加载中…" : "查看更多"}</ActionLink> : null}
        </PageScrollView>
      </SafeAreaView>
    </Modal>
  );
}
