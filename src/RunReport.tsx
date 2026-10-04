import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { ApiError, request, type Connection } from "./api";
import { useSyncStatus } from "./ConnectionStatus";
import { useUi } from "./ui";
import { layout } from "./theme";

type Report = {
  usage: { model_attempts: number; tool_calls: number; input_tokens: number; output_tokens: number; unknown_usage: number };
  steps: { id: string; description: string; status: "pending" | "passed" | "blocked"; evidence: { kind?: string; reason?: string } | null }[];
};

export function RunReport({ connection, runId }: { connection: Connection; runId: string }) {
  const { s, colors } = useUi();
  const [report, setReport] = useState<Report | null>(null);
  const [expanded, setExpanded] = useState(false);
  const retry = useRef<() => void>(() => undefined);
  const reportSync = useSyncStatus(() => retry.current());
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    let supported = true;
    async function refresh() {
      if (busy || !supported) return;
      busy = true;
      try {
        const value = await request<Report>(connection, `/runs/${runId}/report`, { signal: controller.signal });
        if (!controller.signal.aborted) { setReport(value); reportSync(); }
      } catch (e) {
        if (!controller.signal.aborted) {
          if (e instanceof ApiError && e.status === 404) { supported = false; reportSync(); }
          else reportSync(e);
        }
      } finally { busy = false; }
    }
    retry.current = () => { void refresh(); };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [connection, runId, reportSync]);
  if (!report) return null;
  const passed = report.steps.filter((step) => step.status === "passed").length;
  const blocked = report.steps.filter((step) => step.status === "blocked");
  return <View style={s.card}>
    <Pressable accessibilityRole="button" accessibilityLabel={expanded ? "收起核对与用量" : "展开核对与用量"}
      accessibilityState={{ expanded }} onPress={() => setExpanded((value) => !value)} style={[s.row, { minHeight: layout.touchTarget }]}>
      <View style={s.headingCopy}><Text style={s.label}>核对与用量</Text><Text style={s.muted}>{report.steps.length ? `${passed} / ${report.steps.length} 项已核对` : `模型 ${report.usage.model_attempts} 次 · 工具 ${report.usage.tool_calls} 次`}</Text></View>
      <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={18} color={colors.muted} />
    </Pressable>
    {!expanded && blocked.length ? <Text style={s.error}>{blocked.length} 项尚未完成 · {blocked[0].evidence?.reason ?? blocked[0].description}</Text> : null}
    {expanded ? <>{report.steps.map(step => <View key={step.id} style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
      <Ionicons name={step.status === "passed" ? "checkmark-circle-outline" : step.status === "blocked" ? "alert-circle-outline" : "ellipse-outline"} color={step.status === "blocked" ? colors.red : colors.muted} size={18} />
      <View style={{ flex: 1 }}><Text style={s.text}>{step.description}</Text><Text style={s.description}>{step.status === "pending" ? "待核验" : step.status === "blocked" ? step.evidence?.reason ?? "尚未完成" : step.evidence?.kind === "command" ? "验证命令已通过" : "已核对操作证据"}</Text></View>
    </View>)}
    <Text style={s.muted}>模型 {report.usage.model_attempts} 次 · 工具 {report.usage.tool_calls} 次</Text>
    <Text style={s.description}>已报告 token：输入 {report.usage.input_tokens.toLocaleString()} · 输出 {report.usage.output_tokens.toLocaleString()}{report.usage.unknown_usage ? `；${report.usage.unknown_usage} 次调用未返回用量` : ""}</Text>
    </> : null}
  </View>;
}
