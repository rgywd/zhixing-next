import { useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import type { Connection } from "./api";
import { createDshSettingsStore, type DshSettingsStore, type DshSettingsState } from "./dshSettings";

export type DshSettingsController = DshSettingsState & Pick<DshSettingsStore, "refresh" | "select">;

export function useDshSettings(connection: Connection, settingsOpen = false): DshSettingsController {
  const store = useMemo(() => createDshSettingsStore(connection), [connection]);
  const [observed, setObserved] = useState({ store, state: store.getSnapshot() });
  useEffect(() => {
    const unsubscribe = store.subscribe(() => setObserved({ store, state: store.getSnapshot() }));
    void store.refresh();
    const foreground = AppState.addEventListener("change", status => { if (status === "active") void store.refresh(); });
    return () => { unsubscribe(); foreground.remove(); };
  }, [store]);
  useEffect(() => { if (settingsOpen) void store.refresh(); }, [store, settingsOpen]);
  return { ...(observed.store === store ? observed.state : store.getSnapshot()), refresh: store.refresh, select: store.select };
}
