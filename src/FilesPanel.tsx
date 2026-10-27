import { useUi, ActionLink, Button, CardHeader, Empty, IconAction, PageScrollView, SheetHeader, humanError } from "./ui";
import { useEffect, useRef, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as Crypto from "expo-crypto";
import * as Sharing from "expo-sharing";
import { Directory, File, Paths } from "expo-file-system";
import { fetch as expoFetch } from "expo/fetch";
import { preparePhoto } from "./photoUploads";
import { useThemedStyles } from "./ThemeProvider";
import { radius, space, type ThemeColors } from "./theme";
import {
  fileUploadRequest,
  MAX_FILE_BYTES,
  request,
  safeDownloadName,
  type Connection,
  type Resource,
} from "./api";

type WorkspaceFile = { path: string; name: string; size: number };
type Upload = { id: string; uri: string; name: string; size: number; image: boolean; resource?: Resource; error?: string };
const MAX_ATTACHMENTS = 8;
export function FilesPanel({
  connection,
  conversationId,
  attach,
  close,
  canAttach,
  attachmentIds = [],
}: {
  connection: Connection;
  conversationId: string;
  attach: (resource: Resource) => Promise<void>;
  close: () => void;
  canAttach: boolean;
  attachmentIds?: string[];
}) {
  const { s } = useUi();
  const styles = useThemedStyles(createStyles);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [progress, setProgress] = useState("");
  const alive = useRef(true);
  const scope = useRef(0);
  const working = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const prefix = `/conversations/${conversationId}/files`;
  const [panelScope, setPanelScope] = useState({ connection, prefix });
  if (panelScope.connection !== connection || panelScope.prefix !== prefix) {
    setPanelScope({ connection, prefix });
    setBusy(false);
    setUploads([]);
    setProgress("");
    setFiles([]);
    setTruncated(false);
    setNotice("");
    setError("");
  }
  const slots = Math.max(0, MAX_ATTACHMENTS - new Set([...attachmentIds, ...uploads.map((item) => item.resource?.id ?? item.id)]).size);
  const current = (session: number) => alive.current && scope.current === session;

  useEffect(() => {
    let active = true;
    const session = scope.current;
    alive.current = true;
    working.current = false;
    const abort = new AbortController();
    request<{ items: WorkspaceFile[]; truncated: boolean }>(
      connection,
      prefix,
      { signal: abort.signal },
    )
      .then((page) => {
        if (active) {
          setFiles(page.items);
          setTruncated(page.truncated);
        }
      })
      .catch((e) => {
        if (active) setError(humanError(e));
      });
    return () => {
      active = false;
      alive.current = false;
      scope.current = session + 1;
      abort.abort();
      controller.current?.abort();
    };
  }, [connection, prefix]);

  async function refresh() {
    const session = scope.current;
    try {
      const page = await request<{
        items: WorkspaceFile[];
        truncated: boolean;
      }>(connection, prefix);
      if (current(session)) {
        setFiles(page.items);
        setTruncated(page.truncated);
      }
    } catch (e) {
      if (current(session)) setError(humanError(e));
    }
  }
  async function pick(source: "photos" | "files") {
    if (working.current || !canAttach || !slots) return;
    working.current = true;
    setBusy(true);
    const session = scope.current;
    setError("");
    setNotice("");
    try {
      const result = source === "photos"
        ? await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: slots,
          orderedSelection: true, allowsEditing: false, quality: 1,
          preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
        })
        : await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
      if (result.canceled || !current(session)) return;
      if (result.assets.length > slots) throw new Error(`每条消息最多 8 份资料，本次还可以选择 ${slots} 份，请减少后重新选择。`);
      const selected: Upload[] = [];
      const failures: string[] = [];
      for (const asset of result.assets) {
        const id = Crypto.randomUUID();
        setProgress(`正在准备 ${selected.length + failures.length + 1}/${result.assets.length}`);
        try {
          const item = source === "photos"
            ? await preparePhoto(asset as ImagePicker.ImagePickerAsset, `照片-${id}.jpg`)
            : { uri: asset.uri, name: (asset as DocumentPicker.DocumentPickerAsset).name,
              size: new File(asset.uri).size, image: asset.mimeType?.startsWith("image/") ?? false };
          if (!current(session)) return;
          if (!item.size) throw new Error("文件暂时无法读取，请重新选择。");
          if (item.size > MAX_FILE_BYTES) throw new Error("单个文件最多 20 MiB，请选择较小的文件。");
          selected.push({ id, ...item });
        } catch (e) {
          if (!current(session)) return;
          const name = "name" in asset ? asset.name : asset.fileName || "照片";
          failures.push(`${name}：${humanError(e)}`);
        }
      }
      setUploads((items) => [...items, ...selected]);
      if (failures.length) setError(failures.join("\n"));
    } catch (e) {
      if (current(session)) setError(humanError(e));
    } finally {
      if (current(session)) {
        working.current = false;
        setBusy(false);
        setProgress("");
      }
    }
  }
  async function sendFiles() {
    if (!uploads.length || working.current || !canAttach) return;
    working.current = true;
    setBusy(true);
    const session = scope.current;
    setError("");
    setNotice("");
    let completed = 0;
    try {
      for (const [index, upload] of uploads.entries()) {
        if (!current(session)) return;
        setProgress(`正在上传 ${index + 1}/${uploads.length}`);
        const abort = new AbortController();
        controller.current = abort;
        const timer = setTimeout(() => abort.abort(), 120000);
        let resource = upload.resource;
        try {
          if (!resource) {
            const options = await fileUploadRequest(connection, new File(upload.uri));
            if (!current(session)) return;
            if (abort.signal.aborted) throw new Error("上传超时，请重试。");
            const response = await expoFetch(
              `${connection.url}/v1${prefix}/${upload.id}?filename=${encodeURIComponent(upload.name)}`,
              { ...options, signal: abort.signal },
            );
            const data = await response.json();
            if (!current(session)) return;
            if (abort.signal.aborted) throw new Error("上传超时，请重试。");
            if (!response.ok) throw new Error(data.error?.message ?? "上传失败，请重试。");
            resource = data as Resource;
            setUploads((items) => items.map((item) => item.id === upload.id ? { ...item, resource, error: undefined } : item));
          }
          if (!current(session)) return;
          await attach(resource);
          if (!current(session)) return;
          completed++;
          setUploads((items) => items.filter((item) => item.id !== upload.id));
        } catch (e) {
          if (!current(session)) return;
          const message = `${resource ? "已上传，加入草稿失败：" : ""}${abort.signal.aborted ? "上传超时，请重试。" : humanError(e)}`;
          setUploads((items) => items.map((item) => item.id === upload.id ? { ...item, resource, error: message } : item));
        } finally {
          clearTimeout(timer);
        }
      }
      if (current(session)) {
        setNotice(completed === uploads.length
          ? `已上传 ${completed} 份资料并加入消息草稿。回到对话即可发送。`
          : `已加入 ${completed} 份，另有 ${uploads.length - completed} 份未完成，可重试剩余资料。`);
        await refresh();
      }
    } finally {
      if (current(session)) {
        working.current = false;
        setBusy(false);
        setProgress("");
      }
    }
  }
  async function share(file: WorkspaceFile) {
    if (working.current) return;
    working.current = true;
    const session = scope.current;
    setBusy(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    const timer = setTimeout(() => abort.abort(), 120000);
    try {
      if (!(await Sharing.isAvailableAsync()))
        throw new Error("此设备暂不支持文件分享。");
      if (file.size > MAX_FILE_BYTES) throw new Error("下载上限为 20 MiB。");
      const response = await expoFetch(
        `${connection.url}/v1${prefix}/content?path=${encodeURIComponent(file.path)}`,
        {
          headers: { Authorization: `Bearer ${connection.token}` },
          signal: abort.signal,
          redirect: "error",
        },
      );
      if (!response.ok) {
        const data = await response.json();
        throw new Error(
          data.error?.message ?? "下载失败，请刷新文件列表重试。",
        );
      }
      const bytes = await response.bytes();
      if (bytes.length > MAX_FILE_BYTES) throw new Error("文件超过下载上限。");
      const directory = new Directory(
        Paths.cache,
        "zhixing-share",
        Crypto.randomUUID(),
      );
      directory.create({ intermediates: true });
      const safeName = safeDownloadName(file.name);
      const local = new File(directory, safeName);
      local.write(bytes);
      if (current(session))
        await Sharing.shareAsync(local.uri, { dialogTitle: file.name });
    } catch (e) {
      if (current(session)) setError(humanError(e));
    } finally {
      clearTimeout(timer);
      if (current(session)) {
        working.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <SafeAreaView style={s.root}>
      <SheetHeader title="资料与产物" onClose={close} />
      <PageScrollView>
        <Text style={s.muted}>
          当前会话的持久工作目录。上传资料后，在消息里说明要做什么；处理结果也会出现在这里。
        </Text>
        <View style={s.card}>
          <CardHeader icon="cloud-upload-outline" title="添加资料" tone="blue" />
          <Text style={s.muted}>
            照片和文件都可以多选，每条消息最多 8 份资料，每份最多 20 MiB。
          </Text>
          <View style={styles.actions}>
            <Button icon="images-outline" disabled={busy || !canAttach || !slots} onPress={() => { void pick("photos"); }}>选择照片</Button>
            <Button secondary icon="document-outline" disabled={busy || !canAttach || !slots} onPress={() => { void pick("files"); }}>选择手机文件</Button>
          </View>
          {uploads.length ? <>
            <Text style={s.label}>待上传 {uploads.length} 份 · 还可选择 {slots} 份</Text>
            {uploads.map((upload) => <View key={upload.id} style={s.row}>
              {upload.image ? <Image source={{ uri: upload.uri }} accessibilityLabel={`待上传照片 ${upload.name}`} style={styles.thumbnail} resizeMode="cover" /> : null}
              <View style={s.grow}>
                <Text numberOfLines={2} style={s.text}>{upload.name}</Text>
                <Text style={s.muted}>{upload.size < 1024 * 1024 ? `${(upload.size / 1024).toFixed(1)} KiB` : `${(upload.size / 1024 / 1024).toFixed(1)} MiB`}</Text>
                {upload.error ? <Text accessibilityRole="alert" style={s.error}>{upload.error}</Text> : null}
              </View>
              <IconAction icon="close-outline" label={`移除 ${upload.name}`} disabled={busy} onPress={() => setUploads((items) => items.filter((item) => item.id !== upload.id))} />
            </View>)}
            <Button disabled={busy || !canAttach} onPress={() => { void sendFiles(); }}>
              {uploads.some((item) => item.error) ? "重试剩余资料" : `上传 ${uploads.length} 份并加入草稿`}
            </Button>
          </> : null}
          {progress ? <Text accessibilityLiveRegion="polite" style={s.muted}>{progress}</Text> : null}
          {!slots && !uploads.length ? <Text style={s.muted}>草稿已有 8 份资料，可先发送或移除部分附件。</Text> : null}
          {!canAttach ? (
            <Text style={s.muted}>
              先确认待发送消息的结果，或返回编辑草稿，再添加资料。
            </Text>
          ) : null}
        </View>
        {error ? (
          <Text accessibilityRole="alert" style={s.error}>
            {error}
          </Text>
        ) : null}
        {notice ? <>
          <Text accessibilityLiveRegion="polite" style={s.muted}>{notice}</Text>
          <ActionLink icon="arrow-back-outline" tone="blue" disabled={busy} onPress={close}>回到对话</ActionLink>
        </> : null}
        <View style={s.spread}>
          <Text style={s.title}>工作目录里的文件</Text>
          <IconAction
            icon="refresh-outline"
            label="刷新文件"
            tone="blue"
            disabled={busy}
            onPress={() => {
              void refresh();
            }}
          />
        </View>
        {!files.length ? (
          <Empty compact icon="documents-outline" title="暂时没有文件">
            上传资料或让知行生成一份文件后，再来这里查看。
          </Empty>
        ) : (
          files.map((file) => (
            <View key={file.path} style={s.card}>
              <Text style={s.label}>{file.name}</Text>
              <Text selectable style={s.muted}>
                {file.path} · {(file.size / 1024).toFixed(1)} KiB
              </Text>
              <View style={[s.row, { flexWrap: "wrap" }]}>
                <ActionLink
                  icon="share-outline"
                  tone="blue"
                  disabled={busy}
                  onPress={() => {
                    void share(file);
                  }}
                >下载分享</ActionLink>
                <ActionLink
                  icon="attach-outline"
                  tone="blue"
                  disabled={busy || !canAttach || !slots}
                  onPress={() => {
                    void request<Resource>(connection, `/conversations/${conversationId}/resources`, { method: "POST", body: { path: file.path } })
                      .then(attach)
                      .then(() => setNotice("资料已加入草稿。"))
                      .catch((e) => setError(humanError(e)));
                  }}
                >加入草稿</ActionLink>
              </View>
            </View>
          ))
        )}
        {truncated ? (
          <Text style={s.noticeText}>
            文件较多，当前只展示服务器返回的部分文件；可让知行按路径查找。
          </Text>
        ) : null}
      </PageScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  thumbnail: { width: 56, height: 56, borderRadius: radius.small, backgroundColor: colors.neutral },
});
