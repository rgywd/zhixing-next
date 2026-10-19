"""Finance tools use strict schemas and the same transactional service as HTTP."""

import asyncio
import hashlib
import json
from decimal import ROUND_HALF_UP, Decimal

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .finance_context import active_finance_input, delegated_finance_input
from .finance_dates import normalize_history_range, verify_budget_due_days, verify_date_evidence
from .finance_facts import verify_income_facts
from .finance_schema import (
    BatchArguments,
    BudgetArguments,
    BudgetChanges,
    CorrectionArguments,
    FinanceInput,
    RecordArguments,
    TransactionChanges,
)
from .finance_service import FinanceService, _money

FINANCE_TOOL_NAMES = [
    "get_finance_summary",
    "list_finance_transactions",
    "record_finance_transaction",
    "correct_finance_transaction",
    "delete_finance_transaction",
    "update_finance_budget",
    "apply_finance_transaction_batch",
    "reconcile_finance_assets",
    "publish_finance_report",
]
FINANCE_INSTRUCTIONS = """你是知行的财务助手，替用户完成整理、记账、预算调整和报告，不让用户反复补表或管理内部字段。清楚的收支直接记录；纠正先查现有记录，未知金额不猜。只有成功工具回执才表示已保存，回复简述结果，不展示内部ID、key或revision。每笔操作使用语义稳定且不同的entry_key，重试沿用；原消息来源由系统绑定。
日期按Asia/Shanghai业务日期。程序会读取当前真实原话验证日/月，无需重复抄quote；历史消息可通过通用历史工具找回并传date_source_message_id。历史只有范围就保留range，程序保留原话明确的整体时段，不凭笔数缩成某几个月；付款次数、发薪规则、余额观察日和费用覆盖月份都不能证明个别交易日。缺少确切日期不阻止范围记账，也不列成待补清单。
实际消费、收入、退款用财务服务，旧余额观察工具只保存balance。日常、固定、大件分别归类，大件仍计入真实结余。公积金提取、提现和赎回本金是transfer；新工资、真实新增缴存和收益才是income，混合情况分别记。遇existing_asset_is_transfer保留transfer并查询核对继续，不靠删备注、换分类反复试写或向用户索要未提及的缴存确认。退款关联原消费；累计总额用aggregate及period_start，覆盖内明细不重复计，同日同额也可能是不同笔。
预算只传changes中用户提及的字段，省略即保留，明确清空用clear_fields。AI建议未被用户接受不自动成为预算。修改房租等付款周期先查看已有承诺并复用同用途key，避免月摊和季度款重复预留；amount是一次实际付款额，every_months是周期，monthly_cost由程序按分币核算，已付覆盖与付款日期分开。未知due_day省略，不猜1号。发薪安排存income_schedule，日期由date_info计算，周末规则不冒充法定调休。写入后核对回执/summary实际值。拆分、更换已有多笔记录用原子batch，默认总额守恒；真实金额或分类纠正可关闭守恒并说明原因。
数字和资产差额直接使用服务计算。预计收入包含实收，不重复相加；内部transfer不加进新增收入。unexplained_difference只表示已知流水未解释的资产差额，不是消费，也不自动记账或猜最可能花在哪里。漏记不等于零支出，范围部分相交、近似余额与覆盖缺口简述即可，不要求用户逐笔对账。
财务报告使用publish_finance_report交付真实可打开附件，不自编数值报告代替。默认沿用本会话已核验范围和资产，当前用户明确新范围才切换，今晚用餐等时间不改变报表范围，period_evidence仅是兼容提示。资产观察可省略，不要求补齐。先完成读取和必要计算再发布；成功后直接给分析与附件，不继续反复calculate或添加未确认情景。明确餐费与实际饮食可关联处理，不凭食物猜钱或凭金额猜食物；部分成功时只补失败项。"""

class SummaryArguments(FinanceInput):
    month: str = ""


class ListArguments(SummaryArguments):
    offset: int = Field(default=0, ge=0)


class ReconcileArguments(FinanceInput):
    start_date: str
    end_date: str
    opening_assets: str
    closing_assets: str
    approximate: bool = True


