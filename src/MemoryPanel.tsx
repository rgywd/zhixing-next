import type { ThemeColors } from "./theme";
import { useUi, humanError } from "./ui";
import { useThemedStyles } from "./ThemeProvider";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { request, type Connection, type Page } from "./api";

import { layout, radius, space, typography } from "./theme";

type Memory = { id: string; content: string; seq: number };

export function MemoryPanel({ connection, onBack }: { connection: Connection; onBack: () => void }) {
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
  const [items, setItems] = useState<Memory[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    void request<Page<Memory>>(connection, "/memories?limit=100")
      .then((page) => { if (active) { setItems(page.items); setCursor(page.next_cursor); setError(""); } })
      .catch((e) => { if (active) setError(humanError(e)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [connection, reload]);
  async function more() {
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const page = await request<Page<Memory>>(connection, `/memories?cursor=${encodeURIComponent(cursor)}&limit=100`);
      setItems((old) => [...old, ...page.items]);
      setCursor(page.next_cursor);
      setError("");
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
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="返回对话历史" onPress={onBack} style={styles.iconButton}><Ionicons name="arrow-back" size={21} color={colors.ink} /></Pressable>
        <View style={s.grow}><Text style={styles.title}>知行记得</Text><Text style={styles.subtitle}>关于你的长期记忆</Text></View>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <Text style={styles.hint}>直接在对话里告诉知行要记住、纠正或忘记什么。</Text>
        {error ? <View style={styles.errorRow}><Text accessibilityRole="alert" style={[s.error, s.grow]}>{error}</Text><Pressable accessibilityRole="button" accessibilityLabel="重试读取记忆" onPress={() => { setBusy(true); setReload((value) => value + 1); }} style={styles.iconButton}><Ionicons name="refresh" size={20} color={colors.accent} /></Pressable></View> : null}
        {busy && !items.length ? <ActivityIndicator color={colors.accent} style={styles.loading} /> : null}
        {!busy && !items.length && !error ? <View style={styles.empty}><Ionicons name="sparkles-outline" size={25} color={colors.accent} /><Text style={styles.emptyTitle}>还没有整理出记忆</Text><Text style={styles.subtitle}>聊着聊着，知行会慢慢记住重要的事。</Text></View> : null}
        {items.map((item) => <View key={item.id} style={styles.memoryRow}><View style={styles.dot} /><Text selectable style={[styles.memoryText, s.grow]}>{item.content}</Text><Pressable accessibilityRole="button" accessibilityLabel={`忘记：${item.content}`} accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => forget(item)} style={styles.iconButton}><Ionicons name="trash-outline" size={18} color={colors.muted} /></Pressable></View>)}
        {cursor ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => { void more(); }} style={styles.more}><Text style={styles.moreText}>{busy ? "加载中…" : "查看更多"}</Text></Pressable> : null}
      </ScrollView>
    </View>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingTop: space.sm, paddingBottom: space.md, borderBottomWidth: 1, borderBottomColor: colors.line },
  iconButton: { width: layout.touchTarget, height: layout.touchTarget, alignItems: "center", justifyContent: "center", borderRadius: radius.control },
  title: { ...typography.section, color: colors.ink },
  subtitle: { ...typography.detail, color: colors.muted },
  content: { paddingTop: space.lg, paddingBottom: space.xl },
  hint: { ...typography.body, color: colors.muted, marginBottom: space.lg },
  errorRow: { flexDirection: "row", alignItems: "center" },
  loading: { marginTop: space.xl },
  empty: { alignItems: "center", gap: space.sm, paddingVertical: 48 },
  emptyTitle: { ...typography.item, color: colors.ink },
  memoryRow: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: space.sm, borderBottomWidth: 1, borderBottomColor: colors.line, paddingVertical: space.sm },
  memoryText: { ...typography.body, color: colors.ink },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent },
  more: { minHeight: layout.touchTarget, alignItems: "center", justifyContent: "center", marginTop: space.sm },
  moreText: { ...typography.button, color: colors.accent },
});
