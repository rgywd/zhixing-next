"""One persistent coordinator with separate chat and execution capacity."""

from __future__ import annotations

import asyncio
import logging
import signal
import time
from collections.abc import Awaitable, Callable

from filelock import FileLock, Timeout

from .config import Settings, load_settings
from .memory import explicit_memory_request, organize_run
from .store import Store

logger = logging.getLogger(__name__)
AgentRunner = Callable[..., Awaitable[str]]


class Worker:
    def __init__(self, settings: Settings, runner: AgentRunner | None = None):
        self.settings = settings
        self.store = Store(settings)
        if runner is None:
            from .runtime import run_agent

            runner = run_agent
        self.runner = runner
        self.active: dict[str, tuple[str, asyncio.Task]] = {}
        self.memory_task: asyncio.Task | None = None
        self._memory_lock = asyncio.Lock()
        self._last_maintenance = 0.0

    async def _organize(self, run: dict) -> bool:
        async with self._memory_lock:
            while self.store.get_run(run["id"])["memory_processed"] == 0:
                # Apply earlier conversations first, so a later "forget" cannot be
                # followed by an older extraction recreating the same fact.
                pending = self.store.next_memory_run()
                if pending is None:
                    break
                try:
                    await organize_run(self.settings, self.store, pending)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning("memory pass for run %s failed (%s)", pending["id"], type(exc).__name__)
                    self.store.fail_memory_run(pending["id"])
            return self.store.get_run(run["id"])["memory_processed"] == 1

    async def _execute(self, run: dict) -> None:
        run_id = run["id"]

        async def emit(event_type: str, data: dict) -> None:
            self.store.add_event(run_id, event_type, data)

        async def controls() -> dict:
            return self.store.get_controls(run_id)

        async def acknowledge(ids: list[str]) -> None:
            self.store.acknowledge_steers(run_id, ids)

        try:
            assistant = self.store.get_assistant()
            run["agent"] = self.store.get_agent(run["agent_id"]) if run.get("agent_id") else None
            run["agents"] = self.store.list_agents()["items"] if not run.get("agent_id") else []
            run["search_provider"] = self.store.get_search_provider(run["search_provider_id"]) if run.get("search_provider_id") else None
            result = await self.runner(
                self.settings, run,
                persona=f"Assistant name: {assistant['name']}\n{assistant['persona']}", emit=emit,
                controls=controls, acknowledge=acknowledge,
            )
            self.store.finish_run(run_id, "completed", result=result)
            current_input = "\n".join(item["content"] for item in self.store.memory_context(run_id))
            if explicit_memory_request(current_input) and not await self._organize(run):
                self.store.add_memory_failure_notice(run_id)
        except asyncio.CancelledError:
            requested = self.store.get_controls(run_id)["cancel_requested"]
            self.store.finish_run(
                run_id, "cancelled" if requested else "interrupted",
                error=None if requested else "服务停止，运行已保存。请检查已完成步骤后继续会话。",
            )
        except Exception as exc:
            # Vendor exception strings can contain request payloads and credentials.
            # Keep user-facing diagnostics bounded to known configuration errors.
            from .runtime import RuntimeConfigurationError

            message = str(exc) if isinstance(exc, RuntimeConfigurationError) else (
                f"运行失败（{type(exc).__name__}）。请检查模型配置或服务连接后继续。"
            )
            logger.warning("run %s failed (%s)", run_id, type(exc).__name__)
            self.store.finish_run(run_id, "failed", error=message)

    async def tick(self) -> None:
        if self.memory_task and self.memory_task.done():
            await self.memory_task
            self.memory_task = None
        for kind, (run_id, task) in list(self.active.items()):
            if task.done():
                # Retrieve unexpected persistence errors instead of silently discarding them.
                await task
                del self.active[kind]
            elif self.store.get_controls(run_id)["cancel_requested"] and not task.cancelling():
                task.cancel()
        if "task" not in self.active and any((self.settings.data_dir / "executions").glob("zhixing-*.json")):
            # A failed Docker stop must be reconciled before admitting more work.
            from .execution import cleanup_orphans

            await cleanup_orphans(self.settings)
        now = time.monotonic()
        if now - self._last_maintenance >= 1:
            self.store.heartbeat()
            self.store.tick_schedules()
            self._last_maintenance = now
        for kind in ("chat", "task"):
            if kind not in self.active:
                run = self.store.claim_next(kind)
                if run:
                    self.active[kind] = (run["id"], asyncio.create_task(self._execute(run)))
        if self.memory_task is None and "chat" not in self.active:
            pending = self.store.next_memory_run()
            if pending:
                self.memory_task = asyncio.create_task(self._organize(pending))

    async def run(self, stop: asyncio.Event | None = None) -> None:
        stop = stop or asyncio.Event()
        self.settings.data_dir.mkdir(parents=True, exist_ok=True)
        lock = FileLock(self.settings.data_dir / "worker.lock")
        try:
            with lock.acquire(timeout=0):
                from .execution import cleanup_orphans

                await cleanup_orphans(self.settings)
                self.store.recover_interrupted()
                logger.info("worker started; one chat slot and one execution slot")
                try:
                    while not stop.is_set():
                        await self.tick()
                        try:
                            await asyncio.wait_for(stop.wait(), self.settings.poll_interval)
                        except TimeoutError:
                            pass
                finally:
                    pending = [task for _, task in self.active.values()]
                    if self.memory_task is not None:
                        pending.append(self.memory_task)
                    for task in pending:
                        if not task.cancelling():
                            task.cancel()
                    if pending:
                        await asyncio.gather(*pending)
                    self.active.clear()
        except Timeout as exc:
            raise RuntimeError("Another worker owns this data directory") from exc


async def _serve() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signum, stop.set)
        except NotImplementedError:
            # asyncio.run handles Ctrl+C on Windows; Linux/macOS use both signals above.
            pass
    await Worker(load_settings()).run(stop)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    # Transport INFO/DEBUG records can include signed URL query parameters.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    try:
        asyncio.run(_serve())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
