"""Docker-backed Deep Agents filesystem. No command is ever run in a host shell."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shlex
import subprocess
import time
from pathlib import Path
from uuid import uuid4

from deepagents.backends.protocol import ExecuteResponse, FileDownloadResponse, FileUploadResponse
from deepagents.backends.sandbox import BaseSandbox

from .config import Settings
from .tools import FileAccess

OUTPUT_LIMIT = 64 * 1024


def owner_label(settings: Settings) -> str:
    return hashlib.sha256(str(settings.data_dir.resolve()).encode()).hexdigest()[:24]


async def docker(*args: str, timeout=30) -> tuple[int, str]:
    process = await asyncio.create_subprocess_exec(
        "docker",
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout)
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.communicate()
        raise
    return process.returncode, output.decode(errors="replace")[:OUTPUT_LIMIT]


async def cleanup_orphans(settings: Settings) -> None:
    """Called only while owning the worker lock, before recovering interrupted runs."""
    registry = settings.data_dir / "executions"
    markers = list(registry.glob("zhixing-*.json")) if registry.exists() else []
    if not settings.execution.enabled and not markers:
        return
    code, output = await docker(
        "ps", "-aq", "--filter", f"label=zhixing.owner={owner_label(settings)}"
    )
    if code:
        raise RuntimeError("Cannot reconcile sandbox processes: Docker is unavailable")
    identifiers = output.split()
    if identifiers:
        code, _ = await docker("rm", "-f", *identifiers)
        if code:
            raise RuntimeError("Could not stop a previous execution container")
    from .store import Store

    store = Store(settings)
    for marker in markers:
        record = json.loads(marker.read_text())
        store.add_event(
            record["run_id"],
            "execution",
            {
                "id": marker.stem,
                "status": "interrupted",
                "stopped": True,
                "reason": "worker_restart",
            },
            allow_terminal=True,
        )
        marker.unlink()


class DockerSandbox(BaseSandbox):
    def __init__(self, settings: Settings, workspace: Path, run_id: str, emit):
        self.settings, self.workspace, self.run_id, self.emit = settings, workspace, run_id, emit
        self.container = "zhixing-" + uuid4().hex
        self._started = False
        self._closed = False
        self._lock = asyncio.Lock()
        self._loop = asyncio.get_running_loop()
        self._marker = settings.data_dir / "executions" / f"{self.container}.json"

    @property
    def id(self) -> str:
        return self.container

    async def start(self) -> None:
        if self._closed:
            raise RuntimeError("Execution has already stopped")
        if self._started:
            return
        if not self.settings.execution.enabled:
            raise PermissionError("Execution is not enabled")
        if os.name != "posix" or os.getuid() == 0:
            raise RuntimeError("Execution requires a non-root macOS/Linux service user")
        access = FileAccess(self.settings, self.workspace)
        workspace, _ = access.authorize(".", write=True)
        # Mount options use commas as delimiters. Reject ambiguous host paths.
        if "," in str(workspace):
            raise ValueError("Workspace cannot contain commas")
        options = self.settings.execution
        self._marker.parent.mkdir(exist_ok=True)
        # Persist ownership before spawning. A worker crash cannot hide an in-flight container.
        from .resources import _atomic_write

        _atomic_write(self._marker, json.dumps({"run_id": self.run_id}).encode())
        args = [
            "run",
            "-d",
            "--name",
            self.container,
            "--pull=never",
            "--label",
            f"zhixing.owner={owner_label(self.settings)}",
            "--label",
            f"zhixing.run={self.run_id}",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=256",
            f"--memory={options.memory_mb}m",
            f"--memory-swap={options.memory_mb}m",
            f"--cpus={options.cpus}",
            f"--network={options.network}",
            "--user",
            f"{os.getuid()}:{os.getgid()}",
            "--tmpfs",
            "/tmp:rw,nosuid,size=536870912,mode=1777",
            "--shm-size=128m",
            "--env",
            "HOME=/tmp/home",
            "--env",
            "PYTHONDONTWRITEBYTECODE=1",
            "--mount",
            f"type=bind,src={workspace},dst=/workspace",
            "--workdir",
            "/workspace",
            options.image,
            "sleep",
            "3600",
        ]
        try:
            code, _ = await docker(*args)
            if code:
                raise RuntimeError(
                    "Sandbox startup failed; check the configured image and Docker engine"
                )
            self._started = True
        except BaseException:
            await self._stop()
            raise

    async def close(self) -> None:
        self._closed = True
        async with self._lock:
            await self._stop()

    async def _stop(self) -> None:
        if not self._marker.exists() and not self._started:
            return
        code, output = await docker("rm", "-f", self.container)
        if code and "No such container" not in output:
            raise RuntimeError("Sandbox stop is unconfirmed; execution must be reconciled")
        self._started = False
        self._marker.unlink(missing_ok=True)

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        # SDK sync fallbacks run in threads. All lifecycle operations remain on the owning loop.
        return asyncio.run_coroutine_threadsafe(
            self.aexecute(command, timeout=timeout), self._loop
        ).result()

    async def aexecute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        async with self._lock:
            await self.start()
            identifier = str(uuid4())
            seconds = min(max(timeout or self.settings.execution.timeout_seconds, 1), 1800)
            await self.emit(
                "execution", {"id": identifier, "status": "started", "timeout_seconds": seconds}
            )
            process = await asyncio.create_subprocess_exec(
                "docker",
                "exec",
                self.container,
                "/bin/sh",
                "-lc",
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            captured = bytearray()
            total = 0
            last_progress = 0.0

            async def read_output():
                nonlocal total, last_progress
                while chunk := await process.stdout.read(4096):
                    total += len(chunk)
                    if len(captured) < OUTPUT_LIMIT:
                        captured.extend(chunk[: OUTPUT_LIMIT - len(captured)])
                    if time.monotonic() - last_progress > 1:
                        last_progress = time.monotonic()
                        await self.emit(
                            "execution",
                            {
                                "id": identifier,
                                "status": "running",
                                "output": chunk[-2000:].decode(errors="replace"),
                            },
                        )
                await process.wait()

            status = "completed"
            try:
                await asyncio.wait_for(read_output(), seconds)
            except (asyncio.CancelledError, TimeoutError) as exc:
                status = "cancelled" if isinstance(exc, asyncio.CancelledError) else "timed_out"
                # Killing the docker CLI alone leaves the command and its descendants alive.
                await self._stop()
                if process.returncode is None:
                    process.kill()
                await process.wait()
                await self.emit(
                    "execution",
                    {
                        "id": identifier,
                        "status": status,
                        "stopped": True,
                        "output": captured.decode(errors="replace"),
                    },
                )
                if isinstance(exc, asyncio.CancelledError):
                    raise
                return ExecuteResponse(
                    output=captured.decode(errors="replace")
                    + "\nExecution timed out; container and child processes stopped.",
                    exit_code=124,
                    truncated=total > OUTPUT_LIMIT,
                )
            if process.returncode:
                status = "failed"
            output = captured.decode(errors="replace")
            await self.emit(
                "execution",
                {
                    "id": identifier,
                    "status": status,
                    "exit_code": process.returncode,
                    "output": output,
                    "truncated": total > OUTPUT_LIMIT,
                },
            )
            return ExecuteResponse(
                output=output, exit_code=process.returncode, truncated=total > OUTPUT_LIMIT
            )

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return asyncio.run_coroutine_threadsafe(self.aupload_files(files), self._loop).result()

    async def aupload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        results = []
        for path, content in files:
            try:
                await self._transfer(path, content)
                results.append(FileUploadResponse(path=path))
            except (OSError, ValueError, RuntimeError):
                results.append(FileUploadResponse(path=path, error="permission_denied"))
        return results

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        return asyncio.run_coroutine_threadsafe(self.adownload_files(paths), self._loop).result()

    async def adownload_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        results = []
        for path in paths:
            try:
                content = await self._transfer(path)
                results.append(FileDownloadResponse(path=path, content=content))
            except (OSError, ValueError, RuntimeError):
                results.append(FileDownloadResponse(path=path, error="file_not_found"))
        return results

    async def _transfer(self, path: str, data: bytes | None = None) -> bytes:
        if data is not None and len(data) > 20 * 1024 * 1024:
            raise ValueError("Transfer exceeds 20 MiB")
        async with self._lock:
            await self.start()
            script = "import sys,pathlib; p=pathlib.Path(sys.argv[1]); " + (
                "p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(sys.stdin.buffer.read())"
                if data is not None
                else "assert p.is_file(); f=p.open('rb'); b=f.read(20971521); assert len(b)<=20971520; sys.stdout.buffer.write(b)"
            )
            process = await asyncio.create_subprocess_exec(
                "docker",
                "exec",
                "-i",
                self.container,
                "python",
                "-c",
                script,
                path,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                output, _ = await asyncio.wait_for(process.communicate(data), 30)
            except BaseException:
                await self._stop()
                if process.returncode is None:
                    process.kill()
                await process.communicate()
                raise
            if process.returncode:
                raise RuntimeError("Sandbox file transfer failed")
            return output


def execution_status(settings: Settings) -> dict:
    if not settings.execution.enabled:
        return {"execution_available": False, "execution_reason": "服务端尚未启用隔离执行。"}
    try:
        result = subprocess.run(
            ["docker", "image", "inspect", settings.execution.image], capture_output=True, timeout=3
        )
        available = result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        available = False
    return {
        "execution_available": available,
        "execution_reason": None if available else "Docker 或执行镜像暂不可用。",
    }


def create_environment_tool(sandbox: DockerSandbox):
    from langchain_core.tools import tool

    @tool
    async def inspect_environment() -> dict:
        """Inspect the actual isolated execution environment, available runtimes and network scope without reading credentials."""
        script = "import json,platform,shutil; print(json.dumps(dict(os=platform.system(),architecture=platform.machine(),python=platform.python_version(),node=shutil.which('node'),libreoffice=shutil.which('libreoffice'))))"
        result = await sandbox.aexecute("python -c " + shlex.quote(script))
        if result.exit_code:
            raise RuntimeError("Execution environment probe failed")
        return {
            **json.loads(result.output),
            "workspace": "/workspace",
            "host_directories": [
                {"path": str(grant.path), "writable": grant.writable}
                for grant in sandbox.settings.grants
            ],
            "network": sandbox.settings.execution.network,
            "memory_mb": sandbox.settings.execution.memory_mb,
            "cpus": sandbox.settings.execution.cpus,
            "execution_available": True,
            "note": "Host grants remain available only through physical file tools; they are not container mounts.",
        }

    return inspect_environment
