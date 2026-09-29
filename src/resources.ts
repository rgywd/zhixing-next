import * as Crypto from "expo-crypto";
import * as Sharing from "expo-sharing";
import { Directory, File, Paths } from "expo-file-system";
import { fetch as expoFetch } from "expo/fetch";
import { MAX_FILE_BYTES, safeDownloadName, type Connection, type Resource } from "./api";

export async function shareResource(connection: Connection, resource: Resource) {
  if (!(await Sharing.isAvailableAsync())) throw new Error("此设备暂不支持文件分享。");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await expoFetch(`${connection.url}/v1/resources/${encodeURIComponent(resource.id)}/content`, {
      headers: { Authorization: `Bearer ${connection.token}` }, redirect: "error", signal: controller.signal,
    });
    if (!response.ok) throw new Error("下载失败，请重试。");
    const bytes = await response.bytes();
    if (bytes.length > MAX_FILE_BYTES) throw new Error("文件超过 20 MiB。");
    const directory = new Directory(Paths.cache, "zhixing-resource", Crypto.randomUUID());
    directory.create({ intermediates: true });
    const file = new File(directory, safeDownloadName(resource.name));
    file.write(bytes);
    await Sharing.shareAsync(file.uri, { dialogTitle: resource.name });
  } finally {
    clearTimeout(timer);
  }
}
