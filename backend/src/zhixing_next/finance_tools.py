"""Finance tools use strict schemas and the same transactional service as HTTP."""

import hashlib
import json

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .finance_schema import (
    BatchArguments,
    BudgetArguments,
    BudgetChanges,
    CorrectionArguments,
    FinanceInput,
    RecordArguments,
    TransactionChanges,
)
from .finance_service import FinanceService

FINANCE_TOOL_NAMES = [
    "get_finance_summary",
    "list_finance_transactions",
    "record_finance_transaction",
    "correct_finance_transaction",
    "delete_finance_transaction",
    "update_finance_budget",
    "apply_finance_transaction_batch",
]
FINANCE_INSTRUCTIONS = """你是知行的财务助手。新消费和收入必须使用record_finance_transaction；旧record_finance_observation仅用于balance余额观察，不能承接新收支。用户清楚表达的消费、收入、退款与预算修改直接通过财务服务工具保存，只有真实成功回执才能说已记录。收支以业务日期而非录入时间归月；今天使用Asia/Shanghai业务日期。不能编造金额、收入、消费或预算。日常、固定、一次性分别记录，大件仍计入真实结余。转账/信用卡还款使用transfer，不能当作新增消费。退款引用原消费ID。先查询真实记录和有效预算再纠正；不要把同日同额不同笔消费合并。固定费用付款仅在明确匹配时填写预算commitment_key。预计收入本身包含实收，不能相加两次。预算可默认沿用或单月覆盖，不把个人数字或规则写死。update_finance_budget仅修改用户提及字段；AI提出的预算不是用户已接受安排。同句多笔用不同且稳定的entry_key（如expense_1、expense_2），同一笔跨重试保持原entry_key；纠正用新操作entry_key及原记录ID。每个工具自动使用原消息source_id确保重试不重复。累计总额用aggregate及period_start，覆盖范围内明细不重复计；禁止把旧余额观察自动变为收入或确定业务日期的账目。覆盖不完整的日均未知，不把漏记当零消费；预测需说明依据和缺口。只有用户确认记录覆盖完整时才修改coverage_start/coverage_through。用户只发饮食照片时不猜餐费，跨服务部分成功时说明已经保存的部分并只补失败项。"""
FINANCE_INSTRUCTIONS += " 收支日期不完整时使用date_precision=month或range及date_start/date_end，不可猜成今天；跨月未知单列未分配，不当作当月现金流。付款日期与费用覆盖月份coverage_start/end分开。季付租金只保留一份承诺，amount为实际付款额、every_months为周期、monthly_cost为月成本，不能另建月摊承诺重复预留。发薪规则存income_schedule；最后工作日通过共用date_info计算，未接法定调休时明确按周一至周五和用户例外。预算只传changes中修改字段，承诺用commitments_upsert或commitment_keys_remove，绝不能为省略未改字段传null；明确清空用clear_fields。更正用结构化changes；未知字段会报错，不能把未成功写入说成不支持。拆分已有收入/消费使用apply_finance_transaction_batch单事务且默认总额守恒；金额本身确需纠正才conserve_total=false并注明原因。工具成功后核对回执中的实际值，报告使用共用publish_report交付可打开文件，不能仅声称工作区文件已交付。"

FINANCE_INSTRUCTIONS += " 重要记账语义：公积金提取、存款提现、取回赎回本金等是已有资产内部转移，使用transfer，不能因为到账银行卡就当income；只有新工资、新收益、新缴存才是income，混合时分别记录。首尾资产都包含的同一资产尤其不可再加作收入。用户只说某段期间收到N笔工资/提取时，N笔不证明实际月份，先把整个明确期间保存range；不要拆猜8月/9月或按发薪规则倒推已到账月份。后续发薪日规则只说明预计日程，不证明过去每笔发生日期。修改付款周期/金额要先查看现有commitments并复用同用途key，或在同一patch显式remove旧key后新增；不能保留旧月摊承诺再加季度款。amount永远是一次实际付款额，monthly_cost是amount/every_months，仅分币舍入。commitment工具回执verification同时给月成本、现金到期款、剩余预留与所有生效项，必须核对并再get_finance_summary；若仍有同用途项应纠正而非直接交付重复预留报告。"


class SummaryArguments(FinanceInput):
    month: str = ""


class ListArguments(SummaryArguments):
    offset: int = Field(default=0, ge=0)


class DeleteArguments(FinanceInput):
    transaction_id: str
    entry_key: str


def _changes(value, legacy, schema):
    from .store import StoreError

    if (value is None) == (legacy is None):
        raise StoreError(
            "invalid_finance_record",
            "Provide changes object, or legacy changes_json, never both",
            422,
        )
    try:
        raw = value.model_dump(exclude_unset=True) if isinstance(value, BaseModel) else value
        raw = json.loads(legacy) if legacy is not None else raw
        return schema.model_validate(raw).model_dump(exclude_unset=True)
    except (ValueError, TypeError) as exc:
        raise StoreError("invalid_finance_record", f"Invalid changes: {exc}", 422) from None


