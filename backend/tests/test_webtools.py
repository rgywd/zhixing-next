import socket

import httpx
import pytest

from zhixing_next.webtools import public_address, read_public_page


async def test_fetch_pins_dns_preserves_tls_name_and_attributes_sources():
    async def resolver(url):
        assert url.host == "source.example"
        return "93.184.216.34"

    def handle(request):
        assert request.url.host == "93.184.216.34"
        assert request.headers["host"] == "source.example"
        assert request.extensions["sni_hostname"] == "source.example"
        return httpx.Response(200, headers={"content-type": "text/html"},
                              text="<h1>Evidence</h1><script>secret()</script><p>Useful fact</p>")

    result = await read_public_page("https://source.example/article", transport=httpx.MockTransport(handle), resolver=resolver)
    assert result["source_url"] == "https://source.example/article"
    assert "Useful fact" in result["text"]
    assert "secret()" not in result["text"]


async def test_redirect_is_revalidated_before_fetch():
    checked = []

    async def resolver(url):
        checked.append(url.host)
        if url.host == "localhost":
            raise ValueError("private")
        return "93.184.216.34"

    transport = httpx.MockTransport(lambda request: httpx.Response(302, headers={"location": "https://localhost/admin"}))
    with pytest.raises(ValueError, match="private"):
        await read_public_page("https://public.example", transport=transport, resolver=resolver)
    assert checked == ["public.example", "localhost"]


@pytest.mark.parametrize("url", ["http://example.org", "https://user:secret@example.org", "https://example.org:8443"])
async def test_disallowed_url_shapes(url):
    with pytest.raises(ValueError):
        await public_address(httpx.URL(url))


async def test_mixed_public_private_dns_is_rejected(monkeypatch):
    import asyncio

    async def addresses(*args, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (value, 443))
                for value in ("93.184.216.34", "127.0.0.1")]

    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", addresses)
    with pytest.raises(ValueError, match="Private"):
        await public_address(httpx.URL("https://example.org"))


async def test_body_limit_applies_after_decompression():
    async def resolver(url):
        return "93.184.216.34"

    response = httpx.Response(200, headers={"content-type": "text/plain"}, content=b"x" * (2 * 1024 * 1024 + 1))
    with pytest.raises(ValueError, match="2 MiB"):
        await read_public_page("https://example.org", transport=httpx.MockTransport(lambda request: response), resolver=resolver)


async def test_compressed_response_is_rejected_before_stream_is_decoded():
    async def resolver(url):
        return "93.184.216.34"

    class NeverRead(httpx.AsyncByteStream):
        async def __aiter__(self):
            raise AssertionError("compressed data should not be read")
            yield b""

    def respond(request):
        assert request.headers["accept-encoding"] == "identity"
        return httpx.Response(200, headers={"content-type": "text/plain", "content-encoding": "gzip"}, stream=NeverRead())

    with pytest.raises(ValueError, match="Compressed"):
        await read_public_page("https://example.org", transport=httpx.MockTransport(respond), resolver=resolver)
