import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useRef, useState } from "react";
import type { ReasoningEffort } from "./api";

type Kind = "chat" | "task";
export type WelcomeDraft = {
  text: string;
  kind: Kind;
  models: Record<Kind, string | null>;
  efforts: Record<Kind, ReasoningEffort | null>;
  searchId: string | null;
};
const empty = (): WelcomeDraft => ({ text: "", kind: "chat", models: { chat: null, task: null }, efforts: { chat: null, task: null }, searchId: null });
const choices = new Set(["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export function parseWelcomeDraft(value: string | null): WelcomeDraft {
  if (!value) return empty();
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed.text !== "string") throw new Error("草稿读取失败。");
  const id = (value: unknown) => typeof value === "string" && value ? value : null;
  const effort = (value: unknown) => typeof value === "string" && choices.has(value) ? value as ReasoningEffort : null;
  return { text: parsed.text, kind: parsed.kind === "task" ? "task" : "chat",
    models: { chat: id(parsed.models?.chat), task: id(parsed.models?.task) },
    efforts: { chat: effort(parsed.efforts?.chat), task: effort(parsed.efforts?.task) }, searchId: id(parsed.searchId) };
}

export function useWelcomeDraft(url: string) {
  const [value, setValue] = useState<WelcomeDraft>(empty);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const current = useRef(value);
  const readable = useRef(false);
  const alive = useRef(false);
  const queued = useRef<((old: WelcomeDraft) => WelcomeDraft)[]>([]);
  const writes = useRef(Promise.resolve());
  const key = `zhixing.welcome-draft.v1:${encodeURIComponent(url)}`;
  const activeKey = useRef(key);
  const writeVersion = useRef(0);

  function persist(next: WelcomeDraft) {
    const version = ++writeVersion.current;
    const write = writes.current.catch(() => undefined).then(() => AsyncStorage.setItem(key, JSON.stringify(next)));
    writes.current = write;
    void write.then(() => { if (alive.current && activeKey.current === key && version === writeVersion.current) setError(""); },
        () => { if (alive.current && activeKey.current === key && version === writeVersion.current) setError("草稿尚未保存，请重试保存后再离开。"); });
    return write;
  }
  useEffect(() => {
    let active = true;
    alive.current = true;
    if (activeKey.current !== key) {
      activeKey.current = key; queued.current = []; current.current = empty();
      setValue(current.current);
    }
    readable.current = false; setReady(false); setError("");
    AsyncStorage.getItem(key).then((stored) => {
      if (!active) return;
      const saved = parseWelcomeDraft(stored);
      const pending = queued.current.splice(0);
      current.current = pending.reduce((old, change) => change(old), saved);
      setValue(current.current); readable.current = true; setReady(true);
      if (pending.length) persist(current.current);
    }).catch(() => { if (active) setError("草稿暂时无法读取，重试后可继续输入。"); });
    return () => { active = false; alive.current = false; };
    // The storage key and explicit retry own this read; edits must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, revision]);
  function update(change: (old: WelcomeDraft) => WelcomeDraft) {
    if (activeKey.current !== key) return;
    if (!readable.current) { queued.current.push(change); return; }
    current.current = change(current.current);
    setValue(current.current); persist(current.current);
  }
  async function consumeText(expected: string) {
    const source = current.current;
    if (!readable.current) throw new Error("草稿尚未读取，请先重试读取。");
    if (source.text.trim() !== expected.trim()) return;
    const next = { ...source, text: "" };
    // The caller must await this durable handoff before sending the first message.
    await persist(next);
    if (alive.current && current.current === source) { current.current = next; setValue(next); }
  }
  return { value, ready, error, consumeText,
    retry: () => { if (readable.current) persist(current.current); else setRevision((old) => old + 1); },
    setText: (text: string | ((old: string) => string)) => update((old) => ({ ...old, text: typeof text === "function" ? text(old.text) : text })),
    setKind: (kind: Kind) => update((old) => ({ ...old, kind })),
    setModel: (kind: Kind, id: string | null) => update((old) => ({ ...old, models: { ...old.models, [kind]: id } })),
    setEffort: (kind: Kind, effort: ReasoningEffort | null) => update((old) => ({ ...old, efforts: { ...old.efforts, [kind]: effort } })),
    setSearch: (searchId: string | null) => update((old) => ({ ...old, searchId })),
  };
}
