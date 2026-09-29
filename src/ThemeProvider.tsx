import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Appearance, useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SystemUI from "expo-system-ui";
import { darkColors, lightColors, parseThemePreference, resolveThemeMode, themePreferenceKey, type ThemeColors, type ThemeMode, type ThemePreference } from "./theme";

type Theme = {
  colors: ThemeColors;
  mode: ThemeMode;
  preference: ThemePreference;
  setPreference: (value: ThemePreference) => void;
  ready: boolean;
  error: string;
};
const Context = createContext<Theme | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [preference, setValue] = useState<ThemePreference>("system");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const writes = useRef(Promise.resolve());
  useEffect(() => {
    let active = true;
    const initialRevision = revision.current;
    void AsyncStorage.getItem(themePreferenceKey).then((stored) => {
      if (active && revision.current === initialRevision) setValue(parseThemePreference(stored));
    }).catch(() => {
      if (active) setError("未能读取外观偏好，暂时跟随系统。");
    }).finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, []);
  const setPreference = useCallback((value: ThemePreference) => {
    const currentRevision = ++revision.current;
    setValue(value);
    setError("");
    // Serialize rapid selections; an older write must never win after restart.
    writes.current = writes.current.catch(() => {}).then(() => AsyncStorage.setItem(themePreferenceKey, value)).catch(() => {
      if (revision.current === currentRevision) setError("外观已切换，但未能保存，下次打开可能恢复默认。");
    });
  }, []);
  useEffect(() => {
    if (ready) Appearance.setColorScheme(preference === "system" ? "unspecified" : preference);
  }, [preference, ready]);
  const mode = resolveThemeMode(preference, system);
  const colors = mode === "dark" ? darkColors : lightColors;
  useEffect(() => { void SystemUI.setBackgroundColorAsync(colors.paper).catch(() => {}); }, [colors]);
  const value = useMemo(() => ({ colors, mode, preference, setPreference, ready, error }), [colors, mode, preference, setPreference, ready, error]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useTheme() {
  const theme = useContext(Context);
  if (!theme) throw new Error("ThemeProvider is missing");
  return theme;
}

export function useThemedStyles<T>(createStyles: (colors: ThemeColors) => T): T {
  const { colors } = useTheme();
  return useMemo(() => createStyles(colors), [createStyles, colors]);
}
