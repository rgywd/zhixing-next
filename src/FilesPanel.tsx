import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import * as Crypto from "expo-crypto";
import * as Sharing from "expo-sharing";
import { Directory, File, Paths } from "expo-file-system";
import { fetch as expoFetch } from "expo/fetch";
import {
  fileUploadRequest,
  MAX_FILE_BYTES,
  request,
  safeDownloadName,
  type Connection,
  type Resource,
} from "./api";
import { Button, humanError, s } from "./ui";

type WorkspaceFile = { path: string; name: string; size: number };
export function FilesPanel({
  connection,
  conversationId,
  attach,
  close,
  canAttach,
}: {
  connection: Connection;
  conversationId: string;
  attach: (resource: Resource) => Promise<void>;
  close: () => void;
  canAttach: boolean;
}) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [upload, setUpload] = useState<{
    id: string;
    uri: string;
    name: string;
  } | null>(null);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const prefix = `/conversations/${conversationId}/files`;

  useEffect(() => {
    let active = true;
    alive.current = true;
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
      abort.abort();
      controller.current?.abort();
    };
  }, [connection, prefix]);

  async function refresh() {
    try {
      const page = await request<{
        items: WorkspaceFile[];
        truncated: boolean;
      }>(connection, prefix);
      if (alive.current) {
        setFiles(page.items);
        setTruncated(page.truncated);
        setError("");
      }
    } catch (e) {
      if (alive.current) setError(humanError(e));
    }
  }
  async function pick() {
    setError("");
    setNotice("");
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !alive.current) return;
      const asset = result.assets[0];
      const file = new File(asset.uri);
      if (file.size > MAX_FILE_BYTES)
        throw new Error("单个文件最多 20 MiB，请选择较小的文件。");
      setUpload({ id: Crypto.randomUUID(), uri: asset.uri, name: asset.name });
    } catch (e) {
      if (alive.current) setError(humanError(e));
    }
  }
  async function sendFile() {
    if (!upload || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const abort = new AbortController();
    controller.current = abort;
    const timer = setTimeout(() => abort.abort(), 120000);
    try {
      const response = await expoFetch(
        `${connection.url}/v1${prefix}/${upload.id}?filename=${encodeURIComponent(upload.name)}`,
        {
          ...(await fileUploadRequest(connection, new File(upload.uri))),
          signal: abort.signal,
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error?.message ?? "上传失败，请重试。");
      if (!alive.current) return;
      await attach(data);
      setUpload(null);
      setNotice("已上传并加入消息草稿。回到对话告诉我怎样处理它。");
      await refresh();
    } catch (e) {
      if (alive.current)
        setError(`${humanError(e)} 原文件仍保留，可以重试同一次上传。`);
    } finally {
      clearTimeout(timer);
      if (alive.current) setBusy(false);
    }
  }
  async function share(file: WorkspaceFile) {
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
      if (alive.current)
        await Sharing.shareAsync(local.uri, { dialogTitle: file.name });
    } catch (e) {
      if (alive.current) setError(humanError(e));
    } finally {
      clearTimeout(timer);
      if (alive.current) setBusy(false);
    }
  }
  return (
    <SafeAreaView style={s.root}>
      <View style={s.header}>
        <Text style={[s.heading, s.grow]}>资料与产物</Text>
        <Button secondary onPress={close}>
          关闭
        </Button>
      </View>
      <ScrollView contentContainerStyle={s.content}>
        <Text style={s.muted}>
          当前会话的持久工作目录。上传资料后，在消息里说明要做什么；处理结果也会出现在这里。
        </Text>
        <View style={s.card}>
          <Text style={s.title}>交给知行一份资料</Text>
          <Text style={s.muted}>
            每个文件最多 20 MiB。图片可直接交给支持视觉的模型；PDF 和 Word 可提取文字。
          </Text>
          {upload ? (
            <>
              <Text style={s.text}>{upload.name}</Text>
              <Button
                disabled={busy || !canAttach}
                onPress={() => {
                  void sendFile();
                }}
              >
                {busy ? "上传中…" : "上传并加入草稿"}
              </Button>
              <Button secondary disabled={busy} onPress={() => setUpload(null)}>
                重新选择
              </Button>
            </>
          ) : (
            <Button
              disabled={busy || !canAttach}
              onPress={() => {
                void pick();
              }}
            >
              选择手机文件
            </Button>
          )}
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
        {notice ? <Text style={s.muted}>{notice}</Text> : null}
        <View style={s.spread}>
          <Text style={s.title}>工作目录里的文件</Text>
          <Button
            secondary
            small
            disabled={busy}
            onPress={() => {
              void refresh();
            }}
          >
            刷新
          </Button>
        </View>
        {!files.length ? (
          <Text style={s.muted}>
            暂时没有文件。上传资料或让知行生成一份文件后，再来这里查看。
          </Text>
        ) : (
          files.map((file) => (
            <View key={file.path} style={s.card}>
              <Text style={s.label}>{file.name}</Text>
              <Text selectable style={s.muted}>
                {file.path} · {(file.size / 1024).toFixed(1)} KiB
              </Text>
              <View style={s.row}>
                <Button
                  secondary
                  small
                  disabled={busy}
                  onPress={() => {
                    void share(file);
                  }}
                >
                  下载并分享
                </Button>
                <Button
                  secondary
                  small
                  disabled={busy || !canAttach}
                  onPress={() => {
                    void request<Resource>(connection, `/conversations/${conversationId}/resources`, { method: "POST", body: { path: file.path } })
                      .then(attach)
                      .then(() => setNotice("资料已加入草稿。"))
                      .catch((e) => setError(humanError(e)));
                  }}
                >
                  加入草稿
                </Button>
              </View>
            </View>
          ))
        )}
        {truncated ? (
          <Text style={s.noticeText}>
            文件较多，当前只展示服务器返回的部分文件；可让知行按路径查找。
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
