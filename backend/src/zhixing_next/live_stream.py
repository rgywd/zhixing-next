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
MAX_EVENT_BYTES = 1024 * 1024
MAX_EVENTS = 512
_IDENTITY = "zhixing_live_model_id"


class ModelStreamIdentity(BaseCallbackHandler):
    # Metadata is shared with LangGraph's messages callback. Use the actual LLM
    # invocation UUID: provider IDs can be absent or reused across a retry.
    run_inline = True

    def on_chat_model_start(self, serialized, messages, *, run_id, metadata=None, **kwargs):
        if metadata is not None:
            metadata[_IDENTITY] = str(run_id)


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
        self.events = self.bytes = 0

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
                return
            self.messages[identifier] = {"text": "", "reasoning": "", "sent": {}, "at": {}, "truncated": {}}
        state = self.messages[identifier]
        for field, value in zip(("text", "reasoning"), visible_parts(message)):
            if not value:
                continue
            combined = state[field] + value if isinstance(message, AIMessageChunk) else value
            # JavaScript measures UTF-16 units. Never split a surrogate pair or
            # send a snapshot the mobile size guard must reject.
            state[field] = combined.encode("utf-16-le", errors="surrogatepass")[:MAX_TEXT * 2].decode("utf-16-le", errors="ignore")
            state["truncated"][field] = state["truncated"].get(field, False) or state[field] != combined
            now = self.clock()
            previous = state["sent"].get(field)
            if (previous is None or now - state["at"].get(field, 0) >= 0.1
                    or len(state[field]) - len(previous) >= 1024):
                await self._snapshot(identifier, field)

    async def _snapshot(self, identifier, field):
        state = self.messages[identifier]
        value = state[field]
        if not value or state["sent"].get(field) == value:
            return
        data = {"stream_id": self.stream_id, "message_id": identifier, "text": value}
        if state["truncated"].get(field):
            data["truncated"] = True
        size = len(json.dumps(data, ensure_ascii=False).encode())
        if self.events >= MAX_EVENTS or self.bytes + size > MAX_EVENT_BYTES:
            return
        await self.emit("assistant.snapshot" if field == "text" else "reasoning.snapshot", data)
        self.events += 1
        self.bytes += size
        state["sent"][field] = value
        state["at"][field] = self.clock()

    async def flush(self):
        for identifier in self.messages:
            for field in ("text", "reasoning"):
                await self._snapshot(identifier, field)
