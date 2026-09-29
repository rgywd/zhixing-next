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


class MemoryInput(Input):
    content: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]


class AgentInput(Input):
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
