import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { mergeById, request, type Connection, type Page, type Resource } from "./api";
import { Attachments } from "./Attachments";
import { ActionLink, Empty, PageHeading, PageScrollView, colors, humanError, s } from "./ui";

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
  return <PageScrollView>
    <PageHeading title="资源库" description="上传的原始资料和已交付的文件都保存在这里。" />
    <View style={[s.row, { backgroundColor: colors.white, borderRadius: 12, borderWidth: 1, borderColor: colors.line, paddingLeft: 12 }]}><Ionicons name="search-outline" size={19} color={colors.blue} /><TextInput style={[s.input, { flex: 1, borderWidth: 0, backgroundColor: "transparent" }]} accessibilityLabel="筛选已加载资料" placeholder="筛选已加载资料的名称…" placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} /></View>
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    {!items.length ? <Empty compact icon="albums-outline" title="还没有资料">可以从聊天或财务页添加图片和文件。</Empty> : null}
    {items.filter((item) => item.name.toLowerCase().includes(query.toLowerCase())).map((item) => <View key={item.id} style={s.card}>
      <Attachments connection={connection} items={[item]} />
    </View>)}
    {items.length && !items.some((item) => item.name.toLowerCase().includes(query.toLowerCase())) ? <Text style={s.muted}>已加载资料中没有匹配项。</Text> : null}
    {cursor ? <ActionLink icon="chevron-down" tone="blue" disabled={busy} onPress={() => { void more(); }}>加载更多</ActionLink> : null}
  </PageScrollView>;
}
