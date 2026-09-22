import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import type { Connection, Draft, PlanDraft } from "./api";
export type { Draft } from "./api";

const CONNECTION_KEY = "zhixing.connection.v1";
export const readConnection = async (): Promise<Connection | null> => {
  const value = await SecureStore.getItemAsync(CONNECTION_KEY);
  if (!value) return null;
  const parsed = JSON.parse(value);
  if (typeof parsed.url !== "string" || typeof parsed.token !== "string")
    throw new Error("连接配置损坏，请重新连接。");
  return parsed;
};
export const saveConnection = (connection: Connection) =>
  SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify(connection));
export const removeConnection = () =>
  SecureStore.deleteItemAsync(CONNECTION_KEY);

export const draftKey = (url: string, conversation: string) =>
  `zhixing.draft.v1:${encodeURIComponent(url)}:${conversation}`;
export const readDraft = async (key: string): Promise<Draft> => {
  const value = await AsyncStorage.getItem(key);
  if (!value) return { text: "", pending: null };
  const parsed = JSON.parse(value);
  if (typeof parsed.text !== "string") throw new Error("草稿读取失败。");
  return parsed;
};
// Serialize autosaves so an older keystroke can never overwrite a persisted send receipt.
let saving = Promise.resolve();
export function saveDraft(key: string, draft: Draft): Promise<void> {
  return saveValue(key, draft);
}
export const clearDraft = (key: string, id: string) =>
  saveValue(key, { text: "", pending: null }, id);
const planKey = (url: string) =>
  `zhixing.plan-draft.v1:${encodeURIComponent(url)}`;
export async function readPlanDraft(url: string): Promise<PlanDraft | null> {
  const value = await AsyncStorage.getItem(planKey(url));
  return value ? JSON.parse(value) : null;
}
export const savePlanDraft = (url: string, draft: PlanDraft) =>
  saveValue(planKey(url), draft);
export const clearPlanDraft = (url: string, id: string, empty: PlanDraft) =>
  saveValue(planKey(url), empty, id);
function saveValue(
  key: string,
  value: Draft | PlanDraft,
  expectedId?: string,
): Promise<void> {
  const next = saving
    .catch(() => undefined)
    .then(async () => {
      if (expectedId) {
        const current = await AsyncStorage.getItem(key);
        if (!current || JSON.parse(current).pending?.id !== expectedId) return;
      }
      await AsyncStorage.setItem(key, JSON.stringify(value));
    });
  saving = next;
  return next;
}
