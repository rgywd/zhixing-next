import json
import sqlite3

import pytest

from zhixing_next.config import Settings
from zhixing_next.finance_service import FinanceService
from zhixing_next.finance_tools import FINANCE_TOOL_NAMES
from zhixing_next.store import Store

OLD_DEFAULTS = [
    "只记录用户明确提供的金额，不猜测扣款链路。记录是观察值，不自动对账或计算总资产；截图识别尚未接入。",
    "只记录用户明确提供的金额，不猜测扣款链路。记录是观察值，不自动对账或计算总资产。截图中清楚可见的金额也属于用户提供的信息；看不清时只追问必要的问题。",
    "只记录用户明确提供的金额，不猜测扣款链路。记录是观察值，不自动对账或计算总资产。",
]


@pytest.mark.parametrize("instructions", [*OLD_DEFAULTS, "我的专属财务指令，不得覆盖"])
def test_v12_to_v13_preserves_ledger_dates_and_custom_instructions_idempotently(tmp_path, instructions):
    settings = Settings(data_dir=tmp_path / "data", workspace_root=tmp_path / "work")
    store = Store(settings)
    service = FinanceService(store)
    record = service.create_transaction(idempotency_key="old-ledger", kind="income", amount="16500", occurred_on="2026-10-15", note="原有已实收工资")
    with sqlite3.connect(store.db_path) as db:
        for column in ("date_precision", "date_start", "date_end", "coverage_start", "coverage_end"):
            db.execute(f"ALTER TABLE finance_transactions DROP COLUMN {column}")
        db.execute("UPDATE agents SET instructions=?,tools_json=? WHERE id='finance'", (instructions, json.dumps(["list_finance_observations", "view_image"])))
        db.execute("PRAGMA user_version=12")
    migrated = Store(settings)
    agent = migrated.get_agent("finance")
    if instructions in OLD_DEFAULTS:
        assert agent["instructions"] not in OLD_DEFAULTS
        assert "通用工具" in agent["instructions"]
    else:
        assert agent["instructions"] == instructions
    assert set(FINANCE_TOOL_NAMES) <= set(agent["tools"])
    assert {"list_finance_observations", "view_image"} <= set(agent["tools"])
    with migrated._connection() as db:
        row = dict(db.execute("SELECT * FROM finance_transactions WHERE id=?", (record["id"],)).fetchone())
        assert db.execute("PRAGMA user_version").fetchone()[0] == 15
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    assert row["date_precision"] == "day" and row["date_start"] == row["date_end"] == row["occurred_on"] == "2026-10-15"
    assert row["amount"] == "16500.00" and row["revision"] == 1
    reopened = Store(settings)
    assert reopened.get_agent("finance") == agent
    with reopened._connection() as db:
        assert dict(db.execute("SELECT * FROM finance_transactions WHERE id=?", (record["id"],)).fetchone()) == row
