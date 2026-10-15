import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Ionicons } from "@react-native-vector-icons/ionicons";
import { MessageBody } from "./MessageBody";
import { layout } from "./theme";
import { useUi } from "./ui";
import type { LiveRunState } from "./liveRun";

const labels: Record<string, string> = {
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
const statusLabels = { started: "进行中", completed: "已完成", failed: "未完成" };
function RunContent({ value }: { value: LiveRunState }) {
  const { s, colors } = useUi();
  const [reasoningExpanded, setReasoningExpanded] = useState<boolean | null>(null);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const showReasoning = reasoningExpanded ?? value.active;
  const terminalLabel = value.run.status === "failed" ? "回复未完成" : value.run.status === "cancelled" ? "回复已停止"
    : value.run.status === "interrupted" ? "回复已中断" : "";
  const phase = value.run.cancel_requested ? "正在停止" : value.phase === "approval" ? "等待你的决定"
    : value.phase === "input" ? "等待补充信息" : value.phase === "recovering" ? "正在恢复进度"
    : value.run.status === "queued" ? "等待回复" : value.tools.some((tool) => tool.status === "started") ? "正在使用工具"
    : value.active ? "正在回复" : "回复已完成";
  return <View style={{ gap: 10, minWidth: 0 }}>
    {terminalLabel || value.active || (!value.answerCommitted && !value.content) || value.connectionIssue ? <View style={[s.row, { gap: 8 }]}>
      {value.active ? <ActivityIndicator size="small" color={colors.gold} /> : null}
      <Text style={s.muted}>{terminalLabel || (value.connectionIssue ? "连接恢复后继续显示进度" : phase)}</Text>
    </View> : null}
    {value.reasoning ? <View style={{ gap: 6 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={showReasoning ? "收起思考" : "展开思考"} accessibilityState={{ expanded: showReasoning }}
        onPress={() => setReasoningExpanded(!showReasoning)} style={[s.row, { minHeight: layout.touchTarget, gap: 6 }]}>
        <Ionicons name="sparkles-outline" size={16} color={colors.muted} /><Text style={s.muted}>思考</Text>
        <Ionicons name={showReasoning ? "chevron-up" : "chevron-down"} size={15} color={colors.muted} />
      </Pressable>
      {showReasoning ? <View style={{ borderLeftWidth: 2, borderLeftColor: colors.line, paddingLeft: 12 }}><Text selectable style={s.description}>{value.reasoning}</Text></View> : null}
    </View> : null}
    {value.tools.length ? <View style={{ gap: 4 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={toolsExpanded ? "收起工具调用" : "展开工具调用"} accessibilityState={{ expanded: toolsExpanded }}
        onPress={() => setToolsExpanded(!toolsExpanded)} style={[s.row, { minHeight: layout.touchTarget, gap: 6 }]}>
        <Ionicons name="construct-outline" size={16} color={colors.muted} />
        <Text style={s.muted}>工具调用 · {value.tools.length} 项{value.active && value.tools.some((tool) => tool.status === "started") ? " · 进行中" : ""}</Text>
        <Ionicons name={toolsExpanded ? "chevron-up" : "chevron-down"} size={15} color={colors.muted} />
      </Pressable>
      {(toolsExpanded ? value.tools : value.tools.slice(-1)).map((tool) => <View key={tool.id} style={[s.row, { gap: 8, alignItems: "flex-start" }]}>
        <Ionicons name={tool.status === "started" ? "time-outline" : tool.status === "completed" ? "checkmark-circle-outline" : "alert-circle-outline"} size={16} color={tool.status === "failed" ? colors.red : colors.muted} />
        <Text style={[s.description, { flex: 1 }]}>{labels[tool.name] ?? tool.name} · {!value.active && tool.status === "started" ? "结果未确认" : statusLabels[tool.status]}</Text>
      </View>)}
    </View> : null}
    {value.content ? <MessageBody>{value.content}</MessageBody> : null}
  </View>;
}
export function LiveRunView({ value }: { value: LiveRunState | null }) {
  return value ? <RunContent key={value.run.id} value={value} /> : null;
}
