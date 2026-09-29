import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { request, type Approval, type Connection, type Page } from "./api";
import { shareDownload } from "./resources";
import { Button, humanError, s } from "./ui";

export function ApprovalCards({ connection, conversationId, runId, onChanged }: {
  connection: Connection;
  conversationId?: string;
  runId?: string;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<Approval[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let polling = false;
    async function poll() {
      if (polling) return;
      polling = true;
      try {
        const filter = runId ? `run_id=${encodeURIComponent(runId)}` : `conversation_id=${encodeURIComponent(conversationId ?? "")}`;
        const page = await request<Page<Approval>>(connection, `/approvals?${filter}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setItems(page.items); setSyncError(""); }
      } catch (e) {
        if (!controller.signal.aborted) setSyncError(humanError(e));
      } finally { polling = false; }
    }
    void poll();
    const timer = setInterval(() => { void poll(); }, 2000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [connection, conversationId, runId]);

  async function decide(item: Approval, decision: string) {
    setBusy(true); setError("");
    try {
      await request(connection, `/approvals/${encodeURIComponent(item.id)}/decision`, { method: "POST", body: { decision } });
      setItems((old) => old.filter((value) => value.id !== item.id));
      onChanged?.();
    } catch (e) { setError(humanError(e)); } finally { setBusy(false); }
  }
  async function preview(item: Approval, version: "before" | "after") {
    setBusy(true); setError("");
    try {
      const name = item.details.path?.split(/[\\/]/).pop() ?? "文件";
      await shareDownload(connection, name, `/approvals/${encodeURIComponent(item.id)}/file?version=${version}`);
    } catch (e) { setError(humanError(e)); } finally { setBusy(false); }
  }
  return <View style={{ gap: 12 }}>
    {items.map((item) => <View key={item.id} style={s.card}>
      <Text style={s.title}>{item.details.title}</Text>
      {item.details.description ? <Text style={s.description}>{item.details.description}</Text> : null}
      {item.details.task ? <Text style={s.text}>{item.details.task}</Text> : null}
      {item.details.path ? <Text selectable style={s.text}>{item.details.path}</Text> : null}
      {item.details.bytes !== undefined ? <Text style={s.muted}>拟写入 {item.details.bytes} 字节；批准只适用于当前文件版本。</Text> : null}
      {item.details.preview ? <Text selectable style={s.text}>{item.details.preview}</Text> : null}
      {item.kind === "overwrite" ? <View style={s.wrap}>
        <Button small secondary disabled={busy} onPress={() => { void preview(item, "before"); }}>查看原件</Button>
        <Button small secondary disabled={busy} onPress={() => { void preview(item, "after"); }}>查看完整新文件</Button>
      </View> : null}
      {item.details.tool ? <Text style={s.muted}>{item.details.tool}</Text> : null}
      {item.details.arguments ? <Text selectable style={s.text}>{JSON.stringify(item.details.arguments, null, 2)}</Text> : null}
      {item.kind === "uncertain" ? <>
        <Button disabled={busy} onPress={() => { void decide(item, "skip"); }}>保留现状，继续核对</Button>
        <Button secondary disabled={busy} onPress={() => { void decide(item, "retry"); }}>允许重新执行（可能重复）</Button>
      </> : <View style={s.wrap}>
        <Button disabled={busy} onPress={() => { void decide(item, "approve"); }}>允许这次操作</Button>
        <Button secondary disabled={busy} onPress={() => { void decide(item, "deny"); }}>不允许</Button>
      </View>}
    </View>)}
    {error || syncError ? <Text accessibilityRole="alert" style={s.error}>{error || syncError}</Text> : null}
  </View>;
}
