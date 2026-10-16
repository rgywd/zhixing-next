"""Health agent tools: the same service and receipts as direct phone input."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal

from langchain_core.tools import tool

from .finance_context import active_finance_input, delegated_finance_input
from .health_service import HealthService, source_key

if TYPE_CHECKING:
    from .config import Settings

HEALTH_TOOL_NAMES = [
    "query_health_context", "save_health_profile", "save_diet_rule", "record_meal",
    "record_weight", "record_steps", "save_meal_recommendation",
    "record_recommendation_feedback", "correct_health_record", "delete_health_record",
    "save_health_reminders",
]

HEALTH_INSTRUCTIONS = """你是知行的饮食与体重助手，先用query_health_context了解当前资料、约定、近期记录、选择困难和餐费摘要。替用户整理并直接完成清楚的记录，不让用户管理内部ID或版本。资料、提醒和纠正只传要改的字段；程序保留未提及信息并同事务读取revision，显式旧版本仍拒绝冲突。每个操作用不同稳定entry_key，重试沿用，实际消息来源由系统绑定，只有成功回执才能说已保存。
饮食记录实际吃下或明确跳过的内容，建议和采纳都不是已吃。漏记是未知，不是未吃或不达标；照片不证明精确克数、营养或餐费。体重与数字目标来自用户，不预设固定热量、减重速度或步数；膝盖等活动限制始终保留。AI提出的新规范用assistant_proposal/proposed，用户采纳才激活。规则日期省略则持续有效，暂停用status=paused。
推荐基于读取的当前context_revision，程序会重查已知禁忌和版本；有变化时重新读取并调整，不要求用户补状态。候选写可照着选择的实际食物、份量与替换，提醒放顶层note，避免把“不要吃某物”放候选列表触发冲突。已知过敏/禁忌不能出现在候选和替换中；存在过敏时提醒核对配料与交叉接触，不承诺安全。商家、价格和库存无来源不编造，日常预算也不能全部视为餐费。没有厨房且加热条件未知时优先即食或商家做好即可吃的组合。
不知道份量、配料和完整摄入时不诊断蛋白质/能量不足或摄入过量，按用户约定给均衡建议。不要推荐极端限制、禁食、药物、惩罚性运动或诊疗；不适、持续饥饿或难执行时先调整，必要时建议专业帮助。服务已计算的体重变化和财务数字直接引用，不自行改算。
采纳、替换、放弃用record_recommendation_feedback保存选择与困难，实际饮食另记并关联原recommendation_id。已采纳是历史选择，资料变化不要求重新采纳；回顾结合反馈和实际记录给一项下一步。纠正原记录，不新建冒充纠正，不删真实饮食美化达标。提醒保存仅代表本机排期偏好，手机同步和实际通知另有回执；今天不提醒只追加当地日期到paused_dates。记录和修改回执简短自然，模型不可用时仍可直接记录。"""

def create_health_tools(settings: Settings, conversation_id: str, source_id: str | None = None) -> list[Any]:
    from .store import Store

    store = Store(settings)
    service = HealthService(store)

    def actual_source():
        return active_finance_input.get() or delegated_finance_input.get() or source_id

    def provenance(record):
        return {**record, "source_id": actual_source(), "conversation_id": conversation_id}

    def operation(kind, entry_key):
        return f"health:{kind}:{source_key(actual_source() or '', entry_key)}"

    def creating(kind, record, entry_key):
        key = operation(kind, entry_key)
        payload = provenance({**record, "id": source_key(actual_source() or '', f'{kind}:{entry_key}')})
        return service.create(kind, payload, operation_key=key)

    @tool
    async def query_health_context(date: str | None = None) -> dict[str, Any]:
        """Read current agreements, restrictions, actual intake, weight coverage and linked choice/difficulty feedback. Missing food records are unknown. Optional date is YYYY-MM-DD. Use returned revision before generating suggestions."""
        context = service.summary(date)
        # Only a narrow meal-budget view is exposed to this health service.
        from .finance_service import FinanceService

        finance = FinanceService(store).summary(month=context["date"][:7])
        context["meal_budget_context"] = {
            "month": finance["month"],
            "daily_budget": finance["budget"].get("daily_budget"),
            "remaining_daily_budget": finance["remaining"]["daily_budget"],
            "recorded_daily_expense": finance["totals"]["daily"],
            "coverage": finance["coverage"],
            "notice": "日常预算包含其他普通开销，不能全部当成餐费额度；无价格来源时不编造餐费",
        }
        return context

    @tool
    async def save_health_profile(profile: dict[str, Any], entry_key: str) -> dict[str, Any]:
        """Patch only user-mentioned profile fields. Omitted allergies, activity limitations and preferences are preserved. Optional revision detects an explicitly stale edit; otherwise the service reads it atomically. Fields: height_cm,activity_limitations,food_allergies,food_exclusions,preferences,goals,note. No invented numeric targets. Reuse entry_key on retry."""
        return service.patch_profile(profile, operation_key=operation("profile", entry_key))

    @tool
    async def save_diet_rule(rule: dict[str, Any], entry_key: str) -> dict[str, Any]:
        """Create a user agreement or proposed AI rule. Fields: content, kind(restriction/preference/guideline), status(active/paused/proposed), optional effective_from/effective_until, excluded_terms, origin(user/professional/assistant_proposal), confirmed. AI proposals do not become active without confirmation."""
        return creating("rules", rule, entry_key)

    @tool
    async def record_meal(
        occurred_at: str, description: str, entry_key: str,
        meal_type: Literal["breakfast", "lunch", "dinner", "snack", "other"] = "other",
        portion: str = "", status: Literal["recorded", "skipped"] = "recorded",
        recommendation_id: str | None = None, note: str = "",
        estimated_energy: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Record actual food or an explicitly skipped meal, never a plan. occurred_at must include UTC offset. Unknown portions stay unknown. Energy estimates require minimum, maximum and basis; photos are not exact grams. Link recommendation_id when actual food follows that choice; stable entry_key survives retries."""
        return creating("meals", {"occurred_at": occurred_at, "description": description,
                                  "meal_type": meal_type, "portion": portion, "status": status,
                                  "recommendation_id": recommendation_id, "note": note,
                                  "estimated_energy": estimated_energy}, entry_key)

    @tool
    async def record_weight(measured_at: str, value: float, entry_key: str,
                            unit: Literal["kg", "lb"] = "kg", note: str = "") -> dict[str, Any]:
        """Record the user's measured weight with original unit and timestamp including offset. Never infer a measurement or replace history with a target. Use the same entry_key on retry."""
        return creating("weights", {"measured_at": measured_at, "value": value, "unit": unit, "note": note}, entry_key)

    @tool
    async def record_steps(measured_at: str, value: int, entry_key: str, note: str = "") -> dict[str, Any]:
        """Record explicitly provided steps, with timestamp including offset. Steps are an optional record, not an automatically increasing exercise target. Reuse entry_key on retry."""
        return creating("steps", {"measured_at": measured_at, "value": value, "note": note}, entry_key)

    @tool
    async def save_meal_recommendation(
        context_revision: int, target_date: str,
        options: list[dict[str, Any]], entry_key: str,
        meal_type: Literal["breakfast", "lunch", "dinner", "snack", "other"] = "other",
        context: str = "", note: str = "",
    ) -> dict[str, Any]:
        """Publish 1–5 next-meal choices grounded in query_health_context revision. Each option has unique id, title, description, ingredients, portion, substitutions and reason. Candidate fields list only actual proposed food and replacements. Put avoidance/allergy/cross-contact notices in top-level note, never candidate food lists; checks conservatively match restriction words. Allergy profiles require a visible note to verify ingredients/cross-contact, never a safety guarantee. No invented restaurants/prices or nutritional deficiency inferred from unknown portions. Current restrictions/revision are revalidated atomically; stale context must be read and regenerated. Saved choices are not actual intake."""
        return creating("recommendations", {"context_revision": context_revision, "target_date": target_date,
                                            "meal_type": meal_type, "options": options,
                                            "context": context, "note": note}, entry_key)

    @tool
    async def record_recommendation_feedback(
        recommendation_id: str, action: Literal["accepted", "replaced", "declined"],
        entry_key: str, option_id: str | None = None, note: str = "",
    ) -> dict[str, Any]:
        """Save the user's choice or difficulty (e.g. only delivery available), linked to a recommendation. accepted requires its option_id. This never creates food intake. The next review reads this note plus subsequent actual meals. Reuse entry_key on retry."""
        return service.feedback(recommendation_id, provenance({
            "id": source_key(actual_source() or "", f"feedback:{entry_key}"),
            "action": action, "option_id": option_id, "note": note,
        }), operation_key=operation("feedback", entry_key))

    @tool
    async def correct_health_record(
        kind: Literal["rules", "meals", "weights", "steps"], identifier: str,
        record: dict[str, Any], entry_key: str,
    ) -> dict[str, Any]:
        """Patch an existing record by its ID: supply only changed editable fields. The service preserves omitted facts/provenance and reads the current revision atomically; optional explicit revision still detects stale edits. Rule pause/resume uses {status:paused|active}. Reuse entry_key on retry."""
        return service.patch_record(kind, identifier, record, operation_key=operation("correct", entry_key))

    @tool
    async def delete_health_record(
        kind: Literal["rules", "meals", "weights", "steps"], identifier: str,
        entry_key: str, revision: int | None = None,
    ) -> dict[str, Any]:
        """Delete a record the user explicitly retracts, by its ID. Current revision is read atomically when omitted; an explicit stale revision still conflicts. Do not delete real food to make adherence look better. Reuse entry_key on retry."""
        return service.delete(kind, identifier, revision, operation_key=operation("delete", entry_key))

    @tool
    async def save_health_reminders(reminders: dict[str, Any], entry_key: str) -> dict[str, Any]:
        """Patch only changed local-reminder preferences; omitted slots/timezone/quiet hours are preserved. Revision is optional and read atomically, explicit stale revisions conflict. Fields:enabled,timezone,slots(id,time HH:mm,meal_type,kind meal/review),quiet_start/end,max_per_day,paused_dates,tone. Saving preferences is not proof of phone notification delivery; device must sync schedules."""
        return service.patch_reminders(reminders, operation_key=operation("reminders", entry_key))

    return [query_health_context, save_health_profile, save_diet_rule, record_meal,
            record_weight, record_steps, save_meal_recommendation, record_recommendation_feedback,
            correct_health_record, delete_health_record, save_health_reminders]
