"""Bounded, replaceable UI projections of actual model output, never graph state."""

from __future__ import annotations

import hashlib
import json
import time
from uuid import uuid4

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import AIMessage, AIMessageChunk

MAX_TEXT = 64 * 1024
MAX_MESSAGES = 64
MAX_EVENT_BYTES = 2 * 1024 * 1024
FINAL_RESERVE = 1024 * 1024
MAX_CAPTURE_UNITS = 128 * 1024
MAX_EVENTS = 512
_IDENTITY = "zhixing_live_model_id"
_QUIET_FINANCE_TEXT = "zhixing_finance_write_text"


class ModelStreamIdentity(BaseCallbackHandler):
    # Metadata is shared with LangGraph's messages callback. Use the actual LLM
    # invocation UUID: provider IDs can be absent or reused across a retry.
    run_inline = True

    def __init__(self):
        self.outcomes = {}

    def on_llm_end(self, response, *, run_id, **kwargs):
        self.outcomes[str(run_id)] = "completed"

    def on_llm_error(self, error, *, run_id, **kwargs):
        self.outcomes[str(run_id)] = "failed"

    def on_chat_model_start(self, serialized, messages, *, run_id, metadata=None, **kwargs):
        if metadata is not None:
            metadata[_IDENTITY] = str(run_id)
            from .finance_context import finance_write_model

            if finance_write_model.get():
                metadata[_QUIET_FINANCE_TEXT] = True


def visible_parts(message):
    """Only provider text/explicit thinking; signatures, args and metadata stay private."""
    text, reasoning = [], []
    if isinstance(message.content, str):
        text.append(message.content)
    elif isinstance(message.content, list):
        for block in message.content:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            if kind == "text" and isinstance(block.get("text"), str):
                text.append(block["text"])
            elif kind == "thinking" and isinstance(block.get("thinking"), str):
                reasoning.append(block["thinking"])
            elif kind == "reasoning":
                if isinstance(block.get("reasoning"), str):
                    reasoning.append(block["reasoning"])
                elif isinstance(block.get("summary"), list):
                    reasoning.extend(item["text"] for item in block["summary"]
                                     if isinstance(item, dict) and item.get("type") == "summary_text"
                                     and isinstance(item.get("text"), str))
    supplied = message.additional_kwargs.get("reasoning_content")
    return "".join(text), supplied if isinstance(supplied, str) else "".join(reasoning)


class LiveModelStream:
    def __init__(self, emit, *, clock=time.monotonic):
        self.emit, self.clock = emit, clock
        self.stream_id = str(uuid4())
        self.callback = ModelStreamIdentity()
        self.messages = {}
        self.events = self.bytes = self.capture_units = 0
        self.truncated = False
        self.outcomes_sent = {}

    async def start(self):
        # A resumed runtime must not append a newly generated answer to its old,
        # uncommitted attempt. Durable final messages are entirely separate.
        await self.emit("assistant.reset", {"stream_id": self.stream_id})

    async def receive(self, message, metadata):
        if not isinstance(message, AIMessage) or metadata.get("langgraph_node") != "model":
            return
        if metadata.get("lc_source") == "summarization" or "langsmith:nostream" in (metadata.get("tags") or []):
            return
        raw_id = metadata.get(_IDENTITY) or [metadata.get("langgraph_checkpoint_ns"), message.id]
        identifier = hashlib.sha256(json.dumps(raw_id).encode()).hexdigest()[:32]
        if identifier not in self.messages:
            if len(self.messages) >= MAX_MESSAGES:
                await self._mark_truncated()
                return
            # Flush a settled previous model turn before introducing the next one.
            await self.flush()
            self.messages[identifier] = {"text": "", "reasoning": "", "sent": {}, "at": {}, "truncated": {}, "sent_truncated": {}, "final_sent": set()}
        state = self.messages[identifier]
        text, reasoning = visible_parts(message)
        if metadata.get(_QUIET_FINANCE_TEXT) and not message.additional_kwargs.get("zhixing_program_finance_write"):
            text = ""
        for field, value in (("reasoning", reasoning), ("text", text)):
            if not value:
                continue
            combined = state[field] + value if isinstance(message, AIMessageChunk) else value
            # JavaScript measures UTF-16 units. Never split a surrogate pair or
            # send a snapshot the mobile size guard must reject.
            old_units = len(state[field].encode("utf-16-le")) // 2
            available = min(MAX_TEXT, MAX_CAPTURE_UNITS - self.capture_units + old_units)
            state[field] = combined.encode("utf-16-le", errors="surrogatepass")[:available * 2].decode("utf-16-le", errors="ignore")
            self.capture_units += len(state[field].encode("utf-16-le")) // 2 - old_units
            state["truncated"][field] = state["truncated"].get(field, False) or state[field] != combined
            if state["truncated"][field]:
                await self._mark_truncated()
            now = self.clock()
            previous = state["sent"].get(field)
            if (previous is None or now - state["at"].get(field, 0) >= 0.1
                    or len(state[field]) - len(previous) >= 1024):
                await self._snapshot(identifier, field)

    async def _mark_truncated(self):
        if not self.truncated:
            self.truncated = True
            await self.emit("assistant.truncated", {"stream_id": self.stream_id, "reason": "display_limit"})

    async def _snapshot(self, identifier, field, *, final=False):
        state = self.messages[identifier]
        value = state[field]
        if not value or (state["sent"].get(field) == value and state["sent_truncated"].get(field, False) == state["truncated"].get(field, False)):
            return
        data = {"stream_id": self.stream_id, "message_id": identifier, "text": value}
        if state["truncated"].get(field):
            data["truncated"] = True
        size = len(json.dumps(data, ensure_ascii=False).encode())
        ceiling = MAX_EVENT_BYTES if final else MAX_EVENT_BYTES - FINAL_RESERVE
        count = MAX_EVENTS if final else MAX_EVENTS - MAX_MESSAGES * 2
        if self.events >= count or self.bytes + size > ceiling:
            await self._mark_truncated()
            return
        await self.emit("assistant.snapshot" if field == "text" else "reasoning.snapshot", data)
        self.events += 1
        self.bytes += size
        state["sent"][field] = value
        state["sent_truncated"][field] = state["truncated"].get(field, False)
        state["at"][field] = self.clock()

    async def flush(self):
        for identifier in self.messages:
            for field in ("reasoning", "text"):
                # Reserve one final flush per field after the incremental budget.
                final = field not in self.messages[identifier]["final_sent"]
                await self._snapshot(identifier, field, final=final)
                if self.messages[identifier][field]:
                    self.messages[identifier]["final_sent"].add(field)
        for raw_id, outcome in self.callback.outcomes.items():
            identifier = hashlib.sha256(json.dumps(raw_id).encode()).hexdigest()[:32]
            if identifier in self.messages and self.outcomes_sent.get(identifier) != outcome:
                await self.emit("assistant.attempt", {"stream_id": self.stream_id, "message_id": identifier, "status": outcome})
                self.outcomes_sent[identifier] = outcome
