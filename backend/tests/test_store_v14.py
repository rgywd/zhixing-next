"""The collaboration migration preserves user data and custom instructions."""

import pytest
from test_runtime import make_settings

from zhixing_next.finance_service import FinanceService
from zhixing_next.health_tools import HEALTH_INSTRUCTIONS
from zhixing_next.store import Store


@pytest.mark.parametrize("instructions", [HEALTH_INSTRUCTIONS, "只用简短句子，先回答我问的事。", HEALTH_INSTRUCTIONS + "\n我的自定义约定：简短回复。"])
def test_v13_to_v14_preserves_ledger_and_only_removes_exact_builtin_default(tmp_path, instructions):
    settings = make_settings(tmp_path)
    store = Store(settings)
    transaction = FinanceService(store).create_transaction(
        idempotency_key="original-payment", kind="expense", amount="24.60",
        occurred_on="2026-10-16", category="餐饮",
    )
    with store._connection(write=True) as db:
        db.execute("UPDATE agents SET instructions=? WHERE id='health'", (instructions,))
        for table in ("conversation_waits", "conversation_deliveries", "agent_child_events", "agent_child_inputs", "agent_children"):
            db.execute(f"DROP TABLE {table}")
        db.execute("ALTER TABLE runs DROP COLUMN origin")
        db.execute("PRAGMA user_version=13")
    upgraded = Store(settings)
    expected = "" if instructions == HEALTH_INSTRUCTIONS else instructions
    assert upgraded.get_agent("health")["instructions"] == expected
    assert FinanceService(upgraded).list_transactions(month="2026-10")["items"][0] == transaction
    with upgraded._connection() as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 14
        assert "origin" in {row[1] for row in db.execute("PRAGMA table_info(runs)")}
        assert all(db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()
                   for name in ("agent_children", "agent_child_inputs", "conversation_deliveries", "conversation_waits"))
    assert Store(settings).get_agent("health")["instructions"] == expected
