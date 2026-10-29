import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { BottomSheet } from "./BottomSheet";
import { ChatFileCard } from "./ChatFileCard";
import { conversationFileKey, searchConversationFiles, type ConversationFile } from "./conversationFiles";
import { ActionLink, Empty, humanError, useUi } from "./ui";
import { layout, radius, space, typography } from "./theme";
import type { DshAttachment } from "./dshProtocol";

/**
 * Bottom sheet listing what the assistant delivered in this exact conversation.
 * It only reads existing DSH delivery data; preview and share stay caller-owned.
 * Preparing a share, its failure and its retry stay inside this panel so they
 * cannot be hidden behind it, and the query survives a preview round trip.
 */
export function ConversationFilesSheet({ visible, ready = true, files, onOpen, onShare, onDismiss, onClose }: {
  visible: boolean; ready?: boolean; files: ConversationFile[];
  onOpen: (file: DshAttachment) => void; onShare?: (file: DshAttachment) => Promise<void>;
  onDismiss?: () => void; onClose: () => void;
}) {
  const { s, colors } = useUi();
  const [query, setQuery] = useState("");
  const [sharing, setSharing] = useState<{ key: string; name: string } | null>(null);
  const [shareError, setShareError] = useState("");
  const [retry, setRetry] = useState<DshAttachment | null>(null);
  const close = () => { setQuery(""); setShareError(""); setRetry(null); onClose(); };
  async function share(file: DshAttachment) {
    if (sharing || !onShare) return;
    setSharing({ key: conversationFileKey(file), name: file.name }); setShareError(""); setRetry(null);
    try { await onShare(file); }
    catch (e) { setShareError(humanError(e)); setRetry(file); }
    finally { setSharing(null); }
  }
  const shown = useMemo(() => searchConversationFiles(files, query), [files, query]);
  const search = query.trim();
  return <BottomSheet visible={visible} title="本对话文件" subtitle={files.length ? `已交付 ${files.length} 个文件` : undefined}
    tall={files.length > 3} onClose={close} onDismiss={onDismiss}>
    {files.length ? <View style={{ paddingHorizontal: layout.gutter, paddingBottom: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: 1, borderColor: colors.line,
        borderRadius: radius.control, backgroundColor: colors.surface, paddingLeft: space.md }}>
        <Ionicons name="search-outline" size={17} color={colors.muted} />
        <TextInput accessibilityLabel="搜索文件名" placeholder="搜索文件名" placeholderTextColor={colors.muted}
          value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} returnKeyType="search"
          style={[{ flex: 1, minWidth: 0, minHeight: layout.touchTarget, paddingVertical: space.sm },
            typography.reading, { color: colors.ink }]} />
        {query ? <Pressable accessibilityRole="button" accessibilityLabel="清空搜索" onPress={() => setQuery("")}
          style={{ width: layout.touchTarget, minHeight: layout.touchTarget, alignItems: "center", justifyContent: "center" }}>
          <Ionicons name="close-circle" size={18} color={colors.muted} />
        </Pressable> : null}
      </View>
    </View> : null}
    {sharing ? <Text numberOfLines={2} style={[s.description, { paddingHorizontal: layout.gutter, paddingBottom: space.sm }]}>正在准备「{sharing.name}」…</Text> : null}
    {shareError ? <View style={{ paddingHorizontal: layout.gutter, paddingBottom: space.sm, gap: space.xs }}>
      <Text accessibilityRole="alert" style={s.error}>分享未完成：{shareError}</Text>
      {retry ? <ActionLink icon="refresh-outline" disabled={!!sharing} onPress={() => { void share(retry); }}>重试分享</ActionLink> : null}
    </View> : null}
    {!ready && !files.length ? <Text style={[s.muted, { paddingHorizontal: layout.gutter, paddingBottom: space.lg }]}>正在读取对话文件…</Text>
      : !files.length ? <View style={{ paddingHorizontal: layout.gutter, paddingBottom: space.lg }}>
        <Empty compact icon="document-text-outline" title="本对话还没有交付文件">助手交付文件后会出现在这里。</Empty>
      </View>
      : !shown.length ? <View style={{ paddingHorizontal: layout.gutter, paddingBottom: space.lg }}>
        <Empty compact icon="search-outline" title="没有匹配的文件">{`没有文件名包含“${search}”的文件。`}</Empty>
        <ActionLink icon="close-circle-outline" onPress={() => setQuery("")}>清空搜索</ActionLink>
      </View>
      : <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: layout.gutter, paddingBottom: space.lg }}>
        {shown.map(item => <ChatFileCard key={item.key} file={item.file} busy={!!sharing} onOpen={() => onOpen(item.file)}
          onShare={onShare ? () => { void share(item.file); } : undefined} />)}
      </ScrollView>}
  </BottomSheet>;
}
