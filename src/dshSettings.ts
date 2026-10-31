import { request, type Connection } from "./api";
import { readCache, writeCache, cacheRevision } from "./localCache";

export type DshSetting = { value: string; options: string[]; revision: string };
export type DshChatSettings = { writable: boolean; permission: DshSetting | null; busy: DshSetting | null };
export type DshSettingKey = "permission" | "busy";
type Snapshot = { settings: DshChatSettings; checkedAt: number };
export type DshSettingsState = { snapshot: Snapshot | null; loading: boolean; saving: DshSettingKey | null; error: string; cacheWarning: string };
export const settingsCacheKey = "dsh:chat-settings:v1";
export const settingsMaxAge = 60_000;

export function validDshChatSettings(value: unknown): value is DshChatSettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as DshChatSettings;
  return typeof settings.writable === "boolean" && [settings.permission, settings.busy].every(item => item === null ||
    !!item && typeof item.value === "string" && typeof item.revision === "string" &&
    Array.isArray(item.options) && item.options.every(option => typeof option === "string"));
}

/** One connection-scoped read cache. Only acknowledged cloud writes enter it. */
export function createDshSettingsStore(connection: Connection) {
  let state: DshSettingsState = { snapshot: null, loading: false, saving: null, error: "", cacheWarning: "" };
  let hydrated = false, generation = 0, reading: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<DshSettingsState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  const persist = async (snapshot: Snapshot, version: number, revision: number) => {
    try {
      await writeCache(connection, settingsCacheKey, snapshot, revision);
      if (version === generation) publish({ cacheWarning: "" });
    } catch {
      if (version === generation) publish({ cacheWarning: "云端配置已读取，本机缓存未保存；下次打开将重新同步。" });
    }
  };
  const fresh = () => {
    const age = Date.now() - (state.snapshot?.checkedAt ?? 0);
    return !!state.snapshot && age >= 0 && age < settingsMaxAge;
  };
  async function refresh(force = false): Promise<void> {
    if (reading) return reading;
    if (state.saving || (hydrated && !force && fresh())) return;
    const version = generation, revision = cacheRevision();
    reading = (async () => {
      publish({ loading: true });
      try {
        if (!hydrated) {
          const cached = await readCache<Snapshot>(connection, settingsCacheKey);
          hydrated = true;
          if (version === generation && cached && validDshChatSettings(cached.settings) && Number.isFinite(cached.checkedAt)) publish({ snapshot: cached });
        }
        if (version !== generation || (!force && fresh())) return;
        const settings = await request<DshChatSettings>(connection, "/settings/chat");
        if (!validDshChatSettings(settings)) throw new Error("服务返回的配置无效，请更新服务后重试。");
        if (version !== generation) return;
        const snapshot = { settings, checkedAt: Date.now() };
        publish({ snapshot, error: "" });
        await persist(snapshot, version, revision);
      } catch (error) {
        if (version === generation) publish({ error: error instanceof Error ? error.message : "未能同步云端配置，请重试。" });
      } finally {
        publish({ loading: false }); reading = undefined;
      }
    })();
    return reading;
  }
  async function select(key: DshSettingKey, value: string) {
    const settings = state.snapshot?.settings, item = settings?.[key];
    if (state.saving || !settings?.writable || !item || value === item.value || !item.options.includes(value)) return;
    const version = ++generation, revision = cacheRevision();
    publish({ saving: key, error: "" });
    try {
      const updated = await request<DshChatSettings>(connection, "/settings/chat", {
        method: "PUT", body: { key, value, revision: item.revision },
      });
      if (!validDshChatSettings(updated) || updated[key]?.value !== value) throw new Error("设置尚未确认，请刷新后重试。");
      const snapshot = { settings: updated, checkedAt: Date.now() };
      publish({ snapshot, error: "" });
      await persist(snapshot, version, revision);
    } catch (error) {
      publish({ error: error instanceof Error ? error.message : "未能保存云端配置，请重试。" });
    } finally { publish({ saving: null }); }
  }
  return { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, refresh, select };
}

export type DshSettingsStore = ReturnType<typeof createDshSettingsStore>;
