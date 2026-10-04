import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useRef, useState } from "react";
import { emptyHomePreferences, parseHomePreferences, recordHomeOpen, toggleHomePin, type HomePreferences, type HomeTarget } from "./homeEntries";

export function useHomePreferences(url: string) {
  const [preferences, setPreferences] = useState<HomePreferences>(emptyHomePreferences);
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const current = useRef(preferences);
  const saves = useRef(Promise.resolve());
  const key = `zhixing.home.v1:${encodeURIComponent(url)}`;
  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(key).then((value) => {
      if (!active) return;
      current.current = parseHomePreferences(value);
      setPreferences(current.current);
      setReady(true); setError("");
    }).catch(() => { if (active) setError("首页偏好读取失败，重试后可继续整理常用。"); });
    return () => { active = false; };
  }, [key, revision]);
  function update(next: HomePreferences) {
    if (!ready) return;
    current.current = next;
    setPreferences(next);
    saves.current = saves.current.catch(() => undefined).then(() => AsyncStorage.setItem(key, JSON.stringify(next)))
      .then(() => setError(""), () => setError("首页偏好尚未保存，再次调整即可重试。"));
  }
  return { preferences, ready, error, retry: () => setRevision((old) => old + 1),
    toggle: (target: HomeTarget) => update(toggleHomePin(current.current, target)),
    opened: (target: HomeTarget) => update(recordHomeOpen(current.current, target, new Date().toISOString())),
  };
}
