import { useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { ApiError, request, type Connection, type Page } from "./api";
import { useSyncStatus } from "./ConnectionStatus";
import { Button, CardHeader, humanError, useUi } from "./ui";

type Question = { id: string; question: string; options: string[] };

export function QuestionCards({ connection, conversationId, runId, onChanged }: {
  connection: Connection; conversationId?: string; runId?: string; onChanged?: () => void;
}) {
  const { s } = useUi();
  const [items, setItems] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const retry = useRef<() => void>(() => undefined);
  const reportSync = useSyncStatus(() => retry.current());
  useEffect(() => {
    const controller = new AbortController();
    let polling = false;
    let supported = true;
    const poll = async () => {
      if (polling || !supported) return;
      polling = true;
      try {
        const filter = runId ? `run_id=${encodeURIComponent(runId)}` : `conversation_id=${encodeURIComponent(conversationId ?? "")}`;
        const page = await request<Page<Question>>(connection, `/input-requests?${filter}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setItems(page.items); reportSync(); }
      } catch (e) {
        if (!controller.signal.aborted) {
          if (e instanceof ApiError && e.status === 404) { supported = false; reportSync(); }
          else reportSync(e);
        }
      } finally { polling = false; }
    };
    retry.current = () => { void poll(); };
    void poll();
    const timer = setInterval(() => { void poll(); }, 2000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [connection, conversationId, runId, reportSync]);

  async function answer(item: Question) {
    setBusy(true); setError("");
    try {
      await request(connection, `/input-requests/${encodeURIComponent(item.id)}/answer`, { method: "POST", body: { answer: answers[item.id]?.trim() } });
      setItems(old => old.filter(value => value.id !== item.id));
      onChanged?.();
    } catch (e) { setError(humanError(e)); } finally { setBusy(false); }
  }
  return <View style={{ gap: 12 }}>
    {items.map(item => <View key={item.id} style={s.card}>
      <CardHeader icon="help-circle-outline" title="需要你补充一点信息" description={item.question} tone="blue" />
      <View style={s.wrap}>{item.options.map(option => <Button small secondary={answers[item.id] !== option} key={option} disabled={busy} onPress={() => setAnswers(old => ({ ...old, [item.id]: option }))}>{option}</Button>)}</View>
      <TextInput accessibilityLabel={item.question} style={s.input} multiline maxLength={10000} placeholder="选择上方选项，或直接回答" value={answers[item.id] ?? ""} onChangeText={value => setAnswers(old => ({ ...old, [item.id]: value }))} editable={!busy} />
      <View style={s.wrap}><Button small disabled={busy || !answers[item.id]?.trim()} onPress={() => { void answer(item); }}>回答并继续</Button></View>
    </View>)}
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
  </View>;
}
