"""Server-only configuration. TOML contains environment variable names, never keys."""

from __future__ import annotations

import os
import tomllib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ModelConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    protocol: Literal["chat_completions", "responses", "gemini"]
    model: str = Field(min_length=1, max_length=200)
    api_key_env: str = Field(pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    base_url: str | None = None
    temperature: float | None = None
    reasoning_effort: Literal["none", "low", "medium", "high", "xhigh"] | None = None
    timeout: float = Field(default=60, gt=0, le=300)

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        from urllib.parse import urlsplit

        parsed = urlsplit(value)
        if parsed.scheme not in {"https", "http"} or not parsed.hostname:
            raise ValueError("base_url must be an HTTP(S) URL")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("base_url must not contain credentials, query or fragment")
        if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("remote model endpoints require HTTPS")
        return value.rstrip("/")

    @model_validator(mode="after")
    def validate_reasoning_protocol(self):
        if self.reasoning_effort is not None and self.protocol == "gemini":
            raise ValueError("reasoning_effort is only supported by OpenAI-compatible protocols")
        return self


class PathGrant(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: Path
    writable: bool = False


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    data_dir: Path = Field(default_factory=lambda: Path(".data").resolve())
    workspace_root: Path = Field(default_factory=lambda: Path(".data/workspaces").resolve())
    api_token: str = Field(default="", repr=False, exclude=True)
    models: dict[str, ModelConfig] = Field(default_factory=dict)
    roles: dict[str, str] = Field(default_factory=lambda: {
        "chat": "chat", "task": "task", "memory": "memory",
    })
    grants: list[PathGrant] = Field(default_factory=list)
    poll_interval: float = Field(default=0.25, ge=0.05, le=10)
    config_file: Path | None = None

    @field_validator("data_dir", "workspace_root")
    @classmethod
    def resolve_path(cls, value: Path) -> Path:
        return value.expanduser().resolve()

    @model_validator(mode="after")
    def isolate_service_data(self):
        if self.data_dir.is_relative_to(self.workspace_root):
            raise ValueError("workspace_root must not contain the service data directory")
        return self

    def model_for(self, role: str) -> ModelConfig:
        identifier = self.roles.get(role)
        if identifier is None or identifier not in self.models:
            raise ValueError(f"Model role '{role}' is not configured")
        return self.models[identifier]


def load_settings() -> Settings:
    config_path = os.environ.get("ZHIXING_CONFIG")
    config_file = Path(config_path).expanduser().resolve() if config_path else None
    raw: dict = {}
    if config_file:
        with config_file.open("rb") as file:
            raw = tomllib.load(file)
    base = config_file.parent if config_file else Path.cwd()
    allowed = {"data_dir", "workspace_root", "api_token_env", "models", "roles", "grants", "poll_interval"}
    if unknown := raw.keys() - allowed:
        raise ValueError("Unknown configuration fields: " + ", ".join(sorted(unknown)))
    data_dir = Path(os.environ.get("ZHIXING_DATA_DIR", raw.pop("data_dir", ".data"))).expanduser()
    if not data_dir.is_absolute():
        data_dir = base / data_dir
    workspace_root = Path(raw.pop("workspace_root", str(data_dir / "workspaces"))).expanduser()
    if not workspace_root.is_absolute():
        workspace_root = base / workspace_root
    for grant in raw.get("grants", []):
        path = Path(grant["path"]).expanduser()
        grant["path"] = (path if path.is_absolute() else base / path).resolve()
    token_env = raw.pop("api_token_env", "ZHIXING_API_TOKEN")
    token = os.environ.get(token_env, "")
    if token and len(token) < 24:
        raise ValueError("Service access token must contain at least 24 characters")
    return Settings(
        **raw, data_dir=data_dir, workspace_root=workspace_root,
        api_token=token, config_file=config_file,
    )
