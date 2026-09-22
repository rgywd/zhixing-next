import os
import subprocess
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from zhixing_next.api import create_app
from zhixing_next.config import ModelConfig, PathGrant, Settings


@pytest.fixture
def settings(tmp_path):
    return Settings(
        data_dir=tmp_path / "data",
        workspace_root=tmp_path / "work",
        api_token="test-service-token-do-not-use",
    )


@pytest.fixture
def client(settings):
    with TestClient(
        create_app(settings), headers={"Authorization": f"Bearer {settings.api_token}"}
    ) as client:
        yield client


def test_auth_is_required_and_missing_config_fails_closed(settings):
    client = TestClient(create_app(settings))
    assert client.get("/healthz").json() == {"status": "ok"}
    response = client.get("/v1/assistant")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"
    assert settings.api_token not in response.text
    assert (
        client.get("/v1/assistant", headers={"Authorization": "Bearer incorrect"}).status_code
        == 401
    )
    settings.api_token = ""
    assert TestClient(create_app(settings)).get("/v1/assistant").status_code == 503


def test_persona_project_and_conversation_flow(client):
    assert (
        client.put("/v1/assistant", json={"name": "小知", "persona": "核实来源后回答"}).status_code
        == 200
    )
    assert client.get("/v1/assistant").json()["name"] == "小知"
    project = client.post("/v1/projects", json={"name": "研究"}).json()
    conversation = client.post(
        "/v1/conversations", json={"title": "资料", "project_id": project["id"]}
    ).json()
    assert (
        client.get("/v1/projects").json()["items"][0]["workspace_path"] == project["workspace_path"]
    )
    assert client.get("/v1/conversations").json()["items"][0]["id"] == conversation["id"]
    assert (
        client.post(
            "/v1/conversations", json={"title": "未知项目", "project_id": "missing"}
        ).status_code
        == 404
    )


def test_send_retry_control_cancel_and_progress(client):
    conversation = client.post("/v1/conversations", json={"title": "聊天"}).json()["id"]
    path = f"/v1/conversations/{conversation}/messages"
    body = {"id": "message-1", "content": "研究资料", "intent": "queue", "kind": "task"}
    accepted = client.post(path, json=body).json()
    assert client.post(path, json=body).json() == accepted
    assert client.post(path, json=dict(body, content="不同内容")).status_code == 409
    run = client.app.state.store.claim_next("task")
    steer = client.post(
        path,
        json={
            "id": "steer",
            "content": "近三年",
            "intent": "steer",
            "kind": "task",
            "target_run_id": run["id"],
        },
    )
    assert steer.json()["message"]["status"] == "accepted"
    assert client.get(f"/v1/runs/{run['id']}/events").json()["items"][0]["type"] == "started"
    assert client.post(f"/v1/runs/{run['id']}/cancel").json()["cancel_requested"]
    assert (
        client.post(
            path,
            json={"id": "late", "content": "迟到", "intent": "steer", "target_run_id": run["id"]},
        ).status_code
        == 409
    )
    client.app.state.store.finish_run(run["id"], "cancelled")
    assert client.get(f"/v1/runs/{run['id']}").json()["status"] == "cancelled"
    assert client.post(f"/v1/conversations/{conversation}/resume").json()["blocked"] is False


@pytest.mark.parametrize(
    "payload",
    [
        {"id": "bad", "content": "   "},
        {"id": "bad", "content": "test", "intent": "unknown"},
        {"id": "bad", "content": "test", "intent": "steer"},
        {"id": "bad", "content": "test", "target_run_id": "unexpected"},
        {"id": "bad", "content": "test", "secret": "not-reflected"},
    ],
)
def test_invalid_messages_are_rejected_without_reflecting_inputs(client, payload):
    conversation = client.post("/v1/conversations", json={"title": "验证"}).json()["id"]
    response = client.post(f"/v1/conversations/{conversation}/messages", json=payload)
    assert response.status_code == 422
    assert set(response.json()) == {"error"}
    assert "not-reflected" not in response.text


