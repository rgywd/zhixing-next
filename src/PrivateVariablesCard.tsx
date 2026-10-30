import { useEffect, useRef, useState } from "react";
import { AppState, Text, TextInput, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { ActionLink, Button, useUi } from "./ui";
import { acquireVaultPrivacy, releaseVaultPrivacy } from "./vaultPrivacy";
import type { DshPending } from "./dshProtocol";
import { space } from "./theme";

type Entry = { id: string; name: string; value: string; replace: boolean };
export type PrivateVariableSubmission = { submissionId: string; fields: Entry[] } | { cancelled: true };

/** Deliberately lives outside the chat draft, cache and ordinary answer flow. */
export function PrivateVariablesCard({ pending, disabled, submit }: {
  pending: DshPending; disabled: boolean; submit: (body: PrivateVariableSubmission) => Promise<void>;
}) {
  const { s, colors } = useUi();
  const [entries, setEntries] = useState<Entry[]>(() => (pending.fields ?? []).map(field => ({ ...field, value: "", replace: false })));
  const [privacy, setPrivacy] = useState(false), [privacyAttempt, retryPrivacy] = useState(0);
  const [error, setError] = useState(""), [saving, setSaving] = useState(false), [finished, setFinished] = useState(false);
  const submissionId = useRef(randomUUID()), active = useRef(true), working = useRef(false);
  useEffect(() => {
    active.current = true;
    const key = `zhixing-private-input-${randomUUID()}`;
    let mounted = true;
    void acquireVaultPrivacy(key).then(() => { if (mounted) { setPrivacy(true); setError(""); } })
      .catch(() => { if (mounted) setError("无法启用输入隐私保护，请重试。"); });
    const subscription = AppState.addEventListener("change", state => {
      if (state !== "active") {
        setEntries(previous => previous.map(entry => ({ ...entry, value: "" })));
        submissionId.current = randomUUID();
      }
    });
    return () => {
      mounted = false; active.current = false; subscription.remove();
      void releaseVaultPrivacy(key).catch(() => undefined);
    };
  }, [privacyAttempt]);
  function edit(id: string, patch: Partial<Entry>) {
    if (working.current) return;
    submissionId.current = randomUUID();
    setEntries(previous => previous.map(entry => entry.id === id ? { ...entry, ...patch } : entry));
  }
  async function send(cancelled = false) {
    if (working.current || disabled || finished || (!cancelled && !privacy)) return;
    working.current = true; setSaving(true); setError("");
    const payload: PrivateVariableSubmission = cancelled ? { cancelled: true } : { submissionId: submissionId.current, fields: entries.map(entry => ({ ...entry })) };
    if (cancelled) setEntries(previous => previous.map(entry => ({ ...entry, value: "" })));
    try {
      await submit(payload);
      if (active.current) {
        setEntries(previous => previous.map(entry => ({ ...entry, value: "" })));
        setFinished(true);
      }
    } catch {
      if (active.current) setError(cancelled ? "取消未确认，请重试。" : "保存未确认，请检查变量名、同名替换选项和连接后重试。");
    } finally {
      if ("fields" in payload) payload.fields.forEach(entry => { entry.value = ""; });
      working.current = false;
      if (active.current) setSaving(false);
    }
  }
  const invalid = !entries.length || entries.some(entry => !/^DSH_SECRET_[A-Z][A-Z0-9_]{0,79}$/.test(entry.name) || !entry.value ||
    (pending.configuredNames?.includes(entry.name) && !entry.replace)) || new Set(entries.map(entry => entry.name)).size !== entries.length;
  return <View style={[s.card, { gap: space.md, marginVertical: space.sm }]}>
    <Text style={s.label}>{pending.title || "填写私密变量"}</Text>
    <Text style={s.muted}>值直接保存到当前 DSH 工作区的凭据中，用于后续命令，不作为聊天发送。</Text>
    {finished ? <Text style={s.muted}>已提交，正在继续对话。</Text> : <>
      {privacy ? entries.map(entry => <View key={entry.id} style={{ gap: space.xs }}>
        <Text style={s.label}>{pending.fields?.find(field => field.id === entry.id)?.label}</Text>
        <TextInput style={s.input} accessibilityLabel={`变量名 ${entry.id}`} value={entry.name} autoCapitalize="characters" autoCorrect={false}
          autoComplete="off" importantForAutofill="no" maxLength={91} editable={!saving && !disabled}
          onChangeText={name => edit(entry.id, { name, replace: false })} />
        <TextInput style={s.input} accessibilityLabel={`私密值 ${entry.id}`} value={entry.value} placeholder="填写 Key、Token 或其他私密值"
          placeholderTextColor={colors.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off"
          textContentType="none" importantForAutofill="no" maxLength={32768} editable={!saving && !disabled}
          onChangeText={value => edit(entry.id, { value })} />
        {pending.configuredNames?.includes(entry.name) ? <ActionLink disabled={saving || disabled}
          onPress={() => edit(entry.id, { replace: !entry.replace })}>{entry.replace ? "☑ 替换已保存的同名变量" : "☐ 替换已保存的同名变量"}</ActionLink> : null}
      </View>) : <Text style={s.muted}>正在启用输入隐私保护…</Text>}
      <Text style={s.small}>变量名以 DSH_SECRET_ 开头，可修改后面的名称。切到后台会清空未提交的值。执行程序可以读取变量，请只用于可信任务。</Text>
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      {!privacy && error ? <ActionLink onPress={() => { setError(""); retryPrivacy(value => value + 1); }}>重试隐私保护</ActionLink> : null}
      <Button disabled={!privacy || invalid || saving || disabled} onPress={() => { void send(); }}>{saving ? "正在提交…" : "保存并继续"}</Button>
      <ActionLink disabled={saving || disabled} onPress={() => { void send(true); }}>取消填写</ActionLink>
    </>}
  </View>;
}
