"""Managed long-running commands with durable ownership and real exit receipts."""

import asyncio
import json
import shlex
from typing import Annotated
from uuid import uuid4

from langchain_core.tools import tool
from pydantic import Field

from .store import timestamp


class Processes:
    def __init__(self, store, run, sandbox):
        self.store, self.run, self.sandbox = store, run, sandbox

    async def action(self, identifier, action):
        with self.store._connection() as db:
            row = self.store._require(db, "processes", identifier)
            if row["run_id"] != self.run["id"]:
                raise PermissionError("Process belongs to another task")
        if row["container"] != self.sandbox.container or row["state"] == "interrupted":
            return {
                "id": identifier,
                "state": "interrupted",
                "exit_code": None,
                "output": "Container ended. Inspect persistent files before deciding whether to restart.",
            }
        result = await self.sandbox.aexecute(
            f"python /opt/zhixing/process.py {action} {identifier}"
        )
        if result.exit_code:
            raise ValueError("Process status could not be confirmed; do not assume completion.")
        receipt = json.loads(result.output)
        receipt.pop("pid", None)
        with self.store._connection(write=True) as db:
            db.execute(
                "UPDATE processes SET state=?,exit_code=? WHERE id=?",
                (receipt["state"], receipt["exit_code"], identifier),
            )
        return {"id": identifier, **receipt}

    async def start(self, command, timeout):
        identifier = uuid4().hex
        with self.store._connection(write=True) as db:
            live = db.execute(
                "SELECT count(*) FROM processes WHERE run_id=? AND state IN ('starting','running')",
                (self.run["id"],),
            ).fetchone()[0]
            if live >= 4:
                raise ValueError(
                    "At most four active processes per task. Read or stop existing processes first."
                )
            db.execute(
                "INSERT INTO processes VALUES(?,?,?,?, 'starting',NULL,?)",
                (identifier, self.run["id"], self.sandbox.container, command, timestamp()),
            )
        payload = shlex.quote(
            json.dumps(
                {
                    "command": command,
                    "timeout": min(timeout, self.store.settings.execution.timeout_seconds),
                }
            )
        )
        result = await self.sandbox.aexecute(
            f"printf %s {payload} | python /opt/zhixing/process.py start {identifier}"
        )
        if result.exit_code:
            raise ValueError(
                "Process startup is unconfirmed. Inspect task process receipts before retrying."
            )
        return await self.action(identifier, "read")


def create_process_tools(store, run, sandbox):
    manager = Processes(store, run, sandbox)

    @tool
    async def start_process(
        command: Annotated[str, Field(min_length=1, max_length=20000)],
        timeout_seconds: Annotated[int, Field(ge=1, le=1800)] = 120,
    ) -> dict:
        """Start a bounded background command inside the sandbox and return its process ID immediately. No interactive stdin. Use read_process/wait_process to verify its actual exit code before claiming success. Processes stop on task end, pause or cancellation."""
        return await manager.start(command, timeout_seconds)

    @tool
    async def read_process(process_id: str) -> dict:
        """Read bounded output and actual state/exit code of a process owned by this task. After restart its state is interrupted, never running."""
        return await manager.action(process_id, "read")

    @tool
    async def wait_process(
        process_id: str, seconds: Annotated[int, Field(ge=1, le=20)] = 10
    ) -> dict:
        """Wait at most 20 seconds for a managed process. A running receipt does not mean success; continue independent work or wait again."""
        deadline = asyncio.get_running_loop().time() + seconds
        while True:
            receipt = await manager.action(process_id, "read")
            if (
                receipt["state"] not in {"starting", "running"}
                or asyncio.get_running_loop().time() >= deadline
            ):
                return receipt
            await asyncio.sleep(0.5)

    @tool
    async def stop_process(process_id: str) -> dict:
        """Stop a managed process and its child process group, returning its confirmed stop state."""
        await manager.action(process_id, "stop")
        return await wait_process.ainvoke({"process_id": process_id, "seconds": 5})

    return [start_process, read_process, wait_process, stop_process]
