import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { mergeById, request, type Connection, type Page, type Resource } from "./api";
import { ResourceImage, ResourcePreview, resourceDetail } from "./ResourcePreview";
import { shareResource } from "./resources";
import { useThemedStyles } from "./ThemeProvider";
import { layout, radius, space, type ThemeColors } from "./theme";
import { ActionLink, Empty, IconAction, PageHeading, PageScrollView, humanError, useUi } from "./ui";

export function ResourcesPanel({ connection, onOpenConversation }: {
  connection: Connection; onOpenConversation?: (id: string) => void;
}) {
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
  const [items, setItems] = useState<Resource[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [fetching, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [resultFor, setResultFor] = useState<{ connection: Connection; prefix: string; reload: number } | null>(null);
  const [selected, setSelected] = useState<Resource | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const [shareError, setShareError] = useState("");
  const moreRequest = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const search = query.trim();
  const prefix = `/resources?limit=50&query=${encodeURIComponent(search)}`;
  const scopeReady = resultFor?.connection === connection && resultFor.prefix === prefix && resultFor.reload === reload;
  const loading = !scopeReady || fetching;
  const visibleItems = scopeReady ? items : [];

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    moreRequest.current?.abort();
    const timer = setTimeout(() => {
      setLoading(true); setLoadingMore(false); setError(""); setCursor(null); setItems([]);
      setResultFor({ connection, prefix, reload });
      void request<Page<Resource>>(connection, `${prefix}&latest=true`, { signal: controller.signal })
        .then((page) => {
          if (controller.signal.aborted || generation.current !== current) return;
          setItems([...page.items].reverse()); setCursor(page.previous_cursor ?? null);
        })
        .catch((e) => { if (!controller.signal.aborted && generation.current === current) setError(humanError(e)); })
        .finally(() => { if (!controller.signal.aborted && generation.current === current) setLoading(false); });
    }, search ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); moreRequest.current?.abort(); };
  }, [connection, prefix, search, reload]);

  async function more() {
    if (!cursor || loadingMore || loading) return;
    const controller = new AbortController();
    moreRequest.current = controller;
    const current = generation.current;
    setLoadingMore(true); setError("");
    try {
      const page = await request<Page<Resource>>(connection, `${prefix}&before=${encodeURIComponent(cursor)}`, { signal: controller.signal });
      if (controller.signal.aborted || generation.current !== current) return;
      setItems((old) => mergeById(old, [...page.items].reverse())); setCursor(page.previous_cursor ?? null);
    } catch (e) {
      if (!controller.signal.aborted && generation.current === current) setError(humanError(e));
    } finally {
      if (!controller.signal.aborted && generation.current === current) setLoadingMore(false);
    }
  }

  return <>
    <PageScrollView>
      <PageHeading title="资源库" description="图片、资料和交付文件，随时找回来。" />
      <View style={styles.search}>
        <Ionicons name="search-outline" size={19} color={colors.muted} />
        <TextInput style={[s.input, styles.searchInput]} accessibilityLabel="搜索全部资料" placeholder="搜索全部资料名称…"
          placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} maxLength={200} returnKeyType="search" />
        {query ? <IconAction icon="close-circle-outline" label="清除资源搜索" onPress={() => setQuery("")} /> : null}
      </View>
      {loading ? <View style={styles.state} accessibilityLabel="正在加载资料"><ActivityIndicator color={colors.blue} /><Text style={s.muted}>{search ? "正在搜索…" : "正在加载资料…"}</Text></View> : null}
      {!loading && error ? <View style={styles.state}>
        <Text accessibilityRole="alert" style={s.error}>{error}</Text>
        <ActionLink icon="refresh-outline" tone="blue" disabled={loadingMore} onPress={() => { if (items.length) void more(); else setReload((value) => value + 1); }}>重新加载</ActionLink>
      </View> : null}
      {!loading && !error && !items.length ? <Empty compact icon={search ? "search-outline" : "albums-outline"} title={search ? "没有找到相关资料" : "还没有资料"}>
        {search ? "试试文件名中的其他关键词。" : "从聊天或财务页添加图片和文件，会自动保存在这里。"}
      </Empty> : null}
      {visibleItems.length ? <View style={styles.list}>{visibleItems.map((item, index) => <View key={item.id} style={[styles.resourceRow, index < visibleItems.length - 1 && styles.divider]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`查看资料 ${item.name}`} style={styles.resourceMain} onPress={() => setSelected(item)}>
          {item.mime_type.startsWith("image/") ? <ResourceImage connection={connection} resource={item} style={styles.thumbnail} />
            : <View style={styles.fileIcon}><Ionicons name="document-text-outline" size={25} color={colors.blue} /></View>}
          <View style={styles.copy}><Text numberOfLines={2} style={s.itemTitle}>{item.name}</Text><Text style={s.muted}>{resourceDetail(item)}</Text></View>
        </Pressable>
        <View style={styles.rowActions}>
          {onOpenConversation ? <Pressable accessibilityRole="button" accessibilityLabel={`打开 ${item.name} 的来源对话`} style={styles.sourceLink} onPress={() => onOpenConversation(item.conversation_id)}>
            <Ionicons name="chatbubble-outline" size={15} color={colors.muted} /><Text style={s.muted}>来源对话</Text><Ionicons name="chevron-forward" size={13} color={colors.muted} />
          </Pressable> : <View />}
          <IconAction icon={sharing === item.id ? "hourglass-outline" : "download-outline"} label={`下载分享 ${item.name}`} tone="blue" disabled={!!sharing} onPress={() => {
            setSharing(item.id); setShareError("");
            void shareResource(connection, item).catch((e) => setShareError(humanError(e))).finally(() => setSharing(null));
          }} />
        </View>
      </View>)}</View> : null}
      {shareError ? <Text accessibilityRole="alert" style={s.error}>{shareError}</Text> : null}
      {!loading && cursor && !error ? <ActionLink icon="chevron-down" tone="blue" disabled={loadingMore} onPress={() => { void more(); }}>{loadingMore ? "正在加载…" : "查看更多资料"}</ActionLink> : null}
    </PageScrollView>
    <ResourcePreview connection={connection} resource={selected} onClose={() => setSelected(null)} />
  </>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  search: { flexDirection: "row", alignItems: "center", paddingLeft: space.md, borderRadius: radius.control, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.line },
  searchInput: { flex: 1, minWidth: 0, borderWidth: 0, backgroundColor: "transparent" },
  state: { paddingVertical: space.xl, alignItems: "center", gap: space.md },
  list: { borderRadius: radius.item, paddingHorizontal: space.md, backgroundColor: colors.surfaceRaised },
  resourceRow: { paddingTop: space.md, paddingBottom: space.xs },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.line },
  resourceMain: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 64 },
  thumbnail: { width: 64, height: 64 },
  fileIcon: { width: 64, height: 64, borderRadius: radius.small, alignItems: "center", justifyContent: "center", backgroundColor: colors.blueSoft },
  copy: { flex: 1, minWidth: 0, gap: space.xs },
  rowActions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 64 + space.md },
  sourceLink: { flexDirection: "row", alignItems: "center", minHeight: layout.touchTarget, gap: space.xs },
});
