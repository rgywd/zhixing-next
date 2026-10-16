"""Durable per-reply display history, bounded projection and safe resumable SSE."""

import asyncio
import json
from contextlib import contextmanager
from threading import Event, Thread

import httpx
import pytest
from langchain_core.messages import AIMessageChunk

from zhixing_next.api import create_app
from zhixing_next.config import Settings
from zhixing_next.display_stream import stream_display
from zhixing_next.live_stream import MAX_EVENT_BYTES, MAX_EVENTS, LiveModelStream
from zhixing_next.reply_process import MAX_PARTS, MAX_UNITS, project
from zhixing_next.sqlite_policy import safe_journal_mode
from zhixing_next.store import Store, StoreError

TOKEN = "isolated-display-test-token-00000"


def setup(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work", api_token=TOKEN)
    store = Store(settings)
    conversation = store.create_conversation("isolated conversation")
    return settings, store, conversation


def start(store, conversation, identifier):
    store.submit_message(conversation["id"], id=identifier, content="synthetic input", kind="chat")
    return store.claim_next("chat")


def append(store, run, kind, **data):
    store.add_event(run["id"], kind, data)


def snapshot(store, run, text, *, stream="s", message="m", reasoning=False):
    append(store, run, "reasoning.snapshot" if reasoning else "assistant.snapshot",
           stream_id=stream, message_id=message, text=text)


def ordered_reply(store, run):
    append(store, run, "assistant.reset", stream_id="s")
    snapshot(store, run, "Actual explicit reasoning", reasoning=True)
    snapshot(store, run, "Before the tool")
    append(store, run, "tool", tool="query_finance", tool_call_id="t", status="started",
           arguments={"private": "NEVER"}, output="NEVER")
    append(store, run, "tool", tool="query_finance", tool_call_id="t", status="completed")
    snapshot(store, run, "The final answer", message="final")
    append(store, run, "assistant.attempt", stream_id="s", message_id="final", status="completed")


def test_two_historical_replies_survive_reopen_and_next_turn(tmp_path):
    settings, store, conversation = setup(tmp_path)
    first = start(store, conversation, "first")
    ordered_reply(store, first)
    store.finish_run(first["id"], "completed", result="The final answer")
    second = start(store, conversation, "second")
    append(store, second, "assistant.reset", stream_id="other")
    snapshot(store, second, "second own reasoning", stream="other", reasoning=True)
    snapshot(store, second, "second final", stream="other")
    store.finish_run(second["id"], "completed", result="second final")
    reopened = Store(settings)
    items = reopened.reply_processes(conversation["id"], [first["id"], second["id"]])["items"]
    assert [item["status"] for item in items] == ["completed", "completed"]
    assert [part["type"] for part in items[0]["parts"]] == ["reasoning", "text", "tool", "text"]
    assert [part["seq"] for part in items[0]["parts"]] == sorted(part["seq"] for part in items[0]["parts"])
    assert items[0]["parts"][2]["status"] == "completed"
    assert items[0]["final_part_id"] == items[0]["parts"][-1]["id"]
    assert items[0]["final_message_id"] != items[1]["final_message_id"]
    assert items[0]["stream_id"] == "s" and items[1]["stream_id"] == "other"
    assert "second own" not in str(items[0]) and "Before the tool" not in str(items[1])
    assert "NEVER" not in str(items)
    assert len([item for item in reopened.list_messages(conversation["id"])["items"] if item["role"] == "assistant"]) == 2


def test_reset_replaces_uncommitted_fragments_preserves_actual_tools_and_partial_failure(tmp_path):
    _, store, conversation = setup(tmp_path)
    run = start(store, conversation, "first")
    ordered_reply(store, run)
    append(store, run, "assistant.reset", stream_id="resumed")
    snapshot(store, run, "partial after recovery", stream="resumed")
    append(store, run, "assistant.attempt", stream_id="resumed", message_id="m", status="failed")
    store.finish_run(run["id"], "failed", error="PRIVATE ERROR")
    process = store.reply_processes(conversation["id"], [run["id"]])["items"][0]
    assert process["status"] == "failed" and process["final_message_id"] is None
    assert [part["type"] for part in process["parts"]] == ["tool", "text"]
    assert process["parts"][-1]["attempt_status"] == "failed"
    assert "Before the tool" not in str(process) and "PRIVATE ERROR" not in str(process)


def test_cancel_keeps_own_partial_and_does_not_create_fake_final(tmp_path):
    _, store, conversation = setup(tmp_path)
    run = start(store, conversation, "cancel")
    append(store, run, "assistant.reset", stream_id="s")
    snapshot(store, run, "actual partial")
    store.cancel_run(run["id"])
    store.finish_run(run["id"], "cancelled")
    item = store.reply_processes(conversation["id"], [run["id"]])["items"][0]
    assert item["parts"][0]["text"] == "actual partial"
    assert item["status"] == "cancelled"
    assert item["final_message_id"] is None and item["final_part_id"] is None


def test_no_final_snapshot_does_not_replace_a_tool_prelude_with_the_answer(tmp_path):
    _, store, conversation = setup(tmp_path)
    run = start(store, conversation, "missing")
    append(store, run, "assistant.reset", stream_id="s")
    snapshot(store, run, "Looking up a record")
    append(store, run, "tool", tool="query_health", tool_call_id="t", status="completed")
    store.finish_run(run["id"], "completed", result="The independently saved answer")
    process = store.reply_processes(conversation["id"], [run["id"]])["items"][0]
    assert process["final_part_id"] is None and process["final_message_id"]
    assert process["parts"][0]["text"] == "Looking up a record"


def test_cross_conversation_and_missing_run_are_rejected_as_a_whole(tmp_path):
    _, store, conversation = setup(tmp_path)
    first = start(store, conversation, "first")
    other = store.create_conversation("other")
    second = start(store, other, "second")
    for identifiers in ([first["id"], second["id"]], ["missing"]):
        with pytest.raises(StoreError) as error:
            store.reply_processes(conversation["id"], identifiers)
        assert error.value.status == 404
    for identifiers in ([], list(map(str, range(51)))):
        with pytest.raises(StoreError) as error:
            store.reply_processes(conversation["id"], identifiers)
        assert error.value.status == 422


def test_process_bound_does_not_truncate_final_message_and_ids_remain_stable(tmp_path):
    _, store, conversation = setup(tmp_path)
    run = start(store, conversation, "bounds")
    append(store, run, "assistant.reset", stream_id="s")
    for index in range(70):
        snapshot(store, run, "😀" * 32000, message=str(index))
    final = "complete unabridged answer " * 20000
    snapshot(store, run, final[:20000], message="last")
    store.finish_run(run["id"], "completed", result=final)
    process = store.reply_processes(conversation["id"], [run["id"]])["items"][0]
    assert len(process["parts"]) == MAX_PARTS and process["truncated"]
    assert sum(len(part.get("text", "").encode("utf-16-le")) // 2 for part in process["parts"]) <= MAX_UNITS
    assert process["parts"][-1]["id"] == process["final_part_id"]
    assert store.list_messages(conversation["id"])["items"][-1]["content"] == final
    again = store.reply_processes(conversation["id"], [run["id"]])["items"][0]
    assert again == process


async def never_disconnected():
    return False


def decode(frames):
    result = []
    for frame in frames:
        if frame.startswith(":"):
            continue
        result.append((next(line[7:] for line in frame.splitlines() if line.startswith("event: ")),
                       json.loads(next(line[6:] for line in frame.splitlines() if line.startswith("data: ")))))
    return result


async def test_sse_cursor_reconnect_filters_private_payload_and_closes_after_final(tmp_path):
    _, store, conversation = setup(tmp_path)
    run = start(store, conversation, "sse")
    ordered_reply(store, run)
    append(store, run, "operation", plan="NEVER PLAN", arguments="NEVER PARAMS")
    store.finish_run(run["id"], "completed", result="The final answer")
    raw = store.list_events(run["id"], limit=100)["items"]
    after = raw[2]["seq"]
    frames = [frame async for frame in stream_display(store, run["id"], after, never_disconnected)]
    values = decode(frames)
    displayed = [value for kind, value in values if kind == "display"]
    assert displayed and all(event["seq"] > after for event in displayed)
    assert [item["seq"] for item in displayed] == sorted({item["seq"] for item in displayed})
    assert "NEVER" not in str(frames) and "result" not in str(frames)
    assert values[-1] == ("done", {"run_id": run["id"], "status": "completed", "cursor": raw[-1]["seq"]})
    tail = [frame async for frame in stream_display(store, run["id"], raw[-1]["seq"], never_disconnected)]
    assert len(tail) == 1 and decode(tail)[0][0] == "done"


async def test_sse_final_commit_race_is_drained(tmp_path, monkeypatch):
    _, store, conversation = setup(tmp_path)
    run = start(store, conversation, "race")
    original = store.get_run
    once = False

    def finishing(identifier):
        nonlocal once
        if not once:
            once = True
            store.finish_run(identifier, "completed", result="atomic final")
        return original(identifier)

    monkeypatch.setattr(store, "get_run", finishing)
    frames = [frame async for frame in stream_display(store, run["id"], 0, never_disconnected)]
    values = decode(frames)
    assert any(kind == "display" and data["type"] == "completed" for kind, data in values)
    assert values[-1][0] == "done"


async def test_sse_heartbeat_disconnect_and_generator_cleanup_do_not_cancel_run(tmp_path, monkeypatch):
    import zhixing_next.display_stream as streaming

    monkeypatch.setattr(streaming, "POLL_SECONDS", 0.001)
    _, store, conversation = setup(tmp_path)
    run = start(store, conversation, "heartbeat")
    disconnected = False

    async def is_disconnected():
        return disconnected

    ticks = iter([0, 16, 32, 48])
    generator = stream_display(store, run["id"], 0, is_disconnected, clock=lambda: next(ticks))
    frames = []
    while not any(frame.startswith(": heartbeat") for frame in frames):
        frames.append(await anext(generator))
    disconnected = True
    with pytest.raises(StopAsyncIteration):
        await anext(generator)
    await generator.aclose()
    assert store.get_run(run["id"])["status"] == "running"
    assert not store.get_run(run["id"])["cancel_requested"]


async def test_sse_task_cancel_does_not_stop_worker_or_leave_reader(tmp_path, monkeypatch):
    import zhixing_next.display_stream as streaming

    monkeypatch.setattr(streaming, "POLL_SECONDS", 0.001)
    _, store, conversation = setup(tmp_path)
    run = start(store, conversation, "disconnect")
    latest = store.list_events(run["id"], limit=100)["items"][-1]["seq"]
    generator = stream_display(store, run["id"], latest, never_disconnected)
    pending = asyncio.create_task(anext(generator))
    await asyncio.sleep(0.01)
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    await generator.aclose()
    assert store.get_run(run["id"])["status"] == "running"


async def test_http_sse_auth_missing_run_last_id_and_batch_validation(tmp_path):
    settings, store, conversation = setup(tmp_path)
    run = start(store, conversation, "http")
    ordered_reply(store, run)
    store.finish_run(run["id"], "completed", result="The final answer")
    app = create_app(settings)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.get(f"/v1/runs/{run['id']}/display-stream")).status_code == 401
        assert (await client.get(f"/v1/conversations/{conversation['id']}/reply-processes", params={"run_ids": run["id"]})).status_code == 401
        headers = {"Authorization": f"Bearer {TOKEN}"}
        assert (await client.get("/v1/runs/missing/display-stream", headers=headers)).status_code == 404
        assert (await client.get(f"/v1/runs/{run['id']}/display-stream?after=-1", headers=headers)).status_code == 422
        assert (await client.get(f"/v1/conversations/{conversation['id']}/reply-processes", headers=headers)).status_code == 422
        response = await client.get(f"/v1/conversations/{conversation['id']}/reply-processes", headers=headers, params={"run_ids": run["id"]})
        assert response.status_code == 200 and response.json()["items"][0]["final_message_id"]
        last = response.json()["items"][0]["cursor"]
        response = await client.get(f"/v1/runs/{run['id']}/display-stream", headers={**headers, "Last-Event-ID": str(last)})
        assert response.status_code == 200 and response.headers["x-accel-buffering"] == "no"
        assert response.headers["cache-control"] == "private, no-store"
        assert "event: done" in response.text and "event: display" not in response.text


async def test_snapshot_budget_exhaustion_signals_and_final_flush_keeps_latest():
    recorded = []

    async def emit(kind, data):
        recorded.append((kind, data))

    clock = [0.0]
    live = LiveModelStream(emit, clock=lambda: clock[0])
    await live.start()
    metadata = {"langgraph_node": "model", "zhixing_live_model_id": "long"}
    for _ in range(300):
        clock[0] += 0.2
        await live.receive(AIMessageChunk(content="line of streamed text\n" * 8), metadata)
    assert live.truncated
    before = len(recorded)
    await live.flush()
    snapshots = [data for kind, data in recorded if kind == "assistant.snapshot"]
    assert len(recorded) > before
    assert snapshots[-1]["text"] == live.messages[next(iter(live.messages))]["text"]
    assert live.bytes <= MAX_EVENT_BYTES and live.events <= MAX_EVENTS
    assert len([kind for kind, _ in recorded if kind == "assistant.truncated"]) == 1
    assert len(snapshots[-1]["text"]) > len(snapshots[-2]["text"])


def test_projection_ignores_old_stream_late_events_and_private_terminal_payload():
    def event(seq, kind, data):
        return {"seq": seq, "run_id": "r", "type": kind, "data": data, "created_at": "now"}

    events = [event(1, "assistant.reset", {"stream_id": "new"}),
              event(2, "assistant.snapshot", {"stream_id": "new", "message_id": "m", "text": "current"}),
              event(3, "assistant.snapshot", {"stream_id": "old", "message_id": "m", "text": "stale"}),
              event(4, "failed", {"error": "NEVER", "result": "NEVER"})]
    result = project({"id": "r", "status": "failed"}, events)
    assert [part["text"] for part in result["parts"]] == ["current"]
    assert "NEVER" not in str(result) and result["cursor"] == 4


@pytest.mark.parametrize("journal_mode", sorted({"DELETE", safe_journal_mode()}))
def test_projection_and_resume_cursor_share_one_read_snapshot(tmp_path, monkeypatch, journal_mode):
    monkeypatch.setattr("zhixing_next.store.safe_journal_mode", lambda: journal_mode)
    settings, store, conversation = setup(tmp_path)
    assert store.journal_mode == journal_mode.lower()
    run = start(store, conversation, "consistent")
    append(store, run, "assistant.reset", stream_id="s")
    snapshot(store, run, "before")
    before_cursor = store.list_events(run["id"])["items"][-1]["seq"]
    original = store._connection
    writer = Store(settings)
    writer_original = writer._connection
    commit_ready, writer_finished = Event(), Event()
    writer_errors, synchronization_errors = [], []
    committed_during_read = []
    fired = False

    @contextmanager
    def observed_write(write=False):
        with writer_original(write=write) as db:
            yield db
            if write:
                # The insert is real; DELETE may commit only once the reader closes.
                commit_ready.set()

    def write_snapshot():
        try:
            snapshot(writer, run, "after")
        except BaseException as error:
            writer_errors.append(error)
        finally:
            writer_finished.set()

    monkeypatch.setattr(writer, "_connection", observed_write)
    writing = Thread(target=write_snapshot)

    @contextmanager
    def traced(write=False):
        nonlocal fired
        with original(write=write) as db:
            def trace(sql):
                nonlocal fired
                if not fired and sql.startswith("SELECT id,run_id,content FROM messages"):
                    fired = True
                    writing.start()
                    # Never raise in a SQLite trace callback: SQLite swallows it.
                    if not commit_ready.wait(5):
                        synchronization_errors.append("writer did not reach commit")
                    if journal_mode == "WAL":
                        if not writer_finished.wait(5):
                            synchronization_errors.append("WAL writer did not finish during read")
                        committed_during_read.append(writer_finished.is_set() and not writer_errors)
                    else:
                        committed_during_read.append(writer_finished.is_set())
            db.set_trace_callback(trace)
            yield db

    monkeypatch.setattr(store, "_connection", traced)
    try:
        first = store.reply_processes(conversation["id"], [run["id"]])["items"][0]
    finally:
        if writing.ident is not None:
            writing.join(10)
    assert fired and not writing.is_alive()
    assert writer_finished.is_set() and not writer_errors
    assert not synchronization_errors
    assert committed_during_read == [journal_mode == "WAL"]
    second = store.reply_processes(conversation["id"], [run["id"]])["items"][0]
    assert first["parts"][0]["text"] == "before" and first["cursor"] == before_cursor
    assert second["parts"][0]["text"] == "after"
    assert first["cursor"] < second["cursor"]
    assert writer.list_events(run["id"], after=first["cursor"])["items"][-1]["data"]["text"] == "after"


def test_legacy_oversized_event_history_is_bounded_and_explicitly_marked(tmp_path):
    _, store, conversation = setup(tmp_path)
    run = start(store, conversation, "legacy")
    append(store, run, "assistant.reset", stream_id="s")
    with store._connection(write=True) as db:
        for index in range(2100):
            store._event(db, run["id"], "assistant.snapshot", {
                "stream_id": "s", "message_id": "m", "text": f"snapshot {index}",
            })
    process = store.reply_processes(conversation["id"], [run["id"]])["items"][0]
    assert process["truncated"] and process["stream_id"] == "s"
    assert process["parts"][0]["text"] == "snapshot 2099"
    assert process["cursor"] == store.list_events(run["id"], after=process["cursor"] - 1)["items"][0]["seq"]
