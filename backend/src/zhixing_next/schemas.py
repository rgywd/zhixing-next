"""Validated client inputs; product IDs remain independent of model providers."""

from typing import Annotated, Literal

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

Identifier = Annotated[
    str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Content = Annotated[str, StringConstraints(min_length=1, max_length=100_000, pattern=r"\S")]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AssistantInput(Input):
    name: Title
    persona: str = Field(max_length=50_000)


class AnswerInput(Input):
    answer: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=10000)]


class ProjectInput(Input):
    name: Title


class ResourceInput(Input):
    path: str = Field(min_length=1, max_length=2000)


class ConversationInput(Input):
    title: Title
    project_id: Identifier | None = None
    agent_id: Identifier | None = None


class ConversationModelInput(Input):
    model_id: Identifier | None
    reasoning_effort: Literal["auto", "none", "low", "medium", "high", "xhigh"] | None


class ModelRoleInput(Input):
    model_id: Identifier


class ProviderInput(Input):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    protocol: Literal["chat_completions", "responses", "gemini"]
    base_url: str = Field(min_length=1, max_length=2000)
    api_key: str | None = Field(default=None, min_length=1, max_length=1000, repr=False)
    enabled: bool = True

    @field_validator("base_url")
    @classmethod
    def endpoint(cls, value):
        from .config import ModelConfig

        return ModelConfig.validate_base_url(value.strip())

    @field_validator("api_key")
    @classmethod
    def credential(cls, value):
        if value is not None and (not value.strip() or not value.isascii() or "\n" in value or "\r" in value):
            raise ValueError("API key must be nonblank and one line")
        return value.strip() if value else value


class ProviderUpdate(ProviderInput):
    revision: int = Field(ge=1)
    clear_api_key: bool = False

    @model_validator(mode="after")
    def key_action(self):
        if self.clear_api_key and self.api_key is not None:
            raise ValueError("Choose replace or clear")
        return self


class ManagedModelInput(Input):
    context_window: int | None = Field(default=None, ge=4096, le=10_000_000)
    model: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    display_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)] | None = None
    enabled: bool = True
    image_input: bool = False
    reasoning_levels: list[Literal["auto", "none", "low", "medium", "high", "xhigh"]] = Field(default_factory=list, max_length=6)
    reasoning_effort: Literal["none", "low", "medium", "high", "xhigh"] | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)
    timeout: float = Field(default=60, gt=0, le=300)

    @model_validator(mode="after")
    def default_reasoning(self):
        if self.reasoning_effort is not None and self.reasoning_effort not in self.reasoning_levels:
            raise ValueError("Default thinking level must be available")
        return self


class ModelsImport(Input):
    revision: int = Field(ge=1)
    models: list[ManagedModelInput] = Field(min_length=1, max_length=200)


class ManagedModelUpdate(Input):
    revision: int = Field(ge=1)
    model: ManagedModelInput


class MemoryInput(Input):
    content: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]


class AgentInput(Input):
    model_id: Identifier | None = None
    name: Title
    description: str = Field(min_length=1, max_length=1000)
    instructions: str = Field(default="", max_length=20_000)
    tools: list[Literal["inspect_environment", "list_directory", "read_text_file", "read_document", "view_image", "write_text_file", "fetch_public_page", "record_finance_observation", "list_finance_observations", "remove_finance_observation"]] = Field(default_factory=list, max_length=10)
    visible: bool = True


class AgentUpdate(AgentInput):
    pass


class MessageInput(Input):
    id: Identifier
    content: str = Field(default="", max_length=100_000)
    attachments: list[Identifier] = Field(default_factory=list, max_length=8)
    intent: Literal["queue", "steer"] = "queue"
    kind: Literal["chat", "task"] = "chat"
    target_run_id: Identifier | None = None
    model_id: Identifier | None = None
    reasoning_effort: Literal["auto", "none", "low", "medium", "high", "xhigh"] | None = None
    search_provider_id: Identifier | None = None

    @model_validator(mode="after")
    def check_target(self) -> "MessageInput":
        if not self.content.strip() and not self.attachments:
            raise ValueError("Provide text or an attachment")
        if len(set(self.attachments)) != len(self.attachments):
            raise ValueError("Attachments must be unique")
        if self.intent == "steer" and not self.target_run_id:
            raise ValueError("Steer requires target_run_id")
        if self.intent == "queue" and self.target_run_id is not None:
            raise ValueError("Queue cannot target an existing run")
        if self.intent == "steer" and (self.model_id or self.reasoning_effort or self.search_provider_id):
            raise ValueError("Steer cannot change model or search tools")
        return self


class SearchProviderInput(Input):
    name: Title
    kind: Literal["brave", "tavily", "serper"]
    api_key: str = Field(min_length=1, max_length=1000, repr=False)

    @field_validator("api_key")
    @classmethod
    def nonblank_key(cls, value: str) -> str:
        if not value.strip() or not value.isascii() or "\n" in value or "\r" in value:
            raise ValueError("API key must be nonblank and one line")
        return value.strip()


class ScheduleInput(Input):
    id: Identifier
    conversation_id: Identifier
    prompt: Content
    next_run_at: AwareDatetime
    interval_seconds: int | None = Field(default=None, ge=1, le=31_536_000, strict=True)


class ScheduleUpdate(Input):
    enabled: bool = Field(strict=True)


class ApprovalDecision(Input):
    decision: Literal["approve", "deny", "retry", "skip"]
