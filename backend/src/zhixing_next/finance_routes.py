"""Finance routes mounted beneath the authenticated /v1 router."""

from typing import Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict, Field

from .finance_service import FinanceService


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Commitment(Input):
    key: str
    label: str
    amount: str
    kind: Literal["fixed", "one_time"]


class BudgetInput(Input):
    month: str
    idempotency_key: str = Field(min_length=1, max_length=300)
    recurring: bool = True
    expected_income: str | None = None
    savings_target: str | None = None
    daily_budget: str | None = None
    commitments: list[Commitment] = Field(default_factory=list, max_length=100)
    coverage_start: str | None = None
    coverage_through: str | None = None
    expected_revision: int | None = Field(default=None, ge=0)
    expected_source_month: str | None = None


class TransactionInput(Input):
    idempotency_key: str = Field(min_length=1, max_length=300)
    kind: Literal["expense", "income", "transfer", "refund"]
    amount: str
    occurred_on: str
    bucket: Literal["daily", "fixed", "one_time"] = "daily"
    category: str = "其他"
    note: str = ""
    commitment_key: str | None = None
    related_transaction_id: str | None = None
    conversation_id: str | None = None
    source_id: str | None = None
    entry_type: Literal["detail", "aggregate"] = "detail"
    period_start: str | None = None


class TransactionUpdate(Input):
    idempotency_key: str = Field(min_length=1, max_length=300)
    expected_revision: int | None = Field(default=None, ge=1)
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


def create_router(store):
    service = FinanceService(store)
    router = APIRouter(prefix="/finance")

    @router.get("/summary")
    def summary(month: str | None = None, as_of: str | None = None):
        return service.summary(month=month, as_of=as_of)

    @router.get("/budget")
    def get_budget(month: str | None = None):
        return service.get_budget(month)

    @router.put("/budget")
    def set_budget(body: BudgetInput):
        return service.set_budget(**body.model_dump())

    @router.delete("/budget")
    def delete_budget(month: str, idempotency_key: str, recurring: bool = False):
        return service.delete_budget(
            month=month, recurring=recurring, idempotency_key=idempotency_key
        )

    @router.get("/transactions")
    def list_transactions(
        month: str | None = None,
        limit: int = Query(default=50, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
    ):
        return service.list_transactions(month=month, limit=limit, offset=offset)

    @router.post("/transactions")
    def create_transaction(body: TransactionInput):
        return service.create_transaction(**body.model_dump())

    @router.patch("/transactions/{identifier}")
    def update_transaction(identifier: str, body: TransactionUpdate):
        return service.update_transaction(identifier, **body.model_dump(exclude_unset=True))

    @router.delete("/transactions/{identifier}")
    def delete_transaction(identifier: str, idempotency_key: str):
        return service.delete_transaction(identifier, idempotency_key=idempotency_key)

    return router
