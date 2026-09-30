import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from test_harness import call
from test_runtime import ScriptedModel, ignore, make_settings, no_controls

from zhixing_next.api import create_app
from zhixing_next.config import ModelConfig
from zhixing_next.models import create_model
from zhixing_next.resources import capture_file
from zhixing_next.retrieval import create_retrieval_tools
from zhixing_next.runtime import run_agent
from zhixing_next.skills import skill_bundle
from zhixing_next.store import Store, StoreError
from zhixing_next.taskflow import TaskFlow


async def test_history_and_saved_resource_remain_retrievable_with_pagination(tmp_path):
    settings = make_settings(tmp_path)
    store = Store(settings)
    conversation = store.create_conversation("旅行预算")["id"]
    store.submit_message(conversation, id="history", content="预算 3000。" + "行程" * 6000)
    workspace = store.workspace_for(conversation)
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "itinerary.txt").write_text("车费 100\n住宿 600")
    resource = capture_file(settings, conversation, "itinerary.txt")
    tools = {t.name: t for t in create_retrieval_tools(store)}
    found = await tools["search_history"].ainvoke({"query": "预算"})
    assert found["items"][0]["conversation_id"] == conversation
    message = await tools["read_history_message"].ainvoke({"message_id": "history"})
    assert message["next_offset"] == 8000
    remaining = await tools["read_history_message"].ainvoke(
        {"message_id": "history", "offset": 8000}
    )
    assert remaining["next_offset"] is None
    found = await tools["find_resources"].ainvoke({"query": "itinerary"})
    assert found["items"][0]["id"] == resource["id"]
    result = await tools["read_saved_resource"].ainvoke({"resource_id": resource["id"]})
    assert "住宿 600" in result["text"]
    assert result["sha256"] == resource["sha256"]


