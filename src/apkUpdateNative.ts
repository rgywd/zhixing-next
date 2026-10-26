import { requireOptionalNativeModule } from "expo";
import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";
import type { ApkUpdateAdapter } from "./apkUpdate";

type Installer = {
  canInstallAsync(): Promise<boolean>;
  openInstallSettingsAsync(): Promise<void>;
  installApkAsync(uri: string, sha256: string, size: number, version: string): Promise<void>;
};
const installer = requireOptionalNativeModule<Installer>("ZhixingUpdates");
const unavailable = () => new Error("当前安装包不支持 App 内更新，请从 GitHub 发布页下载安装新版。");
const cancelled = () => Object.assign(new Error("下载已取消"), { name: "AbortError" });
const directory = () => {
  if (Platform.OS !== "android" || !installer || !FileSystem.cacheDirectory) throw unavailable();
  return `${FileSystem.cacheDirectory}zhixing-updates/`;
};

export const apkUpdateAdapter: ApkUpdateAdapter = {
  async download(release, signal, progress) {
    const root = directory(), uri = `${root}download-${Crypto.randomUUID()}.apk`;
    await FileSystem.makeDirectoryAsync(root, { intermediates: true });
    if (signal.aborted) throw cancelled();
    let oversized = false;
    const task = FileSystem.createDownloadResumable(release.apkUrl!, uri, {}, (event) => {
      if (event.totalBytesWritten > release.apkSize!) {
        oversized = true; void task.cancelAsync().catch(() => {}); return;
      }
      progress(event.totalBytesWritten, release.apkSize!);
    });
    const abort = () => { void task.cancelAsync().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await task.downloadAsync();
      if (signal.aborted) throw cancelled();
      if (oversized) throw new Error("安装包大小与发布信息不符，请重新检查更新。");
      if (!result || result.status !== 200 || result.uri !== uri) throw new Error("下载未完成，请检查网络后重试。");
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists || info.isDirectory || info.size !== release.apkSize) throw new Error("安装包下载不完整，请重试。");
      return uri;
    } catch (error) {
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      if (signal.aborted) throw cancelled();
      throw error instanceof Error && /安装包|下载未完成/.test(error.message) ? error : new Error("下载未完成，请检查网络后重试。");
    } finally { signal.removeEventListener("abort", abort); }
  },
  async remove(uri) {
    const root = directory();
    if (!uri.startsWith(root) || !/^download-[a-f0-9-]+\.apk$/.test(uri.slice(root.length))) return;
    await FileSystem.deleteAsync(uri, { idempotent: true });
  },
  async canInstall() { if (!installer) throw unavailable(); return installer.canInstallAsync(); },
  async openSettings() { if (!installer) throw unavailable(); await installer.openInstallSettingsAsync(); },
  async install(uri, release) {
    if (!installer) throw unavailable();
    await installer.installApkAsync(uri, release.apkSha256!, release.apkSize!, release.version);
  },
};
