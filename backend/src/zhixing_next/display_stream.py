"""Authenticated route's SSE generator. Disconnect never changes the run."""

import asyncio
import json
import time

from .reply_process import TERMINAL, public_event

POLL_SECONDS = 0.1
HEARTBEAT_SECONDS = 15


def frame(kind, data, identifier=None):
    prefix = f"id: {identifier}\n" if identifier is not None else ""
    return f"{prefix}event: {kind}\ndata: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n"


async def stream_display(store, run_id, after, disconnected, *, clock=time.monotonic):
    cursor, heartbeat = after, clock()
    while not await disconnected():
        # A short thread-bound read holds no transaction or worker while waiting on the socket.
        page = await asyncio.to_thread(store.list_events, run_id, cursor, 100)
        for event in page["items"]:
            if await disconnected():
                return
            cursor = event["seq"]
            public = public_event(event)
            if public is not None:
                yield frame("display", public, cursor)
        if page["items"]:
            yield frame("cursor", {"cursor": cursor}, cursor)
        if page["next_cursor"]:
            continue
        run = await asyncio.to_thread(store.get_run, run_id)
        if run["status"] in TERMINAL:
            # Finish and its final message/event are one transaction. Drain a race with that commit.
            tail = await asyncio.to_thread(store.list_events, run_id, cursor, 1)
            if tail["items"]:
                continue
            yield frame("done", {"run_id": run_id, "status": run["status"], "cursor": cursor})
            return
        if clock() - heartbeat >= HEARTBEAT_SECONDS:
            yield ": heartbeat\n\n"
            heartbeat = clock()
        await asyncio.sleep(POLL_SECONDS)
