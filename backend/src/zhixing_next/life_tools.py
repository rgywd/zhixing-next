"""Main-agent tools for one actual meal plus its explicitly stated payment."""

from langchain_core.tools import tool

from .life_service import LifeService

LIFE_TOOL_NAMES = ["record_life_meal", "correct_life_meal", "query_life_events"]
LIFE_INSTRUCTIONS = """一句输入同时包含明确餐费和实际饮食时，优先record_life_meal一次原子保存两项；不要再委派子助手重复记同一笔。meal只写实际吃过或明确跳过的记录；付款amount和业务日期必须来自用户已知信息，只有菜品照片不推断金额。缺金额时只保存meal。稳定entry_key跨重试保持一致。工具成功的event_id关联两域，用户纠正同一顿的日期/金额/食物时用correct_life_meal；需要同时改日期时meal_changes.occurred_at和finance_changes.occurred_on都填写。纠正前可query_life_events拿event_id，引用原记录，不另建两份。此工具是同一数据库内的原子写入；任一记录失败则两项均未保存，不能声称部分成功。"""


def create_life_tools(settings, conversation_id, source_id):
    from .store import Store

    service = LifeService(Store(settings))

    @tool
    async def record_life_meal(
        entry_key: str,
        meal: dict,
        amount: str | None = None,
        occurred_on: str | None = None,
        note: str = "",
    ) -> dict:
        """Atomically record actual food and optional explicitly stated CNY payment. meal fields: occurred_at(with UTC offset),description,meal_type(breakfast/lunch/dinner/snack/other),portion,note,status(recorded/skipped),recommendation_id,estimated_energy(optional minimum/maximum/basis). amount never inferred from food/photo; payment occurred_on is YYYY-MM-DD. Keep entry_key stable for this item across retry. If either record fails, neither is saved."""
        return service.record_meal(
            source_id=source_id,
            entry_key=entry_key,
            conversation_id=conversation_id,
            meal=meal,
            amount=amount,
            occurred_on=occurred_on,
            note=note,
        )

    @tool
    async def correct_life_meal(
        event_id: str,
        entry_key: str,
        meal_changes: dict | None = None,
        finance_changes: dict | None = None,
    ) -> dict:
        """Correct linked actual meal/payment in one transaction. Read event_id first. meal_changes contains only changed meal fields; finance_changes supports amount,occurred_on,category,note. Correct both date fields when both were wrong. Use a stable new operation entry_key. No duplicate records are created."""
        return service.correct_meal(
            event_id,
            source_id=source_id,
            entry_key=entry_key,
            meal_changes=meal_changes,
            finance_changes=finance_changes,
        )

    @tool
    async def query_life_events(source_id_filter: str | None = None) -> dict:
        """Read recent linked meal/payment IDs to correct their original records. Optionally filter a known source message ID. The main finance/health tools supply current detailed facts."""
        return service.list_events(source_id=source_id_filter)

    return [record_life_meal, correct_life_meal, query_life_events]
