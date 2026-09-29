import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Modal, Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ModelInfo } from "./api";
import { Button, Empty, PageScrollView, SheetHeader, colors, humanError, s } from "./ui";

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
  const filtered = models.filter((item) =>
    `${item.name} ${item.model} ${item.provider}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const favoriteModels = filtered.filter((item) => favorites.includes(item.id));
  const providers = [...new Set(filtered.map((item) => item.provider))];
  function row(item: ModelInfo, prefix: string) {
    return (
      <View key={`${prefix}-${item.id}`} style={[s.card, s.cardRow]}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: selectedId === item.id, disabled: busy || !item.ready }}
          disabled={busy || !item.ready}
          onPress={() => { void choose(item.id); }}
          style={s.headingCopy}
        >
          <Text numberOfLines={1} style={[s.label, selectedId === item.id && s.accentText]}>
            {item.name}{selectedId === item.id ? " · 当前" : ""}
          </Text>
          <Text numberOfLines={1} style={s.muted}>
            {item.model} · {item.protocol === "chat_completions" ? "OpenAI 兼容" : item.protocol === "responses" ? "Responses" : "Gemini"}
          </Text>
          <Text style={s.muted}>{item.ready ? (item.reasoning_levels.length ? "密钥已配置 · 可调思考深度" : "密钥已配置") : "密钥未就绪"}{item.image_input ? " · 支持图片" : ""}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`${favorites.includes(item.id) ? "取消收藏" : "收藏"} ${item.name}`} onPress={() => { void toggleFavorite(item.id); }} style={s.iconButton}>
          <Ionicons name={favorites.includes(item.id) ? "heart" : "heart-outline"} size={22} color={favorites.includes(item.id) ? colors.accent : colors.muted} />
        </Pressable>
      </View>
    );
  }
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={s.root}>
        <SheetHeader title={title} onClose={onClose} />
        <PageScrollView>
          <TextInput accessibilityLabel="搜索模型" placeholder="搜索模型或供应商" placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} autoCorrect={false} style={s.input} />
          {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
          {onUseDefault ? <Button secondary disabled={busy} onPress={() => { void choose(); }}>{defaultLabel}</Button> : null}
          {!filtered.length ? <Empty compact icon="search-outline" title="没有匹配的模型">请调整搜索词，或在服务器配置模型后刷新。</Empty> : null}
          {favoriteModels.length ? (
            <View style={s.stack}><Text style={s.title}>收藏</Text>{favoriteModels.map((item) => row(item, "favorite"))}</View>
          ) : null}
          {providers.map((provider) => (
            <View key={provider} style={s.stack}>
              <Text style={s.title}>{provider}</Text>
              {filtered.filter((item) => item.provider === provider).map((item) => row(item, provider))}
            </View>
          ))}
        </PageScrollView>
      </SafeAreaView>
    </Modal>
  );
}
