"""Server-only configuration. TOML contains environment variable names, never keys."""

from __future__ import annotations

import os
import tomllib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

from .reasoning import ReasoningLevel, ThinkingLevel, reasoning_profile


class ModelConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    protocol: Literal["chat_completions", "responses", "gemini"]
    model: str = Field(min_length=1, max_length=200)
    provider: str | None = Field(default=None, min_length=1, max_length=100)
    display_name: str | None = Field(default=None, min_length=1, max_length=100)
    api_key_env: str | None = Field(default=None, pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    # Runtime-only credential. Public catalog responses and model_dump never include it.
    api_key: SecretStr | None = Field(default=None, repr=False, exclude=True)
    base_url: str | None = None
    temperature: float | None = None
    reasoning_effort: ThinkingLevel | None = None
    reasoning_levels: list[ReasoningLevel] = Field(default_factory=list, max_length=8)
    timeout: float = Field(default=60, gt=0, le=300)
    image_input: bool = False
    context_window: int | None = Field(default=None, ge=4096, le=10_000_000)

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
        if len(self.reasoning_levels) != len(set(self.reasoning_levels)):
            raise ValueError("reasoning_levels must be unique")
        profile = reasoning_profile(self.model, self.protocol)
        if profile is not None:
            self.reasoning_levels = list(profile.levels)
            # Legacy defaults may no longer be meaningful for a binary-only model.
            if self.reasoning_effort not in self.reasoning_levels:
                self.reasoning_effort = None
        else:
            if self.reasoning_effort is not None and self.protocol == "gemini":
                raise ValueError("reasoning_effort requires a recognized Gemini model")
            if self.protocol == "gemini" and set(self.reasoning_levels) & {"none", "xhigh", "max"}:
                raise ValueError("Gemini thinking levels cannot promise off or xhigh")
        return self


class PathGrant(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: Path
    writable: bool = False
    overwrite: Literal["ask", "allow"] = "ask"


class ExecutionConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    skills_dir: Path | None = None
    image: str = Field(default="zhixing-sandbox:1", pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$")
    memory_mb: int = Field(default=2048, ge=256, le=16384)
    cpus: float = Field(default=2, gt=0, le=16)
    timeout_seconds: int = Field(default=120, ge=1, le=1800)
    # Explicit host-side network grant. 'none' remains useful with uploaded resources.
    network: Literal["none", "bridge"] = "none"
    network_authorization: Literal["ask", "allow"] = "ask"


class RuntimeLimits(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model_attempts: int = Field(default=80, ge=1, le=1000)
    tool_calls: int = Field(default=160, ge=1, le=2000)
    total_tokens: int = Field(default=1_000_000, ge=1, le=20_000_000)
    retries: int = Field(default=3, ge=0, le=5)
    retry_base_seconds: float = Field(default=1, ge=0, le=10)
    active_seconds: int = Field(default=1800, ge=1, le=14400)


class GitLabConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = "https://gitlab.com"
    token_env: str = Field(default="ZHIXING_GITLAB_TOKEN", pattern=r"^[A-Za-z_][A-Za-z0-9_]*$")
    projects: list[str] = Field(default_factory=list, max_length=30)
    allow_writes: bool = False

    @field_validator("url")
    @classmethod
    def endpoint(cls, value):
        return ModelConfig.validate_base_url(value)

    @field_validator("projects")
    @classmethod
    def project_ids(cls, value):
        if any(not item or len(item) > 200 or any(part in {"", ".", ".."} for part in item.split("/")) or any(c in item for c in "?#%\\") for item in value):
            raise ValueError("Use project IDs or namespace/project paths")
        return list(dict.fromkeys(value))


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    data_dir: Path = Field(default_factory=lambda: Path(".data").resolve())
    workspace_root: Path = Field(default_factory=lambda: Path(".data/workspaces").resolve())
    api_token: str = Field(default="", repr=False, exclude=True)
    models: dict[str, ModelConfig] = Field(default_factory=dict)
    roles: dict[str, str | None] = Field(default_factory=lambda: {
        "chat": "chat", "task": "task", "memory": "memory",
    })
    grants: list[PathGrant] = Field(default_factory=list)
    execution: ExecutionConfig = Field(default_factory=ExecutionConfig)
    limits: RuntimeLimits = Field(default_factory=RuntimeLimits)
    gitlab: GitLabConfig = Field(default_factory=GitLabConfig)
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
    allowed = {"data_dir", "workspace_root", "api_token_env", "models", "roles", "grants", "poll_interval", "execution", "limits", "gitlab"}
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
    if raw.get("execution", {}).get("skills_dir"):
        directory = Path(raw["execution"]["skills_dir"]).expanduser()
        raw["execution"]["skills_dir"] = (directory if directory.is_absolute() else base / directory).resolve()
    token_env = raw.pop("api_token_env", "ZHIXING_API_TOKEN")
    token = os.environ.get(token_env, "")
    if token and len(token) < 24:
        raise ValueError("Service access token must contain at least 24 characters")
    return Settings(
        **raw, data_dir=data_dir, workspace_root=workspace_root,
        api_token=token, config_file=config_file,
    )
