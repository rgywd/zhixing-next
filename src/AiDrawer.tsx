import type { ThemeColors } from "./theme";
import { useUi, humanError, timeLabel } from "./ui";
import { useThemedStyles } from "./ThemeProvider";
import { useEffect, useState } from "react";
import { ActivityIndicator, Animated, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { request, type Connection, type Conversation, type ConversationSearchResult } from "./api";
import { MemoryPanel } from "./MemoryPanel";

import { layout, radius, space, typography } from "./theme";

type SearchSort = "relevance" | "newest" | "oldest";

function SearchSnippet({ text, query }: { text: string; query: string }) {
  const styles = useThemedStyles(createStyles);
  const term = query.trim().split(/\s+/).find((part) => text.toLocaleLowerCase().includes(part.toLocaleLowerCase()));
  if (!term) return <Text numberOfLines={2} style={styles.snippet}>{text}</Text>;
  const start = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
  return <Text numberOfLines={2} style={styles.snippet}>{text.slice(0, start)}<Text style={styles.hit}>{text.slice(start, start + term.length)}</Text>{text.slice(start + term.length)}</Text>;
}

export function AiDrawer({
  visible, connection, name, conversations, selectedId, hasMore, busy,
  onClose, onOpen, onMore, onNew, onSettings,
}: {
  visible: boolean;
  connection: Connection;
  name: string;
  conversations: Conversation[];
  selectedId: string | null;
  hasMore: boolean;
  busy: boolean;
  onClose: () => void;
  onOpen: (id: string, messageSeq?: number) => void;
  onMore: () => void;
  onNew: () => void;
  onSettings: () => void;
}) {
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
  const [view, setView] = useState<"history" | "search" | "memory">("history");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SearchSort>("relevance");
  const [results, setResults] = useState<ConversationSearchResult[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [slide] = useState(() => new Animated.Value(-380));
  const [cutoff] = useState(() => Date.now() - 7 * 24 * 60 * 60 * 1000);
  useEffect(() => {
    if (visible) {
      slide.setValue(-380);
      Animated.timing(slide, { toValue: 0, duration: 230, useNativeDriver: true }).start();
    }
  }, [visible, slide]);
  useEffect(() => {
    const keyword = query.trim();
    if (!visible || view !== "search" || !keyword) return;
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => {
      void request<{ items: ConversationSearchResult[] }>(
        connection,
        `/conversations/search?q=${encodeURIComponent(keyword)}&sort=${sort}&limit=50`,
        { signal: controller.signal },
      ).then((page) => { if (active) setResults(page.items); })
        .catch((error) => { if (active) setSearchError(humanError(error)); })
        .finally(() => { if (active) setSearchBusy(false); });
    }, 300);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [connection, query, sort, view, visible]);
  const ordered = [...conversations].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const recent = ordered.filter((item) => Date.parse(item.updated_at) >= cutoff);
  const older = ordered.filter((item) => Date.parse(item.updated_at) < cutoff);

  function reset() {
    setView("history"); setQuery(""); setResults([]); setSearchBusy(false); setSearchError("");
  }
  function close() { reset(); onClose(); }
  function changeQuery(value: string) {
    setQuery(value); setResults([]); setSearchError(""); setSearchBusy(!!value.trim());
  }
  function changeSort(value: SearchSort) {
    setSort(value); setResults([]); setSearchError(""); setSearchBusy(!!query.trim());
  }

  function historyRow(item: Conversation) {
    return <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`打开对话：${item.title}`} onPress={() => { reset(); onClose(); onOpen(item.id); }} style={({ pressed }) => [styles.historyRow, item.id === selectedId && styles.selected, pressed && s.pressed]}>
      <Ionicons name={item.agent_id ? "person-outline" : "chatbubble-outline"} size={17} color={item.id === selectedId ? colors.accent : colors.muted} />
      <Text numberOfLines={1} style={[styles.historyTitle, s.grow]}>{item.title}</Text>
      {item.blocked ? <Ionicons name="pause-circle-outline" size={16} color={colors.muted} /> : null}
    </Pressable>;
  }
  function shortcut(label: string, icon: "search-outline" | "library-outline" | "settings-outline", onPress: () => void) {
    return <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.shortcut, pressed && s.pressed]}>
      <Ionicons name={icon} size={20} color={colors.accent} />
      <Text style={styles.shortcutText}>{label}</Text>
    </Pressable>;
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={styles.overlay}>
        <Animated.View style={[styles.panel, { transform: [{ translateX: slide }] }]}>
          <SafeAreaView style={styles.safeArea}>
            {view === "memory" ? <MemoryPanel connection={connection} onBack={() => setView("history")} /> : view === "search" ? (
              <View style={styles.page}>
                <View style={styles.topLine}>
                  <Pressable accessibilityRole="button" accessibilityLabel="返回对话历史" onPress={() => setView("history")} style={styles.iconButton}><Ionicons name="arrow-back" size={21} color={colors.ink} /></Pressable>
                  <Text style={[styles.heading, s.grow]}>搜索对话</Text>
                </View>
                <View style={styles.searchBox}>
                  <Ionicons name="search-outline" size={19} color={colors.muted} />
                  <TextInput accessibilityLabel="搜索对话与消息" placeholder="搜索标题或聊天内容" placeholderTextColor={colors.muted} value={query} onChangeText={changeQuery} maxLength={100} autoFocus returnKeyType="search" style={styles.searchInput} />
                  {query ? <Pressable accessibilityRole="button" accessibilityLabel="清空搜索" onPress={() => changeQuery("")} style={styles.clearButton}><Ionicons name="close-circle" size={19} color={colors.muted} /></Pressable> : null}
                </View>
                <View style={styles.sortBar}>
                  {([["relevance", "相关"], ["newest", "最新"], ["oldest", "最早"]] as const).map(([value, label]) =>
                    <Pressable key={value} accessibilityRole="button" accessibilityLabel={`按${label}排序`} accessibilityState={{ selected: sort === value }} onPress={() => changeSort(value)} style={[styles.sortChip, sort === value && styles.sortActive]}><Text style={[styles.sortText, sort === value && styles.sortTextActive]}>{label}</Text></Pressable>)}
                </View>
                <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.searchResults}>
                  {searchBusy ? <ActivityIndicator color={colors.accent} style={styles.loading} /> : null}
                  {searchError ? <Text accessibilityRole="alert" style={s.error}>{searchError}</Text> : null}
                  {!query.trim() ? <Text style={styles.empty}>输入几个字，查找过去的对话和消息。</Text> : !searchBusy && !searchError && !results.length ? <Text style={styles.empty}>没有找到匹配的对话</Text> : null}
                  {results.map((item) => <Pressable key={item.conversation_id} accessibilityRole="button" accessibilityLabel={`打开搜索结果：${item.title}`} onPress={() => { reset(); onClose(); onOpen(item.conversation_id, item.message_seq ?? undefined); }} style={({ pressed }) => [styles.resultRow, pressed && s.pressed]}>
                    <View style={styles.resultTitleLine}><Ionicons name="chatbubble-outline" size={17} color={colors.accent} /><Text numberOfLines={1} style={[styles.resultTitle, s.grow]}>{item.title}</Text></View>
                    {item.snippet ? <SearchSnippet text={item.snippet} query={query} /> : <Text style={styles.snippet}>标题匹配</Text>}
                    <Text style={styles.resultTime}>{timeLabel(item.updated_at)}</Text>
                  </Pressable>)}
                </ScrollView>
              </View>
            ) : (
              <View style={styles.page}>
                <View style={styles.profile}>
                  <View style={styles.avatar}><Ionicons name="sparkles" size={20} color={colors.accent} /></View>
                  <View style={s.grow}><Text numberOfLines={1} style={styles.name}>{name}</Text><Text style={styles.subhead}>你的 AI 伙伴</Text></View>
                  <Pressable accessibilityRole="button" accessibilityLabel="关闭侧边栏" onPress={close} style={styles.iconButton}><Ionicons name="close" size={21} color={colors.muted} /></Pressable>
                </View>
                <View style={styles.shortcuts}>
                  {shortcut("搜索", "search-outline", () => { setView("search"); setSearchBusy(!!query.trim()); })}
                  {shortcut("记忆", "library-outline", () => setView("memory"))}
                  {shortcut("设置", "settings-outline", () => { reset(); onSettings(); })}
                </View>
                <View style={styles.historyHead}><Text style={styles.heading}>对话历史</Text><Text style={styles.count}>{ordered.length}{hasMore ? "+" : ""}</Text></View>
                <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.historyList}>
                  {recent.length ? <Text style={styles.group}>7 天内</Text> : null}
                  {recent.map(historyRow)}
                  {older.length ? <Text style={styles.group}>更早</Text> : null}
                  {older.map(historyRow)}
                  {!ordered.length ? <Text style={styles.empty}>还没有对话，开始一段新的聊天吧。</Text> : null}
                  {hasMore ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} onPress={onMore} style={styles.more}><Text style={styles.moreText}>{busy ? "加载中…" : "查看更早的对话"}</Text></Pressable> : null}
                </ScrollView>
                <Pressable accessibilityRole="button" accessibilityLabel="新建对话" onPress={() => { reset(); onNew(); }} style={({ pressed }) => [styles.newButton, pressed && s.pressed]}><Ionicons name="add" size={23} color={colors.onPrimary} /><Text style={styles.newText}>新建对话</Text></Pressable>
              </View>
            )}
          </SafeAreaView>
        </Animated.View>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭侧边栏" onPress={close} style={styles.scrim} />
      </View>
    </Modal>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  overlay: { flex: 1, flexDirection: "row", backgroundColor: colors.overlay },
  panel: { width: "86%", maxWidth: 380, backgroundColor: colors.paper },
  safeArea: { flex: 1, paddingHorizontal: space.lg },
  page: { flex: 1 },
  scrim: { flex: 1 },
  profile: { minHeight: 72, flexDirection: "row", alignItems: "center", gap: space.md, borderBottomWidth: 1, borderBottomColor: colors.line },
  avatar: { width: 40, height: 40, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: colors.pale },
  name: { ...typography.section, color: colors.ink },
  subhead: { ...typography.caption, color: colors.muted },
  iconButton: { width: layout.touchTarget, height: layout.touchTarget, alignItems: "center", justifyContent: "center", borderRadius: radius.control },
  shortcuts: { flexDirection: "row", gap: space.sm, paddingVertical: space.md },
  shortcut: { flex: 1, minHeight: 57, alignItems: "center", justifyContent: "center", gap: 2, borderRadius: radius.item, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.line },
  shortcutText: { ...typography.detail, color: colors.ink },
  historyHead: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingTop: space.md, paddingBottom: space.sm },
  heading: { ...typography.section, color: colors.ink },
  count: { ...typography.caption, color: colors.muted },
  historyList: { paddingBottom: space.xl },
  group: { ...typography.caption, color: colors.muted, fontWeight: "700", marginTop: space.lg, marginBottom: space.xs },
  historyRow: { minHeight: 46, flexDirection: "row", alignItems: "center", gap: space.sm, borderRadius: radius.control, paddingHorizontal: space.sm },
  historyTitle: { ...typography.body, color: colors.ink },
  selected: { backgroundColor: colors.pale },
  empty: { ...typography.body, color: colors.muted, marginTop: space.xl },
  more: { minHeight: layout.touchTarget, alignItems: "center", justifyContent: "center", marginTop: space.sm },
  moreText: { ...typography.button, color: colors.accent },
  newButton: { minHeight: 48, borderRadius: radius.pill, backgroundColor: colors.primary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, marginVertical: space.sm },
  newText: { ...typography.button, color: colors.onPrimary },
  topLine: { minHeight: 60, flexDirection: "row", alignItems: "center", gap: space.sm },
  searchBox: { minHeight: 46, borderRadius: radius.control, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surfaceRaised, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md },
  searchInput: { flex: 1, ...typography.body, color: colors.ink, paddingVertical: space.sm },
  clearButton: { width: 30, height: 40, alignItems: "center", justifyContent: "center" },
  sortBar: { flexDirection: "row", gap: space.sm, paddingVertical: space.md },
  sortChip: { minHeight: 34, paddingHorizontal: space.md, alignItems: "center", justifyContent: "center", borderRadius: radius.pill, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.line },
  sortActive: { backgroundColor: colors.pale, borderColor: colors.pale },
  sortText: { ...typography.detail, color: colors.muted },
  sortTextActive: { color: colors.accent, fontWeight: "700" },
  searchResults: { paddingBottom: space.xl },
  loading: { marginVertical: space.lg },
  resultRow: { paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: colors.line, gap: space.xs },
  resultTitleLine: { flexDirection: "row", alignItems: "center", gap: space.sm },
  resultTitle: { ...typography.item, color: colors.ink },
  snippet: { ...typography.body, color: colors.muted },
  hit: { color: colors.accent, fontWeight: "700", backgroundColor: colors.pale },
  resultTime: { ...typography.caption, color: colors.muted },
});
