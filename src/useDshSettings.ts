import { useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import type { Connection } from "./api";
import { createDshSettingsStore, settingsMaxAge, type DshSettingsStore, type DshSettingsState } from "./dshSettings";

export type DshSettingsController = DshSettingsState & Pick<DshSettingsStore, "refresh" | "select">;

export function useDshSettings(connection: Connection): DshSettingsController {
  const store = useMemo(() => createDshSettingsStore(connection), [connection]);
  const [observed, setObserved] = useState({ store, state: store.getSnapshot() });
  useEffect(() => {
    const unsubscribe = store.subscribe(() => setObserved({ store, state: store.getSnapshot() }));
    void store.refresh();
    const foreground = AppState.addEventListener("change", status => { if (status === "active") void store.refresh(); });
    const timer = setInterval(() => { if (AppState.currentState === "active") void store.refresh(); }, settingsMaxAge);
    return () => { unsubscribe(); foreground.remove(); clearInterval(timer); };
  }, [store]);
  return { ...(observed.store === store ? observed.state : store.getSnapshot()), refresh: store.refresh, select: store.select };
}
