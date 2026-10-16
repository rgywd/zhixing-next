"""Strict AI/HTTP finance inputs: omitted fields never mean erase."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class FinanceInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Commitment(FinanceInput):
    key: str
    label: str
    amount: str
    kind: Literal["fixed", "one_time"]
    every_months: int = Field(default=1, ge=1, le=120)
    anchor_month: str | None = None
    due_day: int | None = Field(default=None, ge=1, le=31)
    monthly_cost: str | None = None
    paid_through: str | None = None
    purpose: str | None = Field(
        default=None,
        description="Stable expense purpose; reuse the existing same-purpose key when changing amount or cycle",
    )
    separate_from_keys: list[str] = Field(
        default_factory=list,
        max_length=100,
        description="Only when the user clearly describes independent costs of the same purpose; list existing keys that must coexist",
    )


class IncomeSchedule(FinanceInput):
    rule: Literal["last_business_day", "day_of_month"]
    day: int | None = Field(default=None, ge=1, le=31)
    weekdays: list[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4])
    working_dates: list[str] = Field(default_factory=list)
    non_working_dates: list[str] = Field(default_factory=list)
    calendar_basis: Literal["weekdays_only", "user_overrides"] = "weekdays_only"


class TransactionChanges(FinanceInput):
    kind: Literal["expense", "income", "transfer", "refund"] | None = None
    amount: str | None = None
    occurred_on: str | None = None
    bucket: Literal["daily", "fixed", "one_time"] | None = None
    category: str | None = None
    note: str | None = None
    commitment_key: str | None = None
    related_transaction_id: str | None = None
    entry_type: Literal["detail", "aggregate"] | None = None
    period_start: str | None = None
    date_precision: Literal["day", "month", "range"] | None = None
    date_start: str | None = None
    date_end: str | None = None
    coverage_start: str | None = None
    coverage_end: str | None = None


class BudgetChanges(FinanceInput):
    expected_income: str | None = None
    savings_target: str | None = None
    daily_budget: str | None = None
    commitments: list[Commitment] | None = Field(default=None, max_length=100)
    commitments_upsert: list[Commitment] = Field(default_factory=list, max_length=100)
    commitment_keys_remove: list[str] = Field(default_factory=list, max_length=100)
    coverage_start: str | None = None
    coverage_through: str | None = None
    income_schedule: IncomeSchedule | None = None
    clear_fields: list[
        Literal[
            "expected_income",
            "savings_target",
            "daily_budget",
            "coverage_start",
            "coverage_through",
            "income_schedule",
        ]
    ] = Field(default_factory=list)


class RecordArguments(FinanceInput):
    entry_key: str
    kind: Literal["expense", "income", "transfer", "refund"]
    amount: str
    occurred_on: str | None = None
    bucket: Literal["daily", "fixed", "one_time"] = "daily"
    category: str = "其他"
    note: str = ""
    commitment_key: str | None = None
    related_transaction_id: str | None = None
    entry_type: Literal["detail", "aggregate"] = "detail"
    period_start: str | None = None
    date_precision: Literal["day", "month", "range"] = Field(
        default="day",
        description="Use month only for an actual payment month explicitly known from the user. A count of past paychecks or a payday rule does not establish past payment months. Preserve the user's whole period as range when individual dates/months are unknown.",
    )
    date_start: str | None = None
    date_end: str | None = None
    coverage_start: str | None = None
    coverage_end: str | None = None


class CorrectionArguments(FinanceInput):
    transaction_id: str
    entry_key: str
    changes: TransactionChanges | None = None
    changes_json: str | None = None
    expected_revision: int | None = Field(default=None, ge=1)


class BudgetArguments(FinanceInput):
    month: str
    entry_key: str
    changes: BudgetChanges | None = None
    changes_json: str | None = None
    recurring: bool = True


class BatchOperation(FinanceInput):
    operation: Literal["create", "update", "delete"]
    transaction_id: str | None = None
    fields: TransactionChanges | None = None
    expected_revision: int | None = Field(default=None, ge=1)


class BatchArguments(FinanceInput):
    entry_key: str
    operations: list[BatchOperation] = Field(min_length=1, max_length=100)
    conserve_total: bool = True
    reason: str = ""
