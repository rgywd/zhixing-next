"""Safe, bounded projections from durable display events; never model/tool state."""

from __future__ import annotations

import json
import re

MAX_PARTS = 64
MAX_UNITS = 128 * 1024
DISPLAY_TYPES = {
    "assistant.reset", "assistant.snapshot", "reasoning.snapshot", "assistant.attempt",
    "assistant.truncated", "tool", "started", "paused", "recovering", "completed", "failed",
    "cancelled", "interrupted",
}
TERMINAL = {"completed", "failed", "cancelled", "interrupted"}
_TOOL_NAME = re.compile(r"[^\w.:-]", re.UNICODE)


def clipped(value, units):
    return value.encode("utf-16-le", errors="surrogatepass")[:units * 2].decode("utf-16-le", errors="ignore")


def public_event(event):
    """Whitelist both event types and fields. Raw operation output must not leak."""
    kind = event["type"]
    if kind not in DISPLAY_TYPES:
        return None
    raw = event["data"]
    raw = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(raw, dict):
        return None
    data = {}
    if kind.startswith(("assistant.", "reasoning.")):
        if not isinstance(raw.get("stream_id"), str):
            return None
        data["stream_id"] = raw["stream_id"][:128]
        if kind in {"assistant.snapshot", "reasoning.snapshot", "assistant.attempt"}:
            if not isinstance(raw.get("message_id"), str):
                return None
            data["message_id"] = raw["message_id"][:128]
        if kind.endswith(".snapshot"):
            if not isinstance(raw.get("text"), str):
                return None
            data["text"] = clipped(raw["text"], 65536)
            if raw.get("truncated") or data["text"] != raw["text"]:
                data["truncated"] = True
        if kind == "assistant.attempt":
            if raw.get("status") not in {"completed", "failed"}:
                return None
            data["status"] = raw["status"]
        if kind == "assistant.truncated":
            data["reason"] = "display_limit"
    elif kind == "tool":
        if raw.get("status") not in {"started", "completed", "failed"}:
            return None
        if not isinstance(raw.get("tool_call_id"), str) or not isinstance(raw.get("tool"), str):
            return None
        data = {"tool": _TOOL_NAME.sub("", raw["tool"])[:100] or "tool",
                "tool_call_id": raw["tool_call_id"][:200], "status": raw["status"]}
        if raw.get("cancel_requested") is True:
            data["cancel_requested"] = True
    elif kind == "paused":
        if raw.get("reason") in {"approval", "input", "resume"}:
            data["reason"] = raw["reason"]
    elif kind == "recovering":
        if isinstance(raw.get("attempt"), int):
            data["attempt"] = max(0, min(raw["attempt"], 100))
        if raw.get("requested") is True:
            data["requested"] = True
    return {"seq": event["seq"], "run_id": event["run_id"], "type": kind,
            "data": data, "created_at": event["created_at"]}


def project(run, events, final_message=None):
    result = {"run_id": run["id"], "status": run["status"], "cursor": 0, "parts": [],
              "final_message_id": final_message["id"] if final_message else None,
              "final_part_id": None, "truncated": False, "stream_id": None, "phase": run["phase"] if "phase" in run.keys() else "normal"}
    parts = {}
    stream_id = None
    outcomes = {}
    for raw in events:
        result["cursor"] = max(result["cursor"], raw["seq"])
        event = public_event(raw)
        if event is None:
            continue
        kind, data = event["type"], event["data"]
        if kind == "assistant.reset":
            stream_id = data["stream_id"]
            # Old model fragments were never committed; actual tool receipts survive recovery.
            parts = {key: part for key, part in parts.items() if part["type"] == "tool"}
            outcomes = {}
            continue
        if kind == "assistant.truncated":
            if data["stream_id"] == stream_id:
                result["truncated"] = True
            continue
        if kind.startswith(("assistant.", "reasoning.")):
            if stream_id is None:
                stream_id = data["stream_id"]
            if data["stream_id"] != stream_id:
                continue
            identity = (stream_id, data.get("message_id"))
            if kind == "assistant.attempt":
                outcomes[identity] = data["status"]
                for part in parts.values():
                    if (part.get("stream_id"), part.get("message_id")) == identity:
                        part["attempt_status"] = data["status"]
                continue
            part_type = "reasoning" if kind == "reasoning.snapshot" else "text"
            key = f"{stream_id}:{data['message_id']}:{part_type}"
            if key not in parts:
                parts[key] = {"id": key, "type": part_type, "seq": event["seq"],
                              "stream_id": stream_id, "message_id": data["message_id"]}
            parts[key]["text"] = data["text"]
            if data.get("truncated"):
                parts[key]["truncated"] = True
            if identity in outcomes:
                parts[key]["attempt_status"] = outcomes[identity]
        elif kind == "tool":
            key = f"tool:{data['tool_call_id']}"
            if key not in parts:
                parts[key] = {"id": key, "type": "tool", "seq": event["seq"],
                              "tool_call_id": data["tool_call_id"], "name": data["tool"]}
            parts[key]["status"] = data["status"]
    ordered = sorted(parts.values(), key=lambda part: part["seq"])
    if final_message:
        candidates = [part for part in ordered if part["type"] == "text" and part.get("attempt_status") != "failed"]
        last_tool_seq = max((part["seq"] for part in ordered if part["type"] == "tool"), default=0)
        if (candidates and candidates[-1]["seq"] > last_tool_seq and candidates[-1]["text"]
                and final_message["content"].startswith(candidates[-1]["text"])):
            result["final_part_id"] = candidates[-1]["id"]
    # The independently stored final message stays complete even if its process preview is clipped.
    if len(ordered) > MAX_PARTS:
        result["truncated"] = True
        ordered = ordered[-MAX_PARTS:]
    if result["final_part_id"] not in {part["id"] for part in ordered}:
        result["final_part_id"] = None
    available = MAX_UNITS
    # Reserve recent/final text first. Display order remains the original sequence.
    for part in reversed(ordered):
        if "text" not in part:
            continue
        text = clipped(part["text"], available)
        available -= len(text.encode("utf-16-le")) // 2
        if text != part["text"]:
            part["truncated"] = True
            result["truncated"] = True
        part["text"] = text
        if part.get("truncated"):
            result["truncated"] = True
    result["stream_id"] = stream_id
    result["parts"] = ordered
    return result
