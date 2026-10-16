import { request, type Connection } from "./api";

export type FinanceTransaction = {
  id: string; revision: number; kind: "expense" | "income" | "transfer" | "refund";
  amount: string; occurred_on: string; date_precision?: "day" | "month" | "range"; date_start?: string | null; date_end?: string | null; coverage_start?: string | null; coverage_end?: string | null; bucket: "daily" | "fixed" | "one_time";
  category: string; note: string; commitment_key?: string | null; related_transaction_id?: string | null;
};
export type FinanceCommitment = { key: string; label: string; amount: string; kind: "fixed" | "one_time"; every_months?: number; anchor_month?: string | null; due_day?: number | null; monthly_cost?: string | null; paid_through?: string | null };
export type IncomeSchedule = { rule: "last_business_day" | "day_of_month"; day?: number | null; weekdays?: number[]; working_dates?: string[]; non_working_dates?: string[]; calendar_basis?: "weekdays_only" | "user_overrides" };
export function financeDateLabel(record: FinanceTransaction) {
  if (record.date_precision === "month") return `${(record.date_start ?? record.occurred_on).slice(0, 7)}（日期待定）`;
  if (record.date_precision === "range") return `${record.date_start ?? "日期待定"} 至 ${record.date_end ?? record.occurred_on}（区间）`;
  return record.occurred_on;
}
export type FinanceBudget = {
  month: string; source_month?: string | null; recurring: boolean; revision: number;
  expected_income: string | null; savings_target: string | null; daily_budget: string | null;
  commitments: FinanceCommitment[]; income_schedule?: IncomeSchedule | null; coverage_start?: string | null; coverage_through?: string | null;
};
export type FinanceDashboardSummary = {
  month: string; budget: FinanceBudget;
  expected_income_on?: string | null;
  commitments?: { monthly_cost: string; cash_due: string; items: { key: string; monthly_cost: string; cash_due: string; remaining_due: string; next_due_on: string | null; paid_through: string | null }[] };
  unallocated?: { items: FinanceTransaction[]; count: number; reason: string };
  totals: { income: string; expense: string; net: string; daily: string; fixed: string; one_time: string; refund: string; transfer: string };
  reservations: { fixed: string; one_time: string; total: string };
  remaining: { daily_budget: string | null; total_spend_budget: string | null; savings_target_headroom: string | null };
  projection: { income: string | null; expense: string | null; savings: string | null; assumptions: string[] };
  daily_average: { amount: string | null; days: number | null; from: string | null; through: string | null; basis: string };
  coverage: { recorded_days: number; from: string | null; through: string | null; complete: boolean; gaps: string[] };
};
export type HealthProfile = {
  revision: number; height_cm: number | null; activity_limitations: string[]; food_allergies: string[];
  food_exclusions: string[]; preferences: string[]; goals: string[]; note?: string;
};
export type HealthRule = {
  id: string; revision: number; content: string; kind: "restriction" | "preference" | "guideline";
  status: "active" | "paused" | "proposed"; effective_from: string | null; effective_until: string | null; excluded_terms: string[]; origin?: "user" | "professional" | "assistant_proposal"; confirmed?: boolean;
};
export type MealType = "breakfast" | "lunch" | "dinner" | "snack" | "other";
export type EnergyEstimate = { minimum: number; maximum: number; basis: string; unit: "kcal" };
export type HealthMeal = {
  id: string; revision: number; occurred_at: string; meal_type: MealType; description: string; portion: string;
  status: "recorded" | "skipped"; recommendation_id?: string | null; note: string; estimated_energy?: EnergyEstimate | null;
};
export type HealthWeight = { id: string; revision: number; measured_at: string; value: number; unit: "kg" | "lb"; value_kg?: number; note: string };
export type HealthSteps = { id: string; revision: number; measured_at: string; value: number; note: string };
export type HealthOption = { id: string; title: string; description: string; ingredients: string[]; portion: string; substitutions: string[]; reason: string; note: string; estimated_energy?: EnergyEstimate | null; cost_note?: string };
export type HealthFeedback = { id: string; action: "accepted" | "replaced" | "declined"; option_id: string | null; note: string; created_at: string };
export type HealthRecommendation = {
  id: string; revision: number; context_revision: number; target_date: string; meal_type: MealType; context: string; note?: string;
  options: HealthOption[]; status: "current" | "stale"; created_at: string; latest_feedback: HealthFeedback | null;
};
export type HealthReminders = {
  revision: number; enabled: boolean; timezone: string;
  slots: { id: string; time: string; meal_type: MealType; kind: "meal" | "review" }[];
  tone?: string; quiet_start: string | null; quiet_end: string | null; max_per_day: number; paused_dates: string[];
};
export type HealthSummary = {
  date: string; revision: number; profile: HealthProfile; rules: HealthRule[]; all_rules: HealthRule[];
  meals: HealthMeal[]; weights: HealthWeight[]; steps: HealthSteps[]; recommendations: HealthRecommendation[]; reminders: HealthReminders;
  review: { recorded_meals: number; skipped_meals: number; coverage: string; unknown_is_not_nonadherence: boolean;
    weight_trend: { count: number; change_kg: number | null; first_date: string | null; last_date: string | null; latest_kg: number | null };
    recent_choices: { id: string; target_date: string; meal_type: MealType; options: HealthOption[]; latest_feedback: HealthFeedback | null; actual_meals: HealthMeal[] }[];
    next_step_context?: string;
  };
};
export type ServiceMutation = { path: string; method: "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown };
export const readFinanceDashboard = (connection: Connection, month: string) => Promise.all([
  request<FinanceDashboardSummary>(connection, `/finance/summary?month=${encodeURIComponent(month)}`),
  request<{ items: FinanceTransaction[]; total: number }>(connection, `/finance/transactions?month=${encodeURIComponent(month)}&limit=100&offset=0`),
]).then(([summary, records]) => {
  const unallocated = new Set(summary.unallocated?.items.map((item) => item.id) ?? []);
  return { summary, records: { ...records, items: records.items.filter((item) => !unallocated.has(item.id)), total: Math.max(0, records.total - (summary.unallocated?.count ?? 0)) } };
});
export const readHealthSummary = (connection: Connection, date: string) =>
  request<HealthSummary>(connection, `/health/summary?date=${encodeURIComponent(date)}`);
export const mutateService = <T>(connection: Connection, mutation: ServiceMutation) => request<T>(connection, mutation.path, mutation);
