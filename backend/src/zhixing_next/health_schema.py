"""Model-visible health and linked-meal fields, without internal source metadata."""

from typing import Literal

from pydantic import Field

from .health_service import EnergyEstimate, Input, MealType, ReminderSlot


class DietRuleFields(Input):
    content: str = Field(min_length=1, max_length=2000)
    kind: Literal["restriction", "preference", "guideline"] = "guideline"
    status: Literal["active", "paused", "proposed"] = "active"
    effective_from: str | None = None
    effective_until: str | None = None
    excluded_terms: list[str] = Field(default_factory=list, max_length=30)
    origin: Literal["user", "professional", "assistant_proposal"] = "user"
    confirmed: bool = False


class MealFields(Input):
    occurred_at: str = Field(description="Actual meal timestamp including UTC offset, for example 2026-10-16T12:30:00+08:00")
    description: str = Field(default="", max_length=4000)
    meal_type: MealType = "other"
    portion: str = Field(default="", max_length=2000)
    status: Literal["recorded", "skipped"] = "recorded"
    recommendation_id: str | None = None
    note: str = Field(default="", max_length=4000)
    estimated_energy: EnergyEstimate | None = None


class MealChanges(Input):
    occurred_at: str | None = None
    description: str | None = Field(default=None, max_length=4000)
    meal_type: MealType | None = None
    portion: str | None = Field(default=None, max_length=2000)
    status: Literal["recorded", "skipped"] | None = None
    recommendation_id: str | None = None
    note: str | None = Field(default=None, max_length=4000)
    estimated_energy: EnergyEstimate | None = None


class HealthRecordChanges(MealChanges):
    """Only supplied fields are applied; the selected record kind validates them."""

    revision: int | None = Field(default=None, ge=1)
    measured_at: str | None = None
    value: int | float | None = Field(default=None, ge=0)
    unit: Literal["kg", "lb"] | None = None
    content: str | None = Field(default=None, min_length=1, max_length=2000)
    kind: Literal["restriction", "preference", "guideline"] | None = None
    # Rule status additionally supports active/paused/proposed.
    status: Literal["recorded", "skipped", "active", "paused", "proposed"] | None = None
    effective_from: str | None = None
    effective_until: str | None = None
    excluded_terms: list[str] | None = Field(default=None, max_length=30)
    origin: Literal["user", "professional", "assistant_proposal"] | None = None
    confirmed: bool | None = None


class LifePaymentChanges(Input):
    amount: str | None = Field(default=None, description="Actual CNY amount, decimal text; do not infer from a food photo")
    occurred_on: str | None = Field(default=None, description="Actual payment date in YYYY-MM-DD")
    category: str | None = None
    note: str | None = None


class ReminderChanges(Input):
    """Only supplied fields reach the service, which validates the merged state.

    Do not inherit the full reminder model: its normalisation validator assigns
    paused_dates, making an omitted field appear explicitly supplied to Pydantic.
    """

    revision: int | None = Field(default=None, ge=0)
    enabled: bool = False
    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=100)
    slots: list[ReminderSlot] = Field(default_factory=list, max_length=12)
    quiet_start: str | None = Field(default=None, pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    quiet_end: str | None = Field(default=None, pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    max_per_day: int = Field(default=3, ge=1, le=12)
    paused_dates: list[str] = Field(default_factory=list, max_length=90)
    tone: str = Field(default="温和提醒", max_length=200)


def supplied(value):
    """Preserve omission versus explicit null for atomic partial updates."""
    return value.model_dump(exclude_unset=True) if isinstance(value, Input) else value
