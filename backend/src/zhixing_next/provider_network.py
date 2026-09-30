"""Explicit, bounded provider discovery and probes. Never return vendor error bodies."""

import asyncio
import json
import re
import time

import httpx
from langchain_core.messages import HumanMessage

from .models import create_model, model_key
from .store import StoreError


def failure(exc):
    code = getattr(exc, "status_code", None)
    if code is None and isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
    if code in (401, 403):
        return "供应商拒绝访问，请检查密钥与权限。"
    if code == 429:
        return "供应商限流或额度不足，请稍后重试。"
    if isinstance(exc, (TimeoutError, httpx.TimeoutException)):
        return "请求超时，请检查地址或稍后重试。"
    return "供应商请求失败，请检查地址、协议和模型配置。"


async def discover(config):
    key = model_key(config)
    if not key:
        raise StoreError("missing_credential", "请先保存供应商密钥。", 422)
    base = config.base_url.rstrip("/")
    gemini = config.protocol == "gemini"
    if gemini and not re.search(r"/v\d+(?:beta\d*)?$", base):
        base += "/v1beta"
    headers = {"x-goog-api-key": key} if gemini else {"Authorization": f"Bearer {key}"}
    items, seen_tokens, token = {}, set(), None
    try:
        async with asyncio.timeout(20), httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False) as client:
            for _ in range(10):
                params = {"pageSize": 200, **({"pageToken": token} if token else {})} if gemini else {}
                async with client.stream("GET", f"{base}/models", headers=headers, params=params) as response:
                    response.raise_for_status()
                    data = bytearray()
                    async for chunk in response.aiter_bytes():
                        data.extend(chunk)
                        if len(data) > 2 * 1024 * 1024:
                            raise ValueError("oversized catalog")
                payload = json.loads(data)
                entries = payload["models" if gemini else "data"]
                if not isinstance(entries, list):
                    raise ValueError("invalid model list")
                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    if gemini and "generateContent" not in entry.get("supportedGenerationMethods", []):
                        continue
                    identifier = entry.get("name" if gemini else "id")
                    if not isinstance(identifier, str):
                        continue
                    identifier = identifier.removeprefix("models/") if gemini else identifier
                    if not identifier.strip() or len(identifier) > 200 or any(ord(char) < 32 for char in identifier):
                        continue
                    name = entry.get("displayName" if gemini else "name") or identifier
                    items[identifier] = {"model": identifier, "name": name[:100] if isinstance(name, str) else identifier[:100]}
                    if len(items) >= 2000:
                        return {"items": sorted(items.values(), key=lambda item: item["model"]), "truncated": True}
                token = payload.get("nextPageToken") if gemini else None
                if not token:
                    return {"items": sorted(items.values(), key=lambda item: item["model"]), "truncated": bool(payload.get("has_more"))}
                if not isinstance(token, str) or len(token) > 2000 or token in seen_tokens:
                    raise ValueError("invalid page token")
                seen_tokens.add(token)
            return {"items": sorted(items.values(), key=lambda item: item["model"]), "truncated": True}
    except Exception as exc:
        raise StoreError("provider_discovery_failed", failure(exc), 502) from None


async def probe(settings, config):
    if not model_key(config):
        raise StoreError("missing_credential", "请先保存供应商密钥。", 422)
    effective = settings.model_copy(update={"models": {"probe": config.model_copy(update={"timeout": 12, "reasoning_effort": None})}})
    checks = []
    for kind in ("reply", "stream", "tools"):
        start = time.monotonic()
        try:
            async with asyncio.timeout(15):
                model = create_model(effective, "chat", "probe", max_tokens=256)
                if kind == "reply":
                    result = await model.ainvoke([HumanMessage(content="Reply with OK.")])
                    if not result.content:
                        raise ValueError("empty reply")
                elif kind == "stream":
                    received = False
                    async for chunk in model.astream([HumanMessage(content="Reply with OK.")]):
                        received = received or bool(chunk.content)
                    if not received:
                        raise ValueError("empty stream")
                else:
                    tool = {"name": "zhixing_connection_probe", "description": "A harmless connection check. Call with value ok.", "parameters": {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]}}
                    result = await model.bind_tools([tool], tool_choice="zhixing_connection_probe").ainvoke([HumanMessage(content="Call zhixing_connection_probe with value ok.")])
                    if not any(item.get("name") == tool["name"] and item.get("args", {}).get("value") == "ok" for item in result.tool_calls):
                        raise ValueError("no valid tool call")
            checks.append({"kind": kind, "ok": True, "elapsed_ms": round((time.monotonic() - start) * 1000)})
        except Exception as exc:
            checks.append({"kind": kind, "ok": False, "elapsed_ms": round((time.monotonic() - start) * 1000), "message": failure(exc)})
    return {"checks": checks}
