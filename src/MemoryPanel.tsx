import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { ApiError, mergeById, request, type Connection, type Page } from "./api";
import { useThemedStyles } from "./ThemeProvider";
import { radius, space, type ThemeColors } from "./theme";
import { ActionLink, Button, Empty, Field, IconAction, humanError, useUi } from "./ui";

type Memory = { id: string; content: string };
type Edit = { item: Memory; content: string };

export function MemoryPanel({ connection, onBack, leaveGuardRef }: {
  connection: Connection; onBack: () => void;
  leaveGuardRef?: { current: ((leave: () => void) => void) | null };
}) {
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
  const [items, setItems] = useState<Memory[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [fetching, setFetching] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [resultFor, setResultFor] = useState<{ connection: Connection; prefix: string; reload: number } | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editError, setEditError] = useState("");
  const [forgetError, setForgetError] = useState<{ item: Memory; message: string } | null>(null);
  const [mutating, setMutating] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const moreRequest = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const editing = useRef(false);
  const generation = useRef(0);
  const search = query.trim();
  const prefix = `/memories?limit=100&query=${encodeURIComponent(search)}`;
  const scopeReady = resultFor?.connection === connection && resultFor.prefix === prefix && resultFor.reload === reload;
  const loading = !scopeReady || fetching;
  const visibleItems = scopeReady ? items : [];

  useEffect(() => () => { mutation.current?.abort(); }, [connection]);
  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    moreRequest.current?.abort();
    moreRequest.current = null;
    const timer = setTimeout(() => {
      setFetching(true); setLoadingMore(false); setError(""); setCursor(null); setItems([]);
      setResultFor({ connection, prefix, reload });
      void request<Page<Memory>>(connection, prefix, { signal: controller.signal })
        .then((page) => {
          if (controller.signal.aborted || generation.current !== current) return;
          setItems(page.items); setCursor(page.next_cursor);
        })
        .catch((e) => { if (!controller.signal.aborted && generation.current === current) setError(humanError(e)); })
        .finally(() => { if (!controller.signal.aborted && generation.current === current) setFetching(false); });
    }, search ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); moreRequest.current?.abort(); };
  }, [connection, prefix, search, reload]);

  async function more() {
    if (!cursor || loadingMore || loading || editing.current || mutation.current || moreRequest.current) return;
    const controller = new AbortController();
    moreRequest.current = controller;
    const current = generation.current;
    setLoadingMore(true); setError("");
    try {
      const page = await request<Page<Memory>>(connection, `${prefix}&cursor=${encodeURIComponent(cursor)}`, { signal: controller.signal });
      if (controller.signal.aborted || generation.current !== current) return;
      setItems((old) => mergeById(old, page.items)); setCursor(page.next_cursor);
    } catch (e) {
      if (!controller.signal.aborted && generation.current === current) setError(humanError(e));
    } finally {
      if (moreRequest.current === controller) moreRequest.current = null;
      if (!controller.signal.aborted && generation.current === current) setLoadingMore(false);
    }
  }

  async function save() {
    if (!edit || !edit.content.trim() || mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    setMutating(edit.item.id); setEditError(""); setNotice("");
    try {
      const updated = await request<Memory>(connection, `/memories/${encodeURIComponent(edit.item.id)}`, {
        method: "PATCH", body: { content: edit.content.trim() }, signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setItems((old) => old.map((item) => item.id === updated.id ? { ...item, ...updated } : item));
      editing.current = false; setEdit(null); setNotice("记忆已纠正");
      // A correction may change whether this record matches the active server search.
      if (search) setReload((value) => value + 1);
    } catch (e) { if (!controller.signal.aborted) setEditError(humanError(e)); }
    finally {
      if (mutation.current === controller) mutation.current = null;
      if (!controller.signal.aborted) setMutating(null);
    }
  }

  async function remove(item: Memory) {
    if (mutation.current || editing.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    setMutating(item.id); setForgetError(null); setNotice("");
    try {
      await request(connection, `/memories/${encodeURIComponent(item.id)}`, { method: "DELETE", signal: controller.signal });
      if (controller.signal.aborted) return;
      setItems((old) => old.filter((value) => value.id !== item.id)); setNotice("已忘记这条记忆");
    } catch (e) {
      if (controller.signal.aborted) return;
      if (e instanceof ApiError && e.status === 404 && e.code === "not_found") {
        setItems((old) => old.filter((value) => value.id !== item.id)); setNotice("已忘记这条记忆");
      } else setForgetError({ item, message: humanError(e) });
    }
    finally {
      if (mutation.current === controller) mutation.current = null;
      if (!controller.signal.aborted) setMutating(null);
    }
  }

  function forget(item: Memory) {
    if (mutation.current || editing.current || moreRequest.current) return;
    Alert.alert("忘记这件事？", "删除后，知行后续不会再使用这条记忆。原对话仍会保留。", [
      { text: "取消", style: "cancel" },
      { text: "忘记", style: "destructive", onPress: () => { void remove(item); } },
    ]);
  }
  useEffect(() => {
    if (!leaveGuardRef) return;
    leaveGuardRef.current = (leave) => {
      if (mutation.current) return;
      if (edit && edit.content.trim() !== edit.item.content) {
        Alert.alert("还有未保存的纠正", "离开会放弃这次修改。", [
          { text: "继续编辑", style: "cancel" }, { text: "放弃修改", style: "destructive", onPress: leave },
        ]);
      } else leave();
    };
    return () => { leaveGuardRef.current = null; };
  }, [edit, leaveGuardRef]);
  function back() {
    if (mutation.current) return;
    if (leaveGuardRef?.current) leaveGuardRef.current(onBack);
    else if (edit && edit.content.trim() !== edit.item.content) {
      Alert.alert("还有未保存的纠正", "返回会放弃这次修改。", [
        { text: "继续编辑", style: "cancel" }, { text: "放弃修改", style: "destructive", onPress: onBack },
      ]);
    } else onBack();
  }
  const locked = !!edit || !!mutating;

  return <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <View style={styles.header}>
      <IconAction icon="arrow-back" label="返回对话历史" onPress={back} disabled={!!mutating} />
      <View style={s.grow}><Text accessibilityRole="header" style={s.title}>知行记得</Text><Text style={s.muted}>关于你的长期记忆</Text></View>
    </View>
    <View style={styles.search}>
      <Ionicons name="search-outline" size={19} color={colors.muted} />
      <TextInput style={[s.input, styles.searchInput]} accessibilityLabel="搜索全部记忆" placeholder="搜索记住的事…" placeholderTextColor={colors.muted}
        value={query} editable={!locked} onChangeText={(value) => { if (mutation.current || editing.current) return; setQuery(value); setNotice(""); setForgetError(null); }} maxLength={200} returnKeyType="search" />
      {query ? <IconAction icon="close-circle-outline" label="清除记忆搜索" disabled={locked} onPress={() => { if (mutation.current || editing.current) return; setQuery(""); setNotice(""); setForgetError(null); }} /> : null}
    </View>
    <ScrollView keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content}>
      <Text style={s.description}>可以直接纠正，也可以在聊天中告诉知行。</Text>
      {notice ? <Text accessibilityLiveRegion="polite" style={s.muted}>{notice}</Text> : null}
      {loading ? <View style={styles.state} accessibilityLabel="正在加载记忆"><ActivityIndicator color={colors.accent} /><Text style={s.muted}>{search ? "正在搜索…" : "正在加载记忆…"}</Text></View> : null}
      {!loading && error ? <View style={styles.state}><Text accessibilityRole="alert" style={s.error}>{error}</Text><ActionLink icon="refresh-outline" disabled={loadingMore || locked} onPress={() => { if (items.length) void more(); else setReload((value) => value + 1); }}>重新加载记忆</ActionLink></View> : null}
      {!loading && !error && !items.length ? <Empty compact icon={search ? "search-outline" : "sparkles-outline"} title={search ? "没有找到相关记忆" : "还没有整理出记忆"}>
        {search ? "试试其他关键词。" : "聊着聊着，知行会慢慢记住重要的事。"}
      </Empty> : null}
      {visibleItems.map((item) => <View key={item.id} style={styles.memoryRow}>
        {edit?.item.id === item.id ? <>
          <Field label="纠正记忆" multiline autoFocus value={edit.content} maxLength={500} editable={!mutating}
            onChangeText={(content) => { if (!mutation.current) setEdit((old) => old ? { ...old, content } : old); }} />
          {editError ? <Text accessibilityRole="alert" style={s.error}>{editError}</Text> : null}
          <View style={styles.actions}><ActionLink disabled={!!mutating} onPress={() => { if (mutation.current) return; editing.current = false; setEdit(null); setEditError(""); }}>取消</ActionLink>
            <Button small disabled={!!mutating || !edit.content.trim()} onPress={() => { void save(); }}>{mutating ? "保存中…" : editError ? "重试保存" : "保存纠正"}</Button></View>
        </> : <>
          <View style={styles.readingRow}><Text selectable style={[s.text, styles.memoryText]}>{item.content}</Text><IconAction icon="ellipsis-horizontal" label={`操作记忆：${item.content}`} disabled={locked || loadingMore} onPress={() => { if (editing.current || mutation.current || moreRequest.current) return; setExpanded((old) => old === item.id ? null : item.id); }} /></View>
          {forgetError?.item.id === item.id ? <View><Text accessibilityRole="alert" style={s.error}>{forgetError.message}</Text><ActionLink icon="refresh-outline" disabled={locked || loadingMore} onPress={() => { void remove(item); }}>重试忘记</ActionLink></View> : null}
          {expanded === item.id ? <View style={styles.actions}><ActionLink icon="create-outline" disabled={locked || loadingMore} onPress={() => { if (editing.current || mutation.current || moreRequest.current) return; editing.current = true; setEdit({ item, content: item.content }); setEditError(""); setForgetError(null); setNotice(""); }}>纠正</ActionLink>
            <ActionLink icon="trash-outline" tone="neutral" disabled={locked || loadingMore} onPress={() => forget(item)}>{mutating === item.id ? "处理中…" : "忘记"}</ActionLink></View> : null}
        </>}
      </View>)}
      {!loading && cursor && !error ? <ActionLink icon="chevron-down" disabled={loadingMore || locked} onPress={() => { void more(); }}>{loadingMore ? "加载中…" : "查看更多记忆"}</ActionLink> : null}
    </ScrollView>
  </KeyboardAvoidingView>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingTop: space.sm, paddingBottom: space.md },
  search: { flexDirection: "row", alignItems: "center", paddingLeft: space.sm, borderRadius: radius.control, backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.line },
  searchInput: { flex: 1, minWidth: 0, borderWidth: 0, backgroundColor: "transparent" },
  content: { paddingTop: space.md, paddingBottom: space.xl, gap: space.sm },
  state: { alignItems: "center", gap: space.sm, paddingVertical: space.xl },
  memoryRow: { gap: space.xs, borderBottomWidth: 1, borderBottomColor: colors.line, paddingTop: space.md, paddingBottom: space.xs },
  readingRow: { flexDirection: "row", alignItems: "flex-start", gap: space.xs },
  memoryText: { flex: 1, minWidth: 0, paddingVertical: space.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: space.lg },
});
