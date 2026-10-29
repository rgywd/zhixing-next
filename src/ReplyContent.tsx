import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { MessageBody } from "./MessageBody";
import { BottomSheet } from "./BottomSheet";
import type { ReplyPart } from "./liveRun";
import type { Run } from "./api";
import { replyParts, replySections } from "./replyParts";
import { layout } from "./theme";
import { useUi } from "./ui";

const toolLabels: Record<string, string> = {
  read: "读取文件", write: "保存文件", edit: "修改文件", bash: "执行命令", subagent: "调用子助手", zhixing_service: "处理知行数据",
  ask_user_question: "等待你的回答", plugin_manager: "管理插件", schedule_create: "安排任务",
  search_history: "查找历史对话", read_history: "读取历史对话", read_history_message: "读取历史消息", browse_personal_memories: "查阅记忆", find_resources: "查找资料", read_saved_resource: "读取保存的资料", search_web: "搜索网页",
  calculate: "计算", date_info: "查询日期", publish_report: "生成报告", apply_finance_transaction_batch: "整理收支",
  list_directory: "查看文件目录", read_text_file: "读取文件", read_document: "读取资料", view_image: "查看图片",
  write_text_file: "保存文件", fetch_public_page: "读取网页", web_search: "搜索网页", search: "搜索网页",
  record_finance_entry: "记录收支", query_finance: "查看财务记录", record_health_entry: "记录健康信息",
  get_finance_summary: "查看预算与支出", query_finance_summary: "查看预算与支出", list_finance_transactions: "查看收支记录",
  record_finance_transaction: "记录收支", correct_finance_transaction: "纠正收支", delete_finance_transaction: "删除收支", update_finance_budget: "调整预算",
  query_health_context: "查看健康记录", save_health_profile: "更新健康资料", save_diet_rule: "保存饮食约定",
  record_meal: "记录饮食", record_weight: "记录体重", record_steps: "记录步数", save_meal_recommendation: "保存饮食建议",
  record_recommendation_feedback: "记录饮食反馈", correct_health_record: "纠正健康记录", delete_health_record: "删除健康记录", save_health_reminders: "调整健康提醒",
  record_life_meal: "记录餐费与饮食", correct_life_meal: "纠正餐费与饮食", query_life_events: "查看生活记录",
  task: "调用子助手", inspect_environment: "检查运行环境",
};
const toolName = (name: string) => toolLabels[name] ?? "使用工具";
const toolStatus = (part: ReplyPart & { type: "tool" }, active: boolean) => part.status === "started" ? active ? "进行中" : "结果未确认"
  : part.status === "completed" ? "已完成" : "未完成";
type Disclosure = "collapsed" | "preview" | "expanded";

