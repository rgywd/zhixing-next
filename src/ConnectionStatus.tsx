import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError } from "./api";
import { failedSync, syncNotice, type SyncFailure } from "./syncHealth";
import { useNotice } from "./Notice";

type Reporter = { report: (id: string, error?: unknown) => void; register: (id: string, retry: () => void) => () => void };
const Context = createContext<Reporter | null>(null);

export function ConnectionStatusProvider({ children }: { children: ReactNode }) {
  const { show, dismiss } = useNotice();
  const noticeId = useId();
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
  useEffect(() => {
    if (message) show({ id: noticeId, message, icon: "cloud-offline-outline", tone: "warning", duration: null,
      action: { label: "重新连接", icon: "refresh-outline", onPress: () => retries.current.forEach((retry) => retry()) } });
    else dismiss(noticeId);
    return () => dismiss(noticeId);
  }, [message, noticeId, show, dismiss]);
  return <Context.Provider value={value}>
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
