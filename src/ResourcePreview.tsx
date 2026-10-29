import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Modal, Platform, Pressable, StyleSheet, Text, View, ScrollView, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { Connection, Resource } from "./api";
import { request } from "./api";
import { MessageBody } from "./MessageBody";
import { shareResource } from "./resources";
import { useThemedStyles } from "./ThemeProvider";
import { layout, radius, space, type ThemeColors } from "./theme";
import { ActionLink, IconAction, humanError, useUi } from "./ui";

type PreviewResource = Pick<Resource, "id" | "name" | "mime_type" | "size">;
export function resourceDetail(resource: Pick<Resource, "name" | "mime_type" | "size">) {
  const size = resource.size < 1024 ? `${resource.size} B`
    : resource.size < 1024 * 1024 ? `${Math.round(resource.size / 1024)} KB`
      : `${(resource.size / (1024 * 1024)).toFixed(1)} MB`;
  const type = resource.mime_type.startsWith("image/") ? "图片" : resource.name.split(".").pop()?.toUpperCase();
  return `${type && type !== resource.name.toUpperCase() ? type : "文件"} · ${size}`;
}

export function ResourceImage({ connection, resource, style, contain = false, label, contentPath }: {
  connection: Connection; resource: Pick<Resource, "id" | "name">; style?: StyleProp<ViewStyle>; contain?: boolean; label?: string; contentPath?: string;
}) {
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
  const [attempt, setAttempt] = useState(0);
  const uri = `${connection.url}/v1${contentPath ?? `/resources/${encodeURIComponent(resource.id)}/content`}?preview=true${attempt ? `&retry=${attempt}` : ""}`;
  const source = useMemo(() => ({ uri, headers: { Authorization: `Bearer ${connection.token}` } }), [uri, connection.token]);
  const [imageState, setImageState] = useState<{ source: typeof source; status: "loading" | "loaded" | "error" }>({ source, status: "loading" });
  const status = imageState.source === source ? imageState.status : "loading";
  useEffect(() => {
    // Native image failures are not always reported immediately; never leave a silent blank.
    const timeout = setTimeout(() => setImageState((current) => current.source !== source || current.status === "loading" ? { source, status: "error" } : current), 20000);
    return () => clearTimeout(timeout);
  }, [source]);
  return <View style={[styles.imageFrame, style]}>
    {/* RN 0.86 Android forwards request headers only through its array-source branch. */}
    <Image key={`${resource.id}:${attempt}`} source={[source]} accessibilityLabel={label ?? resource.name}
      resizeMode={contain ? "contain" : "cover"} style={StyleSheet.absoluteFill}
      onLoad={() => setImageState({ source, status: "loaded" })} onError={() => setImageState({ source, status: "error" })} />
    {status === "loading" ? <View pointerEvents="none" style={styles.imageStatus} accessibilityLabel={`正在加载${label ?? `图片 ${resource.name}`}`}>
      <ActivityIndicator color={colors.blue} />
    </View> : null}
    {status === "error" ? <Pressable accessibilityRole="button" accessibilityLabel={`重试加载${label ?? `图片 ${resource.name}`}`}
      style={styles.imageStatus} onPress={(event) => { event.stopPropagation(); setAttempt((value) => value + 1); }}>
      <Ionicons name="refresh-outline" size={20} color={colors.blue} />
      <Text style={s.small}>重试图片</Text>
    </Pressable> : null}
  </View>;
}

export const canPreviewText = (resource: Pick<Resource, "name" | "mime_type">) => resource.mime_type.startsWith("text/") || /\.(md|markdown|txt|csv|json|log)$/i.test(resource.name);
type TextPreview = { resource_id: string; content: string; format: "markdown" | "text"; truncated: boolean };

