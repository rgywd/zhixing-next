import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { BottomSheet } from "./BottomSheet";
import { BrandIcon } from "./BrandIcon";
import { radius, space, typography } from "./theme";
import type { ModelInfo } from "./api";
import { Empty, colors, humanError, s } from "./ui";

export const reasoningLabel = {
  auto: "自动",
  none: "关闭",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
} as const;

export function ModelPicker({
  visible, title, connectionUrl, models, selectedId, onSelect, onUseDefault, defaultLabel = "跟随默认聊天模型", onClose,
}: {
  visible: boolean;
  title: string;
  connectionUrl: string;
  models: ModelInfo[];
  selectedId: string | null;
  onSelect: (id: string) => Promise<void>;
  onUseDefault?: () => Promise<void>;
  defaultLabel?: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = `zhixing:model-favorites:${connectionUrl}`;
  useEffect(() => {
    if (!visible) return;
    let active = true;
    void AsyncStorage.getItem(key).then((value) => {
      const parsed: unknown = value ? JSON.parse(value) : [];
      if (active) setFavorites(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
    }).catch(() => {
      if (active) setFavorites([]);
    });
    return () => { active = false; };
  }, [key, visible]);
  async function toggleFavorite(id: string) {
    const next = favorites.includes(id) ? favorites.filter((item) => item !== id) : [...favorites, id];
    setFavorites(next);
    try {
      await AsyncStorage.setItem(key, JSON.stringify(next));
    } catch (e) {
      setError(humanError(e));
    }
  }
  async function choose(id?: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (id) await onSelect(id);
      else await onUseDefault?.();
      onClose();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }
  const filtered = models.filter((item) => (!providerFilter || item.provider === providerFilter) &&
    `${item.name} ${item.model} ${item.provider}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const favoriteModels = filtered.filter((item) => favorites.includes(item.id));
  const otherModels = filtered.filter((item) => !favorites.includes(item.id));
  const providers = [...new Set(models.map((item) => item.provider))];
  function row(item: ModelInfo, prefix: string) {
    const selected = selectedId === item.id;
    return <View key={`${prefix}-${item.id}`} style={[styles.model, selected && styles.selected]}>
      <Pressable accessibilityRole="radio" accessibilityLabel={item.name} accessibilityState={{ checked: selected, disabled: busy || !item.ready }} disabled={busy || !item.ready} onPress={() => { void choose(item.id); }} style={[styles.modelChoice, !item.ready && s.disabled]}>
        <View style={styles.logo}><BrandIcon name={`${item.model} ${item.provider}`} size={28} /></View>
        <View style={s.headingCopy}>
          <Text numberOfLines={1} style={styles.modelName}>{item.name}</Text>
          <View style={styles.capabilities}>
            {selected ? <Ionicons name="checkmark-circle" size={15} color={colors.purple} /> : null}
            {item.image_input ? <View style={styles.capability}><Ionicons name="image-outline" size={12} color={colors.blue} /><Text style={styles.capabilityText}>图片</Text></View> : null}
            {item.reasoning_levels.length ? <View style={styles.capability}><Ionicons name="bulb-outline" size={12} color={colors.gold} /><Text style={styles.capabilityText}>思考</Text></View> : null}
            <Text numberOfLines={1} style={s.small}>{item.ready ? item.model : "暂不可用"}</Text>
          </View>
        </View>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`${favorites.includes(item.id) ? "取消收藏" : "收藏"} ${item.name}`} onPress={() => { void toggleFavorite(item.id); }} style={s.iconButton}>
        <Ionicons name={favorites.includes(item.id) ? "heart" : "heart-outline"} size={20} color={favorites.includes(item.id) ? colors.accent : colors.muted} />
      </Pressable>
    </View>;
  }
  return <BottomSheet visible={visible} title={title} onClose={onClose} tall>
    <View style={styles.search}><Ionicons name="search-outline" size={19} color={colors.muted} /><TextInput accessibilityLabel="搜索模型" placeholder="搜索模型或供应商" placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} autoCorrect={false} style={styles.searchInput} />{query ? <Pressable onPress={() => setQuery("")} accessibilityRole="button" accessibilityLabel="清空搜索" style={s.iconButton}><Ionicons name="close-circle" size={17} color={colors.muted} /></Pressable> : null}</View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filters} contentContainerStyle={styles.filterContent}>
      {[null, ...providers].map((provider) => <Pressable key={provider ?? "all"} accessibilityRole="button" accessibilityState={{ selected: providerFilter === provider }} onPress={() => setProviderFilter(provider)} style={[styles.filter, providerFilter === provider && styles.filterActive]}><Text style={[styles.filterText, providerFilter === provider && { color: colors.ink }]}>{provider ?? "全部"}</Text></Pressable>)}
    </ScrollView>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.list}>
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      {onUseDefault && !query.trim() ? <Pressable disabled={busy} onPress={() => { void choose(); }} accessibilityRole="button" style={styles.defaultRow}><Ionicons name="return-down-back-outline" size={18} color={colors.muted} /><Text style={s.description}>{defaultLabel}</Text></Pressable> : null}
      {!filtered.length ? <Empty compact icon="search-outline" title="没有匹配的模型">换个关键词试试</Empty> : null}
      {favoriteModels.length ? <View style={styles.group}><Text style={styles.groupLabel}>收藏</Text>{favoriteModels.map((item) => row(item, "favorite"))}</View> : null}
      {providers.filter((provider) => otherModels.some((item) => item.provider === provider)).map((provider) => <View key={provider} style={styles.group}><Text style={styles.groupLabel}>{provider}</Text>{otherModels.filter((item) => item.provider === provider).map((item) => row(item, provider))}</View>)}
    </ScrollView>
  </BottomSheet>;
}

const styles = StyleSheet.create({
  search: { marginHorizontal: 18, backgroundColor: colors.white, borderRadius: radius.control, borderWidth: 1, borderColor: colors.line, paddingLeft: 12, flexDirection: "row", alignItems: "center", gap: 8 },
  searchInput: { flex: 1, height: 44, ...typography.body, fontSize: 14, color: colors.ink },
  filters: { flexGrow: 0, flexShrink: 0, height: 44, marginTop: 8, marginBottom: 4 },
  filterContent: { paddingHorizontal: 18, gap: 6 },
  filter: { minHeight: 38, paddingHorizontal: 13, justifyContent: "center", borderRadius: radius.small },
  filterActive: { backgroundColor: colors.neutral },
  filterText: { ...typography.detail, color: colors.muted, fontWeight: "600" },
  list: { paddingHorizontal: 18, paddingBottom: 20, gap: 14 },
  group: { gap: 6 },
  groupLabel: { ...typography.caption, color: colors.muted, paddingLeft: 3, paddingTop: 5 },
  model: { flexDirection: "row", alignItems: "center", paddingRight: 4, borderRadius: radius.item, backgroundColor: colors.white, borderWidth: 1, borderColor: "transparent" },
  selected: { backgroundColor: colors.purpleSoft, borderColor: "#DDD1F3" },
  modelChoice: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, padding: 11, minHeight: 64 },
  logo: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  modelName: { ...typography.item, color: colors.ink, fontSize: 14 },
  capabilities: { flexDirection: "row", alignItems: "center", gap: 5, overflow: "hidden" },
  capability: { flexDirection: "row", alignItems: "center", gap: 2, backgroundColor: colors.paper, paddingHorizontal: 4, borderRadius: 4 },
  capabilityText: { ...typography.small, color: colors.muted },
  defaultRow: { flexDirection: "row", minHeight: 44, gap: space.sm, alignItems: "center" },
});
