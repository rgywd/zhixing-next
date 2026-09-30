"""Bounded model retries and durable run-wide budgets, shared with child agents."""

import asyncio
import hashlib
import json
import random
import time
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime

import httpx


class RunLimitError(RuntimeError):
    """Safe, actionable diagnostics; never includes vendor payloads."""


def failure_kind(exc):
    status = getattr(exc, "status_code", None)
    if status in {401, 403}:
        return "authentication", False
    if status == 429:
        return "rate_limit", True
    if status in {408, 409} or isinstance(status, int) and 500 <= status < 600:
        return "temporary_service", True
    if isinstance(exc, (TimeoutError, httpx.TimeoutException, httpx.NetworkError)) or type(
        exc
    ).__name__ in {"APITimeoutError", "APIConnectionError"}:
        return "connection", True
    return "request", False


def retry_delay(exc, attempt, base):
    headers = getattr(getattr(exc, "response", None), "headers", {})
    try:
        if "retry-after-ms" in headers:
            return max(0, min(30, float(headers["retry-after-ms"]) / 1000))
        value = headers.get("retry-after")
        if value is not None:
            try:
                delay = float(value)
            except ValueError:
                delay = (parsedate_to_datetime(value) - datetime.now(UTC)).total_seconds()
            return max(0, min(30, delay))
    except (ValueError, TypeError, OverflowError):
        pass
    return min(30, base * 2**attempt * random.uniform(0.8, 1.2))


class RunBudget:
    def __init__(self, store, run_id):
        self.store, self.run_id = store, run_id
        self.limits = store.settings.limits

    def summary(self):
        with self.store._connection() as db:
            row = db.execute("SELECT * FROM run_usage WHERE run_id=?", (self.run_id,)).fetchone()
            return (
                {
                    key: row[key]
                    for key in (
                        "model_attempts",
                        "tool_calls",
                        "input_tokens",
                        "output_tokens",
                        "unknown_usage",
                        "active_seconds",
                    )
                }
                if row
                else {
                    "model_attempts": 0,
                    "tool_calls": 0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "unknown_usage": 0,
                    "active_seconds": 0,
                }
            )

    def reserve(self, kind):
        with self.store._connection(write=True) as db:
            db.execute("INSERT OR IGNORE INTO run_usage(run_id) VALUES(?)", (self.run_id,))
            row = db.execute("SELECT * FROM run_usage WHERE run_id=?", (self.run_id,)).fetchone()
            if row["input_tokens"] + row["output_tokens"] >= self.limits.total_tokens:
                raise RunLimitError(
                    "本次任务已达到 token 预算；已完成的结果保留，请缩小任务或调整服务端预算后继续。"
                )
            if row[kind] >= getattr(self.limits, kind):
                raise RunLimitError("本次任务已达到调用次数上限；已停止继续调用，已有结果保留。")
            db.execute(f"UPDATE run_usage SET {kind}={kind}+1 WHERE run_id=?", (self.run_id,))

    def usage(self, response):
        messages = getattr(response, "result", [])
        usage = [item.usage_metadata for item in messages if getattr(item, "usage_metadata", None)]
        incoming = sum(item.get("input_tokens", 0) for item in usage)
        outgoing = sum(item.get("output_tokens", 0) for item in usage)
        with self.store._connection(write=True) as db:
            db.execute(
                "UPDATE run_usage SET input_tokens=input_tokens+?,output_tokens=output_tokens+?,unknown_usage=unknown_usage+? WHERE run_id=?",
                (incoming, outgoing, int(not usage), self.run_id),
            )
        return self.summary()

    def elapsed(self, seconds):
        with self.store._connection(write=True) as db:
            db.execute("INSERT OR IGNORE INTO run_usage(run_id) VALUES(?)", (self.run_id,))
            db.execute(
                "UPDATE run_usage SET active_seconds=active_seconds+? WHERE run_id=?",
                (seconds, self.run_id),
            )

    def check_loop(self, call, state):
        # Polling observes a moving process, so repeat counts are bounded by the
        # global tool budget instead. A new user instruction resets this sequence.
        if call["name"] in {"read_process", "wait_process"}:
            return
        human = next((m.id for m in reversed(state.get("messages", [])) if m.type == "human"), "")
        signature = hashlib.sha256(
            json.dumps([human, call["name"], call.get("args", {})], sort_keys=True).encode()
        ).hexdigest()
        with self.store._connection(write=True) as db:
            row = db.execute(
                "SELECT loop_signature,loop_count,loop_call_id FROM run_usage WHERE run_id=?",
                (self.run_id,),
            ).fetchone()
            if row and row["loop_call_id"] == call["id"]:
                return
            count = row["loop_count"] + 1 if row and row["loop_signature"] == signature else 1
            db.execute(
                "UPDATE run_usage SET loop_signature=?,loop_count=?,loop_call_id=? WHERE run_id=?",
                (signature, count, call["id"], self.run_id),
            )
        if count >= 4:
            raise RunLimitError(
                "连续重复同一工具及参数，未见执行方案变化；已停止循环，已有结果保留。"
            )

    async def invoke_model(self, handler, request, controls, emit):
        for attempt in range(self.limits.retries + 1):
            if (await controls()).get("cancel_requested"):
                raise asyncio.CancelledError()
            self.reserve("model_attempts")
            try:
                response = await handler(request)
            except Exception as exc:
                with self.store._connection(write=True) as db:
                    db.execute(
                        "UPDATE run_usage SET unknown_usage=unknown_usage+1 WHERE run_id=?",
                        (self.run_id,),
                    )
                kind, retry = failure_kind(exc)
                if not retry or attempt == self.limits.retries:
                    await emit(
                        "model_error", {"kind": kind, "retryable": retry, "attempts": attempt + 1}
                    )
                    raise
                delay = retry_delay(exc, attempt, self.limits.retry_base_seconds)
                await emit(
                    "retry",
                    {"kind": kind, "attempt": attempt + 1, "delay_seconds": round(delay, 2)},
                )
                deadline = time.monotonic() + delay
                while time.monotonic() < deadline:
                    control = await controls()
                    if control.get("cancel_requested"):
                        raise asyncio.CancelledError()
                    if control.get("steers"):
                        from langchain.agents.middleware.types import ModelResponse
                        from langchain_core.messages import AIMessage

                        # The after-model hook discards this empty decision and
                        # checkpoints the new instruction before calling again.
                        return ModelResponse(result=[AIMessage(content="")])
                    await asyncio.sleep(min(0.25, max(0, deadline - time.monotonic())))
            else:
                await emit("usage", self.usage(response))
                return response