export function TextResourcePreview({ connection, resource, textPath }: { connection: Connection; resource: PreviewResource; textPath?: string }) {
  const { s, colors } = useUi();
  const [attempt, setAttempt] = useState(0);
  const scope = `${connection.url}\n${connection.token}\n${resource.id}\n${textPath ?? ""}`;
  const [state, setState] = useState<{ scope: string; result?: TextPreview; error?: string } | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void request<TextPreview>(connection, textPath ?? `/resources/${encodeURIComponent(resource.id)}/text`, { signal: controller.signal })
      .then((result) => { if (active && !controller.signal.aborted) setState({ scope, result }); })
      .catch((e) => { if (active && !controller.signal.aborted) setState({ scope, error: humanError(e) }); });
    return () => { active = false; controller.abort(); };
  }, [connection, resource.id, scope, attempt, textPath]);
  const visible = state?.scope === scope ? state : null;
  if (!visible) return <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }} accessibilityLabel="正在打开报告"><ActivityIndicator color={colors.blue} /></View>;
  if (visible.error) return <View style={[s.content, { flex: 1, justifyContent: "center" }]}>
    <Text accessibilityRole="alert" style={s.error}>{visible.error}</Text>
    <ActionLink icon="refresh-outline" tone="blue" onPress={() => { setState(null); setAttempt((value) => value + 1); }}>重新打开</ActionLink>
    <Text style={s.description}>也可以下载分享，在手机其他应用中打开。</Text>
  </View>;
  return <ScrollView accessibilityLabel={`报告内容 ${resource.name}`} contentContainerStyle={{ padding: 20, paddingBottom: 32 }}>
    {visible.result?.truncated ? <Text style={[s.muted, { marginBottom: 12 }]}>文件较长，当前显示前半部分；下载可查看全文。</Text> : null}
    {visible.result?.format === "markdown" ? <MessageBody>{visible.result.content}</MessageBody>
      : <Text selectable style={[s.text, { fontFamily: "monospace" }]}>{visible.result?.content}</Text>}
  </ScrollView>;
}

export function ResourcePreview({ connection, resource, onClose, onDismiss, textPath, onDownload }: {
  connection: Connection; resource: PreviewResource | null; onClose: () => void; onDismiss?: () => void;
  textPath?: string; onDownload?: () => Promise<void>;
}) {
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ resourceId: string; message: string } | null>(null);
  // Modal reports dismissal completion on iOS only. Android dialogs are already
  // gone by the next commit, so notify from the effect there instead of guessing
  // an animation duration.
  const wasOpen = useRef(!!resource);
  useEffect(() => {
    const open = !!resource;
    if (wasOpen.current && !open && Platform.OS !== "ios") onDismiss?.();
    wasOpen.current = open;
  }, [resource, onDismiss]);
  return <Modal visible={!!resource} onRequestClose={onClose} onDismiss={onDismiss}>
    <SafeAreaView style={s.root}>
      <View style={styles.header}><Ionicons name="document-text-outline" size={22} color={colors.muted} /><Text accessibilityRole="header" numberOfLines={2} style={styles.heading}>{resource?.name ?? "资料"}</Text><IconAction icon="close" label="关闭" onPress={onClose} /></View>
      {resource ? <>
        {resource.mime_type.startsWith("image/")
          ? <ResourceImage key={resource.id} connection={connection} resource={resource} contain style={styles.preview} />
          : canPreviewText(resource) ? <TextResourcePreview key={resource.id} connection={connection} resource={resource} textPath={textPath} />
          : <View style={styles.document}><Ionicons name="document-text-outline" size={48} color={colors.blue} /><Text style={s.title}>{resource.name}</Text><Text style={s.muted}>{resourceDetail(resource)}</Text><Text style={s.description}>下载后，可在手机中的应用打开。</Text></View>}
        <View style={styles.footer}>
          {error?.resourceId === resource.id ? <Text accessibilityRole="alert" style={s.error}>{error.message}</Text> : null}
          <ActionLink icon="share-outline" tone="blue" disabled={busy} onPress={() => {
            setBusy(true); setError(null);
            void (onDownload ? onDownload() : shareResource(connection, resource)).catch((e) => setError({ resourceId: resource.id, message: humanError(e) })).finally(() => setBusy(false));
          }}>{busy ? "正在准备文件…" : "下载分享"}</ActionLink>
        </View>
      </> : null}
    </SafeAreaView>
  </Modal>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 64, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  heading: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 22, fontWeight: "600", color: colors.ink },
  imageFrame: { overflow: "hidden", borderRadius: radius.small, backgroundColor: colors.neutral },
  imageStatus: { ...StyleSheet.absoluteFill, minHeight: layout.touchTarget, alignItems: "center", justifyContent: "center", gap: space.xs, backgroundColor: colors.neutral },
  preview: { flex: 1, width: "100%", borderRadius: 0, backgroundColor: colors.paper },
  document: { flex: 1, padding: space.xl, gap: space.lg, alignItems: "center", justifyContent: "center" },
  footer: { paddingHorizontal: layout.gutter, paddingVertical: space.sm, alignItems: "center", borderTopWidth: 1, borderTopColor: colors.line },
});
