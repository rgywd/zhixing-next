import { useState } from "react";
import { Text, View } from "react-native";
import type { ReplyPart } from "./liveRun";
import { toolDetails } from "./toolPresentation";
import { CopyAction } from "./CopyAction";
import { ActionLink, useUi } from "./ui";
import { radius, space } from "./theme";

function DetailBlock({ title, text, tone }: { title: string; text: string; tone?: "error" | "success" }) {
  const { s, colors } = useUi();
  return <View style={{ gap: space.xs }}>
    <View style={[s.row, { justifyContent: "space-between" }]}><Text style={s.label}>{title}</Text><CopyAction text={text} label={`复制${title}`} /></View>
    <Text selectable style={[s.text, { fontFamily: "monospace", padding: space.md, borderRadius: radius.small, backgroundColor: colors.neutral,
      color: tone === "error" ? colors.red : tone === "success" ? colors.green : colors.ink }]}>{text || "（空）"}</Text>
  </View>;
}

export function ToolDetails({ part }: { part: ReplyPart & { type: "tool" } }) {
  const { s } = useUi();
  const [technical, setTechnical] = useState(false);
  const detail = toolDetails(part);
  if (!part.detail) return null;
  return <View style={{ gap: space.md }}>
    {detail.path ? <Text selectable style={s.label}>{detail.path.split(/[\\/]/).at(-1)}</Text> : null}
    {detail.duration !== null ? <Text style={s.muted}>用时 {detail.duration < 1000 ? "不到 1 秒" : `${(detail.duration / 1000).toFixed(1)} 秒`}</Text> : null}
    {detail.command ? <DetailBlock title="执行命令" text={detail.command} /> : null}
    {detail.exitCode !== null && detail.exitCode !== 0 ? <Text style={s.error}>退出码：{detail.exitCode}</Text> : null}
    {detail.diffs.map((diff, index) => <View key={index} style={{ gap: space.sm }}>
      <DetailBlock title="修改前" text={diff.before} tone="error" /><DetailBlock title="修改后" text={diff.after} tone="success" />
    </View>)}
    {detail.error ? <DetailBlock title="执行错误" text={detail.error} tone="error" /> : null}
    {detail.preview && !detail.diffs.length ? <DetailBlock title={part.name === "write" ? "文件内容" : "结果"} text={detail.preview} /> : null}
    <ActionLink icon="code-slash-outline" onPress={() => setTechnical(!technical)}>{technical ? "收起技术详情" : "技术详情"}</ActionLink>
    {technical ? <>
      <Text selectable style={s.muted}>{part.name}{detail.path ? `\n${detail.path}` : ""}</Text>
      {detail.input ? <DetailBlock title="输入参数" text={detail.input} /> : null}
      {detail.output ? <DetailBlock title="原始输出" text={detail.output} /> : null}
      {detail.meta ? <DetailBlock title="结果信息" text={detail.meta} /> : null}
    </> : null}
  </View>;
}
