import asyncio
import io
from uuid import uuid4

import httpx
import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from PIL import Image
from test_runtime import ScriptedModel, ignore, no_controls

from zhixing_next.api import create_app
from zhixing_next.config import ModelConfig, Settings
from zhixing_next.resources import hydrate_messages, input_message, resource_bytes
from zhixing_next.runtime import _portable_history, run_agent
from zhixing_next.store import Store


def test_text_model_does_not_receive_historical_image_tool_blocks(setup):
    settings, _, _ = setup
    message = ToolMessage(
        content=[{"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,example"}}],
        tool_call_id="image",
    )
    portable = _portable_history([message])
    result = hydrate_messages(settings, portable, image_input=False)
    assert "image_url" not in str(result[0].content)
    assert "当前模型" in str(result[0].content)
    assert hydrate_messages(settings, portable, image_input=True)[0].content == message.content


def png():
    image = Image.new("RGB", (32, 24), "red")
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


async def upload(client, conversation, name="screen.png", data=None):
    response = await client.put(
        f"/v1/conversations/{conversation}/files/{uuid4()}",
        params={"filename": name},
        headers={"Content-Type": "application/octet-stream"},
        content=png() if data is None else data,
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def setup(tmp_path):
    settings = Settings(
        data_dir=tmp_path / "data", workspace_root=tmp_path / "workspaces", api_token="x" * 30
    )
    return settings, Store(settings), create_app(settings)


async def test_image_only_retry_scope_reopen_and_original_integrity(setup):
    settings, store, app = setup
    conversation = store.create_conversation("截图")["id"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app),
        base_url="http://test",
        headers={"Authorization": "Bearer " + settings.api_token},
    ) as client:
        resource = await upload(client, conversation)
        payload = {"id": "image-only", "attachments": [resource["id"]]}
        first = await client.post(f"/v1/conversations/{conversation}/messages", json=payload)
        assert first.status_code == 200, first.text
        retry = await client.post(f"/v1/conversations/{conversation}/messages", json=payload)
        assert first.json() == retry.json()
        other = store.create_conversation("其他")["id"]
        assert (
            await client.post(
                f"/v1/conversations/{other}/messages", json={**payload, "id": "wrong-scope"}
            )
        ).status_code == 403
        preview = await client.get(f"/v1/resources/{resource['id']}/content?preview=true")
        assert preview.headers["content-type"] == "image/jpeg"
        assert Image.open(io.BytesIO(preview.content)).size == (32, 24)
        run = Store(settings).claim_next("chat")
        assert run["attachments"][0]["id"] == resource["id"]
        # Editing a working copy cannot mutate the original image or future model payload.
        (store.workspace_for(conversation) / resource["path"]).write_bytes(b"modified")
        assert resource_bytes(settings, resource) == png()


async def test_real_graph_hydrates_images_without_checkpointing_base64_and_keeps_followup(setup):
    settings, store, app = setup
    conversation = store.create_conversation("截图续聊")["id"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app),
        base_url="http://test",
        headers={"Authorization": "Bearer " + settings.api_token},
    ) as client:
        resource = await upload(client, conversation)
    store.submit_message(
        conversation, id="first", content="看看这张图", attachments=[resource["id"]]
    )
    run = store.claim_next("chat")
    model = ScriptedModel(replies=[AIMessage(content="看到了")])
    await run_agent(
        settings,
        run,
        persona="",
        emit=ignore,
        controls=no_controls,
        acknowledge=ignore,
        model_override=model,
    )
    human = next(item for item in model.seen[0] if isinstance(item, HumanMessage))
    assert human.content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    store.finish_run(run["id"], "completed", result="看到了")
    store.submit_message(conversation, id="second", content="继续分析")
    second = ScriptedModel(replies=[AIMessage(content="继续")])
    await run_agent(
        settings,
        store.claim_next("chat"),
        persona="",
        emit=ignore,
        controls=no_controls,
        acknowledge=ignore,
        model_override=second,
    )
    assert any(
        isinstance(item, HumanMessage) and isinstance(item.content, list) for item in second.seen[0]
    )
    import aiosqlite

    from zhixing_next.runtime import _prepare_checkpointer

    async with aiosqlite.connect(settings.data_dir / "checkpoints.sqlite") as connection:
        saver = await _prepare_checkpointer(connection)
        checkpoint = await saver.aget({"configurable": {"thread_id": conversation}})
        assert "data:image/jpeg;base64," not in str(checkpoint)
    portable = _portable_history([input_message("图", "m", [resource])])
    assert portable[0].additional_kwargs["zhixing_attachments"][0]["id"] == resource["id"]
    assert (
        hydrate_messages(settings, portable, image_input=True)[0].content[1]["type"] == "image_url"
    )


