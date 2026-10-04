import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import type { Connection, Resource } from "./api";
import { shareResource } from "./resources";
import { useThemedStyles } from "./ThemeProvider";
import { layout, radius, space, type ThemeColors } from "./theme";
import { ActionLink, SheetHeader, humanError, useUi } from "./ui";

export function resourceDetail(resource: Resource) {
  const size = resource.size < 1024 ? `${resource.size} B`
    : resource.size < 1024 * 1024 ? `${Math.round(resource.size / 1024)} KB`
      : `${(resource.size / (1024 * 1024)).toFixed(1)} MB`;
  const type = resource.mime_type.startsWith("image/") ? "图片" : resource.name.split(".").pop()?.toUpperCase();
  return `${type && type !== resource.name.toUpperCase() ? type : "文件"} · ${size}`;
}

export function ResourceImage({ connection, resource, style, contain = false }: {
  connection: Connection; resource: Resource; style?: StyleProp<ViewStyle>; contain?: boolean;
}) {
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
  const [attempt, setAttempt] = useState(0);
  const uri = `${connection.url}/v1/resources/${encodeURIComponent(resource.id)}/content?preview=true${attempt ? `&retry=${attempt}` : ""}`;
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
    <Image key={`${resource.id}:${attempt}`} source={[source]} accessibilityLabel={resource.name}
      resizeMode={contain ? "contain" : "cover"} style={StyleSheet.absoluteFill}
      onLoad={() => setImageState({ source, status: "loaded" })} onError={() => setImageState({ source, status: "error" })} />
    {status === "loading" ? <View pointerEvents="none" style={styles.imageStatus} accessibilityLabel={`正在加载图片 ${resource.name}`}>
      <ActivityIndicator color={colors.blue} />
    </View> : null}
    {status === "error" ? <Pressable accessibilityRole="button" accessibilityLabel={`重试加载图片 ${resource.name}`}
      style={styles.imageStatus} onPress={(event) => { event.stopPropagation(); setAttempt((value) => value + 1); }}>
      <Ionicons name="refresh-outline" size={20} color={colors.blue} />
      <Text style={s.small}>重试图片</Text>
    </Pressable> : null}
  </View>;
}

export function ResourcePreview({ connection, resource, onClose }: {
  connection: Connection; resource: Resource | null; onClose: () => void;
}) {
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ resourceId: string; message: string } | null>(null);
  return <Modal visible={!!resource} onRequestClose={onClose}>
    <SafeAreaView style={s.root}>
      <SheetHeader title={resource?.name ?? "资料"} onClose={onClose} />
      {resource ? <>
        {resource.mime_type.startsWith("image/")
          ? <ResourceImage key={resource.id} connection={connection} resource={resource} contain style={styles.preview} />
          : <View style={styles.document}><Ionicons name="document-text-outline" size={48} color={colors.blue} /><Text style={s.title}>{resource.name}</Text><Text style={s.muted}>{resourceDetail(resource)}</Text><Text style={s.description}>下载后，可在手机中的应用打开。</Text></View>}
        <View style={styles.footer}>
          {error?.resourceId === resource.id ? <Text accessibilityRole="alert" style={s.error}>{error.message}</Text> : null}
          <ActionLink icon="share-outline" tone="blue" disabled={busy} onPress={() => {
            setBusy(true); setError(null);
            void shareResource(connection, resource).catch((e) => setError({ resourceId: resource.id, message: humanError(e) })).finally(() => setBusy(false));
          }}>{busy ? "正在准备文件…" : "下载分享"}</ActionLink>
        </View>
      </> : null}
    </SafeAreaView>
  </Modal>;
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  imageFrame: { overflow: "hidden", borderRadius: radius.small, backgroundColor: colors.neutral },
  imageStatus: { ...StyleSheet.absoluteFill, minHeight: layout.touchTarget, alignItems: "center", justifyContent: "center", gap: space.xs, backgroundColor: colors.neutral },
  preview: { flex: 1, width: "100%", borderRadius: 0, backgroundColor: colors.paper },
  document: { flex: 1, padding: space.xl, gap: space.lg, alignItems: "center", justifyContent: "center" },
  footer: { paddingHorizontal: layout.gutter, paddingVertical: space.sm, alignItems: "center", borderTopWidth: 1, borderTopColor: colors.line },
});
