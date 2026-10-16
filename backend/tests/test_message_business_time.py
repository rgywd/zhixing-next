from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from langchain_core.messages import AIMessage
from test_runtime import ScriptedModel, ignore, make_settings, no_controls

from zhixing_next.runtime import _business_time_prompt, run_agent
from zhixing_next.store import Store


@pytest.mark.parametrize("agent_id", [None, "finance", "health"])
async def test_delayed_queue_uses_original_user_message_date_for_main_and_service_agents(tmp_path, agent_id):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("跨日排队", agent_id=agent_id)["id"]
    store.submit_message(conversation, id="yesterday", content="记录这个月到现在的开支")
    with store._connection(write=True) as db:
        db.execute("UPDATE messages SET created_at='2026-10-15T10:44:00+00:00' WHERE id='yesterday'")
        db.execute("UPDATE runs SET created_at='2026-10-16T04:00:00+00:00' WHERE message_id='yesterday'")
    text = _business_time_prompt(store, "yesterday", now=datetime(2026, 10, 16, 12, tzinfo=ZoneInfo("Asia/Shanghai")))
    assert "Current service time: 2026-10-16T12:00:00+08:00" in text
    assert "source message was sent at: 2026-10-15T18:44:00+08:00" in text
    assert "not a later queue execution time" in text and "explicitly stated date/context takes precedence" in text
    run = store.claim_next("chat")
    run["agent"] = store.get_agent(agent_id) if agent_id else None
    model = ScriptedModel(replies=[AIMessage(content="按原消息日期核对。")])
    await run_agent(settings, run, persona="", emit=ignore, controls=no_controls, acknowledge=ignore, model_override=model)
    assert "source message was sent at: 2026-10-15T18:44:00+08:00" in str(model.seen[0])