async def test_steer_image_and_capability_check_are_atomic(setup):
    settings, store, app = setup
    conversation = store.create_conversation("引导")["id"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app),
        base_url="http://test",
        headers={"Authorization": "Bearer " + settings.api_token},
    ) as client:
        resource = await upload(client, conversation)
        store.submit_message(conversation, id="run", content="开始")
        run = store.claim_next("chat")
        entered, release = asyncio.Event(), asyncio.Event()
        model = ScriptedModel(
            replies=[AIMessage(content="旧决策"), AIMessage(content="依据补图回答")],
            entered=entered,
            release=release,
        )

        async def controls():
            return store.get_controls(run["id"])

        async def acknowledge(ids):
            store.acknowledge_steers(run["id"], ids)

        task = asyncio.create_task(
            run_agent(
                settings,
                run,
                persona="",
                emit=ignore,
                controls=controls,
                acknowledge=acknowledge,
                model_override=model,
            )
        )
        await entered.wait()
        response = await client.post(
            f"/v1/conversations/{conversation}/messages",
            json={
                "id": "steer-image",
                "intent": "steer",
                "target_run_id": run["id"],
                "attachments": [resource["id"]],
            },
        )
        assert response.status_code == 200
        release.set()
        assert await task == "依据补图回答"
        assert any(
            isinstance(m, HumanMessage) and isinstance(m.content, list) for m in model.seen[-1]
        )
        assert store.get_controls(run["id"])["steers"] == []
        settings.models["text-only"] = ModelConfig(
            protocol="chat_completions", model="text", api_key_env="TEST_KEY"
        )
        response = await client.post(
            f"/v1/conversations/{conversation}/messages",
            json={"id": "unsupported", "attachments": [resource["id"]], "model_id": "text-only"},
        )
        assert response.status_code == 422
        assert all(
            item["id"] != "unsupported" for item in store.list_messages(conversation)["items"]
        )


async def test_broken_image_never_becomes_a_resource(setup):
    settings, store, app = setup
    conversation = store.create_conversation("坏图")["id"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app),
        base_url="http://test",
        headers={"Authorization": "Bearer " + settings.api_token},
    ) as client:
        response = await client.put(
            f"/v1/conversations/{conversation}/files/{uuid4()}",
            params={"filename": "broken.png"},
            headers={"Content-Type": "application/octet-stream"},
            content=b"not an image",
        )
        assert response.status_code == 422
        assert store.list_resources()["items"] == []


async def test_finance_image_reaches_model_and_observation_service(setup):
    settings, store, app = setup
    conversation = store.create_conversation("财务截图", agent_id="finance")["id"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app),
        base_url="http://test",
        headers={"Authorization": "Bearer " + settings.api_token},
    ) as client:
        resource = await upload(client, conversation)
    store.submit_message(
        conversation, id="finance-image", content="记录截图中的余额", attachments=[resource["id"]]
    )
    run = store.claim_next("chat")
    run["agent"] = store.get_agent("finance")
    # This verifies image transport and service writes, not cloud OCR accuracy.
    model = ScriptedModel(
        replies=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "record_finance_observation",
                        "args": {
                            "kind": "balance",
                            "platform": "测试账户",
                            "amount": "123.45",
                            "note": "图片链路测试",
                        },
                        "id": "record",
                        "type": "tool_call",
                    }
                ],
            ),
            AIMessage(content="已记录测试余额。"),
        ]
    )
    await run_agent(
        settings,
        run,
        persona="",
        emit=ignore,
        controls=no_controls,
        acknowledge=ignore,
        model_override=model,
    )
    human = next(item for item in model.seen[0] if isinstance(item, HumanMessage))
    assert human.content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert store.list_finance_observations()["balances"][0]["amount"] == "123.45"
    assert "view_image" in model.bound_names and "execute" not in model.bound_names
