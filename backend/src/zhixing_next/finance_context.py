"""Actual input already present in this finance tool's checkpointed graph state."""

from contextvars import ContextVar

active_finance_input: ContextVar[str | None] = ContextVar("active_finance_input", default=None)
finance_write_model: ContextVar[bool] = ContextVar("finance_write_model", default=False)
