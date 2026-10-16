"""AI tools record unknown clocks without manufacturing actual meal facts."""

import pytest
from langchain_core.utils.function_calling import convert_to_openai_tool

from zhixing_next.config import Settings
from zhixing_next.finance_context import active_finance_input, delegated_finance_input
from zhixing_next.health_service import HealthService
from zhixing_next.health_tools import create_health_tools
from zhixing_next.life_tools import create_life_tools
from zhixing_next.meal_input import UNKNOWN_MEAL_TIME_NOTE, UNKNOWN_MEASUREMENT_TIME_NOTE
from zhixing_next.store import Store, StoreError


@pytest.fixture
def inputs(tmp_path):
    store = Store(Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work"))
    conversation = store.create_conversation("自然记录")['id']

    def source(identifier="source", text="今天午饭花24.60元，实际吃豆腐、青菜、米饭，米饭剩了一半。",
               created_at="2026-10-16T07:42:13.123456+00:00"):
        store.submit_message(conversation, id=identifier, content=text)
        with store._connection(write=True) as db:
            db.execute("UPDATE messages SET created_at=? WHERE id=?", (created_at, identifier))
        return {
            **{tool.name: tool for tool in create_health_tools(store.settings, conversation, identifier)},
            **{tool.name: tool for tool in create_life_tools(store.settings, conversation, identifier)},
        }

    return store, source


async def record(tools, route, **changes):
    fields = {"description": "豆腐、青菜、米饭", "portion": "米饭剩了一半", "meal_type": "lunch", **changes}
    if route == "health":
        return await tools["record_meal"].ainvoke({"entry_key": "meal", **fields})
    return (await tools["record_life_meal"].ainvoke({
        "entry_key": "meal", "meal": fields, "amount": "24.60", "occurred_on": "2026-10-16",
    }))["meal"]


@pytest.mark.parametrize("route", ["health", "life"])
async def test_omitted_meal_clock_uses_original_message_not_worker_time_and_retries_stably(inputs, route):
    _, source = inputs
    tools = source()
    result = await record(tools, route)
    assert result["occurred_at"] == "2026-10-16T15:42:13+08:00"
    assert UNKNOWN_MEAL_TIME_NOTE in result["note"]
    assert result["portion"] == "米饭剩了一半"
    assert "豆腐一份" not in result["portion"] and "青菜一份" not in result["portion"]
    repeated = await record(tools, route)
    assert {key: repeated[key] for key in result} == result


@pytest.mark.parametrize("route", ["health", "life"])
async def test_an_unsupported_precise_meal_clock_is_not_promoted_to_an_actual_time(inputs, route):
    _, source = inputs
    result = await record(source(), route, occurred_at="2026-10-16T12:30:00+08:00")
    assert result["occurred_at"] == "2026-10-16T15:42:13+08:00"
    assert UNKNOWN_MEAL_TIME_NOTE in result["note"]


async def test_date_only_retains_the_known_business_day_and_source_recording_clock(inputs):
    _, source = inputs
    result = await record(source(text="10月14日午饭吃了豆腐、青菜和米饭。"), "health", occurred_at="2026-10-14")
    assert result["occurred_at"] == "2026-10-14T15:42:13+08:00"
    assert UNKNOWN_MEAL_TIME_NOTE in result["note"]


async def test_linked_payment_date_supplies_same_meal_day_without_guessing_a_clock(inputs):
    _, source = inputs
    result = await source(text="10月14日午饭花24.60，吃了豆腐青菜米饭。")["record_life_meal"].ainvoke({
        "entry_key": "historical-meal", "meal": {"description": "豆腐青菜米饭"},
        "amount": "24.60", "occurred_on": "2026-10-14",
    })
    assert result["meal"]["occurred_at"] == "2026-10-14T15:42:13+08:00"
    assert result["finance"]["occurred_on"] == "2026-10-14"
    assert UNKNOWN_MEAL_TIME_NOTE in result["meal"]["note"]


@pytest.mark.parametrize("context", [active_finance_input, delegated_finance_input])
async def test_linked_meal_uses_actual_seen_message_identity_and_recording_clock(inputs, context):
    store, source = inputs
    tools = source()
    source("second", "那顿午饭吃了豆腐和青菜", "2026-10-17T03:07:19+00:00")
    token = context.set("second")
    try:
        saved = await tools["record_life_meal"].ainvoke({"entry_key": "meal", "meal": {"description": "豆腐青菜"}})
        replay = await tools["record_life_meal"].ainvoke({"entry_key": "meal", "meal": {"description": "豆腐青菜"}})
    finally:
        context.reset(token)
    assert replay == saved
    assert saved["meal"]["source_id"] == "second"
    events = await tools["query_life_events"].ainvoke({"source_id_filter": "second"})
    assert [event["id"] for event in events["items"]] == [saved["event_id"]]
    assert saved["meal"]["occurred_at"] == "2026-10-17T11:07:19+08:00"
    assert len(HealthService(store).list("meals")["items"]) == 1


async def test_linked_meal_clock_correction_uses_actual_seen_supplement_not_closure_message(inputs):
    _, source = inputs
    tools = source()
    saved = await tools["record_life_meal"].ainvoke({"entry_key": "meal", "meal": {"description": "豆腐青菜"}})
    source("second", "这顿实际是12:20吃的", "2026-10-17T03:07:19+00:00")
    token = active_finance_input.set("second")
    try:
        corrected = await tools["correct_life_meal"].ainvoke({
            "event_id": saved["event_id"], "entry_key": "fix-clock", "meal_changes": {"occurred_at": "2026-10-16T12:20:00+08:00"},
        })
    finally:
        active_finance_input.reset(token)
    assert corrected["meal"]["occurred_at"] == "2026-10-16T12:20:00+08:00"
    assert UNKNOWN_MEAL_TIME_NOTE not in corrected["meal"]["note"]


@pytest.mark.parametrize(("text", "clock"), [
    ("今天12:20吃的午饭。", "12:20:00"), ("中午十二点半吃的午饭。", "12:30:00"),
    ("下午一点二十分吃的午饭。", "13:20:00"),
])
async def test_explicit_user_clocks_are_preserved_without_an_unknown_time_label(inputs, text, clock):
    _, source = inputs
    expected = f"2026-10-16T{clock}+08:00"
    result = await record(source(text=text), "health", occurred_at=expected, note="用户备注")
    assert result["occurred_at"] == expected and result["note"] == "用户备注"


@pytest.mark.parametrize("route", ["health", "life"])
async def test_portion_only_corrections_preserve_original_recording_time_and_unknown_note(inputs, route):
    _, source = inputs
    tools = source()
    if route == "life":
        saved = await tools["record_life_meal"].ainvoke({
            "entry_key": "meal", "meal": {"description": "豆腐青菜米饭", "portion": "米饭剩一半"},
        })
        original = saved["meal"]
        result = await source("correction", "米饭实际只吃三分之一", "2026-10-17T11:00:00+00:00")["correct_life_meal"].ainvoke({
            "entry_key": "correct", "event_id": saved["event_id"], "meal_changes": {"portion": "米饭三分之一"},
        })
        corrected = result["meal"]
    else:
        original = await record(tools, "health")
        corrected = await source("correction", "米饭实际只吃三分之一", "2026-10-17T11:00:00+00:00")["correct_health_record"].ainvoke({
            "entry_key": "correct", "kind": "meals", "identifier": original["id"], "record": {"portion": "米饭三分之一"},
        })
    assert corrected["occurred_at"] == original["occurred_at"]
    assert corrected["note"] == original["note"]
    assert corrected["portion"] == "米饭三分之一"


async def test_date_only_correction_keeps_a_previous_actual_clock_without_new_source_clock(inputs):
    _, source = inputs
    original = await record(source(text="今天12:20吃的午饭。"), "health",
                            occurred_at="2026-10-16T12:20:00+08:00", note="原备注")
    corrected = await source("date-fix", "那顿午饭其实是10月15日。", "2026-10-17T11:00:00+00:00")["correct_health_record"].ainvoke({
        "entry_key": "date-correction", "kind": "meals", "identifier": original["id"],
        "record": {"occurred_at": "2026-10-15"},
    })
    assert corrected["occurred_at"] == "2026-10-15T12:20:00+08:00"
    assert corrected["note"] == "原备注"


async def test_date_only_correction_keeps_previous_unknown_recording_clock_and_note(inputs):
    _, source = inputs
    original = await record(source(), "health", note="原备注")
    corrected = await source("date-fix", "那顿其实是10月15日。", "2026-10-17T11:00:00+00:00")["correct_health_record"].ainvoke({
        "entry_key": "date-correction", "kind": "meals", "identifier": original["id"],
        "record": {"occurred_at": "2026-10-15"},
    })
    assert corrected["occurred_at"] == "2026-10-15T15:42:13+08:00"
    assert corrected["note"] == original["note"]


@pytest.mark.parametrize("route", ["health", "life"])
@pytest.mark.parametrize("note", ["更新备注", "", None])
async def test_note_only_correction_cannot_erase_unknown_meal_time(inputs, route, note):
    _, source = inputs
    tools = source()
    if route == "life":
        original = await tools["record_life_meal"].ainvoke({
            "entry_key": "meal", "meal": {"description": "豆腐青菜米饭", "note": "原备注"},
        })
        corrected = (await source("correction", "修改这顿的备注")["correct_life_meal"].ainvoke({
            "entry_key": "note-correction", "event_id": original["event_id"], "meal_changes": {"note": note},
        }))["meal"]
        original = original["meal"]
    else:
        original = await record(tools, "health", note="原备注")
        corrected = await source("correction", "修改这顿的备注")["correct_health_record"].ainvoke({
            "entry_key": "note-correction", "kind": "meals", "identifier": original["id"], "record": {"note": note},
        })
    assert corrected["occurred_at"] == original["occurred_at"]
    assert corrected["note"] == f"{note or ''}\n{UNKNOWN_MEAL_TIME_NOTE}".strip()


async def test_confirmed_actual_clock_correction_replaces_unknown_marker(inputs):
    _, source = inputs
    original = await record(source(), "health", note="用户备注")
    corrected = await source("correction", "这顿实际是12:20吃的")["correct_health_record"].ainvoke({
        "entry_key": "clock-correction", "kind": "meals", "identifier": original["id"],
        "record": {"occurred_at": "2026-10-16T12:20:00+08:00"},
    })
    assert corrected["occurred_at"] == "2026-10-16T12:20:00+08:00"
    assert corrected["note"] == "用户备注"


@pytest.mark.parametrize("route", ["health", "life"])
@pytest.mark.parametrize("origin_field", ["message", "run"])
async def test_an_internal_consultation_cannot_supply_recording_time(inputs, route, origin_field):
    store, source = inputs
    tools = source()
    with store._connection(write=True) as db:
        if origin_field == "message":
            db.execute("UPDATE messages SET request_json=json_set(request_json,'$.origin','agent_message') WHERE id='source'")
        else:
            db.execute("UPDATE runs SET origin='agent_message' WHERE message_id='source'")
    with pytest.raises(StoreError) as error:
        await record(tools, route)
    assert error.value.code == "record_source_missing"
    assert HealthService(store).list("meals")["items"] == []


@pytest.mark.parametrize(("name", "value"), [("record_weight", 70.9), ("record_steps", 4200)])
async def test_missing_measurement_time_does_not_force_a_guessed_clock_or_change_the_value(inputs, name, value):
    _, source = inputs
    result = await source(text=f"今天实际测到{value}。")[name].ainvoke({"entry_key": "measurement", "value": value})
    assert result["measured_at"] == "2026-10-16T15:42:13+08:00" and result["value"] == value
    assert UNKNOWN_MEASUREMENT_TIME_NOTE in result["note"]


@pytest.mark.parametrize(("name", "kind", "value"), [("record_weight", "weights", 70.9), ("record_steps", "steps", 4200)])
async def test_note_only_measurement_patch_preserves_unknown_marker_and_source_clock(inputs, name, kind, value):
    _, source = inputs
    original = await source()[name].ainvoke({"entry_key": "measurement", "value": value})
    corrected = await source("correction", "清空备注")["correct_health_record"].ainvoke({
        "kind": kind, "identifier": original["id"], "entry_key": "note-correction", "record": {"note": ""},
    })
    assert corrected["measured_at"] == original["measured_at"] and corrected["value"] == original["value"]
    assert corrected["note"] == UNKNOWN_MEASUREMENT_TIME_NOTE


def test_model_schemas_do_not_require_unknown_clocks_or_supply_a_meal_time_example(inputs):
    _, source = inputs
    tools = source()
    for name, field in (("record_meal", "occurred_at"), ("record_weight", "measured_at"), ("record_steps", "measured_at")):
        schema = convert_to_openai_tool(tools[name])["function"]["parameters"]
        assert field not in schema["required"]
    nested = convert_to_openai_tool(tools["record_life_meal"])["function"]["parameters"]["properties"]["meal"]
    assert "occurred_at" not in nested.get("required", [])
    assert "12:30" not in str(nested)
