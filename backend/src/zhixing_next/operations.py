"""Durable tool receipts and human decisions. Unknown effects are never blindly replayed."""

import asyncio
import difflib
import hashlib
import json
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from filelock import FileLock
from langchain_core.messages import ToolMessage, message_to_dict, messages_from_dict
from langgraph.errors import GraphInterrupt
from langgraph.types import Command, interrupt

from .resources import _atomic_write
from .store import Store, StoreError, _json, _record, timestamp
from .tools import FileAccess

EFFECT_TOOLS = {
    "execute",
    "browser_action",
    "write_file",
    "edit_file",
    "delete",
    "task",
    "write_text_file",
    "copy_file",
    "publish_artifact",
    "record_finance_observation",
    "remove_finance_observation",
    "schedule_task",
    "set_schedule_enabled",
    "start_background_task",
}
LIMIT = 20 * 1024 * 1024


class RunPaused(Exception):
    """The graph has persisted an interrupt; this is neither success nor failure."""


def digest(data):
    return hashlib.sha256(data).hexdigest()


def operation_record(row):
    result = dict(row)
    for key in ("args", "plan", "result"):
        raw = result.pop(key + "_json")
        result[key] = json.loads(raw) if raw else None
    return result


def approval_record(row):
    result = dict(row)
    result["details"] = json.loads(result.pop("details_json"))
    return result


