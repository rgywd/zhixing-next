import httpx
import pytest

from zhixing_next.search import search_provider


@pytest.mark.asyncio
@pytest.mark.parametrize("kind,expected_path,payload", [
    ("brave", "/res/v1/web/search", {"web": {"results": [{"title": "来源", "url": "https://example.com/a", "description": "摘要"}]}}),
    ("tavily", "/search", {"results": [{"title": "来源", "url": "https://example.com/a", "content": "摘要"}]}),
    ("serper", "/search", {"organic": [{"title": "来源", "link": "https://example.com/a", "snippet": "摘要"}]}),
])
async def test_selected_provider_uses_fixed_endpoint_and_returns_sources(kind, expected_path, payload):
    def handle(request):
        assert request.url.path == expected_path
        assert "test-secret" not in str(request.url)
        assert "test-secret" in (request.headers.get("X-Subscription-Token") or request.headers.get("Authorization") or request.headers.get("X-API-KEY") or "")
        return httpx.Response(200, json=payload)

    result = await search_provider({"kind": kind, "name": "测试", "api_key": "test-secret"}, "最新新闻", transport=httpx.MockTransport(handle))
    assert result["items"] == [{"title": "来源", "url": "https://example.com/a", "text": "摘要"}]
    assert "test-secret" not in str(result)
