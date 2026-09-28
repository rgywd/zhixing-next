import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { Conversation } from "./api";
import { colors, s } from "./ui";

export function AiDrawer({
  visible,
  name,
  conversations,
  selectedId,
  hasMore,
  busy,
  onClose,
  onOpen,
  onMore,
  onNew,
  onSettings,
}: {
  visible: boolean;
  name: string;
  conversations: Conversation[];
  selectedId: string | null;
  hasMore: boolean;
  busy: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
  onMore: () => void;
  onNew: () => void;
  onSettings: () => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const matches = [...conversations]
    .filter((item) => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const [cutoff] = useState(() => Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recent = matches.filter((item) => Date.parse(item.updated_at) >= cutoff);
  const older = matches.filter((item) => Date.parse(item.updated_at) < cutoff);

  function conversationRow(item: Conversation) {
    return (
      <Pressable
        key={item.id}
        accessibilityRole="button"
        accessibilityLabel={`打开对话：${item.title}`}
        onPress={() => onOpen(item.id)}
        style={({ pressed }) => [styles.conversation, item.id === selectedId && styles.selected, pressed && s.pressed]}
      >
        <Text numberOfLines={1} style={styles.conversationTitle}>{item.title}</Text>
        {item.blocked ? <Ionicons name="pause-circle-outline" size={16} color={colors.muted} /> : null}
      </Pressable>
    );
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <SafeAreaView style={styles.panel}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
            <View style={styles.identity}>
              <View style={styles.identityTop}>
                <View style={styles.avatar}><Ionicons name="leaf-outline" size={28} color={colors.accent} /></View>
                <View style={s.grow}>
                  <Text numberOfLines={1} style={styles.name}>{name}</Text>
                  <Text style={styles.identitySub}>你的 AI 伙伴</Text>
                </View>
              </View>
              <View style={styles.identityLine} />
              <View style={styles.shortcuts}>
                {([
                  { label: "搜索", icon: "search-outline", onPress: () => setSearchOpen(true) },
                  { label: "设置", icon: "settings-outline", onPress: onSettings },
                ] as const).map((item) => (
                  <Pressable key={item.label} accessibilityRole="button" accessibilityLabel={item.label} onPress={item.onPress} style={styles.shortcut}>
                    <Ionicons name={item.icon} size={25} color={colors.ink} />
                    <Text style={styles.shortcutText}>{item.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <View style={styles.historyHeader}>
              <Text style={styles.heading}>对话历史</Text>
              {searchOpen ? <Pressable accessibilityRole="button" accessibilityLabel="关闭搜索" onPress={() => { setSearchOpen(false); setQuery(""); }}><Ionicons name="close" size={22} color={colors.muted} /></Pressable> : null}
            </View>
            {searchOpen ? (
              <View style={styles.searchBox}>
                <Ionicons name="search-outline" size={20} color={colors.muted} />
                <TextInput accessibilityLabel="搜索对话标题" placeholder="搜索对话标题" placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} style={styles.searchInput} />
              </View>
            ) : null}
            {recent.length ? <Text style={styles.group}>7 天内</Text> : null}
            {recent.map(conversationRow)}
            {older.length ? <Text style={styles.group}>更早</Text> : null}
            {older.map(conversationRow)}
            {!matches.length ? <Text style={styles.empty}>{query ? "没有找到匹配的对话" : "还没有对话，开始一段新的聊天吧。"}</Text> : null}
            {hasMore ? (
              <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy} onPress={onMore} style={styles.more}>
                <Text style={styles.moreText}>{busy ? "加载中…" : "查看更早的对话"}</Text>
              </Pressable>
            ) : null}
          </ScrollView>
          <Pressable accessibilityRole="button" accessibilityLabel="新建对话" onPress={() => { setQuery(""); setSearchOpen(false); onNew(); }} style={styles.newButton}>
            <Ionicons name="create-outline" size={21} color={colors.ink} />
            <Text style={styles.newText}>新建对话</Text>
          </Pressable>
        </SafeAreaView>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭侧边栏" onPress={onClose} style={styles.scrim} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, flexDirection: "row", backgroundColor: "#25252D77" },
  panel: { width: "84%", maxWidth: 400, backgroundColor: colors.white, paddingHorizontal: 18 },
  scrim: { flex: 1 },
  content: { paddingTop: 20, paddingBottom: 24 },
  identity: { backgroundColor: "#F5F5F7", borderRadius: 25, padding: 18, gap: 17 },
  identityTop: { flexDirection: "row", alignItems: "center", gap: 13 },
  avatar: { width: 55, height: 55, borderRadius: 28, backgroundColor: colors.pale, alignItems: "center", justifyContent: "center" },
  name: { color: colors.ink, fontSize: 19, fontWeight: "700" },
  identitySub: { color: colors.muted, fontSize: 13, marginTop: 4 },
  identityLine: { height: 1, backgroundColor: colors.line },
  shortcuts: { flexDirection: "row" },
  shortcut: { flex: 1, minHeight: 66, alignItems: "center", justifyContent: "center", gap: 7 },
  shortcutText: { color: colors.ink, fontSize: 14, fontWeight: "500" },
  historyHeader: { marginTop: 32, marginBottom: 13, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  heading: { color: colors.ink, fontSize: 19, fontWeight: "700" },
  searchBox: { minHeight: 44, borderRadius: 13, backgroundColor: "#F5F5F7", flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, marginBottom: 12 },
  searchInput: { flex: 1, color: colors.ink, fontSize: 14, paddingVertical: 8 },
  group: { color: colors.muted, fontSize: 12, fontWeight: "600", marginTop: 15, marginBottom: 6 },
  conversation: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 13, paddingHorizontal: 12 },
  selected: { backgroundColor: colors.pale },
  conversationTitle: { flex: 1, color: colors.ink, fontSize: 14 },
  empty: { color: colors.muted, fontSize: 13, lineHeight: 20, marginTop: 15 },
  more: { minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: 12 },
  moreText: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  newButton: { alignSelf: "center", minHeight: 54, paddingHorizontal: 23, borderRadius: 27, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, marginBottom: 10, shadowColor: colors.ink, shadowOpacity: 0.12, shadowRadius: 10, elevation: 5 },
  newText: { color: colors.ink, fontSize: 15, fontWeight: "700" },
});
