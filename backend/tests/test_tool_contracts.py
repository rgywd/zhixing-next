"""Check the schemas models actually receive, plus safe typed-tool round trips.

These local contract tests verify structure and execution boundaries. They do
not establish that a real model will choose the right tool or preserve semantics.
"""

import json
from types import SimpleNamespace

import pytest
from langchain_core.messages import ToolMessage
from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import ValidationError

from zhixing_next.config import Settings
from zhixing_next.finance_service import FinanceService
from zhixing_next.finance_tools import create_finance_service_tools
from zhixing_next.health_schema import HealthRecordChanges, MealChanges, ReminderChanges, supplied
from zhixing_next.health_service import HealthService
from zhixing_next.health_tools import create_health_tools
from zhixing_next.life_tools import create_life_tools
from zhixing_next.runtime import RunControls
from zhixing_next.store import Store, StoreError


@pytest.fixture
def contracts(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work")
    store = Store(settings)
    conversation = store.create_conversation("工具契约虚构测试")["id"]
    store.submit_message(conversation, id="tool-source", content="2026年10月16日午饭24.60元")
    tools = [*create_health_tools(settings, conversation, "tool-source"),
             *create_life_tools(settings, conversation, "tool-source"),
             *create_finance_service_tools(settings, conversation, "tool-source")]
    return store, {tool.name: tool for tool in tools}


def nodes(value):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from nodes(item)
    elif isinstance(value, list):
        for item in value:
            yield from nodes(item)


@pytest.mark.parametrize("name", [
    "save_health_profile", "save_diet_rule", "record_meal", "save_meal_recommendation",
    "save_health_reminders", "correct_health_record", "record_life_meal", "correct_life_meal",
])
def test_model_visible_nested_health_and_life_objects_are_closed_without_source_metadata(contracts, name):
    _, tools = contracts
    parameters = convert_to_openai_tool(tools[name])["function"]["parameters"]
    nested_objects = [node for node in nodes(parameters) if node is not parameters
                      and (node.get("type") == "object" or "properties" in node)]
    assert nested_objects, f"{name} must expose its nested business fields"
    for node in nested_objects:
        assert node.get("properties"), f"{name} contains a bare object"
        assert node.get("additionalProperties") is False, name
    for node in nodes(parameters):
        assert not {"source_id", "conversation_id"} & node.get("properties", {}).keys(), name


@pytest.mark.parametrize(("name", "argument", "fields"), [
    ("save_health_profile", "profile", {"revision", "food_allergies", "preferences"}),
    ("record_life_meal", "meal", {"occurred_at", "description", "estimated_energy"}),
    ("save_health_reminders", "reminders", {"revision", "timezone", "slots", "paused_dates"}),
    ("correct_health_record", "record", {"revision", "portion", "value", "status"}),
])
def test_model_visible_nested_fields_survive_langchain_openai_conversion(contracts, name, argument, fields):
    _, tools = contracts
    schema = convert_to_openai_tool(tools[name])["function"]["parameters"]["properties"][argument]
    assert fields <= schema["properties"].keys()


@pytest.mark.parametrize(("name", "arguments", "location"), [
    ("save_health_profile", {"profile": {"preferences": "SENSITIVE-WRONG-VALUE"}, "entry_key": "profile"},
     ("profile", "preferences")),
    ("record_meal", {"occurred_at": "2026-10-16T12:00:00+08:00", "description": "豆腐",
                     "entry_key": "meal", "estimated_energy": {"minimum": 200, "maximum": 300}},
     ("estimated_energy", "basis")),
    ("save_meal_recommendation", {"context_revision": 0, "target_date": "2026-10-16",
                                 "options": [{"id": "one", "description": "豆腐米饭"}],
                                 "entry_key": "recommendation"}, ("options", 0, "title")),
    ("save_health_reminders", {"reminders": {"slots": [{"id": "dinner", "time": "25:00"}]},
                              "entry_key": "reminders"}, ("reminders", "slots", 0, "time")),
    ("correct_health_record", {"kind": "meals", "identifier": "existing", "entry_key": "correct",
                              "record": {"portion": ["SENSITIVE-WRONG-VALUE"]}}, ("record", "portion")),
    ("record_life_meal", {"entry_key": "linked", "meal": {
        "occurred_at": "2026-10-16T12:00:00+08:00", "source_id": "SENSITIVE-WRONG-VALUE"}},
     ("meal", "source_id")),
])
async def test_structural_errors_reach_model_with_field_location_and_no_input_values(
    contracts, name, arguments, location,
):
    _, tools = contracts
    tool = tools[name]
    with pytest.raises(ValidationError) as error:
        tool.args_schema.model_validate(arguments)
    assert location in [item["loc"] for item in error.value.errors()]

    events = []

    async def controls():
        return {}

    async def emit(kind, data):
        events.append((kind, data))

    async def handler(request):
        # Runtime schema validation must reject this call before the service runs.
        pytest.fail("invalid structural arguments reached the service")

    request = SimpleNamespace(tool=tool, tool_call={"name": name, "id": "invalid", "args": arguments})
    reply = await RunControls(controls, emit)._invoke_tool(request, handler)
    assert isinstance(reply, ToolMessage) and reply.status == "error"
    feedback = json.loads(reply.content)["error"]
    assert ".".join(map(str, location)) in {item["field"] for item in feedback["fields"]}
    assert len(reply.content) <= 2000 and "SENSITIVE-WRONG-VALUE" not in reply.content
    assert events[-1][1]["failure_category"] == "parameter_validation"
    assert "SENSITIVE-WRONG-VALUE" not in json.dumps(events)


@pytest.mark.parametrize("name", ["correct_finance_transaction", "update_finance_budget"])
def test_legacy_json_is_parsed_but_hidden_from_all_model_schema_forms(contracts, name):
    _, tools = contracts
    tool = tools[name]
    for schema in (tool.args_schema.model_json_schema(),
                   tool.tool_call_schema.model_json_schema(),
                   convert_to_openai_tool(tool)["function"]["parameters"]):
        assert "changes" in schema["properties"]
        assert "changes_json" not in schema["properties"]
        assert "changes_json" not in json.dumps(schema)
    assert "changes_json" not in convert_to_openai_tool(tool)["function"]["description"]
    assert "changes_json" in tool.args_schema.model_fields


async def test_hidden_legacy_finance_calls_still_execute_and_preserve_omitted_budget_fields(contracts):
    store, tools = contracts
    finance = FinanceService(store)
    finance.patch_budget(month="2026-10", idempotency_key="initial-budget", changes={
        "expected_income": "9800", "daily_budget": "1800", "savings_target": "5200",
        "commitments_upsert": [{"key": "rent", "label": "住房", "amount": "1900", "kind": "fixed"}],
    })
    result = await tools["update_finance_budget"].ainvoke({
        "month": "2026-10", "entry_key": "budget-patch", "changes_json": '{"daily_budget":"2000"}',
    })
    assert result["daily_budget"] == "2000.00"
    assert result["expected_income"] == "9800.00" and result["savings_target"] == "5200.00"
    assert [item["key"] for item in result["commitments"]] == ["rent"]
    transaction = finance.create_transaction(idempotency_key="existing-expense", kind="expense",
                                             amount="24.60", occurred_on="2026-10-16")
    corrected = await tools["correct_finance_transaction"].ainvoke({
        "transaction_id": transaction["id"], "entry_key": "legacy-correct",
        "changes_json": '{"amount":"22.60"}',
    })
    assert corrected["amount"] == "22.60" and corrected["changed_fields"] == ["amount"]
    with pytest.raises(StoreError, match="never both"):
        await tools["correct_finance_transaction"].ainvoke({
            "transaction_id": transaction["id"], "entry_key": "ambiguous-correct",
            "changes": {"amount": "1"}, "changes_json": '{"amount":"2"}',
        })


def test_partial_change_models_do_not_materialise_omitted_defaults():
    assert supplied(MealChanges.model_validate({"portion": "半份"})) == {"portion": "半份"}
    assert supplied(HealthRecordChanges.model_validate({"revision": 1, "value": 70.9})) == {
        "revision": 1, "value": 70.9,
    }
    # An explicit null remains distinguishable from an omitted field.
    assert supplied(MealChanges.model_validate({"recommendation_id": None})) == {"recommendation_id": None}
    assert supplied(ReminderChanges.model_validate({"enabled": False, "tone": "简短"})) == {
        "enabled": False, "tone": "简短",
    }


async def test_health_typed_wrappers_pass_only_supplied_patch_fields_to_service(contracts, monkeypatch):
    _, tools = contracts
    captured = []

    def patch_profile(self, record, *, operation_key):
        captured.append(record)
        return record

    monkeypatch.setattr(HealthService, "patch_profile", patch_profile)
    await tools["save_health_profile"].ainvoke({
        "entry_key": "one-preference", "profile": {"revision": 1, "preferences": ["清淡"]},
    })
    # The wrapper must not turn omitted fields into defaults before patching.
    assert captured == [{"revision": 1, "preferences": ["清淡"]}]


async def test_complete_profile_round_trip_keeps_other_user_facts(contracts):
    store, tools = contracts
    health = HealthService(store)
    initial = health.set_profile({**health.profile(), "height_cm": 172,
                                  "activity_limitations": ["避免跑跳"],
                                  "food_allergies": ["花生"], "goals": ["规律进食"]})
    result = await tools["save_health_profile"].ainvoke({
        "entry_key": "complete-profile", "profile": {**initial, "preferences": ["清淡"]},
    })
    assert result["height_cm"] == 172 and result["food_allergies"] == ["花生"]
    assert result["activity_limitations"] == ["避免跑跳"] and result["goals"] == ["规律进食"]


async def test_linked_meal_partial_correction_preserves_unmentioned_meal_and_payment(contracts):
    _, tools = contracts
    recorded = await tools["record_life_meal"].ainvoke({
        "entry_key": "lunch", "amount": "24.60", "occurred_on": "2026-10-16",
        "meal": {"occurred_at": "2026-10-16T12:00:00+08:00", "description": "豆腐青菜米饭",
                 "meal_type": "lunch", "portion": "一份", "note": "原始备注"},
    })
    corrected = await tools["correct_life_meal"].ainvoke({
        "event_id": recorded["event_id"], "entry_key": "lunch-portion-correction",
        "meal_changes": {"portion": "米饭半份"},
    })
    assert corrected["meal"]["portion"] == "米饭半份"
    assert corrected["meal"]["description"] == recorded["meal"]["description"]
    assert corrected["meal"]["note"] == "原始备注"
    assert corrected["finance"]["amount"] == "24.60"
    assert corrected["finance"]["revision"] == recorded["finance"]["revision"]


async def test_reminder_tool_patch_preserves_omitted_pauses_slots_timezone_and_quiet_hours(contracts):
    store, tools = contracts
    health = HealthService(store)
    initial = health.set_reminders({
        **health.reminders(), "enabled": True, "timezone": "Asia/Tokyo",
        "slots": [{"id": "dinner", "time": "18:30", "meal_type": "dinner", "kind": "meal"}],
        "paused_dates": ["2026-10-16", "2026-10-17"], "quiet_start": "22:00", "quiet_end": "08:00",
    })
    result = await tools["save_health_reminders"].ainvoke({
        "entry_key": "reminder-tone-disable", "reminders": {"enabled": False, "tone": "简短提醒"},
    })
    assert result["enabled"] is False and result["tone"] == "简短提醒"
    for field in ("paused_dates", "slots", "timezone", "quiet_start", "quiet_end", "max_per_day"):
        assert result[field] == initial[field], field
