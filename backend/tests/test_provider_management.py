import json
import sqlite3
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import httpx
import pytest
from fastapi.testclient import TestClient

from zhixing_next.api import create_app
from zhixing_next.config import ModelConfig, Settings
from zhixing_next.models import configured_model, model_key
from zhixing_next.provider_network import discover
from zhixing_next.store import Store, StoreError
from zhixing_next.worker import Worker


@pytest.fixture
def settings(tmp_path):
    return Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work", api_token="local-provider-tests-service-token")


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings), headers={"Authorization": f"Bearer {settings.api_token}"}) as client:
        yield client


def add(client, base_url="https://example.invalid/v1", key="private-provider-key"):
    response = client.post("/v1/providers", json={"name": "测试供应商", "protocol": "chat_completions", "base_url": base_url, "api_key": key})
    assert response.status_code == 201, response.text
    provider = response.json()
    response = client.post(f"/v1/providers/{provider['id']}/models", json={"revision": provider["revision"], "models": [{"model": "model-one", "image_input": True, "reasoning_levels": ["none", "high"]}]})
    assert response.status_code == 201, response.text
    return response.json()


def update(client, provider, **changes):
    body = {key: provider[key] for key in ("name", "protocol", "base_url", "enabled", "revision")}
    return client.put(f"/v1/providers/{provider['id']}", json={**body, **changes})


def test_authenticated_crud_keeps_keys_private_and_blank_edits_do_not_erase(client, settings):
    assert client.post("/v1/providers", headers={"Authorization": "Bearer wrong"}, json={}).status_code == 401
    provider = add(client)
    assert "private-provider-key" not in json.dumps(provider)
    assert provider["has_api_key"] and provider["credential_source"] == "stored"
    result = update(client, provider, name="Renamed")
    assert result.status_code == 200
    renamed = result.json()
    assert renamed["has_api_key"]
    assert update(client, provider, name="Stale").status_code == 409
    assert client.get("/v1/providers").json()["items"][0]["name"] == "Renamed"
    for path in ("/v1/providers", "/v1/models", "/v1/status"):
        assert "private-provider-key" not in client.get(path).text
    assert update(client, renamed, clear_api_key=True, api_key="conflicting-action").status_code == 422
    cleared = update(client, renamed, clear_api_key=True).json()
    assert not cleared["has_api_key"]
    assert client.post(f"/v1/providers/{cleared['id']}/discover").status_code == 422
    assert Store(settings).runtime_settings().models[provider["models"][0]["id"]].api_key is None
    assert client.delete(f"/v1/providers/{cleared['id']}?revision={cleared['revision']}").status_code == 200
    assert TestClient(create_app(settings), headers=client.headers).get("/v1/providers").json()["items"] == []


async def test_worker_hot_reads_and_queued_run_snapshots_survive_edit_delete_and_restart(client, settings):
    worker = Worker(settings)  # Created before any provider; no restart needed to see new entries.
    provider = add(client)
    model_id = provider["models"][0]["id"]
    for role in ("chat", "task"):
        assert client.put(f"/v1/models/roles/{role}", json={"model_id": model_id}).status_code == 200
    conversation = client.post("/v1/conversations", json={"title": "snapshot"}).json()["id"]
    client.put(f"/v1/conversations/{conversation}/model", json={"model_id": model_id, "reasoning_effort": "high"})
    old = client.post(f"/v1/conversations/{conversation}/messages", json={"id": "old", "content": "你好"}).json()["run"]
    provider = update(client, provider, base_url="https://new.example.invalid/v1", api_key="replacement-private-key").json()
    changed = client.put(f"/v1/providers/{provider['id']}/models/{model_id}", json={"revision": provider["revision"], "model": {"model": "model-two", "reasoning_levels": ["high"]}})
    assert changed.status_code == 200
    provider = changed.json()
    newer = client.post(f"/v1/conversations/{conversation}/messages", json={"id": "new", "content": "你好"}).json()["run"]
    assert worker.store.runtime_settings().models[model_id].model == "model-two"
    disabled = update(client, provider, enabled=False).json()
    assert client.get("/v1/models").json()["items"] == []
    assert client.get(f"/v1/conversations/{conversation}").json()["model_id"] is None
    assert client.get("/v1/models").json()["roles"]["chat"] is None
    assert client.put("/v1/models/roles/chat", json={"model_id": model_id}).status_code == 422
    assert client.delete(f"/v1/providers/{provider['id']}?revision={disabled['revision']}").status_code == 200
    seen = []

    async def runner(effective, run, **_):
        _, config = configured_model(effective, run["kind"], run["model_id"])
        seen.append((config.model, config.base_url, model_key(config)))
        return "OK"

    restarted = Worker(settings, runner=runner)
    for expected in (old, newer):
        run = restarted.store.claim_next("chat")
        assert run["id"] == expected["id"]
        await restarted._execute(run)
        assert restarted.store.get_run(run["id"])["status"] == "completed"
        assert "private-key" not in client.get(f"/v1/runs/{run['id']}").text
        assert "private-key" not in client.get(f"/v1/conversations/{conversation}/messages").text
    assert seen == [("model-one", "https://example.invalid/v1", "private-provider-key"), ("model-two", "https://new.example.invalid/v1", "replacement-private-key")]


