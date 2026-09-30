"""Model-name rules for thinking controls; unrecognized models retain explicit settings."""

import re
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlsplit

ThinkingLevel = Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"]
ReasoningLevel = Literal["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"]


@dataclass(frozen=True)
class ReasoningProfile:
    kind: str
    levels: tuple[str, ...]


def reasoning_profile(model: str, protocol: str) -> ReasoningProfile | None:
    # Gate by the actual model ID, never the editable display/provider name.
    name = model.strip().lower().rsplit("/", 1)[-1].replace("_", "-")

    def profile(kind, *levels):
        return ReasoningProfile(kind, ("auto", *levels) if levels else ())

    if re.match(r"^(?:qwen|qwq)(?:\d|[-.])", name):
        if protocol != "chat_completions":
            return profile("unsupported")
        if re.search(
            r"coder|instruct|non-thinking|embedding|rerank|guard|asr|tts", name
        ) or name.startswith(("qwq", "qwen3.5-omni")):
            return profile("fixed")
        if re.match(r"^qwen3\.8-(?:max|flash|27b)(?:-|$)", name):
            return profile("qwen_effort", "none", "low", "medium", "xhigh")
        if re.match(r"^qwen3\.8-2\.4t-a95b(?:-|$)", name):
            return profile("qwen_effort", "low", "medium", "xhigh")
        dated_alias = re.match(r"^qwen-(?:plus|flash|turbo)-(\d{4}-\d{2}-\d{2})$", name)
        if dated_alias and dated_alias[1] < "2025-04-28":
            return profile("fixed")
        if re.match(r"^qwen3(?:[.-]|$)", name) or re.match(
            r"^qwen-(?:plus|flash|turbo)(?:-|$)", name
        ):
            return profile(
                "qwen_budget",
                *(() if "thinking" in name or name.startswith("qwen3.8-2.4t-a95b") else ("none",)),
                "low",
                "medium",
                "high",
            )
        return profile("fixed")
    if name.startswith("deepseek-"):
        if re.match(r"^deepseek-(?:v4(?:[.-]|$)|flash(?:-|$)|pro(?:-|$))", name):
            if protocol in {"chat_completions", "responses"}:
                return profile("deepseek_effort", "none", "low", "high", "max")
        if protocol == "chat_completions" and re.match(
            r"^deepseek-(?:chat(?:-|$)|v3[.-](?:1|2)(?:-|$))", name
        ):
            return profile("toggle", "none", "high")
        return profile("fixed")
    if re.match(r"^glm-", name):
        if protocol != "chat_completions" or re.match(r"^glm-(?:5\.3|4\.1v)(?:-|$)", name):
            return profile("fixed")
        if re.match(r"^glm-(?:4\.[567](?:v)?|5(?:\.[12])?)(?:-|$)", name):
            return profile("toggle", "none", "high")
        return profile("fixed")
    if re.match(r"^(?:kimi|moonshot)-", name):
        if (
            protocol == "chat_completions"
            and "thinking" not in name
            and re.match(r"^kimi-k2\.[56](?:-|$)", name)
        ):
            return profile("toggle", "none", "high")
        return profile("fixed")
    if name.startswith("gemini-"):
        if protocol == "responses":
            return profile("unsupported")
        if re.search(r"image|live|embedding|tts|robotics", name):
            return profile("fixed")
        if re.match(r"^gemini-2\.5-(?:flash|pro)(?:-|$)", name):
            return profile(
                "gemini_budget", *(() if "pro" in name else ("none",)), "low", "medium", "high"
            )
        if re.match(r"^gemini-3(?:\.[1-8])?-(?:flash|pro)(?:-|$)", name):
            if "pro" in name:
                return profile(
                    "gemini_level",
                    "low",
                    *(("medium",) if name.startswith("gemini-3.1-") else ()),
                    "high",
                )
            minimal = () if re.match(r"^gemini-3\.[78]-flash(?:-|$)", name) else ("minimal",)
            return profile("gemini_level", *minimal, "low", "medium", "high")
        # Unknown Gemini variants can still use manually declared levels.
        return None
    if re.match(r"^(?:gpt-[3-6]|o[134](?:-|$))", name):
        if (
            protocol == "gemini"
            or re.search(r"chat|image|audio|realtime|search|transcribe|tts", name)
            or re.match(r"^gpt-[34]", name)
        ):
            return profile("fixed")
        if re.match(r"^gpt-6", name):
            if protocol != "responses":
                return profile("unsupported")
            return profile(
                "openai",
                *(() if "astra" in name else ("none",)),
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
            )
        if "-pro" in name:
            if re.match(r"^(?:gpt-5-pro|o[13]-pro)(?:-|$)", name):
                return profile("openai", "high")
            return profile("openai", "medium", "high", "xhigh")
        if re.match(r"^gpt-5\.[2-6](?:-|$)", name):
            return profile(
                "openai",
                *(() if "codex" in name else ("none",)),
                "low",
                "medium",
                "high",
                "xhigh",
                *(("max",) if name.startswith("gpt-5.6") else ()),
            )
        if re.match(r"^gpt-5\.1(?:-|$)", name):
            return profile(
                "openai",
                *(("none",) if "codex" not in name else ()),
                "low",
                "medium",
                "high",
                *(("xhigh",) if "codex-max" in name else ()),
            )
        if re.match(r"^gpt-5(?:-|$)", name):
            return profile(
                "openai", *(() if "codex" in name else ("minimal",)), "low", "medium", "high"
            )
        return profile("openai", "low", "medium", "high")
    return None


def reasoning_options(config, effort: str | None) -> dict:
    if effort is None:
        return {}
    profile = reasoning_profile(config.model, config.protocol)
    kind = profile.kind if profile else "openai"
    if profile and effort not in profile.levels:
        raise ValueError("The selected thinking depth is not available for this model.")
    if kind in {"qwen_budget", "qwen_effort"}:
        body = {"enable_thinking": effort != "none"}
        if effort != "none":
            if kind == "qwen_effort":
                body["reasoning_effort"] = effort
            else:
                body["thinking_budget"] = {"low": 1024, "medium": 8192, "high": 16384}[effort]
        return {"extra_body": body}
    if kind in {"toggle", "deepseek_effort"}:
        # Model Studio serves third-party models with its own switch parameter.
        host = urlsplit(config.base_url or "").hostname or ""
        model_studio = (
            bool(re.search(r"(?:^|\.)dashscope(?:-[a-z]+)?\.aliyuncs\.com$", host))
            or host == "maas.qwencloudapi.com"
        )
        if config.protocol == "responses":
            return {"reasoning": {"effort": effort}}
        options = {
            "extra_body": {"enable_thinking": effort != "none"}
            if model_studio
            else {"thinking": {"type": "disabled" if effort == "none" else "enabled"}}
        }
        if kind == "deepseek_effort" and effort != "none":
            options["reasoning_effort"] = effort
        return options
    if kind == "gemini_budget":
        budget = {"none": 0, "low": 1024, "medium": 8192, "high": 24576}[effort]
        if config.protocol == "gemini":
            return {"thinking_budget": budget}
        return {"reasoning_effort": effort}
    if kind == "gemini_level":
        if config.protocol == "gemini":
            return {"thinking_level": effort}
        return {"reasoning_effort": effort}
    return {"reasoning_effort": effort}


def reasoning_metadata(config) -> dict:
    profile = reasoning_profile(config.model, config.protocol)
    kind = profile.kind if profile else "manual"
    return {
        "reasoning_kind": kind,
        "reasoning_labels": {"high": "开启"} if kind == "toggle" else {},
    }
