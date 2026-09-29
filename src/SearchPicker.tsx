import type { ThemeColors } from "./theme";
import { useUi, Button, Field, humanError } from "./ui";
import { useThemedStyles } from "./ThemeProvider";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { BottomSheet } from "./BottomSheet";
import { BrandIcon } from "./BrandIcon";
import { radius, space, typography } from "./theme";
import { ApiError, request, type Connection, type SearchProvider } from "./api";

const kinds = { brave: "Brave", tavily: "Tavily", serper: "Serper" } as const;

export function SearchPicker({ visible, connection, selectedId, onSelect, onClose }: {
  visible: boolean;
  connection: Connection;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<SearchProvider[]>([]);
  const [kind, setKind] = useState<SearchProvider["kind"]>("brave");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    void request<{ items: SearchProvider[] }>(connection, "/search/providers")
      .then((page) => { if (active) { setItems(page.items); setSupported(true); setError(""); setLoading(false); } })
      .catch((e) => { if (active) { setLoading(false); setSupported(!(e instanceof ApiError && e.status === 404)); setError(e instanceof ApiError && e.status === 404 ? "当前服务端尚未支持联网搜索，请先更新服务端。" : humanError(e)); } });
    return () => { active = false; };
  }, [connection, visible]);
  async function add() {
    if (busy || !key.trim()) return;
    setBusy(true);
    setError("");
    try {
      const item = await request<SearchProvider>(connection, "/search/providers", {
        method: "POST", body: { name: name.trim() || kinds[kind], kind, api_key: key.trim() },
      });
      setItems((old) => [...old, item]);
      setKey("");
      setName("");
      setAdding(false);
      onSelect(item.id);
      onClose();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }
  function remove(item: SearchProvider) {
    Alert.alert("移除搜索服务？", `将删除 ${item.name} 的服务端密钥。`, [
      { text: "取消", style: "cancel" },
      { text: "移除", style: "destructive", onPress: () => {
        setBusy(true);
        void request(connection, `/search/providers/${item.id}`, { method: "DELETE" })
          .then(() => {
            setItems((old) => old.filter((value) => value.id !== item.id));
            if (selectedId === item.id) onSelect(null);
          })
          .catch((e) => setError(humanError(e)))
          .finally(() => setBusy(false));
      } },
    ]);
  }
  const selected = items.find((item) => item.id === selectedId);
  return <BottomSheet visible={visible} title={adding ? "添加搜索服务" : "联网搜索"} subtitle={adding ? "配置后即可在对话中选用" : "需要最新资料时，让知行联网查找"} onClose={() => { setAdding(false); onClose(); }}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      {adding ? <>
        <Pressable accessibilityRole="button" accessibilityLabel="返回搜索服务" onPress={() => setAdding(false)} style={styles.back}><Ionicons name="chevron-back" size={17} color={colors.muted} /><Text style={s.description}>搜索服务</Text></Pressable>
        <View style={styles.kinds}>{(Object.keys(kinds) as SearchProvider["kind"][]).map((value) => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={kinds[value]} accessibilityState={{ checked: kind === value }} onPress={() => setKind(value)} style={[styles.kind, kind === value && styles.selected]}><BrandIcon name={value} size={22} search /><Text style={s.description}>{kinds[value]}</Text></Pressable>)}</View>
        <Field label="名称" placeholder="可选" value={name} onChangeText={setName} maxLength={100} />
        <Field label={`${kinds[kind]} API 密钥`} placeholder="粘贴密钥" value={key} onChangeText={setKey} secureTextEntry autoCapitalize="none" autoCorrect={false} />
        <Text style={s.muted}>密钥仅保存在你的知行服务端。</Text>
        <Button disabled={busy || !key.trim() || !supported} onPress={() => { void add(); }}>{busy ? "保存中…" : "保存并使用"}</Button>
      </> : <>
        <View style={styles.toggle}>
          <View style={styles.globe}><Ionicons name="globe-outline" size={24} color={selectedId ? colors.blue : colors.muted} /></View>
          <View style={s.headingCopy}><Text style={s.itemTitle}>网络搜索</Text><Text style={s.muted}>{selectedId ? selected?.name ?? "已开启" : "已关闭"}</Text></View>
          <Switch accessibilityLabel="网络搜索" disabled={busy || loading || !supported || (!items.length && !selectedId)} value={!!selectedId} onValueChange={(value) => { onSelect(value ? items[0]?.id ?? null : null); }} trackColor={{ false: colors.strongLine, true: colors.blue }} thumbColor={colors.switchThumb} />
        </View>
        {loading ? <ActivityIndicator color={colors.blue} /> : null}
        <View style={styles.grid}>{items.map((item) => <View key={item.id} style={[styles.provider, selectedId === item.id && styles.selected]}>
          <Pressable accessibilityRole="radio" accessibilityLabel={`使用 ${item.name}`} accessibilityState={{ checked: selectedId === item.id, disabled: busy }} disabled={busy} onPress={() => { onSelect(item.id); onClose(); }} style={styles.providerChoice}>
            <BrandIcon name={item.kind} size={25} search /><Text numberOfLines={1} style={[s.itemTitle, { flex: 1 }]}>{item.name}</Text>{selectedId === item.id ? <Ionicons name="checkmark-circle" size={16} color={colors.blue} /> : null}
          </Pressable>
          <View style={styles.providerFoot}><Text numberOfLines={1} style={[s.small, { flex: 1 }]}>网页搜索</Text><Pressable accessibilityRole="button" accessibilityLabel={`移除 ${item.name}`} disabled={busy} onPress={() => remove(item)} style={styles.delete}><Ionicons name="ellipsis-horizontal" size={18} color={colors.muted} /></Pressable></View>
        </View>)}</View>
        {!loading && !items.length ? <View style={styles.empty}><Text style={s.description}>还没有搜索服务</Text><Text style={s.muted}>添加一个服务，就能在聊天中随时开关。</Text></View> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="添加搜索服务" disabled={!supported} onPress={() => setAdding(true)} style={styles.add}><Ionicons name="add-circle-outline" size={20} color={colors.blue} /><Text style={styles.addText}>添加搜索服务</Text></Pressable>
      </>}
    </ScrollView>
  </BottomSheet>;
}
const createStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { paddingHorizontal: 20, paddingBottom: 18, gap: space.md },
  toggle: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.neutral, borderRadius: radius.item, padding: 13 },
  globe: { width: 36, height: 36, justifyContent: "center", alignItems: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 10 },
  provider: { width: "48%", backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.line, borderRadius: radius.item },
  selected: { backgroundColor: colors.blueSoft, borderColor: colors.blueLine },
  providerChoice: { flexDirection: "row", alignItems: "center", gap: 7, padding: 12, minHeight: 52 },
  providerFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 12 },
  delete: { height: 44, width: 44, alignItems: "center", justifyContent: "center" },
  add: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  addText: { ...typography.button, color: colors.blue },
  empty: { paddingVertical: 8, alignItems: "center", gap: 5 },
  back: { flexDirection: "row", alignItems: "center", minHeight: 36, gap: 4 },
  kinds: { flexDirection: "row", gap: 8 },
  kind: { flex: 1, borderWidth: 1, borderColor: colors.line, borderRadius: radius.small, paddingVertical: 12, alignItems: "center", gap: 6 },
});
