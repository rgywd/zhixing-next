"""Bounded partial changes for assistant evolution and proactive follow-through."""

from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import AwareDatetime, Field, StringConstraints, field_validator

from .schemas import Input

Key = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Clock = Annotated[str, StringConstraints(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")]
Guidance = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]


class PreferencesPatch(Input):
    expected_revision: int | None = Field(default=None, ge=0)
    enabled: bool | None = None
    maintenance_enabled: bool | None = None
    timezone: str | None = Field(default=None, min_length=1, max_length=100)
    quiet_start: Clock | None = None
    quiet_end: Clock | None = None
    daily_limit: int | None = Field(default=None, ge=1, le=12, description="Only set when the user requests a daily message count. Leave other frequency fields omitted.")
    min_interval_minutes: int | None = Field(default=None, ge=15, le=10080, description="Only set when the user explicitly requests the interval BETWEEN messages. A daily cap, gentle tone, or enabling a topic does not request a new interval. Omit to preserve the current interval; never choose a new default.")
    snooze_until: AwareDatetime | None = None
    topics: dict[Key, Literal["allow", "block"] | None] | None = Field(default=None, max_length=40, description="Explicit positive proactive permission must be saved as topic:allow; negative preference as topic:block. For example 写作:allow. Guidance text alone never enables a topic.")
    guidance: dict[Key, Guidance | None] | None = Field(default=None, max_length=40, description="Only additional situations and presentation. Do not duplicate structured topic permission, times or limits here.")

    @field_validator("timezone")
    @classmethod
    def known_timezone(cls, value):
        if value is not None:
            try:
                ZoneInfo(value)
            except (ZoneInfoNotFoundError, ValueError) as exc:
                raise ValueError("Choose an IANA timezone") from exc
        return value


class GoalPatch(Input):
    expected_revision: int | None = Field(default=None, ge=0)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    context: str | None = Field(default=None, max_length=4000)
    topic: Key | None = None
    status: Literal["active", "paused", "completed", "cancelled"] | None = None
    next_check_at: AwareDatetime | None = Field(default=None, description="The user's requested check time, resolved from their source message timestamp. Preserve this time even during quiet hours: delivery is deferred automatically without rewriting the request. Save all requested changes once per user input.")
    interval_seconds: int | None = Field(default=None, ge=900, le=31536000)


DEFAULT_PREFERENCES = {
    "enabled": False,
    "maintenance_enabled": True,
    "timezone": "Asia/Shanghai",
    "quiet_start": "22:00",
    "quiet_end": "08:00",
    "daily_limit": 3,
    "min_interval_minutes": 240,
    "snooze_until": None,
    "topics": {},
    "guidance": {},
    "target_conversation_id": None,
}
