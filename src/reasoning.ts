import type { ModelInfo, ReasoningEffort } from "./api";

export const reasoningLabel: Record<ReasoningEffort, string> = {
  auto: "自动", none: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高",
};

export function thinkingLabel(model: ModelInfo | undefined, level: ReasoningEffort) {
  return model?.reasoning_labels?.[level] ?? reasoningLabel[level];
}

export function thinkingDescription(model: ModelInfo | undefined, level: ReasoningEffort) {
  if (model?.reasoning_kind === "toggle" && level === "high") return "开启模型思考";
  if (model?.reasoning_kind?.endsWith("budget") && ["low", "medium", "high"].includes(level)) {
    return `限制思考预算为 ${level === "low" ? "1,024" : level === "medium" ? "8,192" : model.reasoning_kind === "gemini_budget" ? "24,576" : "16,384"} token`;
  }
  return {
    auto: "使用模型默认的思考方式", none: "关闭额外思考", minimal: "尽量少思考，不保证完全关闭", low: "轻量思考，快速回应", medium: "兼顾速度与推敲", high: "为复杂问题多想一步", xhigh: "使用更高思考档位", max: "使用当前模型最高思考档位",
  }[level];
}
