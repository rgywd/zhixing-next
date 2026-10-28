import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type Connection } from "./api";
import { mutateService, type FinanceCommitment, type ServiceMutation } from "./serviceApi";
import { cacheRevision, readCache, serviceCacheKey, writeCache } from "./localCache";

export const localDate = (value = new Date()) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
export const localTime = (value = new Date()) => `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
export function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && localDate(date) === value;
}
export function requireDate(value: string, label = "日期") {
  if (!validDate(value)) throw new Error(`${label}请使用有效的 YYYY-MM-DD。`);
  return value;
}
export function requireTime(value: string) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("时间请使用 24 小时制 HH:mm。");
  return value;
}
export const localTimestamp = (date: string, time: string) => {
  const instant = new Date(`${requireDate(date)}T${requireTime(time)}:00`);
  const offset = -instant.getTimezoneOffset();
  const zone = `${offset >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  return `${date}T${time}:00${zone}`;
};
export function moneyInput(value: string, label: string, optional = false) {
  const clean = value.trim();
  if (optional && !clean) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(clean) || !Number.isFinite(Number(clean)) || Number(clean) > 999999999999) throw new Error(`${label}请输入最多两位小数的非负金额。`);
  return clean;
}
export const textLines = (value: string) => value.split(/[\n；;]/).map((item) => item.trim()).filter(Boolean);
export function positiveNumber(value: string, label: string, integer = false) {
  const number = Number(value.trim());
  if (!value.trim() || !Number.isFinite(number) || number <= 0 || (integer && !Number.isInteger(number))) throw new Error(`${label}请输入有效的${integer ? "正整数" : "正数"}。`);
  return number;
}
export function parseCommitments(value: string, previous: FinanceCommitment[]) {
  const entries = textLines(value).map((line) => {
    const [label, amount, kind] = line.split(/[|｜]/).map((part) => part.trim());
    if (!label || !amount || !["固定", "大件"].includes(kind)) throw new Error("固定支出和大件请每行填写：名称 | 金额 | 固定或大件。");
    return { label, amount: moneyInput(amount, label)!, kind: kind === "固定" ? "fixed" as const : "one_time" as const };
  });
  const matches = entries.map((item) => previous.find((old) => old.label === item.label && old.kind === item.kind)?.key);
  const reserved = new Set(matches.filter(Boolean));
  const used = new Set<string>();
  return entries.map((item, index) => {
    const oldKey = previous[index]?.key;
    const candidate = matches[index] ?? (oldKey && !reserved.has(oldKey) ? oldKey : undefined);
    const key = candidate && !used.has(candidate) ? candidate : randomUUID();
    used.add(key);
    const old = previous.find((entry) => entry.key === key);
    const metadata: Partial<FinanceCommitment> = old ? { ...old } : {};
    // A changed payment amount must recalculate the monthly cost; preserve its cycle.
    if (old && Number(old.amount) !== Number(item.amount)) delete metadata.monthly_cost;
    return { ...metadata, key, ...item };
  });
}
export function parseReminderSlots(value: string, previous: { id: string; time: string; meal_type: string; kind: string }[]) {
  const mealTypes = { 早餐: "breakfast", 午餐: "lunch", 晚餐: "dinner", 加餐: "snack", 其他: "other", 回顾: "other" } as const;
  return textLines(value).map((line) => {
    const [time, label] = line.trim().split(/\s+/);
    requireTime(time);
    if (!(label in mealTypes)) throw new Error("每行填写时间和餐次，例如：12:00 午餐；餐次可选早餐、午餐、晚餐、加餐、其他、回顾。");
    const kind = label === "回顾" ? "review" as const : "meal" as const;
    const meal_type = mealTypes[label as keyof typeof mealTypes];
    return { id: previous.find((slot) => slot.time === time && slot.meal_type === meal_type && slot.kind === kind)?.id ?? randomUUID(), time, meal_type, kind };
  });
}
export const mealLabels = { breakfast: "早餐", lunch: "午餐", dinner: "晚餐", snack: "加餐", other: "其他" } as const;
export const moneyLabel = (value: string | number | null | undefined) => value == null ? "待补充" : `¥${Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export type ServiceDraft = { kind: string; id: string; fields: Record<string, string>; context: Record<string, unknown>; pending: ServiceMutation | null; initialFields?: Record<string, string>; recoveryNoticeSeen?: boolean };
const unchangedDraft = (draft: ServiceDraft) => !draft.pending && draft.initialFields &&
  Object.keys(draft.fields).length === Object.keys(draft.initialFields).length &&
  Object.entries(draft.fields).every(([name, value]) => draft.initialFields![name] === value);
let saving = Promise.resolve();
const persist = (key: string, value: unknown) => {
  const next = saving.catch(() => undefined).then(() => AsyncStorage.setItem(key, JSON.stringify(value)));
  saving = next;
  return next;
};
/** Keep the exact request until its receipt is known; a retry after timeout must not create another record. */
export function useServiceEditor(connection: Connection, service: string, onSaved: (saved: ServiceDraft) => void, onRecovery?: (resume: () => void) => void) {
  const key = `zhixing.service-draft.v1:${encodeURIComponent(connection.url)}:${service}`;
  const [draft, setDraft] = useState<ServiceDraft | null>(null);
  const current = useRef<ServiceDraft | null>(null);
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [readAttempt, setReadAttempt] = useState(0);
  const recoveryCallback = useRef(onRecovery);
  useEffect(() => { recoveryCallback.current = onRecovery; }, [onRecovery]);
  const update = useCallback((next: ServiceDraft | null) => {
    current.current = next; setDraft(next);
    void persist(key, next).then(() => setStorageError("")).catch(() => setStorageError("本机草稿尚未保存，请保持页面打开；提交前会再次尝试保存。"));
  }, [key]);
  const offerRecovery = useCallback((source: ServiceDraft) => {
    if (source.recoveryNoticeSeen || !recoveryCallback.current) return;
    update({ ...source, recoveryNoticeSeen: true });
    recoveryCallback.current(() => { if (current.current?.id === source.id && !busyRef.current) setVisible(true); });
  }, [update]);
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => { if (active) setReady(false); return AsyncStorage.getItem(key); }).then((value) => {
      if (!active) return;
      const parsed: ServiceDraft | null = value ? JSON.parse(value) : null;
      if (parsed && (typeof parsed.kind !== "string" || typeof parsed.id !== "string" || !parsed.fields || !parsed.context)) throw new Error("invalid draft");
      const restored = parsed && !unchangedDraft(parsed) ? parsed : null;
      current.current = restored; setDraft(restored); setVisible(false); setReady(true); setStorageError("");
      if (parsed && !restored) update(null);
      if (restored) offerRecovery(restored);
    }).catch(() => { if (active) { setReady(false); setStorageError("本机草稿尚未读取，请重试后继续；原草稿不会被覆盖。"); } });
    return () => { active = false; };
  }, [key, readAttempt, update, offerRecovery]);
  const submit = async (build: (draft: ServiceDraft) => ServiceMutation, beforeSubmit?: (draft: ServiceDraft) => Promise<void>) => {
    if (busyRef.current || !ready || !current.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const source = current.current;
      if (!source.pending) await beforeSubmit?.(source);
      const pending = source.pending ?? build(source);
      const next = { ...source, pending };
      current.current = next; setDraft(next);
      await persist(key, next);
      await mutateService(connection, pending);
      await persist(key, null);
      current.current = null; setDraft(null); setVisible(false); setStorageError("");
      onSaved(next);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500 && current.current) {
        update({ ...current.current, pending: null });
      }
      setError(reason instanceof Error ? reason.message : "尚未保存，请重试。");
    } finally { busyRef.current = false; setBusy(false); }
  };
  return { draft, ready, visible, busy, error, storageError, retryRead() { if (!busyRef.current && !ready) setReadAttempt((attempt) => attempt + 1); }, locked: busy || Boolean(draft?.pending),
    open(kind: string, fields: Record<string, string>, context: Record<string, unknown> = {}) {
      if (!ready || busyRef.current) return;
      if (current.current) { setVisible(true); return; }
      update({ kind, id: randomUUID(), fields: { ...fields }, initialFields: { ...fields }, context, pending: null }); setError(""); setVisible(true);
    },
    set(name: string, value: string) { if (current.current && !busyRef.current && !current.current.pending) update({ ...current.current, fields: { ...current.current.fields, [name]: value } }); },
    close() {
      if (!ready || busyRef.current) return;
      setVisible(false);
      const source = current.current;
      if (source && unchangedDraft(source)) { update(null); setError(""); }
      else if (source) offerRecovery(source);
    },
    resume() { if (ready && current.current && !busyRef.current) setVisible(true); },
    discard() { if (!busyRef.current && !current.current?.pending) { update(null); setVisible(false); setError(""); } }, submit,
  };
}

/** Cache the last server result so a connection failure never looks like a fresh, empty ledger. */
export function useServiceSnapshot<T>(connection: Connection, scope: string, read: () => Promise<T>, refreshKey?: number) {
  const key = serviceCacheKey(scope);
  const identity = `${connection.url}\n${connection.token}\n${key}`;
  const [stored, setStored] = useState<{ identity: string; data: T | null }>({ identity, data: null });
  const data = stored.identity === identity ? stored.data : null;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const own = ++generation.current;
    const version = cacheRevision();
    setLoading(true);
    try {
      const result = await read();
      if (own !== generation.current) return;
      setStored({ identity, data: result }); setError("");
      void writeCache(connection, key, result, version).catch(() => undefined);
    } catch (reason) {
      if (own === generation.current) setError(reason instanceof Error ? reason.message : "摘要暂时无法更新。");
    } finally { if (own === generation.current) setLoading(false); }
  }, [connection, identity, key, read]);
  useEffect(() => {
    let active = true;
    const versions = generation;
    const own = ++versions.current;
    Promise.resolve().then(() => {
      if (active && own === versions.current) {
        setLoading(true); setError("");
      }
      return readCache<T>(connection, key);
    }).then((cached) => {
      if (active && own === generation.current && cached) { setStored({ identity, data: cached }); setLoading(false); }
    }).catch(() => undefined).finally(() => { if (active && own === generation.current) void reload(); });
    return () => { active = false; versions.current++; };
  }, [connection, identity, key, reload, refreshKey]);
  return { data, loading, error, reload };
}
