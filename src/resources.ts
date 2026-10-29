import * as Crypto from "expo-crypto";
import * as Sharing from "expo-sharing";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import { fetch as expoFetch } from "expo/fetch";
import { MAX_FILE_BYTES, safeDownloadName, type Connection, type Resource } from "./api";

export async function shareResource(connection: Connection, resource: Pick<Resource, "id" | "name">) {
  return shareDownload(connection, resource.name, `/resources/${encodeURIComponent(resource.id)}/content`);
}

/** DSH files stream to disk without applying the legacy business upload limit. */
export async function shareNativeDownload(connection: Connection, name: string, path: string) {
  if (!(await Sharing.isAvailableAsync())) throw new Error("此设备暂不支持文件分享。");
  const directory = new Directory(Paths.cache, "zhixing-dsh-download", Crypto.randomUUID());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await expoFetch(`${connection.url}/v1${path}`, {
      headers: { Authorization: `Bearer ${connection.token}` }, redirect: "error", signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error("下载失败，请重试。");
    directory.create({ intermediates: true });
    const file = new File(directory, safeDownloadName(name));
    file.create();
    const handle = file.open(FileMode.WriteOnly), reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        handle.writeBytes(value);
      }
    } finally { handle.close(); await reader.cancel(); }
    clearTimeout(timer);
    await Sharing.shareAsync(file.uri, { dialogTitle: name });
  } catch (error) {
    try { if (directory.exists) directory.delete(); } catch { /* Cache cleanup can be retried by the OS. */ }
    throw error;
  } finally { clearTimeout(timer); }
}

export async function shareDownload(connection: Connection, name: string, path: string) {
  if (!(await Sharing.isAvailableAsync())) throw new Error("此设备暂不支持文件分享。");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await expoFetch(`${connection.url}/v1${path}`, {
      headers: { Authorization: `Bearer ${connection.token}` }, redirect: "error", signal: controller.signal,
    });
    if (!response.ok) throw new Error("下载失败，请重试。");
    const bytes = await response.bytes();
    if (bytes.length > MAX_FILE_BYTES) throw new Error("文件超过 20 MiB。");
    const directory = new Directory(Paths.cache, "zhixing-resource", Crypto.randomUUID());
    directory.create({ intermediates: true });
    const file = new File(directory, safeDownloadName(name));
    file.write(bytes);
    await Sharing.shareAsync(file.uri, { dialogTitle: name });
  } finally {
    clearTimeout(timer);
  }
}
