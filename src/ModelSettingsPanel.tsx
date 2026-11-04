import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Text } from "react-native";
import { request, type Connection, type ModelCatalog } from "./api";
import { ModelPicker } from "./ModelPicker";
import { ActionLink, ActionRow, humanError, PageHeading, PageScrollView, SettingsGroup, useUi } from "./ui";

type Target = "default" | "telegram";
type Selection = { model_id: string | null; effective_model_id: string; writable: boolean; revision: string };
type ModelSettings = Record<Target, Selection | null>;

export function ModelSettingsPanel({ connection, onChanged }: { connection: Connection; onChanged: () => void }) {
  // Remount on either connection field changing; an old response cannot enter another server's page.
  return <ConnectedModelSettings key={JSON.stringify(connection)} connection={connection} onChanged={onChanged} />;
}

function ConnectedModelSettings({ connection, onChanged }: { connection: Connection; onChanged: () => void }) {
  const { s } = useUi();
  const [snapshot, setSnapshot] = useState<{ settings: ModelSettings; catalog: ModelCatalog } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  const active = useRef(false), sequence = useRef(0), writing = useRef(false);
  const refresh = useCallback(() => {
    const version = ++sequence.current;
    return Promise.all([
      request<ModelSettings>(connection, "/settings/models"), request<ModelCatalog>(connection, "/models"),
    ]).then(([settings, catalog]) => {
      if (active.current && version === sequence.current) { setSnapshot({ settings, catalog }); setError(""); }
    }, e => {
      if (active.current && version === sequence.current) setError(humanError(e));
    }).finally(() => { if (active.current && version === sequence.current) setLoading(false); });
  }, [connection]);
  useEffect(() => {
    active.current = true;
    void refresh();
    const listener = AppState.addEventListener("change", state => { if (state === "active" && !writing.current) { setLoading(true); void refresh(); } });
    return () => { active.current = false; listener.remove(); };
  }, [refresh]);
  async function choose(modelId: string | null) {
    if (!target || !snapshot?.settings[target] || writing.current) return;
    writing.current = true; setSaving(true); ++sequence.current;
    try {
      const settings = await request<ModelSettings>(connection, "/settings/models", { method: "PUT",
        body: { key: target, model_id: modelId, revision: snapshot.settings[target].revision } });
      if (active.current) { setSnapshot({ ...snapshot, settings }); setError(""); onChanged(); }
    } catch (e) {
      // A stale revision or uncertain network response must be read back before another attempt.
      if (active.current) { setLoading(true); await refresh(); }
      throw e;
    } finally { writing.current = false; if (active.current) setSaving(false); }
  }
  const label = (id?: string | null) => snapshot?.catalog.items.find(m => m.id === id)?.name ?? (id ? "云端模型未在列表中" : "尚未配置");
  const defaults = snapshot?.settings.default, telegram = snapshot?.settings.telegram;
  return <PageScrollView>
    <PageHeading title="模型控制" description="选择云端已经配置好的模型。" />
    {loading ? <Text style={s.muted}>正在读取云端模型…</Text> : null}
    {saving ? <Text style={s.muted}>正在保存到云端…</Text> : null}
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    <SettingsGroup title="知行">
      <ActionRow icon="sparkles-outline" title="默认模型" description={label(defaults?.effective_model_id)} compact last
        disabled={loading || saving || !defaults?.writable} onPress={() => setTarget("default")} />
    </SettingsGroup>
    <Text style={s.muted}>用于新建对话。已有对话可以在聊天页单独选择模型。</Text>
    <SettingsGroup title="Telegram 机器人">
      <ActionRow icon="paper-plane-outline" title="后台模型" compact last
        description={telegram ? `${telegram.model_id === null ? "跟随知行默认 · " : ""}${label(telegram.effective_model_id)}` : "当前服务未配置 Telegram"}
        disabled={loading || saving || !telegram?.writable} onPress={() => setTarget("telegram")} />
    </SettingsGroup>
    <Text style={s.muted}>切换后用于接下来的回复和主动消息，保留聊天与记忆。正在回复时请等这轮结束。</Text>
    <ActionLink icon="refresh-outline" disabled={loading || saving} onPress={() => { setLoading(true); void refresh(); }}>刷新云端模型</ActionLink>
    <ModelPicker visible={target !== null} title={target === "telegram" ? "TG 后台模型" : "知行默认模型"}
      connectionUrl={connection.url} models={snapshot?.catalog.items ?? []} selectedId={target ? snapshot?.settings[target]?.model_id ?? null : null}
      onSelect={choose} onUseDefault={target === "telegram" ? () => choose(null) : undefined}
      defaultLabel={`跟随知行默认 · ${label(defaults?.effective_model_id)}`} onClose={() => setTarget(null)} />
  </PageScrollView>;
}
