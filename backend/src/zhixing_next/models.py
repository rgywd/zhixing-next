"""Select the explicitly configured protocol; credentials stay on the server."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any

from langchain_core.language_models.chat_models import BaseChatModel

if TYPE_CHECKING:
    from .config import Settings


class ModelConfigurationError(ValueError):
    pass


def configured_model(settings: Settings, kind: str, model_id: str | None = None) -> tuple[str, Any]:
    role = "task" if kind == "task" else "chat"
    name = model_id if model_id is not None else settings.roles.get(role)
    if not name or name not in settings.models:
        raise ModelConfigurationError(f"The {role} model role is not configured.")
    return name, settings.models[name]


def model_ready(settings: Settings, kind: str = "chat", model_id: str | None = None) -> bool:
    try:
        _, config = configured_model(settings, kind, model_id)
        return bool(os.environ.get(config.api_key_env, "").strip())
    except ModelConfigurationError:
        return False


def create_model(
    settings: Settings, kind: str, model_id: str | None = None,
    reasoning_effort: str | None = None,
) -> BaseChatModel:
    _, config = configured_model(settings, kind, model_id)
    if reasoning_effort is not None and reasoning_effort not in config.reasoning_levels:
        raise ModelConfigurationError("The selected thinking depth is not available for this model.")
    key = os.environ.get(config.api_key_env, "").strip()
    if not key:
        raise ModelConfigurationError(
            f"The configured model credential environment variable {config.api_key_env} is missing."
        )
    options: dict[str, Any] = {
        "model": config.model,
        "api_key": key,
        "timeout": config.timeout,
        "max_retries": 0,
    }
    if config.base_url is not None:
        options["base_url"] = config.base_url
    if config.temperature is not None:
        options["temperature"] = config.temperature
    effort = config.reasoning_effort if reasoning_effort is None else (
        None if reasoning_effort == "auto" else reasoning_effort
    )
    if config.protocol in {"chat_completions", "responses"}:
        from langchain_openai import ChatOpenAI

        if effort is not None:
            options["reasoning_effort"] = effort
        return ChatOpenAI(**options, use_responses_api=config.protocol == "responses")
    if config.protocol == "gemini":
        from langchain_google_genai import ChatGoogleGenerativeAI

        if effort is not None:
            options["reasoning_effort"] = effort
        return ChatGoogleGenerativeAI(**options, vertexai=False)
    raise ModelConfigurationError(f"Unsupported model protocol: {config.protocol}")