class Journal:
    def __init__(self, settings):
        self.store = Store(settings)
        self.settings = settings

    def operation(self, identifier):
        with self.store._connection() as db:
            row = db.execute("SELECT * FROM operations WHERE id=?", (identifier,)).fetchone()
            return operation_record(row) if row else None

    def prepare(self, run_id, call, plan):
        identifier = str(uuid5(NAMESPACE_URL, f"{run_id}:{call['id']}"))
        with self.store._connection(write=True) as db:
            db.execute(
                "INSERT OR IGNORE INTO operations VALUES(?,?,?,?,?,?,'prepared',NULL,?,?)",
                (
                    identifier,
                    run_id,
                    call["id"],
                    call["name"],
                    _json(call["args"]),
                    _json(plan),
                    timestamp(),
                    timestamp(),
                ),
            )
        result = self.operation(identifier)
        if result["tool"] != call["name"] or result["args"] != call["args"]:
            raise StoreError("operation_conflict", "同一步骤的参数发生变化，不能复用已有回执")
        return result

    def denied_target(self, run_id, path):
        with self.store._connection() as db:
            return (
                db.execute(
                    "SELECT 1 FROM operations WHERE run_id=? AND state='denied' AND json_extract(plan_json,'$.path')=?",
                    (run_id, path),
                ).fetchone()
                is not None
            )

    def set_state(self, identifier, state, result=None):
        with self.store._connection(write=True) as db:
            row = self.store._require(db, "operations", identifier)
            db.execute(
                "UPDATE operations SET state=?,result_json=?,updated_at=? WHERE id=?",
                (state, _json(result) if result is not None else None, timestamp(), identifier),
            )
            self.store._event(
                db,
                row["run_id"],
                "operation",
                {"id": identifier, "tool": row["tool"], "state": state},
            )

    def request_approval(self, run_id, identifier, kind, details, operation_id=None):
        with self.store._connection(write=True) as db:
            existing = db.execute("SELECT * FROM approvals WHERE id=?", (identifier,)).fetchone()
            if not existing:
                db.execute(
                    "INSERT INTO approvals VALUES(?,?,?,?,?,'pending',?,NULL)",
                    (identifier, run_id, operation_id, kind, _json(details), timestamp()),
                )
                self.store._event(
                    db, run_id, "approval", {"id": identifier, "kind": kind, "status": "pending"}
                )
            return approval_record(self.store._require(db, "approvals", identifier))

    def approvals(self, conversation_id=None, run_id=None):
        with self.store._connection() as db:
            rows = db.execute(
                "SELECT a.* FROM approvals a JOIN runs r ON r.id=a.run_id WHERE (? IS NULL OR r.conversation_id=?) AND (? IS NULL OR r.id=?) AND a.state='pending' ORDER BY a.created_at LIMIT 100",
                (conversation_id, conversation_id, run_id, run_id),
            ).fetchall()
            return {"items": [approval_record(row) for row in rows], "next_cursor": None}

    def approval_file(self, identifier, version):
        with self.store._connection() as db:
            approval = self.store._require(db, "approvals", identifier)
            if approval["kind"] != "overwrite":
                raise StoreError("no_file_preview", "此请求没有文件预览", 422)
            operation = operation_record(
                self.store._require(db, "operations", approval["operation_id"])
            )
        try:
            data = (
                self.settings.data_dir / "operation-files" / operation["id"] / version
            ).read_bytes()
        except OSError as exc:
            raise StoreError(
                "snapshot_unavailable", "预览副本不可读取，请检查服务数据备份"
            ) from exc
        if digest(data) != operation["plan"][version + "_sha256"]:
            raise StoreError("snapshot_changed", "预览文件校验失败")
        return Path(operation["plan"]["path"]).name, data

    def decide(self, identifier, decision):
        with self.store._connection(write=True) as db:
            row = self.store._require(db, "approvals", identifier)
            allowed = {"retry", "skip"} if row["kind"] == "uncertain" else {"approve", "deny"}
            if decision not in allowed:
                raise StoreError("invalid_decision", "此操作不支持该决定", 422)
            if row["state"] != "pending":
                if row["state"] == decision:
                    return approval_record(row)
                raise StoreError("decision_conflict", "此请求已有决定或已失效")
            run = self.store._require(db, "runs", row["run_id"])
            if run["status"] not in {"queued", "running"} or run["cancel_requested"]:
                raise StoreError("approval_expired", "任务已停止，此批准请求已失效")
            db.execute(
                "UPDATE approvals SET state=?,decided_at=? WHERE id=?",
                (decision, timestamp(), identifier),
            )
            self.store._event(db, run["id"], "approval", {"id": identifier, "status": decision})
            if not db.execute(
                "SELECT 1 FROM approvals WHERE run_id=? AND state='pending'", (run["id"],)
            ).fetchone():
                db.execute(
                    "UPDATE runs SET phase='recovering' WHERE id=? AND status='queued'",
                    (run["id"],),
                )
            return approval_record(self.store._require(db, "approvals", identifier))

    def receipts(self, run_id):
        with self.store._connection() as db:
            self.store._require(db, "runs", run_id)
            rows = db.execute(
                "SELECT * FROM operations WHERE run_id=? ORDER BY created_at", (run_id,)
            ).fetchall()
            # Never return internal checkpoint encodings or full file contents to list UIs.
            return {
                "items": [
                    {
                        key: value
                        for key, value in operation_record(row).items()
                        if key not in {"args", "result"}
                    }
                    for row in rows
                ],
                "next_cursor": None,
            }

    def file_authorization(self, operation):
        if not operation["plan"]["requires_approval"]:
            return {"required": False}
        with self.store._connection() as db:
            row = db.execute(
                "SELECT id,state,decided_at FROM approvals WHERE id=?", (operation["id"],)
            ).fetchone()
        return {"required": True, **dict(row)} if row else {"required": True, "state": "pending"}

    def reconcile_service(self, operation):
        args, run_id = operation["args"], operation["run_id"]
        with self.store._connection() as db:
            if operation["tool"] == "schedule_task":
                from .services import schedule_identifier

                identifier = schedule_identifier(
                    run_id, args["prompt"], args["next_run_at"], args.get("interval_seconds")
                )
                row = db.execute("SELECT * FROM schedules WHERE id=?", (identifier,)).fetchone()
                return _record(row) if row else None
            if operation["tool"] == "start_background_task":
                identifier = str(uuid5(NAMESPACE_URL, f"task:{run_id}:{args['instructions']}"))
                row = db.execute(
                    "SELECT r.id,r.status FROM runs r JOIN messages m ON m.run_id=r.id WHERE m.id=?",
                    (identifier,),
                ).fetchone()
                return {"run_id": row["id"], "status": row["status"]} if row else None
        return None