def test_v9_migration_preserves_ids_roles_env_and_existing_queue_once(settings, monkeypatch):
    old = Store(settings)
    conversation = old.create_conversation("legacy")
    run = old.submit_message(conversation["id"], id="legacy", content="hello")["run"]
    with sqlite3.connect(old.db_path) as db:
        db.execute("DROP TABLE run_model_configs")
        db.execute("DROP TABLE provider_models")
        db.execute("DROP TABLE model_providers")
        db.execute("PRAGMA user_version=9")
        db.execute("UPDATE runs SET model_id='chat' WHERE id=?", (run["id"],))
    monkeypatch.setenv("LEGACY_KEY", "legacy-private-key")
    settings.models = {"chat": ModelConfig(protocol="chat_completions", model="legacy-model", provider="Legacy", api_key_env="LEGACY_KEY")}
    client = TestClient(create_app(settings), headers={"Authorization": f"Bearer {settings.api_token}"})
    assert client.get("/v1/models").json()["items"][0]["id"] == "chat"
    provider = client.get("/v1/providers").json()["items"][0]
    assert provider["credential_source"] == "environment"
    assert "LEGACY_KEY" not in json.dumps(provider)
    run = old.get_run(run["id"])
    assert model_key(Store(settings).settings_for_run(run).models["chat"]) == "legacy-private-key"
    assert client.delete(f"/v1/providers/{provider['id']}?revision=1").status_code == 200
    assert Store(settings).runtime_settings().models == {}  # TOML cannot resurrect deleted entries.


@pytest.mark.parametrize("url", ["http://example.com/v1", "https://key@example.com/v1", "https://example.com/?key=hidden", "file:///tmp/key", "https://example.com/#hidden"])
def test_provider_url_restrictions(client, url):
    response = client.post("/v1/providers", json={"name": "bad", "protocol": "chat_completions", "base_url": url, "api_key": "do-not-echo-this"})
    assert response.status_code == 422
    assert "do-not-echo-this" not in response.text


def test_model_validation_atomic_import_duplicate_and_cross_provider_edit(client):
    provider = add(client)
    path = f"/v1/providers/{provider['id']}/models"
    invalid = client.post(path, json={"revision": provider["revision"], "models": [{"model": "first-valid"}, {"model": "invalid", "reasoning_levels": ["low", "low"]}]})
    assert invalid.status_code == 422
    assert len(client.get("/v1/providers").json()["items"][0]["models"]) == 1
    duplicate = client.post(path, json={"revision": provider["revision"], "models": [{"model": "model-one"}, {"model": "new"}]}).json()
    assert len(duplicate["models"]) == 2
    other = add(client)
    assert client.put(f"{path}/{other['models'][0]['id']}", json={"revision": duplicate["revision"], "model": {"model": "bad-owner"}}).status_code == 404
    assert update(client, duplicate, protocol="gemini").status_code == 422


