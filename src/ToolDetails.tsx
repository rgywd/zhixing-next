import { useState } from "react";
import { Text, View } from "react-native";
import type { ReplyPart } from "./liveRun";
import { toolDetails } from "./toolPresentation";
import { CopyAction } from "./CopyAction";
import { ActionLink, humanError, useUi } from "./ui";
import { radius, space } from "./theme";

function DetailBlock({ title, text, tone }: { title: string; text: string; tone?: "error" | "success" }) {
  const { s, colors } = useUi();
  return <View style={{ gap: space.xs }}>
    <View style={[s.row, { justifyContent: "space-between" }]}><Text style={s.label}>{title}</Text><CopyAction text={text} label={`复制${title}`} /></View>
    <Text selectable style={[s.text, { fontFamily: "monospace", padding: space.md, borderRadius: radius.small, backgroundColor: colors.neutral,
      color: tone === "error" ? colors.red : tone === "success" ? colors.green : colors.ink }]}>{text || "（空）"}</Text>
  </View>;
}

export function ToolDetails({ part, onPublish }: { part: ReplyPart & { type: "tool" }; onPublish?: (seq: number) => Promise<void> }) {
  const { s } = useUi();
  const [parameters, setParameters] = useState(false);
  const [metadata, setMetadata] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);
  const [error, setError] = useState("");
  const detail = toolDetails(part);
  if (!part.detail) return null;
  return <View style={{ gap: space.md }}>
    <Text selectable style={s.muted}>{part.name}{detail.duration !== null ? ` · 耗时 ${detail.duration < 1000 ? `${detail.duration} 毫秒` : `${(detail.duration / 1000).toFixed(1)} 秒`}` : ""}</Text>
    {detail.path ? <Text selectable style={s.description}>{detail.path}</Text> : null}
    {onPublish && detail.path && part.seq !== undefined && part.status === "completed" && ["read", "write", "edit"].includes(part.name) ? <View>
      <ActionLink icon="download-outline" disabled={publishing || published} onPress={() => {
        setPublishing(true); setError("");
        void onPublish(part.seq!).then(() => setPublished(true)).catch(e => setError(humanError(e))).finally(() => setPublishing(false));
      }}>{published ? "已发布到本条回复" : publishing ? "正在发布…" : "发布当前文件"}</ActionLink>
      <Text style={s.muted}>保存当前文件的副本，发布后可在回复中打开和分享。</Text>
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    </View> : null}
    {detail.command ? <DetailBlock title="命令" text={detail.command} /> : null}
    {detail.exitCode !== null ? <Text style={s.text}>退出码：{detail.exitCode}</Text> : null}
    {detail.diffs.map((diff, index) => <View key={index} style={{ gap: space.sm }}>
      {diff.path !== detail.path || detail.diffs.length > 1 ? <Text selectable style={s.description}>{diff.path}</Text> : null}
      <DetailBlock title="修改前" text={diff.before} tone="error" /><DetailBlock title="修改后" text={diff.after} tone="success" />
    </View>)}
    {detail.error ? <DetailBlock title="执行错误" text={detail.error} tone="error" /> : null}
    {detail.output ? <DetailBlock title="输出结果" text={detail.output} /> : part.status !== "started" ? <Text style={s.muted}>工具未返回正文。</Text> : null}
    {detail.input ? <View>
      <ActionLink icon="code-slash-outline" onPress={() => setParameters(!parameters)}>{parameters ? "收起输入参数" : "查看输入参数"}</ActionLink>
      {parameters ? <DetailBlock title="输入参数" text={detail.input} /> : null}
    </View> : null}
    {detail.meta ? <View>
      <ActionLink icon="information-circle-outline" onPress={() => setMetadata(!metadata)}>{metadata ? "收起结果信息" : "查看结果信息"}</ActionLink>
      {metadata ? <DetailBlock title="结果信息" text={detail.meta} /> : null}
    </View> : null}
  </View>;
}
