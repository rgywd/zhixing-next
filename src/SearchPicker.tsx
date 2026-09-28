import { useEffect, useState } from "react";
import { Alert, Modal, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError, request, type Connection, type SearchProvider } from "./api";
import { Button, colors, humanError, s } from "./ui";

const kinds = { brave: "Brave", tavily: "Tavily", serper: "Serper" } as const;

export function SearchPicker({ visible, connection, selectedId, onSelect, onClose }: {
  visible: boolean;
  connection: Connection;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
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
      .then((page) => { if (active) { setItems(page.items); setSupported(true); setError(""); } })
      .catch((e) => { if (active) { setSupported(!(e instanceof ApiError && e.status === 404)); setError(e instanceof ApiError && e.status === 404 ? "当前服务端尚未支持联网搜索，请先更新服务端。" : humanError(e)); } });
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
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={s.root}>
        <View style={s.header}><Text style={[s.heading, s.grow]}>联网搜索</Text><Button secondary onPress={onClose}>关闭</Button></View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
          <Text style={s.muted}>选中的服务只用于接下来发送的聊天或任务。密钥保存在你的知行服务端，列表不会返回密钥。</Text>
          {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
          <Button secondary={selectedId !== null} onPress={() => { onSelect(null); onClose(); }}>关闭联网搜索{selectedId === null ? " · 当前" : ""}</Button>
          {items.map((item) => (
            <View key={item.id} style={[s.card, { gap: 8 }]}>
              <View style={s.row}>
                <View style={s.grow}><Text style={s.title}>{item.name}</Text><Text style={s.muted}>{kinds[item.kind]}{selectedId === item.id ? " · 当前" : ""}</Text></View>
                <Button small secondary={selectedId !== item.id} onPress={() => { onSelect(item.id); onClose(); }}>使用</Button>
              </View>
              <Button small secondary danger disabled={busy} onPress={() => remove(item)}>移除服务</Button>
            </View>
          ))}
          <Text style={s.title}>添加搜索服务</Text>
          <View style={s.wrap}>{(Object.keys(kinds) as SearchProvider["kind"][]).map((value) => <Button key={value} small secondary={kind !== value} onPress={() => setKind(value)}>{kinds[value]}</Button>)}</View>
          <TextInput accessibilityLabel="搜索服务名称" placeholder="名称（可选）" placeholderTextColor={colors.muted} value={name} onChangeText={setName} maxLength={100} style={s.input} />
          <TextInput accessibilityLabel="搜索服务 API 密钥" placeholder={`${kinds[kind]} API 密钥`} placeholderTextColor={colors.muted} value={key} onChangeText={setKey} secureTextEntry autoCapitalize="none" autoCorrect={false} style={s.input} />
          <Button disabled={busy || !key.trim() || !supported} onPress={() => { void add(); }}>{busy ? "保存中…" : "保存并使用"}</Button>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
