import { isReleaseLink, type AppRelease } from "./appUpdates";

export type ApkUpdateState =
  | { phase: "idle" | "cancelled" | "permission" | "verifying" | "handed-off" }
  | { phase: "downloading"; written: number; total: number }
  | { phase: "error"; message: string };
export type ApkUpdateAdapter = {
  download(release: AppRelease, signal: AbortSignal, progress: (written: number, total: number) => void): Promise<string>;
  remove(uri: string): Promise<void>;
  canInstall(): Promise<boolean>;
  openSettings(): Promise<void>;
  install(uri: string, release: AppRelease): Promise<void>;
};

export function hasVerifiedApkMetadata(release: AppRelease): boolean {
  return !!release.apkUrl && isReleaseLink(release.apkUrl) && !!release.apkSha256 && /^[a-f0-9]{64}$/.test(release.apkSha256)
    && Number.isSafeInteger(release.apkSize) && release.apkSize! > 0 && release.apkSize! <= 512 * 1024 * 1024;
}

/** Owns only this explicit update attempt. A launched installer is not a completed installation. */
export function createApkUpdater(adapter: ApkUpdateAdapter, changed: (state: ApkUpdateState) => void) {
  let generation = 0, controller: AbortController | null = null;
  let file: { uri: string; release: AppRelease } | null = null;
  let phase: ApkUpdateState["phase"] = "idle";
  let working = false;
  const publish = (state: ApkUpdateState) => { phase = state.phase; changed(state); };
  const remove = async (uri: string) => { try { await adapter.remove(uri); } catch { /* Private cache can be reclaimed later. */ } };

  async function install() {
    if (working || !file || phase === "verifying" || phase === "handed-off") return;
    working = true;
    const attempt = generation, selected = file;
    try {
      const allowed = await adapter.canInstall();
      if (generation !== attempt) return;
      if (!allowed) { publish({ phase: "permission" }); return; }
      publish({ phase: "verifying" });
      await adapter.install(selected.uri, selected.release);
      if (generation !== attempt) return;
      file = null;
      publish({ phase: "handed-off" });
      // Native code hands its own verified private copy to the system installer.
      await remove(selected.uri);
    } catch (error) {
      if (generation === attempt) {
        file = null;
        await remove(selected.uri);
        publish({ phase: "error", message: error instanceof Error ? error.message : "安装未开始，请重新下载后重试。" });
      }
    } finally { working = false; }
  }

  return {
    async start(release: AppRelease) {
      if (working || controller || phase === "verifying") return;
      if (!hasVerifiedApkMetadata(release)) {
        publish({ phase: "error", message: "此安装包缺少完整校验信息，请重新检查更新，或查看 GitHub 发布页。" });
        return;
      }
      const attempt = ++generation;
      const task = new AbortController(); controller = task;
      if (file) { const old = file; file = null; await remove(old.uri); }
      if (generation !== attempt) { if (controller === task) controller = null; return; }
      publish({ phase: "downloading", written: 0, total: release.apkSize! });
      try {
        const uri = await adapter.download(release, task.signal, (written, total) => {
          if (generation === attempt && !task.signal.aborted) publish({ phase: "downloading", written, total });
        });
        if (generation !== attempt || task.signal.aborted) { await remove(uri); return; }
        file = { uri, release };
        controller = null;
        await install();
      } catch (error) {
        if (generation === attempt && !task.signal.aborted)
          publish({ phase: "error", message: error instanceof Error ? error.message : "下载未完成，请检查网络后重试。" });
      } finally { if (controller === task) controller = null; }
    },
    install,
    async openSettings() {
      if (phase !== "permission" || working) return;
      const attempt = generation;
      try { await adapter.openSettings(); }
      catch { if (generation === attempt) publish({ phase: "error", message: "未能打开安装权限设置，请重试。" }); }
    },
    async cancel() {
      // Once verification/handoff starts, Android owns the installation confirmation.
      if (phase === "verifying") return false;
      generation++; controller?.abort(); controller = null;
      const previous = file; file = null;
      publish({ phase: "cancelled" });
      if (previous) await remove(previous.uri);
      return true;
    },
  };
}
