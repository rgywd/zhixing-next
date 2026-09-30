import httpx
import pytest
from langchain_core.messages import AIMessage
from test_harness import call
from test_runtime import ScriptedModel, ignore, make_run, make_settings, no_controls, run_agent

from zhixing_next.config import GitLabConfig
from zhixing_next.gitlab import GitLab, create_gitlab_tools
from zhixing_next.operations import Journal, RunPaused
from zhixing_next.store import Store


async def test_scoped_reads_pagination_and_redirect_does_not_leak_key(monkeypatch):
    monkeypatch.setenv("TEST_GITLAB", "fixture-secret")
    requests = []

    def route(request):
        requests.append(request)
        assert request.headers["PRIVATE-TOKEN"] == "fixture-secret"
        return httpx.Response(
            200,
            json=[
                {"iid": 3, "title": "验收", "web_url": "https://gitlab.test/team/app/-/issues/3"}
            ],
            headers={"x-next-page": "2"},
        )

    config = GitLabConfig(url="https://gitlab.test", token_env="TEST_GITLAB", projects=["team/app"])
    tools = {t.name: t for t in create_gitlab_tools(config, transport=httpx.MockTransport(route))}
    result = await tools["gitlab_issues"].ainvoke({"project": "team/app", "query": "验收"})
    assert result["next_page"] == 2
    assert result["items"][0]["iid"] == 3
    assert "/api/v4/projects/team%2Fapp/issues" in str(requests[0].url)
    with pytest.raises(PermissionError):
        await tools["gitlab_issues"].ainvoke({"project": "other/private"})
    assert len(requests) == 1
    assert "gitlab_create_issue" not in tools
    redirect = GitLab(
        config,
        transport=httpx.MockTransport(
            lambda _: httpx.Response(302, headers={"location": "https://attacker.test"})
        ),
    )
    with pytest.raises(ValueError):
        await redirect.request("GET", "/projects/team%2Fapp")


async def test_write_approval_then_unknown_result_requires_separate_decision(tmp_path, monkeypatch):
    settings, run = make_settings(tmp_path), make_run()
    settings.gitlab = GitLabConfig(
        url="https://gitlab.test", token_env="TEST_GITLAB", projects=["27"], allow_writes=True
    )
    monkeypatch.setenv("TEST_GITLAB", "fixture-secret")
    writes = []

    def timeout_after_submission(request):
        writes.append(request)
        raise httpx.ReadTimeout("provider may have committed")

    monkeypatch.setattr(
        "zhixing_next.gitlab.create_gitlab_tools",
        lambda config: create_gitlab_tools(
            config, transport=httpx.MockTransport(timeout_after_submission)
        ),
    )
    model = ScriptedModel(
        replies=[
            call(
                "gitlab_create_issue",
                {"project": "27", "title": "待办", "description": "明确的交付条件"},
                "external",
            )
        ]
    )
    with pytest.raises(RunPaused):
        await run_agent(
            settings,
            run,
            persona="",
            emit=ignore,
            controls=no_controls,
            acknowledge=ignore,
            model_override=model,
        )
    store, journal = Store(settings), Journal(settings)
    store.pause_run(run["id"])
    approval = journal.approvals(run_id=run["id"])["items"][0]
    assert approval["kind"] == "external_write"
    assert not writes
    journal.decide(approval["id"], "approve")
    store.claim_next("chat")
    with pytest.raises(RunPaused):
        await run_agent(
            settings,
            run,
            persona="",
            emit=ignore,
            controls=no_controls,
            acknowledge=ignore,
            model_override=ScriptedModel(replies=[]),
        )
    assert len(writes) == 1
    store.pause_run(run["id"])
    unknown = journal.approvals(run_id=run["id"])["items"][0]
    assert unknown["kind"] == "uncertain"
    journal.decide(unknown["id"], "skip")
    store.claim_next("chat")
    result = await run_agent(
        settings,
        run,
        persona="",
        emit=ignore,
        controls=no_controls,
        acknowledge=ignore,
        model_override=ScriptedModel(replies=[AIMessage(content="提交结果待核对，未重复创建。")]),
    )
    assert result == "提交结果待核对，未重复创建。"
    assert len(writes) == 1


async def test_confirmed_write_replay_is_not_submitted_twice(tmp_path, monkeypatch):
    settings, run = make_settings(tmp_path), make_run()
    settings.gitlab = GitLabConfig(
        url="https://gitlab.test", token_env="TEST_GITLAB", projects=["27"], allow_writes=True
    )
    monkeypatch.setenv("TEST_GITLAB", "fixture-secret")
    writes = []

    def route(request):
        writes.append(request)
        return httpx.Response(
            201,
            json={
                "id": 90,
                "iid": 4,
                "project_id": 27,
                "title": "测试",
                "web_url": "https://gitlab.test/a/issues/4",
            },
        )

    monkeypatch.setattr(
        "zhixing_next.gitlab.create_gitlab_tools",
        lambda config: create_gitlab_tools(config, transport=httpx.MockTransport(route)),
    )
    model = ScriptedModel(
        replies=[call("gitlab_create_issue", {"project": "27", "title": "测试"}, "external")]
    )
    with pytest.raises(RunPaused):
        await run_agent(
            settings,
            run,
            persona="",
            emit=ignore,
            controls=no_controls,
            acknowledge=ignore,
            model_override=model,
        )
    store, journal = Store(settings), Journal(settings)
    store.pause_run(run["id"])
    journal.decide(journal.approvals(run_id=run["id"])["items"][0]["id"], "approve")
    store.claim_next("chat")
    await run_agent(
        settings,
        run,
        persona="",
        emit=ignore,
        controls=no_controls,
        acknowledge=ignore,
        model_override=ScriptedModel(replies=[AIMessage(content="已创建 #4")]),
    )
    assert len(writes) == 1
    operation = journal.receipts(run["id"])["items"][0]
    assert operation["state"] == "succeeded"
    assert "fixture-secret" not in str(journal.receipts(run["id"]))


async def test_update_rejects_changed_issue_version(monkeypatch):
    monkeypatch.setenv("TEST_GITLAB", "fixture-secret")
    methods = []

    def route(request):
        methods.append(request.method)
        return httpx.Response(200, json={"iid": 1, "updated_at": "new"})

    config = GitLabConfig(
        url="https://gitlab.test", token_env="TEST_GITLAB", projects=["27"], allow_writes=True
    )
    update = next(
        t
        for t in create_gitlab_tools(config, transport=httpx.MockTransport(route))
        if t.name == "gitlab_update_issue"
    )
    with pytest.raises(ValueError, match="changed"):
        await update.ainvoke(
            {"project": "27", "iid": 1, "expected_updated_at": "old", "title": "replacement"}
        )
    assert methods == ["GET"]
