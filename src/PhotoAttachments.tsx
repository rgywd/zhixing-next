import { useState } from "react";
import { ActivityIndicator, FlatList, Image, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { StatusBar } from "expo-status-bar";
import type { Connection, DraftPhoto, Resource } from "./api";
import { ResourceImage, ResourcePreview } from "./ResourcePreview";
import { shareResource } from "./resources";
import { useThemedStyles } from "./ThemeProvider";
import { mediaColors, radius, space, typography, type ThemeColors } from "./theme";
import { humanError, useUi } from "./ui";

type NativePhoto = { id: string; name: string; path: string };
type Photo = { id: string; uri?: string; resource?: Resource; image?: NativePhoto; error?: string };

function PhotoImage({ connection, photo, contain = false }: { connection?: Connection; photo: Photo; contain?: boolean }) {
  if (photo.uri) return <Image source={{ uri: photo.uri }} accessibilityLabel="照片" resizeMode={contain ? "contain" : "cover"} style={StyleSheet.absoluteFill} />;
  const style = contain ? [StyleSheet.absoluteFill, { backgroundColor: mediaColors.background, borderRadius: 0 }] : StyleSheet.absoluteFill;
  if (connection && photo.image) return <ResourceImage connection={connection} resource={photo.image} contentPath={photo.image.path} label="照片" contain={contain} style={style} />;
  return connection && photo.resource ? <ResourceImage connection={connection} resource={photo.resource} label="照片" contain={contain} style={style} /> : null;
}

export function PhotoViewer({ connection, photos, selectedId, close }: {
  connection?: Connection; photos: Photo[]; selectedId: string | null; close: () => void;
}) {
  const { width } = useWindowDimensions();
  const start = photos.findIndex((photo) => photo.id === selectedId);
  const [page, setPage] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState(selectedId);
  if (opened !== selectedId) { setOpened(selectedId); setPage(Math.max(0, start)); setError(""); }
  const photo = photos[page];
  return <Modal visible={start >= 0} onRequestClose={close} animationType="fade">
    {start >= 0 ? <StatusBar style="light" /> : null}
    <SafeAreaView style={viewer.root}>
      <View style={viewer.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭照片预览" onPress={close} style={viewer.action}><Ionicons name="close" size={25} color={mediaColors.foreground} /></Pressable>
        <Text style={viewer.count}>{page + 1} / {photos.length}</Text>
        {connection && photo?.resource ? <Pressable accessibilityRole="button" accessibilityLabel="分享照片" disabled={sharing} style={viewer.action} onPress={() => {
          setSharing(true); setError("");
          void shareResource(connection, photo.resource!).catch((e) => setError(humanError(e))).finally(() => setSharing(false));
        }}>{sharing ? <ActivityIndicator color={mediaColors.foreground} /> : <Ionicons name="share-outline" size={23} color={mediaColors.foreground} />}</Pressable> : <View style={viewer.action} />}
      </View>
      {start >= 0 ? <FlatList key={`${selectedId}:${width}`} data={photos} horizontal pagingEnabled showsHorizontalScrollIndicator={false}
        initialScrollIndex={start} keyExtractor={(item) => item.id}
        getItemLayout={(_, index) => ({ index, length: width, offset: width * index })}
        onMomentumScrollEnd={(event) => setPage(Math.max(0, Math.min(photos.length - 1, Math.round(event.nativeEvent.contentOffset.x / width))))}
        renderItem={({ item }) => <View style={{ width, height: "100%" }}><PhotoImage connection={connection} photo={item} contain /></View>} /> : null}
      {error ? <Text accessibilityRole="alert" style={viewer.error}>{error}</Text> : null}
    </SafeAreaView>
  </Modal>;
}

export function DraftAttachments({ connection, attachments = [], photos = [], remove, removePhoto, sendingId }: {
  connection: Connection; attachments?: Resource[]; photos?: DraftPhoto[];
  remove?: (id: string) => void; removePhoto?: (id: string) => void; sendingId?: string | null;
}) {
  const { s, colors } = useUi();
  const styles = useThemedStyles(createStyles);
  const [selected, setSelected] = useState<string | null>(null);
  const [document, setDocument] = useState<Resource | null>(null);
  const localIds = new Set(photos.map((photo) => photo.resource?.id ?? photo.id));
  const remote = attachments.filter((item) => !localIds.has(item.id));
  const images: Photo[] = [...remote.filter((item) => item.mime_type.startsWith("image/")).map((resource) => ({ id: resource.id, resource })), ...photos];
  if (!images.length && !remote.length) return null;
  return <>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={styles.stripViewport} contentContainerStyle={styles.strip}>
      {images.map((photo, index) => {
        const onRemove = photos.some((item) => item.id === photo.id) ? removePhoto : remove;
        return <View key={photo.id} style={styles.thumbnail}>
          <Pressable accessibilityRole="button" accessibilityLabel={`预览第 ${index + 1} 张照片`} onPress={() => setSelected(photo.id)} style={styles.image}>
            <PhotoImage connection={connection} photo={photo} />
            {sendingId === photo.id ? <View style={styles.progress} pointerEvents="none" accessibilityLabel={`正在发送第 ${index + 1} 张照片`}><ActivityIndicator color={mediaColors.foreground} /></View> : null}
            {photo.error ? <View style={styles.failed} pointerEvents="none"><Ionicons name="alert-circle" size={18} color={colors.red} /><Text style={s.small}>未发送</Text></View> : null}
          </Pressable>
          {onRemove ? <Pressable accessibilityRole="button" accessibilityLabel={`移除第 ${index + 1} 张照片`} onPress={() => onRemove(photo.id)} style={styles.remove}>
            <View style={styles.removeCircle}><Ionicons name="close" size={15} color={mediaColors.foreground} /></View>
          </Pressable> : null}
        </View>;
      })}
      {remote.filter((item) => !item.mime_type.startsWith("image/")).map((item) => <View key={item.id} style={styles.file}>
        <Pressable accessibilityRole="button" accessibilityLabel={`打开文件 ${item.name}`} onPress={() => setDocument(item)} style={styles.fileBody}>
          <Ionicons name="document-text-outline" size={22} color={colors.blue} /><Text numberOfLines={2} style={[s.small, { flex: 1 }]}>{item.name}</Text>
        </Pressable>
        {remove ? <Pressable accessibilityRole="button" accessibilityLabel={`移除文件 ${item.name}`} onPress={() => remove(item.id)} style={styles.fileRemove}><Ionicons name="close" size={18} color={colors.muted} /></Pressable> : null}
      </View>)}
    </ScrollView>
    <PhotoViewer connection={connection} photos={images} selectedId={selected} close={() => setSelected(null)} />
    <ResourcePreview connection={connection} resource={document} onClose={() => setDocument(null)} />
  </>;
}

export function MessagePhotos({ connection, items = [], images = [] }: { connection: Connection; items?: Resource[]; images?: NativePhoto[] }) {
  const styles = useThemedStyles(createStyles);
  const { width } = useWindowDimensions();
  const [selected, setSelected] = useState<string | null>(null);
  const photos: Photo[] = [...items.map((resource) => ({ id: resource.id, resource })), ...images.map(image => ({ id: image.id, image }))];
  const available = Math.max(160, Math.min(width - 88, 360));
  const [measured, setMeasured] = useState(available);
  const size = photos.length === 1 ? Math.min(240, measured) : Math.floor((measured - space.xs) / 2);
  return <>
    <View onLayout={event => setMeasured(event.nativeEvent.layout.width)} style={[styles.messagePhotos, { width: photos.length === 1 ? Math.min(240, available) : available, maxWidth: "100%" }]}>
      {Array.from({ length: Math.ceil(photos.length / 2) }, (_, row) => <View key={row} style={{ flexDirection: "row", gap: space.xs }}>
        {photos.slice(row * 2, row * 2 + 2).map((photo, index) => <Pressable key={photo.id} accessibilityRole="button" accessibilityLabel={`查看第 ${row * 2 + index + 1} 张照片`} onPress={() => setSelected(photo.id)} style={[styles.image, { width: size, height: size }]}>
          <PhotoImage connection={connection} photo={photo} />
        </Pressable>)}
      </View>)}
    </View>
    <PhotoViewer connection={connection} photos={photos} selectedId={selected} close={() => setSelected(null)} />
  </>;
}

const viewer = StyleSheet.create({
  root: { flex: 1, backgroundColor: mediaColors.background },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8 },
  action: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  count: { ...typography.reading, color: mediaColors.foreground },
  error: { ...typography.body, color: mediaColors.foreground, padding: space.lg },
});
const createStyles = (colors: ThemeColors) => StyleSheet.create({
  stripViewport: { flexGrow: 0 },
  strip: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.xs },
  thumbnail: { width: 96, height: 96 },
  image: { width: "100%", height: "100%", overflow: "hidden", borderRadius: radius.small, backgroundColor: colors.neutral },
  remove: { position: "absolute", top: 0, right: 0, width: 44, height: 44, alignItems: "flex-end", padding: 4 },
  removeCircle: { width: 22, height: 22, borderRadius: 11, backgroundColor: mediaColors.control, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: mediaColors.controlBorder },
  progress: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", backgroundColor: mediaColors.loading },
  failed: { position: "absolute", left: 0, bottom: 0, right: 0, backgroundColor: colors.paper, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 3, paddingVertical: 3 },
  file: { height: 64, width: 178, flexDirection: "row", alignItems: "center", borderRadius: radius.small, backgroundColor: colors.blueSoft },
  fileBody: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.sm },
  fileRemove: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  messagePhotos: { gap: space.xs, marginVertical: space.xs },
});
