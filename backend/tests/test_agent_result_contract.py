"""Real wait receipts govern pagination; these are not cloud-model choice tests."""

import pytest
from langchain_core.utils.function_calling import convert_to_openai_tool
from test_runtime import ignore, make_settings, no_controls

from zhixing_next.agent_collaboration import RESULT_WINDOW, AgentCollaboration, create_agent_tools
from zhixing_next.store import Store


@pytest.fixture
def completed_research(tmp_path):
    store = Store(make_settings(tmp_path))
    conversation = store.create_conversation("Result reading")
    store.submit_message(conversation["id"], id="question", content="Read the supplied evidence")
    run = store.claim_next("chat")

    async def no_new_research(*args):
        raise AssertionError("Reading a terminal result must not restart its research")

    manager = AgentCollaboration(store, run, no_new_research, ignore, no_controls)

    def saved_result(text):
        row, _ = manager.ledger.create("start", "reader", "Read evidence", 4)
        manager.ledger.update(row["id"], "completed", result=text)
        return row["id"]

    return manager, {item.name: item for item in create_agent_tools(manager)}, saved_result


@pytest.mark.parametrize("text", ["A short finding; inventory remains unknown.", "x" * RESULT_WINDOW])
async def test_wait_returns_complete_result_without_a_page_or_cleanup(completed_research, text):
    manager, tools, saved_result = completed_research
    child_id = saved_result(text)
    receipt = await tools["wait_agents"].ainvoke({"agent_ids": [child_id], "timeout_ms": 0})
    result = receipt["agents"][0]
    assert result["result"] == text and result["result_length"] == len(text)
    assert result["result_truncated"] is False and result["next_result_offset"] is None
    assert result["stopped"] and result["status"] == "completed"
    assert manager.outstanding() == []  # Final delivery is allowed after this read.
    assert manager.ledger.get(child_id)["status"] == "completed"  # No close required.


async def test_long_result_is_reconstructed_using_only_actual_returned_cursors(completed_research):
    manager, tools, saved_result = completed_research
    text = "首" + "x" * (RESULT_WINDOW * 2) + "尾"
    child_id = saved_result(text)
    offset, chunks, versions, returned_offsets = 0, [], set(), []
    while True:
        receipt = await tools["wait_agents"].ainvoke({
            "agent_ids": [child_id], "timeout_ms": 0, "result_offset": offset,
        })
        result = receipt["agents"][0]
        chunks.append(result["result"])
        versions.add(result["result_version"])
        if not result["result_truncated"]:
            assert result["next_result_offset"] is None
            break
        next_offset = result["next_result_offset"]
        assert next_offset is not None and next_offset > offset
        returned_offsets.append(next_offset)
        offset = next_offset
    assert "".join(chunks) == text and len(chunks) == 3
    assert versions == {1} and len(returned_offsets) == 2
    assert manager.outstanding() == [] and manager.ledger.get(child_id)["status"] == "completed"


def test_model_visible_contract_does_not_supply_an_invented_page_offset():
    tools = {item.name: item for item in create_agent_tools(None)}
    wait = convert_to_openai_tool(tools["wait_agents"])["function"]
    assert "16000" not in str(wait)
    assert "result_truncated=true AND next_result_offset is not null" in wait["description"]
    offset = wait["parameters"]["properties"]["result_offset"]["description"]
    assert "copy its exact next_result_offset" in offset
    assert "never guess an offset or reread the same version" in offset
    assert "already-read terminal result needs no close_agent cleanup" in wait["description"]
    start = convert_to_openai_tool(tools["start_agent"])["function"]
    task = start["parameters"]["properties"]["task"]["description"]
    assert "original research question" in task and "only necessary context and source locations" in task
    assert "Preserve the original scope and unknowns" in task
    assert "full report repeating the whole prompt" in task
