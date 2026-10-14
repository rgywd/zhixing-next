"""Health agent tools: the same service and receipts as direct phone input."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal

from langchain_core.tools import tool

from .health_service import HealthService, source_key

if TYPE_CHECKING:
    from .config import Settings

HEALTH_TOOL_NAMES = [
    "query_health_context", "save_health_profile", "save_diet_rule", "record_meal",
    "record_weight", "record_steps", "save_meal_recommendation",
    "record_recommendation_feedback", "correct_health_record", "delete_health_record",
    "save_health_reminders",
]

HEALTH_INSTRUCTIONS = """你是知行的饮食与体重助手。先读取 query_health_context 的当前资料、有效规范、近期实际记录、建议反馈和餐费摘要，再记录、建议和回顾。服务数据是真实依据，不用共享记忆替代。
用户明确提供的饮食、体重、活动限制和要求可以直接记录；AI提出的新规范用 origin=assistant_proposal/status=proposed，用户明确采纳后才生效。规则不填生效日期则持续沿用；指定一天时前后日期相同，暂停用status=paused。写入数字和目标来自用户，不能套固定热量、体重、步数或减重速度。膝盖或其他活动限制须遵守，不推荐通过额外运动补偿摄入。
每笔写入给一个语义稳定的 entry_key（例如 meal:lunch:1、weight:1）；重试和重新委派沿用同一键。源输入由系统固定，不能为了绕过冲突换键。只能依据成功工具回执声称已经记录或修改，发生冲突先读当前数据再处理。
饮食记录是实际吃下或用户明确跳过的内容；计划、推荐、采纳绝不能伪装成已吃。漏记只表示未知，不表示没吃或不达标。照片不能证明精确克数或营养；若估算能量，必须提供minimum/maximum/basis并说明估算。付款金额不推断食物，食物不推断付款金额。
推荐读取最新revision并作为context_revision传给save_meal_recommendation。每个option须包含id、title、description、ingredients、portion、substitutions、reason；已知过敏/明确禁忌不能出现在候选或替换中，成分不明先补充信息，不承诺过敏安全。候选标题、描述、食材、份量与替换列表只写实际推荐食物；过敏禁忌、避免某食物及交叉接触提醒放在推荐的顶层note，不写进候选食物列表，程序会保守检查候选的禁忌词。存在过敏资料时，顶层note及最终用户可见回复都必须提醒核对配料与交叉接触风险；不能因候选未出现某食物名就宣称安全或已排除全部过敏原。
实际食物缺少份量、配料或完整摄入信息时，不推断蛋白质不足、热量不足、摄入过低或已摄入过量；给均衡搭配建议时明确依据是用户约定，而非虚构的营养结论。用户没有厨房且未确认可加热时，优先开袋即食或商家已经做好、送到即可吃的组合；不要默认有微波炉、炉具或其他加热条件。
食物类型、份量与可替换项应能照着执行；商家、实时价格或库存没有来源就不编造。体重变化、财务额度及其他程序已计算数字直接引用服务摘要，不自行口算或更改小数位。程序会验证已知限制和修订号，若记录或约定已变需重新生成。不要给极端限制、禁食、药物、惩罚性运动或诊疗建议；不适、持续饥饿或难执行优先调整，必要时建议专业帮助。
采纳、替换、放弃用record_recommendation_feedback保存option_id及困难note。已有反馈视为历史选择，内部版本变化不要求用户重新采纳或补做状态操作；实际吃完仍关联原recommendation_id，按实际食物和份量记录。日常回执简短说明已经保存的选择，省略内部ID、revision与状态迁移，用户不需要管理这些信息。之后的实际饮食用recommendation_id关联，次日回顾必须读取这些选择、困难与实际记录，再说明一项下一步调整。修改资料、规范与记录后尚未采纳的旧建议可能过期，需要基于最新限制重新推荐，不能继续声称仍适用。
纠正先读记录id/revision，correct_health_record传完整可编辑字段并保留原事实来源；不用另建一条冒充纠正。提醒只保存本机排期偏好，手机同步成功才代表已排期，不把偏好保存或工具成功说成通知已到达；今天不提醒只追加当地日期到paused_dates。模型不可用时用户仍可在健康页直接记录。"""


def create_health_tools(settings: Settings, conversation_id: str, source_id: str | None = None) -> list[Any]:
    from .store import Store

    store = Store(settings)
    service = HealthService(store)

    def provenance(record):
        return {**record, "source_id": source_id, "conversation_id": conversation_id}

    def operation(kind, entry_key):
        return f"health:{kind}:{source_key(source_id or '', entry_key)}"

    def creating(kind, record, entry_key):
        key = operation(kind, entry_key)
        payload = provenance({**record, "id": source_key(source_id or '', f'{kind}:{entry_key}')})
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
        """Save the complete current user-provided profile with its revision from query_health_context. Fields: height_cm, activity_limitations, food_allergies, food_exclusions, preferences, goals, note. No numeric targets may be invented. Reuse entry_key on retry."""
        return service.set_profile(profile, operation_key=operation("profile", entry_key))

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
            "id": source_key(source_id or "", f"feedback:{entry_key}"),
            "action": action, "option_id": option_id, "note": note,
        }), operation_key=operation("feedback", entry_key))

    @tool
    async def correct_health_record(
        kind: Literal["rules", "meals", "weights", "steps"], identifier: str,
        record: dict[str, Any], entry_key: str,
    ) -> dict[str, Any]:
        """Correct an existing record after reading its id/revision. Supply the COMPLETE editable record with revision, omitting created_at/updated_at/value_kg. Do not create a duplicate. Rule pause/resume also uses this tool. Reuse entry_key on retry."""
        return service.update(kind, identifier, record, operation_key=operation("correct", entry_key))

    @tool
    async def delete_health_record(
        kind: Literal["rules", "meals", "weights", "steps"], identifier: str,
        revision: int, entry_key: str,
    ) -> dict[str, Any]:
        """Delete only a health record the user explicitly retracts, using its current id/revision. Do not delete real food to make adherence look better. Reuse entry_key on retry."""
        return service.delete(kind, identifier, revision, operation_key=operation("delete", entry_key))

    @tool
    async def save_health_reminders(reminders: dict[str, Any], entry_key: str) -> dict[str, Any]:
        """Save full local-reminder preferences plus current revision: enabled, IANA timezone, slots(id,time HH:mm,meal_type,kind meal/review), quiet_start/end, max_per_day, paused_dates, tone. No repeated nagging. Saving preferences is not proof of phone notification delivery; device must sync schedules."""
        return service.set_reminders(reminders, operation_key=operation("reminders", entry_key))

    return [query_health_context, save_health_profile, save_diet_rule, record_meal,
            record_weight, record_steps, save_meal_recommendation, record_recommendation_feedback,
            correct_health_record, delete_health_record, save_health_reminders]
