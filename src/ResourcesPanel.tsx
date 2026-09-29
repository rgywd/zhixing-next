import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { mergeById, request, type Connection, type Page, type Resource } from "./api";
import { Attachments } from "./Attachments";
import { Button, humanError, s } from "./ui";

export function ResourcesPanel({ connection }: { connection: Connection }) {
  const [items, setItems] = useState<Resource[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    request<Page<Resource>>(connection, "/resources?limit=50", { signal: controller.signal })
      .then((page) => { setItems(page.items); setCursor(page.next_cursor); })
      .catch((e) => { if (!controller.signal.aborted) setError(humanError(e)); });
    return () => controller.abort();
  }, [connection]);
  async function more() {
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const page = await request<Page<Resource>>(connection, `/resources?cursor=${encodeURIComponent(cursor)}&limit=50`);
      setItems((old) => mergeById(old, page.items)); setCursor(page.next_cursor); setError("");
    } catch (e) { setError(humanError(e)); } finally { setBusy(false); }
  }
  return <ScrollView contentContainerStyle={s.content}>
    <Text style={s.heading}>资源库</Text>
    <Text style={s.muted}>上传的原始资料和已交付的文件都保存在这里。</Text>
    <TextInput style={s.input} accessibilityLabel="筛选已加载资料" placeholder="筛选已加载资料的名称…" value={query} onChangeText={setQuery} />
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    {!items.length ? <Text style={s.muted}>还没有资料。可以从聊天或财务页添加图片和文件。</Text> : null}
    {items.filter((item) => item.name.toLowerCase().includes(query.toLowerCase())).map((item) => <View key={item.id} style={s.card}>
      <Attachments connection={connection} items={[item]} />
    </View>)}
    {cursor ? <Button secondary disabled={busy} onPress={() => { void more(); }}>加载更多</Button> : null}
  </ScrollView>;
}
