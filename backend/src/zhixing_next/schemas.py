"""Validated client inputs; product IDs remain independent of model providers."""

from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints, model_validator

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
    tools: list[Literal["inspect_environment", "list_directory", "read_text_file", "read_document", "write_text_file", "fetch_public_page", "record_finance_observation", "list_finance_observations", "remove_finance_observation"]] = Field(default_factory=list, max_length=9)
    visible: bool = True


class AgentUpdate(AgentInput):
    pass


class MessageInput(Input):
    id: Identifier
    content: Content
    intent: Literal["queue", "steer"] = "queue"
    kind: Literal["chat", "task"] = "chat"
    target_run_id: Identifier | None = None

    @model_validator(mode="after")
    def check_target(self) -> "MessageInput":
        if self.intent == "steer" and not self.target_run_id:
            raise ValueError("Steer requires target_run_id")
        if self.intent == "queue" and self.target_run_id is not None:
            raise ValueError("Queue cannot target an existing run")
        return self


class ScheduleInput(Input):
    id: Identifier
    conversation_id: Identifier
    prompt: Content
    next_run_at: AwareDatetime
    interval_seconds: int | None = Field(default=None, ge=1, le=31_536_000, strict=True)


class ScheduleUpdate(Input):
    enabled: bool = Field(strict=True)
