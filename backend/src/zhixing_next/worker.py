"""One persistent coordinator with separate chat and execution capacity."""

from __future__ import annotations

import asyncio
import logging
import signal
import time
from collections.abc import Awaitable, Callable

from filelock import FileLock, Timeout

from .config import Settings, load_settings
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
        self._last_maintenance = 0.0

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
            result = await self.runner(
                self.settings, run,
                persona=f"Assistant name: {assistant['name']}\n{assistant['persona']}", emit=emit,
                controls=controls, acknowledge=acknowledge,
            )
            self.store.finish_run(run_id, "completed", result=result)
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
        for kind, (run_id, task) in list(self.active.items()):
            if task.done():
                # Retrieve unexpected persistence errors instead of silently discarding them.
                await task
                del self.active[kind]
            elif self.store.get_controls(run_id)["cancel_requested"] and not task.cancelling():
                task.cancel()
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

    async def run(self, stop: asyncio.Event | None = None) -> None:
        stop = stop or asyncio.Event()
        self.settings.data_dir.mkdir(parents=True, exist_ok=True)
        lock = FileLock(self.settings.data_dir / "worker.lock")
        try:
            with lock.acquire(timeout=0):
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
