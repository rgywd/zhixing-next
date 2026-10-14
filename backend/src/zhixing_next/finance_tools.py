"""Finance tools share the HTTP service and original-message idempotency scope."""

import hashlib
import json
from typing import Literal

from langchain_core.tools import tool

from .finance_service import FinanceService

FINANCE_TOOL_NAMES = [
    "get_finance_summary",
    "list_finance_transactions",
    "record_finance_transaction",
    "correct_finance_transaction",
    "delete_finance_transaction",
    "update_finance_budget",
]
FINANCE_INSTRUCTIONS = """你是知行的财务助手。新消费和收入必须使用record_finance_transaction；旧record_finance_observation仅用于balance余额观察，不能承接新收支。用户清楚表达的消费、收入、退款与预算修改直接通过财务服务工具保存，只有真实成功回执才能说已记录。收支以业务日期而非录入时间归月；今天使用Asia/Shanghai业务日期。不能编造金额、收入、消费或预算。日常、固定、一次性分别记录，大件仍计入真实结余。转账/信用卡还款使用transfer，不能当作新增消费。退款引用原消费ID。先查询真实记录和有效预算再纠正；不要把同日同额不同笔消费合并。固定费用付款仅在明确匹配时填写预算commitment_key。预计收入本身包含实收，不能相加两次。预算可默认沿用或单月覆盖，不把个人数字或规则写死。update_finance_budget仅修改用户提及字段；AI提出的预算不是用户已接受安排。同句多笔用不同且稳定的entry_key（如expense_1、expense_2），同一笔跨重试保持原entry_key；纠正用新操作entry_key及原记录ID。每个工具自动使用原消息source_id确保重试不重复。累计总额用aggregate及period_start，覆盖范围内明细不重复计；禁止把旧余额观察自动变为收入或确定业务日期的账目。覆盖不完整的日均未知，不把漏记当零消费；预测需说明依据和缺口。只有用户确认记录覆盖完整时才修改coverage_start/coverage_through。用户只发饮食照片时不猜餐费，跨服务部分成功时说明已经保存的部分并只补失败项。"""


def create_finance_service_tools(settings, conversation_id: str, source_id: str):
    from .store import Store

    service = FinanceService(Store(settings))

    def key(operation, entry_key):
        if not source_id or not entry_key or not entry_key.strip():
            from .store import StoreError

            raise StoreError("missing_source", "A stable source and entry key are required", 422)
        scope = json.dumps([source_id, operation, entry_key], ensure_ascii=False)
        return "finance-tool:" + hashlib.sha256(scope.encode()).hexdigest()

    @tool
    async def get_finance_summary(month: str = "") -> dict:
        """Read complete-month totals, effective editable budget, reservations and projection gaps. month is YYYY-MM, empty means current month. Incomplete coverage is not zero spending."""
        return service.summary(month=month or None)

    @tool
    async def list_finance_transactions(month: str = "", offset: int = 0) -> dict:
        """List 100 transactions with IDs for corrections/refunds; offset pages the month. Balances remain separate observations."""
        return service.list_transactions(month=month or None, limit=100, offset=offset)

    @tool
    async def record_finance_transaction(
        entry_key: str,
        kind: Literal["expense", "income", "transfer", "refund"],
        amount: str,
        occurred_on: str,
        bucket: Literal["daily", "fixed", "one_time"] = "daily",
        category: str = "其他",
        note: str = "",
        commitment_key: str | None = None,
        related_transaction_id: str | None = None,
        entry_type: Literal["detail", "aggregate"] = "detail",
        period_start: str | None = None,
    ) -> dict:
        """Save explicit CNY amount and business date YYYY-MM-DD. Use stable distinct entry_key per item within this user message. Refund references an expense ID. aggregate means user-provided cumulative total from period_start through occurred_on; covered details are not counted twice."""
        return service.create_transaction(
            idempotency_key=key("record", entry_key),
            kind=kind,
            amount=amount,
            occurred_on=occurred_on,
            bucket=bucket,
            category=category,
            note=note,
            commitment_key=commitment_key,
            related_transaction_id=related_transaction_id,
            conversation_id=conversation_id,
            source_id=source_id,
            entry_type=entry_type,
            period_start=period_start,
        )

    @tool
    async def correct_finance_transaction(
        transaction_id: str, entry_key: str, changes_json: str, expected_revision: int | None = None
    ) -> dict:
        """Correct an existing record in place. changes_json contains changed fields: amount,occurred_on,kind,bucket,category,note,commitment_key,related_transaction_id,entry_type,period_start. Read the ID first; keep operation entry_key stable."""
        changes = json.loads(changes_json)
        if not isinstance(changes, dict):
            from .store import StoreError

            raise StoreError("invalid_finance_record", "Changes must be an object", 422)
        return service.update_transaction(
            transaction_id,
            idempotency_key=key("correct", entry_key),
            expected_revision=expected_revision,
            **changes,
        )

    @tool
    async def delete_finance_transaction(transaction_id: str, entry_key: str) -> dict:
        """Delete a mistaken record when requested. Read ID first; delete or correct refunds before their original expense."""
        return service.delete_transaction(transaction_id, idempotency_key=key("delete", entry_key))

    @tool
    async def update_finance_budget(
        month: str, entry_key: str, changes_json: str, recurring: bool = True
    ) -> dict:
        """Update user-specified budget fields for YYYY-MM. recurring=true applies from that month onward; false is a single-month override. changes_json supports expected_income,savings_target,daily_budget (strings/null), commitments [{key,label,amount,kind:fixed|one_time}],coverage_start,coverage_through (confirmed coverage only). Missing fields retain current values."""
        changes = json.loads(changes_json)
        allowed = {
            "expected_income",
            "savings_target",
            "daily_budget",
            "commitments",
            "coverage_start",
            "coverage_through",
        }
        if not isinstance(changes, dict) or changes.keys() - allowed:
            from .store import StoreError

            raise StoreError("invalid_finance_record", "Unknown budget fields", 422)
        mutation_key = key("budget", entry_key)

        def operation(db):
            current = service._budget(db, month)
            values = {field: current[field] for field in allowed}
            values.update(changes)
            return service.set_budget(
                month=month, idempotency_key=mutation_key, recurring=recurring, _db=db, **values
            )

        return service._mutate(
            mutation_key,
            {"op": "tool_budget", "month": month, "recurring": recurring, "changes": changes},
            operation,
        )

    return [
        get_finance_summary,
        list_finance_transactions,
        record_finance_transaction,
        correct_finance_transaction,
        delete_finance_transaction,
        update_finance_budget,
    ]
