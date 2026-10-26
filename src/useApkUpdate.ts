import { useEffect, useRef, useState } from "react";
import { createApkUpdater, type ApkUpdateState } from "./apkUpdate";
import { apkUpdateAdapter } from "./apkUpdateNative";
import type { AppRelease } from "./appUpdates";

export function useApkUpdate() {
  const [state, setState] = useState<ApkUpdateState>({ phase: "idle" });
  const updater = useRef<ReturnType<typeof createApkUpdater> | null>(null);
  useEffect(() => {
    let active = true;
    const own = createApkUpdater(apkUpdateAdapter, (value) => { if (active) setState(value); });
    updater.current = own;
    return () => { active = false; void own.cancel(); };
  }, []);
  return { state,
    start: (release: AppRelease) => updater.current?.start(release),
    install: () => updater.current?.install(),
    openSettings: () => updater.current?.openSettings(),
    cancel: () => updater.current?.cancel(),
  };
}