def create_finance_service_tools(settings, conversation_id: str, source_id: str):
    from .store import Store, StoreError

    service = FinanceService(Store(settings))

    def key(operation, entry_key):
        if not source_id or not entry_key or not entry_key.strip():
            raise StoreError("missing_source", "A stable source and entry key are required", 422)
        scope = json.dumps([source_id, operation, entry_key], ensure_ascii=False)
        return "finance-tool:" + hashlib.sha256(scope.encode()).hexdigest()

    @tool(args_schema=SummaryArguments)
    async def get_finance_summary(month: str = "") -> dict:
        """Read effective budget, actual cash totals, monthly costs, due payments and uncertain-date records. YYYY-MM; empty means current month. Incomplete coverage is unknown, never zero spending."""
        return service.summary(month=month or None)

    @tool(args_schema=ListArguments)
    async def list_finance_transactions(month: str = "", offset: int = 0) -> dict:
        """List 100 records with IDs, revisions and date precision for corrections. Unknown cross-month dates are visibly unallocated in summary, not assigned to the end month."""
        return service.list_transactions(month=month or None, limit=100, offset=offset)

    @tool(args_schema=RecordArguments)
    async def record_finance_transaction(
        entry_key: str,
        kind: str,
        amount: str,
        occurred_on: str | None = None,
        bucket: str = "daily",
        category: str = "其他",
        note: str = "",
        commitment_key: str | None = None,
        related_transaction_id: str | None = None,
        entry_type: str = "detail",
        period_start: str | None = None,
        date_precision: str = "day",
        date_start: str | None = None,
        date_end: str | None = None,
        coverage_start: str | None = None,
        coverage_end: str | None = None,
    ) -> dict:
        """Record explicit CNY cash flow with stable distinct entry_key. Exact day: occurred_on YYYY-MM-DD. Month-only: date_precision=month,date_start=YYYY-MM. Uncertain range: date_precision=range,date_start/date_end YYYY-MM-DD. Never invent today. coverage_start/end are YYYY-MM costs covered by a payment. Withdrawals of provident funds, deposits or returned principal are existing-asset transfer, never income; new external earnings/contributions are income. A count of past payments does not prove months: preserve the user's stated whole period as range. Refund references an expense. aggregate is an explicit cumulative total with period_start."""
        row = service.create_transaction(
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
            date_precision=date_precision,
            date_start=date_start,
            date_end=date_end,
            coverage_start=coverage_start,
            coverage_end=coverage_end,
        )
        return {**row, "verified": True}

    @tool(args_schema=CorrectionArguments)
    async def correct_finance_transaction(
        transaction_id: str,
        entry_key: str,
        changes=None,
        changes_json: str | None = None,
        expected_revision: int | None = None,
    ) -> dict:
        """Correct an existing ID with structured changes object, e.g. changes={amount:'42'}. Read ID/revision first. Do not place amount at top level. Unknown fields are rejected. Legacy changes_json is accepted instead of changes, never together. Keep entry_key stable across retry."""
        fields = _changes(changes, changes_json, TransactionChanges)
        if not fields:
            raise StoreError(
                "invalid_finance_record", "At least one changed field is required", 422
            )
        row = service.update_transaction(
            transaction_id,
            idempotency_key=key("correct", entry_key),
            expected_revision=expected_revision,
            **fields,
        )
        return {**row, "verified": True, "changed_fields": sorted(fields)}

    @tool(args_schema=DeleteArguments)
    async def delete_finance_transaction(transaction_id: str, entry_key: str) -> dict:
        """Delete a mistaken record when requested. Read ID first; correct/delete linked refunds before deleting their expense. For a split/replacement use atomic batch instead."""
        return service.delete_transaction(transaction_id, idempotency_key=key("delete", entry_key))

    @tool(args_schema=BudgetArguments)
    async def update_finance_budget(
        month: str,
        entry_key: str,
        changes=None,
        changes_json: str | None = None,
        recurring: bool = True,
    ) -> dict:
        """Patch only user-mentioned budget fields for YYYY-MM. Structured changes supports expected_income,savings_target,daily_budget,income_schedule,coverage_start/through,commitments_upsert,commitment_keys_remove,clear_fields. Missing fields inherit. Null is rejected: explicit clearing names clear_fields. Commitment amount is actual due cash; every_months/anchor_month/due_day define cycle, monthly_cost is amount/every_months rounded to cents, paid_through marks explicitly paid coverage. Reuse existing same-purpose keys when changing cycle/amount, or explicitly remove old keys in the same patch. Only clearly independent costs may list separate_from_keys; purpose is an optional stable expense identity. recurring=false overrides only changed fields for that month. Legacy changes_json is accepted instead of changes; legacy commitments list is safe keyed upsert, never implicit deletion."""
        fields = _changes(changes, changes_json, BudgetChanges)
        return service.patch_budget(
            month=month,
            idempotency_key=key("budget", entry_key),
            recurring=recurring,
            changes=fields,
        )

    @tool(args_schema=BatchArguments)
    async def apply_finance_transaction_batch(
        entry_key: str, operations: list, conserve_total: bool = True, reason: str = ""
    ) -> dict:
        """Atomically create/correct/delete multiple records. Each operation is {operation:create|update|delete,transaction_id?,expected_revision?,fields:{...}}. Split by updating/deleting original plus creating distinct parts in ONE batch; default conserve_total=true checks each income/expense/transfer total. For an explicitly corrected total/classification set false with reason. Any failure rolls back all operations. Never first record parts then delete original in separate tools."""
        values = [
            item.model_dump(exclude_unset=True) if isinstance(item, BaseModel) else item
            for item in operations
        ]
        return service.apply_transaction_batch(
            idempotency_key=key("batch", entry_key),
            operations=values,
            conserve_total=conserve_total,
            reason=reason,
            conversation_id=conversation_id,
            source_id=source_id,
        )

    return [
        get_finance_summary,
        list_finance_transactions,
        record_finance_transaction,
        correct_finance_transaction,
        delete_finance_transaction,
        update_finance_budget,
        apply_finance_transaction_batch,
    ]