async def test_gemini_discovery_pagination_filtering_headers_and_no_capability_guesses(monkeypatch):
    calls = []
    def respond(request):
        calls.append(request)
        assert request.headers["x-goog-api-key"] == "secret"
        assert "authorization" not in request.headers and "secret" not in str(request.url)
        if not request.url.params.get("pageToken"):
            return httpx.Response(200, json={"models": [{"name": "models/one", "supportedGenerationMethods": ["generateContent"]}, {"name": "models/embed", "supportedGenerationMethods": ["embedContent"]}], "nextPageToken": "next"})
        return httpx.Response(200, json={"models": [{"name": "models/two", "displayName": "Two", "supportedGenerationMethods": ["generateContent"]}]})
    real = httpx.AsyncClient
    monkeypatch.setattr("zhixing_next.provider_network.httpx.AsyncClient", lambda **kwargs: real(**kwargs, transport=httpx.MockTransport(respond)))
    result = await discover(ModelConfig(protocol="gemini", model="unused", base_url="https://example.com", api_key="secret"))
    assert len(calls) == 2 and calls[0].url.path == "/v1beta/models"
    assert result == {"items": [{"model": "one", "name": "one"}, {"model": "two", "name": "Two"}], "truncated": False}


@pytest.mark.parametrize("status", [302, 401, 500])
async def test_discovery_errors_do_not_echo_secrets_or_follow_redirects(monkeypatch, status):
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(status, text="secret-provider-credential", headers={"Location": "https://unrelated.invalid"})
    real = httpx.AsyncClient
    monkeypatch.setattr("zhixing_next.provider_network.httpx.AsyncClient", lambda **kwargs: real(**kwargs, transport=httpx.MockTransport(respond)))
    with pytest.raises(StoreError) as exc:
        await discover(ModelConfig(protocol="responses", model="unused", base_url="https://example.com/v1", api_key="secret-provider-credential"))
    assert "secret-provider-credential" not in str(exc.value)
    assert len(calls) == 1