def encode_result(result):
    if isinstance(result, ToolMessage):
        return {"kind": "message", "value": message_to_dict(result)}
    if isinstance(result, Command):
        update = dict(result.update or {})
        if "messages" in update:
            update["messages"] = [message_to_dict(message) for message in update["messages"]]
        return {"kind": "command", "update": update, "goto": result.goto}
    raise TypeError("Unsupported tool receipt")


def decode_result(result):
    if result["kind"] == "message":
        return messages_from_dict([result["value"]])[0]
    update = dict(result["update"])
    if "messages" in update:
        update["messages"] = messages_from_dict(update["messages"])
    return Command(update=update, goto=result["goto"])


class OperationRunner:
    def __init__(self, settings, run, sandbox=None):
        self.settings, self.run, self.sandbox = settings, run, sandbox
        self.journal = Journal(settings)
        self.access = FileAccess(settings, Path(run["workspace_path"]))

    def approval(self, identifier, kind, details, operation_id=None):
        approval = self.journal.request_approval(
            self.run["id"], identifier, kind, details, operation_id
        )
        while approval["state"] == "pending":
            # The response itself carries no authority. The authenticated API writes the decision.
            interrupt({"approval_id": identifier})
            approval = self.journal.request_approval(
                self.run["id"], identifier, kind, details, operation_id
            )
        return approval["state"]

    def file_plan(self, call, identifier):
        args = call["args"]
        required = (
            ("path", "content") if call["name"] == "write_text_file" else ("source", "destination")
        )
        if any(not isinstance(args.get(key), str) for key in required) or not isinstance(
            args.get("overwrite", False), bool
        ):
            raise ValueError("文件路径和内容必须是文字，overwrite 必须为布尔值")
        supplied = args["path"] if call["name"] == "write_text_file" else args["destination"]
        path, _ = self.access.authorize(supplied, write=True)
        if self.journal.denied_target(self.run["id"], str(path)):
            raise PermissionError("用户已拒绝本任务替换该文件。请保留原件，不要重复请求。")
        if path.exists() and not args.get("overwrite", False):
            raise FileExistsError("目标文件已存在，未请求替换")
        data = (
            args["content"].encode()
            if call["name"] == "write_text_file"
            else self.access.read_bytes(args["source"], limit=LIMIT)[1]
        )
        if len(data) > (256 * 1024 if call["name"] == "write_text_file" else LIMIT):
            raise ValueError("文件超过操作大小限制")
        before = self.access.read_bytes(str(path), limit=LIMIT)[1] if path.exists() else None
        root = self.settings.data_dir / "operation-files" / identifier
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        _atomic_write(root / "after", data)
        if before is not None:
            _atomic_write(root / "before", before)
        needs_approval = before is not None and not path.is_relative_to(self.access.workspace)
        if needs_approval:
            grants = [
                grant
                for grant in self.settings.grants
                if path.is_relative_to(grant.path) and grant.writable
            ]
            needs_approval = not any(grant.overwrite == "allow" for grant in grants)
        preview = ""
        if call["name"] == "write_text_file":
            preview = "\n".join(
                difflib.unified_diff(
                    (before or b"").decode(errors="replace").splitlines(),
                    data.decode().splitlines(),
                    fromfile="当前文件",
                    tofile="拟写入内容",
                    lineterm="",
                )
            )[:4000]
        return {
            "kind": "file",
            "path": str(path),
            "before_sha256": digest(before) if before is not None else None,
            "after_sha256": digest(data),
            "bytes": len(data),
            "backup": before is not None,
            "requires_approval": needs_approval,
            "preview": preview,
        }

    def apply_file(self, operation):
        plan, identifier = operation["plan"], operation["id"]
        metadata = {
            "authorization": self.journal.file_authorization(operation),
            "backup_available": plan["backup"],
        }
        if plan["backup"]:
            metadata["backup_restore"] = (
                "备份仅供服务端人工核查与恢复；当前 App 没有版本历史或一键恢复入口。"
            )
        lock_root = self.settings.data_dir / "operation-locks"
        lock_root.mkdir(exist_ok=True, mode=0o700)
        with FileLock(lock_root / (digest(plan["path"].encode()) + ".lock"), timeout=5):
            path, _ = self.access.authorize(plan["path"], write=True)
            current = self.access.read_bytes(str(path), limit=LIMIT)[1] if path.exists() else None
            actual = digest(current) if current is not None else None
            if actual == plan["after_sha256"]:
                return {
                    "path": str(path),
                    "bytes": plan["bytes"],
                    "sha256": actual,
                    "reconciled": True,
                    **metadata,
                }
            if actual != plan["before_sha256"]:
                raise ValueError(
                    "文件已被其他操作修改；本次批准失效，未覆盖新版本。请重新读取后决定。"
                )
            data = (self.settings.data_dir / "operation-files" / identifier / "after").read_bytes()
            if digest(data) != plan["after_sha256"]:
                raise ValueError("待写入副本校验失败")
            self.journal.set_state(identifier, "started")
            receipt = self.access.write_bytes(
                str(path),
                data,
                overwrite=current is not None,
                limit=LIMIT,
                expected_sha256=plan["before_sha256"],
            )
            # Read actual content after publication, not just an attempted write result.
            actual = digest(self.access.read_bytes(str(path), limit=LIMIT)[1])
            if actual != plan["after_sha256"]:
                raise ValueError("写入后文件发生变化，不能报告交付成功")
            return {
                **receipt,
                "sha256": actual,
                **metadata,
            }

    async def invoke(self, call, handler):
        try:
            return await self._invoke(call, handler)
        except (OSError, ValueError, StoreError) as exc:
            result = ToolMessage(content=str(exc)[:2000], tool_call_id=call["id"], status="error")
            identifier = str(uuid5(NAMESPACE_URL, f"{self.run['id']}:{call['id']}"))
            previous = self.journal.operation(identifier)
            if (
                previous
                and previous["result"] is None
                and previous["args"] == call["args"]
                and previous["tool"] == call["name"]
            ):
                self.journal.set_state(identifier, "failed", encode_result(result))
            return result

    def defer_for_steer(self, call):
        """A new instruction can stop replay, but cannot erase an already observed effect."""
        identifier = str(uuid5(NAMESPACE_URL, f"{self.run['id']}:{call['id']}"))
        operation = self.journal.operation(identifier)
        if not operation:
            return None
        if operation["result"] is not None:
            return decode_result(operation["result"])
        plan = operation["plan"]
        if plan["kind"] == "file":
            try:
                actual = digest(self.access.read_bytes(plan["path"], limit=LIMIT)[1])
            except (OSError, ValueError):
                actual = None
            if actual == plan["after_sha256"]:
                result = ToolMessage(
                    content=_json(
                        {
                            "path": plan["path"],
                            "sha256": actual,
                            "reconciled": True,
                            "authorization": self.journal.file_authorization(operation),
                        }
                    ),
                    tool_call_id=call["id"],
                )
                self.journal.set_state(identifier, "succeeded", encode_result(result))
                return result
        if operation["state"] == "started":
            result = ToolMessage(
                content="新的用户要求已到达，因此未重放这一步；中断前可能已经有副作用。请先读取实际结果，再按新要求继续，不要声称它从未执行。",
                tool_call_id=call["id"],
                status="error",
            )
            self.journal.set_state(identifier, "unconfirmed", encode_result(result))
            return result
        return None

    async def _invoke(self, call, handler):
        name = call["name"]
        if name not in EFFECT_TOOLS:
            return await handler()
        if (
            self.sandbox
            and self.settings.execution.network == "bridge"
            and self.settings.execution.network_authorization == "ask"
            and name in {"execute", "browser_action", "write_file", "edit_file", "delete"}
        ):
            scope_id = str(uuid5(NAMESPACE_URL, f"network:{self.run['id']}"))
            decision = self.approval(
                scope_id,
                "network",
                {
                    "title": "允许本任务联网执行",
                    "description": "脚本和浏览器将能访问 Docker 可达网络，包括内网，并可能提交外部修改。授权仅限本任务，沿用当前工作目录和资源限制。",
                    "task": self.run["prompt"][:2000],
                    "network": "bridge",
                },
            )
            if decision != "approve":
                return ToolMessage(
                    content="用户拒绝本任务联网执行，请使用离线资料或说明限制。",
                    tool_call_id=call["id"],
                    status="error",
                )
        identifier = str(uuid5(NAMESPACE_URL, f"{self.run['id']}:{call['id']}"))
        operation = self.journal.operation(identifier)
        if operation is None:
            plan = (
                self.file_plan(call, identifier)
                if name in {"write_text_file", "copy_file"}
                else {"kind": "tool", "description": name, "arguments": call["args"]}
            )
            operation = self.journal.prepare(self.run["id"], call, plan)
        elif operation["tool"] != name or operation["args"] != call["args"]:
            raise ValueError("步骤参数与持久回执不匹配")
        plan = operation["plan"]
        if operation["result"] is not None:
            if plan["kind"] == "file" and operation["state"] == "succeeded":
                try:
                    current = self.access.read_bytes(plan["path"], limit=LIMIT)[1]
                except FileNotFoundError:
                    current = None
                if current is None or digest(current) != plan["after_sha256"]:
                    return ToolMessage(
                        content="此步骤已有完成回执，但文件现在已变化或缺失。未重放写入，请读取实际情况后继续核对。",
                        tool_call_id=call["id"],
                        status="error",
                    )
            return decode_result(operation["result"])
        if plan["kind"] == "file":
            if plan["requires_approval"]:
                decision = self.approval(
                    identifier,
                    "overwrite",
                    {"title": "替换授权目录中的现有文件", **plan},
                    identifier,
                )
                if decision != "approve":
                    result = ToolMessage(
                        content="用户拒绝替换该文件。请保留原件，改为生成新的工作文件。",
                        tool_call_id=call["id"],
                        status="error",
                    )
                    self.journal.set_state(identifier, "denied", encode_result(result))
                    return result
            task = asyncio.create_task(asyncio.to_thread(self.apply_file, operation))
            try:
                receipt = await asyncio.shield(task)
            except asyncio.CancelledError:
                receipt = await task
                result = ToolMessage(content=_json(receipt), tool_call_id=call["id"])
                self.journal.set_state(identifier, "succeeded", encode_result(result))
                self.journal.store.add_event(
                    self.run["id"],
                    "tool",
                    {
                        "tool": name,
                        "tool_call_id": call["id"],
                        "status": "completed",
                        "cancel_requested": True,
                    },
                )
                raise
            result = ToolMessage(content=_json(receipt), tool_call_id=call["id"])
            self.journal.set_state(identifier, "succeeded", encode_result(result))
            return result
        if operation["state"] == "started":
            receipt = self.journal.reconcile_service(operation)
            if receipt is not None:
                result = ToolMessage(content=_json(receipt), tool_call_id=call["id"])
                self.journal.set_state(identifier, "succeeded", encode_result(result))
                return result
            review_id = str(
                uuid5(NAMESPACE_URL, f"uncertain:{identifier}:{operation['updated_at']}")
            )
            decision = self.approval(
                review_id,
                "uncertain",
                {
                    "title": "中断前的操作结果尚不能确认",
                    "description": "此步骤可能已经产生副作用。保留现状会让知行继续核对；重新执行可能重复写入或提交。",
                    "tool": name,
                    "arguments": call["args"],
                },
                identifier,
            )
            if decision != "retry":
                result = ToolMessage(
                    content="这一步在中断前可能已执行。用户选择保留现状；不要声称成功或直接重复此操作，请先读取实际结果再继续。",
                    tool_call_id=call["id"],
                    status="error",
                )
                self.journal.set_state(identifier, "unconfirmed", encode_result(result))
                return result
        self.journal.set_state(identifier, "started")
        try:
            result = await handler()
        except GraphInterrupt:
            self.journal.set_state(identifier, "prepared")
            raise
        encoded = encode_result(result)
        state = (
            "failed"
            if isinstance(result, ToolMessage) and result.status == "error"
            else "succeeded"
        )
        self.journal.set_state(identifier, state, encoded)
        return result