def test_context_window_reaches_actual_model_profile(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    settings.models["chat"] = ModelConfig(
        protocol="chat_completions", model="fixture", api_key_env="TEST_MODEL", context_window=32000
    )
    monkeypatch.setenv("TEST_MODEL", "fixture-key")
    assert create_model(settings, "chat").profile["max_input_tokens"] == 32000


def test_sandbox_file_aliases_share_scope_and_do_not_rewrite_file_contents(tmp_path):
    import json

    from langchain_core.messages import ToolMessage

    from zhixing_next.runtime import _sandbox_receipt
    from zhixing_next.tools import FileAccess

    settings = make_settings(tmp_path)
    settings.execution.enabled = True
    workspace = settings.workspace_root / "test"
    workspace.mkdir(parents=True)
    access = FileAccess(settings, workspace)
    access.write_bytes("/workspace/report.txt", b"actual file")
    assert (workspace / "report.txt").read_bytes() == b"actual file"
    with pytest.raises(PermissionError):
        access.authorize("/workspace/../private")
    message = ToolMessage(
        content=json.dumps(
            {"path": str(workspace / "report.txt"), "content": str(workspace / "literal-user-text")}
        ),
        tool_call_id="read",
    )
    result = json.loads(_sandbox_receipt(message, workspace).content)
    assert result["path"] == "/workspace/report.txt"
    assert result["content"] == str(workspace / "literal-user-text")


async def test_subagent_uses_its_snapshotted_model_with_shared_usage(tmp_path, monkeypatch):
    settings = make_settings(tmp_path)
    settings.models = {
        name: ModelConfig(protocol="chat_completions", model=name, api_key_env="TEST_MODEL")
        for name in ("chat", "specialist")
    }
    monkeypatch.setenv("TEST_MODEL", "fixture-key")
    store = Store(settings)
    child = store.create_agent(
        name="资料助手",
        description="读取资料",
        instructions="只使用指定工具",
        tools=["read_text_file"],
        visible=True,
        model_id="specialist",
    )
    conversation = store.create_conversation("模型委托")["id"]
    store.submit_message(conversation, id="input", content="委托资料助手")
    run = store.claim_next("chat")
    run["agents"] = [child]
    snapshot = store.settings_for_run(run)
    assert snapshot.models["specialist"].model == "specialist"
    with store._connection(write=True) as db:
        db.execute(
            "UPDATE provider_models SET config_json=json_set(config_json,'$.model','changed') WHERE id='specialist'"
        )
    assert store.settings_for_run(run).models["specialist"].model == "specialist"
    store.update_agent(
        child["id"],
        name=child["name"],
        description=child["description"],
        instructions=child["instructions"],
        tools=child["tools"],
        visible=True,
        model_id="chat",
    )
    assert (
        next(a for a in store.agents_for_run(run) if a["id"] == child["id"])["model_id"]
        == "specialist"
    )
    child_model = ScriptedModel(
        replies=[
            AIMessage(
                content="资料已检查",
                usage_metadata={"input_tokens": 5, "output_tokens": 2, "total_tokens": 7},
            )
        ]
    )
    used = []

    def configured(_settings, kind, model_id, *args):
        used.append(model_id)
        return child_model

    monkeypatch.setattr("zhixing_next.runtime.create_model", configured)
    parent = ScriptedModel(
        replies=[
            call(
                "task",
                {
                    "subagent_type": "agent_" + child["id"].replace("-", "_"),
                    "description": "检查资料",
                },
                "delegate",
            ),
            AIMessage(content="整理完成"),
        ]
    )
    assert (
        await run_agent(
            snapshot,
            run,
            persona="",
            emit=ignore,
            controls=no_controls,
            acknowledge=ignore,
            model_override=parent,
        )
        == "整理完成"
    )
    assert used == ["specialist"]
    assert "execute" not in child_model.bound_names
    from zhixing_next.resilience import RunBudget

    assert RunBudget(store, run["id"]).summary()["input_tokens"] == 5


def test_skill_bundle_is_immutable_and_rejects_symlinks(tmp_path):
    settings = make_settings(tmp_path)
    source = tmp_path / "skills"
    entry = source / "research" / "SKILL.md"
    entry.parent.mkdir(parents=True)
    entry.write_text(
        "---\nname: research\ndescription: Check source evidence\n---\nRead the actual source."
    )
    settings.execution.skills_dir = source
    bundle, before = skill_bundle(settings)
    entry.write_text("updated instructions")
    after_bundle, after = skill_bundle(settings)
    assert before != after and bundle != after_bundle
    assert "Read the actual source." in (bundle / "research/SKILL.md").read_text()
    (source / "private").symlink_to(tmp_path / "data")
    with pytest.raises(ValueError, match="symbolic"):
        skill_bundle(settings)


def test_question_answer_api_auth_conflict_and_report(tmp_path):
    settings = make_settings(tmp_path)
    settings.api_token = "fixture-access-token-long-enough"
    store = Store(settings)
    conversation = store.create_conversation("问题回执")["id"]
    store.submit_message(conversation, id="input", content="确定格式")
    run = store.claim_next("chat")
    flow = TaskFlow(store)
    question = flow.ask(run["id"], "question", "哪个格式？", ["PDF", "DOCX"])
    store.pause_run(run["id"])
    client = TestClient(create_app(settings))
    path = f"/v1/input-requests/{question['id']}/answer"
    assert client.post(path, json={"answer": "PDF"}).status_code == 401
    client.headers["Authorization"] = "Bearer " + settings.api_token
    assert client.post(path, json={"answer": "PDF"}).status_code == 200
    assert client.post(path, json={"answer": "DOCX"}).status_code == 409
    assert client.get(f"/v1/runs/{run['id']}/report").json()["steps"] == []


def test_custom_agent_edit_cannot_acquire_service_tools(tmp_path):
    store = Store(make_settings(tmp_path))
    fields = dict(name="资料", description="阅读资料", instructions="", tools=[], visible=True)
    agent = store.create_agent(**fields)
    with pytest.raises(StoreError, match="fixed service"):
        store.update_agent(agent["id"], **(fields | {"tools": ["record_finance_observation"]}))
