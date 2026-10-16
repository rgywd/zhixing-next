"""Main-agent tools for one actual meal plus its explicitly stated payment."""

from langchain_core.tools import tool

from .finance_context import active_finance_input, delegated_finance_input
from .health_schema import LifePaymentChanges, MealChanges, MealFields, supplied
from .life_service import LifeService
from .meal_input import normalise_meal_fields

LIFE_TOOL_NAMES = ["record_life_meal", "correct_life_meal", "query_life_events"]
LIFE_INSTRUCTIONS = """一句输入同时包含明确餐费和实际饮食时，优先record_life_meal一次原子保存两项；不要再委派子助手重复记同一笔。meal只写实际吃过或明确跳过的记录；付款amount和业务日期必须来自用户已知信息，只有菜品照片不推断金额。缺金额时只保存meal。稳定entry_key跨重试保持一致。工具成功的event_id关联两域，用户纠正同一顿的日期/金额/食物时用correct_life_meal；需要同时改日期时meal_changes.occurred_at和finance_changes.occurred_on都填写。纠正前可query_life_events拿event_id，引用原记录，不另建两份。此工具是同一数据库内的原子写入；任一记录失败则两项均未保存，不能声称部分成功。"""
LIFE_INSTRUCTIONS += " 用餐时刻未知就省略occurred_at，只知日期用YYYY-MM-DD，不按午餐等类型猜12点。程序提供的原消息记录时钟不代表实际用餐时刻，实际时刻未知时回复需保留未知。portion逐项只记用户说出的份量；例如只说米饭剩一半，就仅记录米饭信息，豆腐和青菜份量仍未知，不能补一份。"
LIFE_INSTRUCTIONS += " 用户已明确纠正同一顿时，description和portion中对同一事实的重复表达必须在本次correct_life_meal原子纠正中同步更新，去掉已推翻的旧份量；保留其他食物、日期和未纠正内容。明确纠错已获授权，不再询问是否同步描述，也不要求用户再次批准同一纠正。"


def create_life_tools(settings, conversation_id, source_id):
    from .store import Store

    store = Store(settings)
    service = LifeService(store)

    def actual_source():
        return active_finance_input.get() or delegated_finance_input.get() or source_id

    @tool
    async def record_life_meal(
        entry_key: str,
        meal: MealFields,
        amount: str | None = None,
        occurred_on: str | None = None,
        note: str = "",
    ) -> dict:
        """Atomically record actual food and optional explicitly stated CNY payment. meal occurred_at is optional: use a precise timestamp only for a user-stated actual clock, YYYY-MM-DD for only a known date, otherwise omit. An omitted clock is source-message recording metadata with actual meal time unknown, never a factual mealtime. portion lists only explicitly stated food quantities; never fill unspecified dishes with one serving or other invented portions. Other meal fields:description,meal_type(breakfast/lunch/dinner/snack/other),note,status(recorded/skipped),recommendation_id,estimated_energy(optional minimum/maximum/basis). amount never inferred from food/photo; payment occurred_on is YYYY-MM-DD. Keep entry_key stable across retry. If either record fails, neither is saved."""
        fields = supplied(meal)
        if not fields.get("occurred_at") and occurred_on:
            fields = {**fields, "occurred_at": occurred_on}
        return service.record_meal(
            source_id=actual_source(),
            entry_key=entry_key,
            conversation_id=conversation_id,
            meal=normalise_meal_fields(store, actual_source(), fields),
            amount=amount,
            occurred_on=occurred_on,
            note=note,
        )

    @tool
    async def correct_life_meal(
        event_id: str,
        entry_key: str,
        meal_changes: MealChanges | None = None,
        finance_changes: LifePaymentChanges | None = None,
    ) -> dict:
        """Correct linked actual meal/payment in one transaction. Read event_id first. meal_changes contains only changed meal fields; finance_changes supports amount,occurred_on,category,note. Correct both date fields when both were wrong. Use a stable new operation entry_key. No duplicate records are created."""
        fields = supplied(meal_changes)
        if fields is not None and ("occurred_at" in fields or "note" in fields):
            from .health_service import HealthService

            with store._connection() as db:
                event = store._require(db, "life_events", event_id)
                previous = HealthService(store)._require(db, "meals", event["meal_id"])
            fields = normalise_meal_fields(store, actual_source(), fields, patch=True, previous=previous)
        return service.correct_meal(
            event_id,
            source_id=actual_source(),
            entry_key=entry_key,
            meal_changes=fields,
            finance_changes=supplied(finance_changes),
        )

    @tool
    async def query_life_events(source_id_filter: str | None = None) -> dict:
        """Read recent linked meal/payment IDs to correct their original records. Optionally filter a known source message ID. The main finance/health tools supply current detailed facts."""
        return service.list_events(source_id=source_id_filter)

    return [record_life_meal, correct_life_meal, query_life_events]