function ReasoningStep({ part, active, onExpand }: { part: ReplyPart & { type: "text" | "reasoning" }; active: boolean; onExpand: () => void }) {
  const { s, colors } = useUi();
  const [choice, setChoice] = useState<Disclosure | null>(null);
  const mode = choice ?? (active ? "preview" : "collapsed");
  const title = part.attempt_status === "failed" ? "上次尝试未完成" : "思考";
  return <View style={{ gap: 2 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={mode === "collapsed" ? `预览${title}` : `收起${title}`}
      accessibilityState={{ expanded: mode !== "collapsed" }} onPress={() => setChoice(mode === "collapsed" ? "preview" : "collapsed")}
      style={[s.row, { minHeight: layout.touchTarget, gap: 8 }]}>
      <Ionicons name={part.attempt_status === "failed" ? "refresh-outline" : "sparkles-outline"} size={16} color={colors.muted} />
      <Text style={[s.muted, { flex: 1 }]}>{title}</Text>
      <Ionicons name={mode === "collapsed" ? "chevron-down" : "chevron-up"} size={14} color={colors.muted} />
    </Pressable>
    {mode !== "collapsed" ? <View style={{ borderLeftWidth: 2, borderLeftColor: colors.line, paddingLeft: 12, gap: 2 }}>
      <View style={mode === "preview" ? { maxHeight: 100, overflow: "hidden" } : undefined}>
        <Text selectable={!active} numberOfLines={mode === "preview" ? 4 : undefined} style={s.description}>{part.text}</Text>
      </View>
      {mode === "preview" ? <Pressable accessibilityRole="button" accessibilityLabel={`展开完整${title}`} onPress={() => { setChoice("expanded"); onExpand(); }}
        style={[s.row, { minHeight: layout.touchTarget }]}><Text style={[s.muted, { color: colors.gold }]}>展开完整{title}</Text></Pressable> : null}
      {part.truncated ? <Text style={s.muted}>这段过程仅展示部分内容</Text> : null}
    </View> : null}
  </View>;
}

function ProcessGroup({ parts, active, onOpenRun }: { parts: ReplyPart[]; active: boolean; onOpenRun?: () => void }) {
  const { s, colors } = useUi();
  const [choice, setChoice] = useState<Disclosure | null>(null);
  const [detailId, setDetail] = useState<string | null>(null);
  const detail = parts.find((part): part is ReplyPart & { type: "tool" } => part.type === "tool" && part.id === detailId);
  const mode = choice ?? (active ? "preview" : "collapsed");
  const visible = mode === "expanded" ? parts : parts.slice(-2);
  const toolCount = parts.filter((part) => part.type === "tool").length;
  return <View style={{ minWidth: 0, gap: 2 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={mode === "collapsed" ? "展开思考与工具过程" : "收起思考与工具过程"}
      accessibilityState={{ expanded: mode !== "collapsed" }} onPress={() => setChoice(mode === "collapsed" ? "preview" : "collapsed")}
      style={[s.row, { minHeight: layout.touchTarget, gap: 8 }]}>
      <Ionicons name="git-network-outline" size={16} color={colors.muted} />
      <Text style={[s.muted, { flex: 1 }]}>思考与工具{toolCount ? ` · ${toolCount} 项工具` : ""} · {parts.length} 步</Text>
      <Ionicons name={mode === "collapsed" ? "chevron-down" : "chevron-up"} size={14} color={colors.muted} />
    </Pressable>
    {mode !== "collapsed" ? <View style={{ borderLeftWidth: 1, borderLeftColor: colors.line, paddingLeft: 12, gap: 2 }}>
      {parts.length > 2 ? <Pressable accessibilityRole="button" accessibilityLabel={mode === "expanded" ? "只看最近两步" : `查看全部 ${parts.length} 步`}
        onPress={() => setChoice(mode === "expanded" ? "preview" : "expanded")} style={[s.row, { minHeight: layout.touchTarget }]}>
        <Text style={s.muted}>{mode === "expanded" ? "只看最近两步" : `更早 ${parts.length - 2} 步 · 查看全部`}</Text>
      </Pressable> : null}
      {visible.map((part) => part.type === "tool" ? <Pressable key={part.id} accessibilityRole="button"
        accessibilityLabel={`${toolName(part.name)} · ${toolStatus(part, active)}，查看工具详情`} onPress={() => setDetail(part.id)}
        style={[s.row, { minHeight: layout.touchTarget, gap: 8, paddingVertical: 5 }]}>
        <Ionicons name={part.status === "started" && active ? "time-outline" : part.status === "completed" ? "checkmark-circle-outline" : "alert-circle-outline"}
          size={16} color={part.status === "failed" ? colors.red : colors.muted} />
        <Text style={[s.description, { flex: 1 }]}>{toolName(part.name)} · {toolStatus(part, active)}</Text>
        <Ionicons name="chevron-forward" size={14} color={colors.muted} />
      </Pressable> : <ReasoningStep key={part.id} part={part} active={active} onExpand={() => setChoice("expanded")} />)}
    </View> : null}
    {detail ? <BottomSheet visible title={toolName(detail.name)} subtitle="这条回复的工具过程" onClose={() => setDetail(null)}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 16, gap: 12 }}>
        <Text style={s.text}>{toolStatus(detail, active)}</Text>
        <Text style={s.description}>{detail.status === "completed" ? "这一步已收到工具完成回执，回复正文会结合结果继续说明。"
          : detail.status === "failed" ? "这一步未完成，请结合回复正文或处理记录查看后续情况。"
          : active ? "助手正在处理这一步，完成后会更新状态。" : "这一步没有收到明确的完成回执。"}</Text>
        {onOpenRun ? <Pressable accessibilityRole="button" accessibilityLabel="查看这条回复的处理记录" onPress={() => { setDetail(null); onOpenRun(); }}
          style={[s.row, { minHeight: layout.touchTarget }]}><Text style={[s.description, { color: colors.gold }]}>查看处理记录</Text></Pressable> : null}
      </ScrollView>
    </BottomSheet> : null}
  </View>;
}

export type ReplyContentProps = { parts: ReplyPart[]; active?: boolean; finalText?: string | null; finalPartId?: string | null;
  status?: Run["status"]; phase?: string; cancelRequested?: boolean; connectionIssue?: boolean; truncated?: boolean; onOpenRun?: () => void };
export function ReplyContent({ parts, active = false, finalText, finalPartId, status, phase, cancelRequested, connectionIssue, truncated, onOpenRun }: ReplyContentProps) {
  const { s, colors } = useUi();
  const terminalLabel = status === "failed" ? "回复未完成" : status === "cancelled" ? "回复已停止" : status === "interrupted" ? "回复已中断" : "";
  const latest = parts.at(-1);
  const label = cancelRequested ? "正在停止" : phase === "approval" ? "等待你的决定" : phase === "input" ? "等待补充信息"
    : phase === "recovering" ? "正在恢复进度" : phase === "agent_wait" ? "等待其他对话回复，可补充要求" : status === "queued" ? "等待回复"
    : phase === "tool" || (phase !== "model" && latest?.type === "tool" && latest.status === "started") ? "正在使用工具" : "正在回复";
  const sections = replySections(replyParts(parts, finalText, finalPartId));
  return <View style={{ gap: 8, minWidth: 0 }}>
    {terminalLabel || active || connectionIssue ? <View style={[s.row, { gap: 8, minHeight: 28 }]}>
      {active ? <ActivityIndicator size="small" color={colors.gold} /> : null}
      <Text style={s.muted}>{terminalLabel || (connectionIssue ? "连接恢复后继续显示进度" : label)}</Text>
    </View> : null}
    {sections.map((section) => section.type === "text" ? section.part.text ? <MessageBody key={section.id} streaming={active}>{section.part.text}</MessageBody> : null
      : <ProcessGroup key={section.id} parts={section.parts} active={active} onOpenRun={onOpenRun} />)}
    {truncated ? <Text style={s.muted}>过程展示有限，完整回答以正文为准。</Text> : null}
  </View>;
}
