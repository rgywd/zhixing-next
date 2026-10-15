import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type ChatDefaultIntent = "queue" | "steer";
export const chatPreferenceKey = "zhixing.chat.default-intent.v1";
export function parseChatDefaultIntent(value: string | null): ChatDefaultIntent {
  if (value === null || value === "queue") return "queue";
  if (value === "steer") return value;
  throw new Error("对话偏好暂时无法读取，请重试。");
}

type Preferences = {
  defaultIntent: ChatDefaultIntent;
  ready: boolean;
  saving: boolean;
  error: string;
  setDefaultIntent: (value: ChatDefaultIntent) => Promise<void>;
  retry: () => void;
};
const Context = createContext<Preferences | null>(null);

export function ChatPreferencesProvider({ children }: { children: ReactNode }) {
  const [defaultIntent, setValue] = useState<ChatDefaultIntent>("queue");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const alive = useRef(true);
  const writing = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(chatPreferenceKey).then((stored) => {
      const value = parseChatDefaultIntent(stored);
      if (active) { setValue(value); setError(""); setReady(true); }
    }).catch(() => { if (active) setError("未能读取对话偏好，请重试。原设置未被覆盖。"); });
    return () => { active = false; };
  }, [revision]);
  const setDefaultIntent = useCallback(async (value: ChatDefaultIntent) => {
    if (!ready || writing.current || value === defaultIntent) return;
    writing.current = true;
    setSaving(true);
    try {
      await AsyncStorage.setItem(chatPreferenceKey, value);
      if (alive.current) { setValue(value); setError(""); }
    } catch (cause) {
      if (alive.current) setError("未能保存对话偏好，仍使用原来的发送方式。");
      throw cause;
    } finally {
      writing.current = false;
      if (alive.current) setSaving(false);
    }
  }, [defaultIntent, ready]);
  const retry = useCallback(() => {
    if (!writing.current) { setReady(false); setError(""); setRevision((value) => value + 1); }
  }, []);
  return <Context.Provider value={{ defaultIntent, ready, saving, error, setDefaultIntent, retry }}>{children}</Context.Provider>;
}

export function useChatPreferences(): Preferences {
  const context = useContext(Context);
  if (!context) throw new Error("ChatPreferencesProvider is missing");
  return context;
}