@contextmanager
def protocol_server():
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            encoded = json.dumps({"data": [{"id": name} for name in ("qwen-flash", "qwen-max", "deepseek-chat", "gemini-flash")]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, body, self.headers.get("Authorization") or self.headers.get("x-goog-api-key")))
            if self.path.endswith("/responses"):
                output = {"type": "function_call", "id": "fc_probe", "call_id": "probe", "name": "zhixing_connection_probe", "arguments": '{"value":"ok"}'} if body.get("tools") else {"type": "message", "id": "msg_probe", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "OK", "annotations": []}]}
                response = {"id": "resp_probe", "object": "response", "created_at": 1, "model": body["model"], "status": "completed", "error": None, "usage": None, "output": [output]}
                events = [{"type": "response.created", "response": response}, {"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "item_id": "msg_probe", "delta": "OK"}, {"type": "response.completed", "response": response}]
                encoded = ("".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events) if body.get("stream") else json.dumps(response)).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream" if body.get("stream") else "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
                return
            if "contents" in body:
                part = {"functionCall": {"name": "zhixing_connection_probe", "args": {"value": "ok"}}} if body.get("tools") else {"text": "OK"}
                response = {"candidates": [{"content": {"role": "model", "parts": [part]}, "finishReason": "STOP"}]}
                stream = "streamGenerateContent" in self.path
                encoded = (f"data: {json.dumps(response)}\n\n" if stream else json.dumps(response)).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream" if stream else "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
                return
            message = {"role": "assistant", "content": "OK"}
            if body.get("tools"):
                message = {"role": "assistant", "content": None, "tool_calls": [{"id": "probe", "type": "function", "function": {"name": "zhixing_connection_probe", "arguments": '{"value":"ok"}'}}]}
            response = {"id": "completion-test", "object": "chat.completion", "created": 1, "model": body["model"], "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if body.get("tools") else "stop"}]}
            if body.get("stream"):
                response["object"] = "chat.completion.chunk"
                response["choices"] = [{"index": 0, "delta": {"content": "OK"}, "finish_reason": "stop"}]
                encoded = f"data: {json.dumps(response)}\n\ndata: [DONE]\n\n".encode()
            else:
                encoded = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream" if body.get("stream") else "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.parametrize("protocol", ["chat_completions", "responses"])
def test_probes_use_real_sdk_http_stream_and_tool_parsing(client, protocol):
    with protocol_server() as (url, requests):
        provider = add(client, url)
        if protocol == "responses":
            provider = update(client, provider, protocol=protocol).json()
        result = client.post(f"/v1/providers/{provider['id']}/models/{provider['models'][0]['id']}/test")
    assert result.status_code == 200, result.text
    assert [check["ok"] for check in result.json()["checks"]] == [True, True, True], result.text
    assert len(requests) == 3
    assert all(header == "Bearer private-provider-key" for _, _, header in requests)
    assert all(body["model"] == "model-one" for _, body, _ in requests)
    assert all(body.get("max_completion_tokens", body.get("max_output_tokens", body.get("max_tokens"))) == 256 for _, body, _ in requests)
    assert all(path == ("/v1/responses" if protocol == "responses" else "/v1/chat/completions") for path, _, _ in requests)
    assert "private-provider-key" not in result.text


def test_recovery_keeps_original_config_and_terminal_runs_drop_private_credentials(client, settings):
    provider = add(client)
    model_id = provider["models"][0]["id"]
    store = Store(settings)
    store.set_model_role("chat", model_id)
    conversation = store.create_conversation("Recovery")["id"]
    run = store.submit_message(conversation, id="recover", content="hello")["run"]
    store.claim_next("chat")
    store.enable_recovery(run["id"])
    provider = update(client, provider, api_key="new-private-key").json()
    store.recover_interrupted()
    recovered = store.claim_next("chat")
    assert recovered["phase"] == "recovering"
    assert model_key(store.settings_for_run(recovered).models[model_id]) == "private-provider-key"
    store.finish_run(run["id"], "interrupted")
    store.resume_run(run["id"])
    resumed = store.claim_next("chat")
    assert model_key(store.settings_for_run(resumed).models[model_id]) == "private-provider-key"
    store.finish_run(run["id"], "completed", result="OK")
    with store._connection() as db:
        assert db.execute("SELECT COUNT(*) FROM run_model_configs").fetchone()[0] == 0


def test_migrated_duplicate_actual_ids_can_still_edit_their_display_names(settings):
    config = ModelConfig(protocol="chat_completions", model="same-model", provider="Original", api_key_env="UNUSED")
    settings.models = {"chat": config, "task": config}
    client = TestClient(create_app(settings), headers={"Authorization": f"Bearer {settings.api_token}"})
    provider = client.get("/v1/providers").json()["items"][0]
    response = client.put(f"/v1/providers/{provider['id']}/models/chat", json={"revision": provider["revision"], "model": {"model": "same-model", "display_name": "聊天"}})
    assert response.status_code == 200, response.text
    assert response.json()["models"][0]["name"] == "聊天"


def test_unconfigured_queued_request_does_not_silently_pick_a_new_default(client, settings):
    store = Store(settings)
    conversation = store.create_conversation("No model")["id"]
    run = store.submit_message(conversation, id="before-config", content="hello")["run"]
    provider = add(client)
    store.set_model_role("chat", provider["models"][0]["id"])
    assert store.settings_for_run(run).models == {}


def test_queue_pins_missing_credentials_even_if_environment_is_configured_later(settings, monkeypatch):
    monkeypatch.delenv("LATE_PROVIDER_KEY", raising=False)
    settings.models = {"chat": ModelConfig(protocol="chat_completions", model="original", api_key_env="LATE_PROVIDER_KEY")}
    store = Store(settings)
    conversation = store.create_conversation("Before credential")["id"]
    run = store.submit_message(conversation, id="missing-key", content="hello")["run"]
    monkeypatch.setenv("LATE_PROVIDER_KEY", "later-private-key")
    assert model_key(store.runtime_settings().models["chat"]) == "later-private-key"
    assert not model_key(store.settings_for_run(run).models["chat"])


@pytest.mark.parametrize("suffix", ["", "/v1beta"])
def test_gemini_real_sdk_handles_root_and_versioned_urls(client, suffix):
    with protocol_server() as (url, requests):
        provider = client.post("/v1/providers", json={"name": "Gemini", "protocol": "gemini", "base_url": url.removesuffix("/v1") + suffix, "api_key": "local-gemini-key"}).json()
        provider = client.post(f"/v1/providers/{provider['id']}/models", json={"revision": provider["revision"], "models": [{"model": "gemini-test"}]}).json()
        result = client.post(f"/v1/providers/{provider['id']}/models/{provider['models'][0]['id']}/test")
    assert result.status_code == 200, result.text
    assert all(check["ok"] for check in result.json()["checks"]), result.text
    assert len(requests) == 3
    assert all(path.startswith("/v1beta/models/") and "/v1beta/v1beta/" not in path for path, _, _ in requests)
    assert all(header == "local-gemini-key" for _, _, header in requests)
    assert all(body["generationConfig"]["maxOutputTokens"] == 256 for _, body, _ in requests)
