"""Final delivery requires actual complete result reads, rather than one page."""

import hashlib
import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import Field
from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls
from test_runtime import run_agent as fixture_run_agent

from zhixing_next.agent_collaboration import (
    RESULT_MESSAGE_LIMIT,
    RESULT_WINDOW,
    AgentCollaboration,
    ChildLedger,
)
from zhixing_next.runtime import run_agent
from zhixing_next.store import Store


def persisted_run(tmp_path):
    store = Store(make_settings(tmp_path))
    conversation = store.create_conversation("Complete research delivery")
    store.submit_message(conversation["id"], id="request", content="Read all findings")
    return store, store.claim_next("chat")


def call(name, args, identifier):
    return AIMessage(content="", tool_calls=[{
        "name": name, "args": args, "id": identifier, "type": "tool_call",
    }])


async def test_actual_graph_rejects_final_after_only_first_child_result_page(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    run = make_run("long-delivery", "Read the full research result before answering")
    child_id = "a_" + hashlib.sha256(f"{run['id']}:start".encode()).hexdigest()[:16]
    critical_tail = "The earlier finding is invalid; preserve this limitation."
    child_model = ScriptedModel(replies=[AIMessage(content="x" * RESULT_WINDOW + critical_tail)])
    monkeypatch.setattr("zhixing_next.runtime.create_model", lambda *args, **kwargs: child_model)
    parent = ScriptedModel(replies=[
        call("start_agent", {"task": "Read evidence", "source_paths": []}, "start"),
        call("wait_agents", {"agent_ids": [child_id]}, "first-page"),
        AIMessage(content="Premature answer that has not seen the limitation"),
        call("wait_agents", {"agent_ids": [child_id], "result_offset": RESULT_WINDOW}, "remaining-page"),
        AIMessage(content="Final answer includes the actual limitation"),
    ])
    result = await fixture_run_agent(
        settings, run, persona="", emit=ignore, controls=no_controls,
        acknowledge=ignore, model_override=parent,
    )
    assert result == "Final answer includes the actual limitation"
    assert critical_tail not in str(parent.seen[2])
    assert any("first page or tail page alone" in str(message.content) for message in parent.seen[3])
    assert any(isinstance(message, ToolMessage) and critical_tail in str(message.content) for message in parent.seen[-1])


class PagedResultModel(ScriptedModel):
    page_menus: list[bool] = Field(default_factory=list)

    def bind_tools(self, tools, **kwargs):
        wait = next(item for item in tools if (item.get("name") if isinstance(item, dict) else item.name) == "wait_agents")
        schema = wait["parameters"] if isinstance(wait, dict) else wait.tool_call_schema.model_json_schema()
        self.page_menus.append("result_offset" in schema["properties"])
        return super().bind_tools(tools, **kwargs)

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(messages)
        if len(self.seen) == 1:
            answer = call("wait_agents", {}, "first-pages")
        elif len(self.seen) == 2:
            answer = AIMessage(content="Premature answer before reading remaining results")
        else:
            latest = {}
            for message in messages:
                if isinstance(message, ToolMessage) and message.name == "wait_agents":
                    payload = json.loads(message.content)
                    latest.update({row["id"]: row for row in payload["agents"]})
            pending = [row for row in latest.values() if row["result_truncated"]]
            assert not pending or self.page_menus[-1], "The actual model menu must permit the returned continuation"
            answer = AIMessage(content="All critical tails received") if not pending else AIMessage(content="", tool_calls=[{
                "name": "wait_agents", "args": {"agent_ids": [row["id"]], "result_offset": row["next_result_offset"]},
                "id": f"page-{len(self.seen)}-{row['id']}", "type": "tool_call",
            } for row in pending])
        return ChatResult(generations=[ChatGeneration(message=answer)])


@pytest.mark.parametrize("repeated", ['"A"\n', "汉🔬"])
async def test_actual_sdk_receives_bounded_multi_child_pages_instead_of_offloaded_pointer(tmp_path, repeated):
    store, run = persisted_run(tmp_path)
    ledger = ChildLedger(store, run["id"])
    markers = []
    for sequence in range(4):
        marker = f"CRITICAL-CHILD-{sequence}-TAIL"
        markers.append(marker)
        text = repeated * ((RESULT_WINDOW - 100) // len(repeated)) + marker
        child, _ = ledger.create(f"start-{sequence}", f"child-{sequence}", "Read facts", 4)
        ledger.update(child["id"], "completed", result=text)
    parent = PagedResultModel(replies=[])
    result = await run_agent(
        store.settings, run, persona="", emit=ignore, controls=no_controls,
        acknowledge=ignore, model_override=parent,
    )
    assert result == "All critical tails received"
    assert parent.page_menus[0] is False
    assert parent.page_menus[1] is True
    assert parent.page_menus[-1] is False
    first = next(message for message in parent.seen[1] if isinstance(message, ToolMessage) and message.tool_call_id == "first-pages")
    assert all(marker not in str(first.content) for marker in markers)
    assert any("first page or tail page alone" in str(message.content) for message in parent.seen[2])
    delivered = [message for message in parent.seen[-1] if isinstance(message, ToolMessage) and message.name == "wait_agents"]
    assert all("/large_tool_results/" not in message.content for message in delivered)
    assert all(marker in "".join(str(message.content) for message in delivered) for marker in markers)
    for message in delivered:
        payload = json.loads(message.content)
        assert max(len(json.dumps(payload, ensure_ascii=ascii_only)) for ascii_only in (True, False)) <= RESULT_MESSAGE_LIMIT


async def test_multiple_eight_thousand_character_results_reveal_paging_only_after_actual_truncation(tmp_path):
    store, run = persisted_run(tmp_path)
    ledger = ChildLedger(store, run["id"])
    for sequence in range(4):
        child, _ = ledger.create(f"start-{sequence}", f"child-{sequence}", "Read facts", 4)
        ledger.update(child["id"], "completed", result='"\\\n\t' * 1990 + f"TAIL-{sequence}")
    parent = PagedResultModel(replies=[])
    result = await run_agent(
        store.settings, run, persona="", emit=ignore, controls=no_controls,
        acknowledge=ignore, model_override=parent,
    )
    assert result == "All critical tails received"
    assert parent.page_menus[0] is False and parent.page_menus[1] is True
    assert parent.page_menus[-1] is False


async def test_out_of_order_pages_need_complete_coverage_and_cannot_skip_a_gap(tmp_path):
    store, run = persisted_run(tmp_path)
    manager = AgentCollaboration(store, run, None, ignore, no_controls)
    child, _ = manager.ledger.create("start", "reader", "Read the evidence", 4)
    manager.ledger.update(child["id"], "completed", result="x" * (RESULT_WINDOW * 2 + 10))

    # A terminal tail receipt has no next page, but cannot establish a full read.
    tail = (await manager.wait([child["id"]], result_offset=RESULT_WINDOW * 2))["agents"][0]
    assert not tail["result_truncated"] and manager.outstanding()
    await manager.wait([child["id"]], result_offset=RESULT_WINDOW * 4)
    await manager.wait([child["id"]])
    assert manager.outstanding(), "Reading the first and last pages must retain the unread middle"
    await manager.wait([child["id"]], result_offset=RESULT_WINDOW)
    assert manager.outstanding() == []


@pytest.mark.parametrize("status,result", [("failed", None), ("completed", ""), ("interrupted", None)])
async def test_empty_terminal_result_only_needs_its_actual_status_receipt(tmp_path, status, result):
    store, run = persisted_run(tmp_path)
    manager = AgentCollaboration(store, run, None, ignore, no_controls)
    child, _ = manager.ledger.create("start", "reader", "Read evidence", 4)
    manager.ledger.update(child["id"], status, result=result)
    assert manager.outstanding()
    receipt = (await manager.wait([child["id"]]))["agents"][0]
    assert receipt["status"] == status and receipt["result"] == result
    assert manager.outstanding() == []


async def test_followup_result_version_cannot_reuse_old_read_coverage(tmp_path):
    store, run = persisted_run(tmp_path)
    versions = ["old-" * (RESULT_WINDOW // 4) + "old-tail", "new-" * (RESULT_WINDOW // 4) + "new-tail"]
    turns = 0

    async def runner(row, history, controls, emit, save):
        nonlocal turns
        incoming = (await controls())["steers"]
        messages = [*history, *[HumanMessage(content=item["content"], id=item["id"]) for item in incoming], AIMessage(content=versions[turns])]
        turns += 1
        save(messages)
        return messages

    manager = AgentCollaboration(store, run, runner, ignore, no_controls)
    child = await manager.start("Read evidence", "reader", "start")
    try:
        original = (await manager.wait([child["id"]]))["agents"][0]
        await manager.wait([child["id"]], result_offset=original["next_result_offset"])
        assert manager.outstanding() == []
        await manager.send(child["id"], "Apply a new fact", "follow-up")
        await manager.children[child["id"]].task
        # The old page cursor can fetch this current page, but grants no proof
        # that the new version's earlier text was read.
        current = (await manager.wait([child["id"]], result_offset=original["next_result_offset"]))["agents"][0]
        assert current["status"] == "completed"
        assert manager.outstanding()
        latest = (await manager.wait([child["id"]]))["agents"][0]
        assert latest["result_version"] == original["result_version"] + 1
        assert manager.outstanding() == []
    finally:
        await manager.shutdown()


@pytest.mark.parametrize("dismissed_status", ["completed", "interrupted"])
async def test_new_owner_requires_a_full_read_unless_result_is_explicitly_abandoned(tmp_path, dismissed_status):
    store, run = persisted_run(tmp_path)
    first = AgentCollaboration(store, run, None, ignore, no_controls)
    child, _ = first.ledger.create("start", "reader", "Read evidence", 4)
    first.ledger.update(child["id"], "completed", result="x" * (RESULT_WINDOW + 10))
    await first.wait([child["id"]])
    await first.wait([child["id"]], result_offset=RESULT_WINDOW)
    assert first.outstanding() == []
    second = AgentCollaboration(store, run, None, ignore, no_controls)
    assert second.outstanding()
    await second.wait([child["id"]], result_offset=RESULT_WINDOW)
    assert second.outstanding()
    await second.wait([child["id"]])
    assert second.outstanding() == []
    abandoned, _ = second.ledger.create("unused", "unused", "Unneeded evidence", 4)
    second.ledger.update(abandoned["id"], dismissed_status, result="y" * (RESULT_WINDOW + 10))
    assert second.outstanding()
    receipt = await second.close(abandoned["id"])
    assert receipt["stopped"]
    assert second.outstanding() == []