def test_schedule_api_validation_and_idempotency(client):
    conversation = client.post("/v1/conversations", json={"title": "定时"}).json()["id"]
    body = {
        "id": "schedule",
        "conversation_id": conversation,
        "prompt": "总结",
        "next_run_at": datetime.now(UTC).isoformat(),
        "interval_seconds": 60,
    }
    created = client.post("/v1/schedules", json=body)
    assert created.status_code == 201
    assert client.post("/v1/schedules", json=body).json() == created.json()
    assert client.post("/v1/schedules", json=dict(body, prompt="changed")).status_code == 409
    assert (
        client.patch("/v1/schedules/schedule", json={"enabled": False}).json()["enabled"] is False
    )
    assert (
        client.post("/v1/schedules", json=dict(body, next_run_at="2026-10-01T10:00:00")).status_code
        == 422
    )
    assert client.post("/v1/schedules", json=dict(body, interval_seconds=0)).status_code == 422


def test_pagination_and_uniform_http_errors(client):
    conversation = client.post("/v1/conversations", json={"title": "历史"}).json()["id"]
    path = f"/v1/conversations/{conversation}/messages"
    for number in range(4):
        client.post(path, json={"id": f"m{number}", "content": str(number)})
    latest = client.get(path, params={"latest": True, "limit": 2}).json()
    assert [m["id"] for m in latest["items"]] == ["m2", "m3"]
    earlier = client.get(path, params={"before": latest["previous_cursor"], "limit": 2}).json()
    assert [m["id"] for m in earlier["items"]] == ["m0", "m1"]
    assert client.get(path, params={"latest": True, "cursor": 1}).status_code == 422
    assert client.get(path, params={"limit": 101}).status_code == 422
    assert client.get("/v1/unknown").json() == {
        "error": {"code": "http_error", "message": "Request could not be handled"}
    }


def test_status_reports_configuration_and_heartbeat_without_model_calls(client, monkeypatch):
    response = client.get("/v1/status")
    assert response.status_code == 200
    assert response.json()["model_ready"] is False
    assert response.json()["worker_online"] is False
    assert response.json()["execution_available"] is False
    assert response.json()["sqlite_journal_mode"] in {"wal", "delete"}
    config = ModelConfig(
        protocol="gemini", model="test-model", api_key_env="ZHIXING_TEST_MODEL_KEY"
    )
    client.app.state.settings.models = {"chat": config, "task": config}
    monkeypatch.setenv("ZHIXING_TEST_MODEL_KEY", "test-value-must-not-be-returned")
    client.app.state.store.heartbeat()
    ready = client.get("/v1/status")
    assert ready.json()["model_ready"] is True
    assert ready.json()["worker_online"] is True
    assert "test-value-must-not-be-returned" not in ready.text


def test_active_run_filter_finds_target_outside_recent_queue_window(client):
    conversation = client.post("/v1/conversations", json={"title": "长队列"}).json()["id"]
    path = f"/v1/conversations/{conversation}/messages"
    for number in range(4):
        client.post(path, json={"id": f"queue-{number}", "content": str(number)})
    active = client.app.state.store.claim_next("chat")
    recent = client.get(
        "/v1/runs", params={"conversation_id": conversation, "latest": True, "limit": 2}
    ).json()
    assert active["id"] not in {run["id"] for run in recent["items"]}
    target = client.get(
        "/v1/runs", params={"conversation_id": conversation, "status": "running"}
    ).json()
    assert target["items"][0]["id"] == active["id"]
    assert client.get(f"/v1/conversations/{conversation}").json()["blocked"] is False


def test_file_upload_retry_list_download_and_conflict(client):
    conversation = client.post("/v1/conversations", json={"title": "文件"}).json()["id"]
    identifier = str(uuid4())
    endpoint = f"/v1/conversations/{conversation}/files/{identifier}"
    options = {
        "params": {"filename": "资料.txt"},
        "headers": {"Content-Type": "application/octet-stream"},
    }
    data = "用户上传的资料".encode()
    first = client.put(endpoint, content=data, **options)
    assert first.status_code == 200
    assert first.json() == {
        "path": f"uploads/{identifier}/资料.txt",
        "name": "资料.txt",
        "size": len(data),
    }
    assert client.put(endpoint, content=data, **options).json() == first.json()
    assert client.put(endpoint, content=b"different", **options).status_code == 409
    assert (
        client.put(
            endpoint, content=data, params={"filename": "renamed.txt"}, headers=options["headers"]
        ).status_code
        == 409
    )
    listing = client.get(f"/v1/conversations/{conversation}/files").json()
    assert listing["items"] == [first.json()]
    downloaded = client.get(
        f"/v1/conversations/{conversation}/files/content", params={"path": first.json()["path"]}
    )
    assert downloaded.content == data
    assert downloaded.headers["content-disposition"].startswith("attachment;")
    assert not list((client.app.state.settings.data_dir / "upload-staging").iterdir())


