"""Agent access to the existing durable scheduling service."""

from datetime import UTC, datetime
from uuid import NAMESPACE_URL, uuid5

from langchain_core.tools import tool

from .schemas import ScheduleInput
from .store import Store


def create_schedule_tools(settings, run):
    store = Store(settings)

    @tool
    async def list_scheduled_tasks(cursor: int = 0) -> dict:
        """Read the user's actual persistent scheduled tasks and their IDs. Times are UTC. Use before changing an existing schedule."""
        return {"now_utc": datetime.now(UTC).isoformat(), **store.list_schedules(cursor=cursor)}

    @tool
    async def schedule_task(
        prompt: str, next_run_at: str, interval_seconds: int | None = None
    ) -> dict:
        """Create a user-requested scheduled task in this conversation. next_run_at must be an ISO datetime with an explicit timezone; clarify timezone only if unknown and relevant. Omit interval_seconds for a one-time task. The same request within a run is idempotent. This schedules execution, not an external push notification."""
        identifier = str(
            uuid5(NAMESPACE_URL, f"{run['id']}:{prompt}:{next_run_at}:{interval_seconds}")
        )
        body = ScheduleInput(
            id=identifier,
            conversation_id=run["conversation_id"],
            prompt=prompt,
            next_run_at=next_run_at,
            interval_seconds=interval_seconds,
        )
        if body.next_run_at <= datetime.now(UTC):
            raise ValueError("Scheduled time must be in the future")
        return store.create_schedule(**body.model_dump())

    @tool
    async def set_schedule_enabled(schedule_id: str, enabled: bool) -> dict:
        """Pause or resume an existing scheduled task at the user's request. Obtain its exact ID from list_scheduled_tasks."""
        return store.update_schedule(schedule_id, enabled)

    return [list_scheduled_tasks, schedule_task, set_schedule_enabled]


def create_background_task_tool(settings, run):
    store = Store(settings)

    @tool
    async def start_background_task(instructions: str) -> dict:
        """Start an execution task for the user's requested multi-step research, scripting, browser or document work. Include the goal, constraints and relevant context. It runs after this chat reply in the same conversation, with the configured task model and original attachments, and delivers its own result. Do not say the work is finished when this returns queued."""
        if not instructions.strip() or len(instructions) > 100000:
            raise ValueError("Provide bounded, nonempty task instructions")
        identifier = str(uuid5(NAMESPACE_URL, f"task:{run['id']}:{instructions}"))
        receipt = store.submit_message(
            run["conversation_id"],
            id=identifier,
            content=instructions,
            kind="task",
            attachments=[item["id"] for item in store.run_attachments(run["id"])],
            search_provider_id=run.get("search_provider_id"),
            source_run_id=run["id"],
        )
        return {"run_id": receipt["run"]["id"], "status": receipt["run"]["status"]}

    return start_background_task