class FinanceReportArguments(FinanceInput):
    entry_key: str | None = Field(
        default=None, max_length=200,
        description="Optional compatibility label; report replay is derived automatically from actual source and scope.",
    )
    start_date: str | None = None
    end_date: str | None = None
    opening_assets: str | None = None
    closing_assets: str | None = None
    approximate: bool = True
    filename: str = Field(
        default="财务回顾.md", min_length=4, max_length=120, pattern=r"^[^/\\\x00-\x1f]+\.md$"
    )
    period_evidence: str | None = Field(
        default=None,
        max_length=240,
        description="Optional legacy hint. The service determines a new report period from actual current user input, or preserves verified prior context; no repeated quote is needed.",
    )


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


def _canonical_ai_dates(fields):
    """Precision and explicit range/month bounds outrank a redundant day hint."""
    fields = dict(fields)
    precision = fields.get("date_precision")
    if fields.get("date_start") and (
        precision == "month" or (precision == "range" and fields.get("date_end"))
    ):
        fields["occurred_on"] = None
    return fields


def create_finance_service_tools(
    settings, conversation_id: str, source_id: str, *, run=None, emit=None
):
    from .store import Store, StoreError

    service = FinanceService(Store(settings))

    def actual_source():
        return active_finance_input.get() or delegated_finance_input.get() or source_id

    def canonical_dates(fields, *, evidence_source_id=None, current=None):
        fields = _canonical_ai_dates(fields)
        date_fields = {"occurred_on", "date_precision", "date_start", "date_end"}
        if not date_fields.intersection(fields):
            return fields
        context = {**(current or {}), **fields}
        resolved = normalize_history_range(
            service.store, source_id=actual_source(), fields=context,
            evidence_source_id=evidence_source_id,
        )
        return {**fields, **{
            name: resolved.get(name) for name in date_fields
            if resolved.get(name) != context.get(name)
        }}

    def key(operation, entry_key):
        current_source = actual_source()
        if not current_source or not entry_key or not entry_key.strip():
            raise StoreError("missing_source", "A stable source and entry key are required", 422)
        scope = json.dumps([current_source, operation, entry_key], ensure_ascii=False)
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
        date_evidence: str | None = None,
        date_source_message_id: str | None = None,
        fact_evidence: str | None = None,
        fact_source_message_id: str | None = None,
    ) -> dict:
        """Record explicit CNY cash flow with stable distinct entry_key. Exact day: occurred_on YYYY-MM-DD. Month-only: date_precision=month,date_start=YYYY-MM. Uncertain range: date_precision=range,date_start/date_end YYYY-MM-DD. Never invent today. coverage_start/end are YYYY-MM costs covered by a payment. Withdrawals of provident funds, deposits or returned principal are existing-asset transfer, never income; new external earnings/contributions are income. A count of past payments does not prove months: preserve the user's stated whole period as range. Precise day/month or same-day range is verified automatically from the bound real user message; date_evidence is an optional hint, never required; do not use an asset observation date, review cutoff, cost coverage or recurring rule. Refund references an expense. aggregate is an explicit cumulative total with period_start."""
        dates = canonical_dates({
            "date_precision": date_precision, "date_start": date_start,
            "date_end": date_end, "occurred_on": occurred_on,
            "amount": amount, "category": category, "note": note,
        }, evidence_source_id=date_source_message_id)
        occurred_on, date_start, date_end = (
            dates.get(name) for name in ("occurred_on", "date_start", "date_end")
        )
        fact_proof = verify_income_facts(
            service.store,
            source_id=actual_source(),
            fields={"kind": kind, "amount": amount, "category": category, "note": note},
            evidence=fact_evidence,
            evidence_source_id=fact_source_message_id,
        )
        proof = verify_date_evidence(
            service.store,
            conversation_id=conversation_id,
            source_id=actual_source(),
            fields={
                "amount": amount,
                "date_precision": date_precision,
                "date_start": date_start,
                "date_end": date_end,
                "occurred_on": occurred_on,
                "category": category,
                "note": note,
            },
            evidence=date_evidence,
            evidence_source_id=date_source_message_id,
        )
        if proof and not (occurred_on or date_start or date_end):
            if date_precision == "month":
                date_start = proof["value"]
            else:
                occurred_on = proof["value"]
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
            source_id=actual_source(),
            entry_type=entry_type,
            period_start=period_start,
            date_precision=date_precision,
            date_start=date_start,
            date_end=date_end,
            coverage_start=coverage_start,
            coverage_end=coverage_end,
        )
        return {
            **row,
            "verified": True,
            "date_verification": proof,
            "income_fact_verification": fact_proof,
        }

    @tool(args_schema=CorrectionArguments)
    async def correct_finance_transaction(
        transaction_id: str,
        entry_key: str,
        changes=None,
        changes_json: str | None = None,
        expected_revision: int | None = None,
        date_evidence: str | None = None,
        date_source_message_id: str | None = None,
        fact_evidence: str | None = None,
        fact_source_message_id: str | None = None,
    ) -> dict:
        """Correct an existing ID with structured changes object, e.g. changes={amount:'42'}. Read ID/revision first. Do not place amount at top level. Unknown fields are rejected. Keep entry_key stable across retry. Precise date changes are verified from the actual current input automatically; optional date_source_message_id selects a retrieved historical user message and date_evidence is only a hint; other non-date changes need no new evidence."""
        fields = _canonical_ai_dates(_changes(changes, changes_json, TransactionChanges))
        if not fields:
            raise StoreError(
                "invalid_finance_record", "At least one changed field is required", 422
            )
        with service.store._connection() as db:
            current = service._require(db, transaction_id)
        fields = canonical_dates(fields, evidence_source_id=date_source_message_id, current=current)
        fact_proof = verify_income_facts(
            service.store,
            source_id=actual_source(),
            fields=fields,
            current=current,
            evidence=fact_evidence,
            evidence_source_id=fact_source_message_id,
        )
        proof = verify_date_evidence(
            service.store,
            conversation_id=conversation_id,
            source_id=actual_source(),
            fields=fields,
            current=current,
            evidence=date_evidence,
            evidence_source_id=date_source_message_id,
        )
        row = service.update_transaction(
            transaction_id,
            idempotency_key=key("correct", entry_key),
            expected_revision=expected_revision,
            **fields,
        )
        return {
            **row,
            "verified": True,
            "changed_fields": sorted(fields),
            "date_verification": proof,
            "income_fact_verification": fact_proof,
        }

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
        date_evidence: str | None = None,
        date_source_message_id: str | None = None,
    ) -> dict:
        """Patch only user-mentioned budget fields for YYYY-MM. Structured changes supports expected_income,savings_target,daily_budget,income_schedule,coverage_start/through,commitments_upsert,commitment_keys_remove,clear_fields. Missing fields inherit. Null is rejected: explicit clearing names clear_fields. New/changed due_day is automatically checked against the user's explicit recurring rule in current input; date_evidence is optional and date_source_message_id may select retrieved history. One actual payment date, covered months or balance date do not establish a recurring day. Omit unknown due_day; never guess the 1st or ask for a date form. Unchanged existing due_day needs no new proof. Commitment amount is actual due cash; every_months/anchor_month/due_day define cycle, monthly_cost is amount/every_months rounded to cents, paid_through marks explicitly paid coverage. Reuse existing same-purpose keys when changing cycle/amount, or explicitly remove old keys in the same patch. Only clearly independent costs may list separate_from_keys; purpose is an optional stable expense identity. recurring=false overrides only changed fields for that month. Commitments lists use keyed upsert, never implicit deletion."""
        fields = _changes(changes, changes_json, BudgetChanges)
        for name in ("commitments", "commitments_upsert"):
            for item in fields.get(name) or []:
                if item.get("monthly_cost") is not None:
                    item["monthly_cost"] = str((
                        Decimal(_money(item["amount"])) / item.get("every_months", 1)
                    ).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
        mutation_key = key("budget", entry_key)
        with service.store._connection() as db:
            replay = (
                db.execute(
                    "SELECT 1 FROM finance_mutations WHERE key=?", (mutation_key,)
                ).fetchone()
                is not None
            )
        if not replay:
            verify_budget_due_days(
                service,
                month=month,
                changes=fields,
                source_id=actual_source(),
                evidence=date_evidence,
                evidence_source_id=date_source_message_id,
            )
        # Existing keys still pass the service's exact request fingerprint check;
        # an old successful mutation may be acknowledged without re-authorizing
        # it against a later, independently changed budget.
        result = service.patch_budget(
            month=month,
            idempotency_key=mutation_key,
            recurring=recurring,
            changes=fields,
        )
        return result

    @tool(args_schema=BatchArguments)
    async def apply_finance_transaction_batch(
        entry_key: str, operations: list, conserve_total: bool = True, reason: str = ""
    ) -> dict:
        """Atomically create/correct/delete multiple records. Each operation is {operation:create|update|delete,transaction_id?,expected_revision?,fields:{...}}. Split by updating/deleting original plus creating distinct parts in ONE batch; default conserve_total=true checks each income/expense/transfer total. For an explicitly corrected total/classification set false with reason. Any failure rolls back all operations. Each precise-date create/change is verified from current user input automatically; optional date_evidence/date_source_message_id belong at operation top level (outside fields). Never first record parts then delete original in separate tools."""
        values = [
            item.model_dump(exclude_unset=True) if isinstance(item, BaseModel) else item
            for item in operations
        ]
        proofs, fact_proofs = [], []
        for operation in values:
            # Common per-item labels do not replace the batch's stable receipt.
            operation.pop("entry_key", None)
            evidence = operation.pop("date_evidence", None)
            evidence_source_id = operation.pop("date_source_message_id", None)
            fact_evidence = operation.pop("fact_evidence", None)
            fact_source_message_id = operation.pop("fact_source_message_id", None)
            if operation["operation"] == "delete":
                proofs.append(None)
                fact_proofs.append(None)
                continue
            current = None
            if operation["operation"] == "update":
                with service.store._connection() as db:
                    current = service._require(db, operation.get("transaction_id"))
            operation["fields"] = canonical_dates(
                operation.get("fields") or {}, evidence_source_id=evidence_source_id, current=current,
            )
            fact_proofs.append(
                verify_income_facts(
                    service.store,
                    source_id=actual_source(),
                    fields=operation.get("fields") or {},
                    current=current,
                    evidence=fact_evidence,
                    evidence_source_id=fact_source_message_id,
                )
            )
            proof = verify_date_evidence(
                service.store,
                conversation_id=conversation_id,
                source_id=actual_source(),
                fields=operation.get("fields") or {},
                current=current,
                evidence=evidence,
                evidence_source_id=evidence_source_id,
            )
            proofs.append(proof)
            fields = operation.get("fields") or {}
            if proof and operation["operation"] == "create" and not any(
                fields.get(key) for key in ("occurred_on", "date_start", "date_end")
            ):
                date_field = "date_start" if fields.get("date_precision") == "month" else "occurred_on"
                fields[date_field] = proof["value"]
        result = service.apply_transaction_batch(
            idempotency_key=key("batch", entry_key),
            operations=values,
            conserve_total=conserve_total,
            reason=reason,
            conversation_id=conversation_id,
            source_id=actual_source(),
        )
        return {**result, "date_verifications": proofs, "income_fact_verifications": fact_proofs}

    @tool(args_schema=ReconcileArguments)
    async def reconcile_finance_assets(
        start_date: str,
        end_date: str,
        opening_assets: str,
        closing_assets: str,
        approximate: bool = True,
    ) -> dict:
        """Read-only reconciliation for the SAME total-assets scope at start/end. Program computes opening + actual income - net expense = expected closing. Transfers/withdrawals of existing assets are listed separately and NEVER added to income. Whole known-date ranges inside this observation period are included; partial overlaps remain unknown. Return exact formula for reports; unexplained difference is NOT a new consumption record. Approximate balance inputs default true. Do not manually add transfers back into this formula."""
        return service.reconcile_assets(
            start_date=start_date,
            end_date=end_date,
            opening_assets=opening_assets,
            closing_assets=closing_assets,
            approximate=approximate,
        )

    available = [
        get_finance_summary,
        list_finance_transactions,
        record_finance_transaction,
        correct_finance_transaction,
        delete_finance_transaction,
        update_finance_budget,
        apply_finance_transaction_batch,
        reconcile_finance_assets,
    ]
    if run is not None and emit is not None:
        from .common_reports import create_report_tool
        from .finance_report import build_finance_report, format_finance_completion
        from .finance_report_context import resolve_finance_report_context
        from .resources import resource_bytes

        if run.get("conversation_id") != conversation_id:
            raise ValueError("Finance report must use the original conversation")
        publication_locks = {}

        def prior_publication(report_key):
            with service.store._connection() as db:
                rows = db.execute(
                    "SELECT data FROM events WHERE run_id=? AND type='artifact' ORDER BY seq DESC",
                    (run["id"],),
                ).fetchall()
            for row in rows:
                receipt = json.loads(row["data"])
                if receipt.get("verification", {}).get("finance_report_key") != report_key:
                    continue
                resource = receipt.get("resource", {})
                if resource.get("conversation_id") != conversation_id:
                    raise StoreError(
                        "invalid_finance_report",
                        "Saved report belongs to a different conversation",
                        409,
                    )
                data = resource_bytes(settings, resource)
                if hashlib.sha256(data).hexdigest() != receipt["verification"].get("sha256"):
                    raise StoreError(
                        "resource_changed", "Saved finance report failed its integrity check", 409
                    )
                return receipt
            return None

        @tool(args_schema=FinanceReportArguments)
        async def publish_finance_report(
            start_date: str | None = None,
            end_date: str | None = None,
            opening_assets: str | None = None,
            closing_assets: str | None = None,
            approximate: bool = True,
            filename: str = "财务回顾.md",
            period_evidence: str | None = None,
            entry_key: str | None = None,
        ) -> dict:
            """Deliver a verified finance report as a real attachment from a fresh ledger snapshot. Optional dates/assets default to the latest verified report in THIS conversation; model arguments cannot shrink that scope unless the actual current user explicitly requests new report dates/month. Optional period_evidence quotes that current request. Current real balance updates replace stale observations. Without prior context use supplied dates or the known ledger range. No content/title input, no user form. Transfers are excluded from income and differences are not new consumption. Finish required reads/calculations BEFORE publishing; after success provide only requested user analysis and the attachment, not repeated calculate calls."""
            arguments = {
                "start_date": start_date,
                "end_date": end_date,
                "opening_assets": opening_assets,
                "closing_assets": closing_assets,
                "approximate": approximate,
                "filename": filename,
            }
            if period_evidence is not None:
                arguments["period_evidence"] = period_evidence
            actual_input = actual_source()
            report_scope = [source_id, arguments]
            if actual_input != source_id:
                report_scope.append(actual_input)
            report_key = hashlib.sha256(
                json.dumps(
                    report_scope,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode()
            ).hexdigest()
            lock = publication_locks.setdefault(report_key, asyncio.Lock())
            async with lock:
                previous = await asyncio.to_thread(prior_publication, report_key)
                if previous is not None:
                    return previous
                selected, context = await asyncio.to_thread(
                    resolve_finance_report_context,
                    settings,
                    service.store,
                    conversation_id=conversation_id,
                    source_id=actual_input,
                    requested=arguments,
                    period_evidence=period_evidence,
                )
                generated = await asyncio.to_thread(
                    build_finance_report,
                    service,
                    start_date=selected["start_date"],
                    end_date=selected["end_date"],
                    opening_assets=selected["opening_assets"],
                    closing_assets=selected["closing_assets"],
                    approximate=selected["approximate"],
                )
                published = None

                async def emit_report(kind, receipt):
                    nonlocal published
                    if kind == "artifact":
                        published = {
                            **receipt,
                            "verification": {
                                **receipt["verification"],
                                "finance_report_key": report_key,
                                "finance_input_id": actual_input,
                            },
                            "finance": {
                                "facts": generated["facts"],
                                "context": context,
                                "completion": format_finance_completion(generated["facts"]),
                                "program_generated": True,
                                "model_supplied_content": False,
                                "single_ledger_snapshot": True,
                            },
                        }
                        await emit(kind, published)
                    else:
                        await emit(kind, receipt)

                publisher = create_report_tool(
                    settings, run, service.store.workspace_for(conversation_id), emit_report
                )
                await publisher.ainvoke({"filename": filename, "content": generated["content"]})
                if published is None:
                    raise StoreError(
                        "invalid_finance_report", "Publisher returned no actual report receipt", 409
                    )
                return published

        available.append(publish_finance_report)
    return available
