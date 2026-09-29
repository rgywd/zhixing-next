import type { ThemeColors } from "./theme";
import { useTheme, useThemedStyles } from "./ThemeProvider";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { ApiError } from "./api";
import { failedSync, syncNotice, type SyncFailure } from "./syncHealth";
import { space, typography } from "./theme";

type Reporter = { report: (id: string, error?: unknown) => void; register: (id: string, retry: () => void) => () => void };
const Context = createContext<Reporter | null>(null);

export function ConnectionStatusProvider({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [failures, setFailures] = useState<Record<string, SyncFailure>>({});
  const [now, setNow] = useState(() => Date.now());
  const retries = useRef(new Map<string, () => void>());
  const report = useCallback((id: string, error?: unknown) => {
    setFailures((old) => {
      if (error) return { ...old, [id]: failedSync(old[id], error instanceof ApiError ? error.status : undefined, Date.now()) };
      if (!old[id]) return old;
      const next = { ...old }; delete next[id]; return next;
    });
    setNow(Date.now());
  }, []);
  const register = useCallback((id: string, retry: () => void) => {
    retries.current.set(id, retry);
    return () => { retries.current.delete(id); report(id); };
  }, [report]);
  const hasFailures = Object.keys(failures).length > 0;
  useEffect(() => {
    if (!hasFailures) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasFailures]);
  const value = useMemo(() => ({ report, register }), [report, register]);
  const message = syncNotice(Object.values(failures), now);
  return <Context.Provider value={value}>
    {message ? <View style={styles.notice} accessibilityLiveRegion="polite">
      <Ionicons name="cloud-offline-outline" size={17} color={colors.muted} />
      <Text style={styles.message}>{message}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="重新连接" onPress={() => retries.current.forEach((retry) => retry())} style={styles.retry}>
        <Ionicons name="refresh-outline" size={18} color={colors.ink} />
      </Pressable>
    </View> : null}
    {children}
  </Context.Provider>;
}

/** Only background reads report here. User actions keep their own immediate error/retry UI. */
export function useSyncStatus(retry?: () => void) {
  const context = useContext(Context);
  const id = useId();
  const retryRef = useRef(retry);
  useEffect(() => { retryRef.current = retry; }, [retry]);
  useEffect(() => context?.register(id, () => retryRef.current?.()), [context, id]);
  return useCallback((error?: unknown) => context?.report(id, error), [context, id]);
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  notice: { flexDirection: "row", alignItems: "center", gap: space.sm, marginHorizontal: space.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  message: { flex: 1, ...typography.caption, color: colors.muted },
  retry: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
});
