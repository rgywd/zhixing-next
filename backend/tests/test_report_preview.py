import hashlib
from uuid import uuid4

import httpx
import pytest

from zhixing_next.api import create_app
from zhixing_next.config import Settings
from zhixing_next.resources import capture_file
from zhixing_next.store import Store


@pytest.fixture
def setup(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work", api_token="x" * 30)
    store = Store(settings)
    conversation = store.create_conversation("报告预览")["id"]
    workspace = store.workspace_for(conversation)
    return settings, store, conversation, workspace, create_app(settings)


def save(setup, filename, data):
    settings, _, conversation, workspace, _ = setup
    (workspace / filename).write_bytes(data)
    return capture_file(settings, conversation, filename)


@pytest.mark.parametrize(("filename", "content", "format"), [
    ("report.md", "# 财务核验\n\n|项目|金额|\n|---|---:|\n|房租预留|2000.00|", "markdown"),
    ("report.csv", "项目,金额\n房租预留,2000.00\n", "text"),
    ("note.txt", "恢复后的真实文本。", "text"),
])
async def test_authenticated_resource_preview_returns_real_immutable_text(setup, filename, content, format):
    settings, _, _, workspace, app = setup
    resource = save(setup, filename, content.encode("utf-8"))
    # Preview must use the immutable published copy, not an edited workspace file.
    (workspace / filename).write_text("模型之后改动的文件")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        route = f"/v1/resources/{resource['id']}/text"
        assert (await client.get(route)).status_code == 401
        assert (await client.get(route, headers={"Authorization": "Bearer wrong"})).status_code == 401
        client.headers["Authorization"] = "Bearer " + settings.api_token
        response = await client.get(route)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.json() == {"resource_id": resource["id"], "name": filename, "content": content,
                                   "format": format, "truncated": False, "sha256": hashlib.sha256(content.encode()).hexdigest()}
        download = await client.get(f"/v1/resources/{resource['id']}/content")
        assert download.content.decode() == content
        assert (await client.get(f"/v1/resources/{uuid4()}/text")).status_code == 404


@pytest.mark.parametrize(("filename", "data"), [("bad.txt", b"\xff\xfe"), ("nul.txt", b"hello\0binary"), ("document.bin", b"some binary")])
async def test_text_preview_rejects_unsupported_or_non_utf8_content(setup, filename, data):
    settings, _, _, _, app = setup
    resource = save(setup, filename, data)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test", headers={"Authorization": "Bearer " + settings.api_token}) as client:
        response = await client.get(f"/v1/resources/{resource['id']}/text")
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "preview_unavailable"
        assert "content" not in response.json()


async def test_text_preview_checks_sha_before_returning_content_and_marks_truncation(setup):
    settings, _, _, _, app = setup
    text = "财" * (128 * 1024 + 17)
    # Uploads allow 20 MiB, whereas captured report tools deliberately limit writes to 256 KiB.
    from zhixing_next.resources import register_upload

    temporary = settings.data_dir / "large-upload"
    data = text.encode()
    temporary.write_bytes(data)
    resource = register_upload(settings, setup[2], str(uuid4()), {"path": "large.txt", "name": "large.txt", "size": len(data)}, temporary, hashlib.sha256(data).hexdigest())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test", headers={"Authorization": "Bearer " + settings.api_token}) as client:
        response = await client.get(f"/v1/resources/{resource['id']}/text")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.json()["content"] == text[:128 * 1024] and response.json()["truncated"]
        (settings.data_dir / "resources" / resource["id"]).write_bytes(b"corrupt original")
        response = await client.get(f"/v1/resources/{resource['id']}/text")
        assert response.status_code == 409 and response.json()["error"]["code"] == "resource_changed"
        assert "corrupt original" not in response.text