@pytest.mark.parametrize(
    "name",
    [
        "../escape.txt",
        "folder/file.txt",
        "folder\\file.txt",
        "C:stream",
        ".",
        "CON.txt",
        "trailing.",
    ],
)
def test_upload_rejects_unsafe_filename(client, name):
    conversation = client.post("/v1/conversations", json={"title": "边界"}).json()["id"]
    response = client.put(
        f"/v1/conversations/{conversation}/files/{uuid4()}",
        params={"filename": name},
        content=b"x",
        headers={"Content-Type": "application/octet-stream"},
    )
    assert response.status_code == 422


def test_upload_limits_declared_and_streamed_bodies(client, monkeypatch):
    from zhixing_next import files

    monkeypatch.setattr(files, "MAX_UPLOAD_BYTES", 4)
    conversation = client.post("/v1/conversations", json={"title": "限额"}).json()["id"]
    path = f"/v1/conversations/{conversation}/files/{uuid4()}"
    arguments = {
        "params": {"filename": "too-big.txt"},
        "headers": {"Content-Type": "application/octet-stream"},
    }
    assert client.put(path, content=b"12345", **arguments).status_code == 413
    assert client.put(path, content=iter([b"123", b"45"]), **arguments).status_code == 413
    assert client.get(f"/v1/conversations/{conversation}/files").json()["items"] == []
    assert not list((client.app.state.settings.data_dir / "upload-staging").iterdir())


def test_download_cannot_use_execution_grants_or_traverse(client, tmp_path):
    conversation = client.post("/v1/conversations", json={"title": "权限"}).json()["id"]
    outside = tmp_path / "outside.txt"
    outside.write_text("not exposed", encoding="utf-8")
    client.app.state.settings.grants = [PathGrant(path=tmp_path, writable=True)]
    for path in (str(outside), "../../../outside.txt", "..\\outside.txt", "C:/outside.txt"):
        response = client.get(
            f"/v1/conversations/{conversation}/files/content", params={"path": path}
        )
        assert response.status_code == 403
        assert "not exposed" not in response.text
    workspace = client.app.state.store.workspace_for(conversation)
    (workspace / ".env").write_text("private", encoding="utf-8")
    assert (
        client.get(
            f"/v1/conversations/{conversation}/files/content", params={"path": ".env"}
        ).status_code
        == 403
    )
    assert client.get(f"/v1/conversations/{conversation}/files").json()["items"] == []


def test_download_and_upload_reject_symlink_parents(client, tmp_path):
    conversation = client.post("/v1/conversations", json={"title": "链接"}).json()["id"]
    workspace = client.app.state.store.workspace_for(conversation)
    outside = tmp_path / "other"
    outside.mkdir()
    (outside / "hidden.txt").write_text("outside")
    try:
        (workspace / "uploads").symlink_to(outside, target_is_directory=True)
    except OSError as exc:
        if os.name != "nt":
            pytest.skip(f"Symlinks unavailable on this host: {exc.errno}")
        # Directory junctions exercise Windows reparse-point denial without administrator rights.
        created = subprocess.run(
            ["cmd.exe", "/c", "mklink", "/J", str(workspace / "uploads"), str(outside)],
            capture_output=True,
            check=False,
        )
        if created.returncode:
            pytest.skip("Neither symlinks nor directory junctions are available on this host")
    endpoint = f"/v1/conversations/{conversation}/files"
    assert (
        client.get(endpoint + "/content", params={"path": "uploads/hidden.txt"}).status_code == 403
    )
    assert (
        client.put(
            endpoint + f"/{uuid4()}",
            params={"filename": "injected.txt"},
            content=b"x",
            headers={"Content-Type": "application/octet-stream"},
        ).status_code
        == 403
    )
    assert sorted(p.name for p in outside.iterdir()) == ["hidden.txt"]
