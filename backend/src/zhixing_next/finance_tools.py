"""Finance tools use strict schemas and the same transactional service as HTTP."""

import asyncio
import hashlib
import json

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .finance_dates import verify_date_evidence
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
    "reconcile_finance_assets",
    "publish_finance_report",
]
FINANCE_INSTRUCTIONS = """你是知行的财务助手。新消费和收入必须使用record_finance_transaction；旧record_finance_observation仅用于balance余额观察，不能承接新收支。用户清楚表达的消费、收入、退款与预算修改直接通过财务服务工具保存，只有真实成功回执才能说已记录。收支以业务日期而非录入时间归月；今天使用Asia/Shanghai业务日期。不能编造金额、收入、消费或预算。日常、固定、一次性分别记录，大件仍计入真实结余。转账/信用卡还款使用transfer，不能当作新增消费。退款引用原消费ID。先查询真实记录和有效预算再纠正；不要把同日同额不同笔消费合并。固定费用付款仅在明确匹配时填写预算commitment_key。预计收入本身包含实收，不能相加两次。预算可默认沿用或单月覆盖，不把个人数字或规则写死。update_finance_budget仅修改用户提及字段；AI提出的预算不是用户已接受安排。同句多笔用不同且稳定的entry_key（如expense_1、expense_2），同一笔跨重试保持原entry_key；纠正用新操作entry_key及原记录ID。每个工具自动使用原消息source_id确保重试不重复。累计总额用aggregate及period_start，覆盖范围内明细不重复计；禁止把旧余额观察自动变为收入或确定业务日期的账目。覆盖不完整的日均未知，不把漏记当零消费；预测需说明依据和缺口。只有用户确认记录覆盖完整时才修改coverage_start/coverage_through。用户只发饮食照片时不猜餐费，跨服务部分成功时说明已经保存的部分并只补失败项。"""
FINANCE_INSTRUCTIONS += " 收支日期不完整时使用date_precision=month或range及date_start/date_end，不可猜成今天；跨月未知单列未分配，不当作当月现金流。付款日期与费用覆盖月份coverage_start/end分开。季付租金只保留一份承诺，amount为实际付款额、every_months为周期、monthly_cost为月成本，不能另建月摊承诺重复预留。发薪规则存income_schedule；最后工作日通过共用date_info计算，未接法定调休时明确按周一至周五和用户例外。预算只传changes中修改字段，承诺用commitments_upsert或commitment_keys_remove，绝不能为省略未改字段传null；明确清空用clear_fields。更正用结构化changes；未知字段会报错，不能把未成功写入说成不支持。拆分已有收入/消费使用apply_finance_transaction_batch单事务且默认总额守恒；金额本身确需纠正才conserve_total=false并注明原因。工具成功后核对回执中的实际值，财务报告使用publish_finance_report复用共同发布链路交付可打开文件，不能仅声称工作区文件已交付。"

FINANCE_INSTRUCTIONS += " 重要记账语义：公积金提取、存款提现、取回赎回本金等是已有资产内部转移，使用transfer，不能因为到账银行卡就当income；只有新工资、新收益、新缴存才是income，混合时分别记录。首尾资产都包含的同一资产尤其不可再加作收入。用户只说某段期间收到N笔工资/提取时，N笔不证明实际月份，先把整个明确期间保存range；不要拆猜8月/9月或按发薪规则倒推已到账月份。后续发薪日规则只说明预计日程，不证明过去每笔发生日期。修改付款周期/金额要先查看现有commitments并复用同用途key，或在同一patch显式remove旧key后新增；不能保留旧月摊承诺再加季度款。amount永远是一次实际付款额，monthly_cost是amount/every_months，仅分币舍入。commitment工具回执verification同时给月成本、现金到期款、剩余预留与所有生效项，必须核对并再get_finance_summary；若仍有同用途项应纠正而非直接交付重复预留报告。"

FINANCE_INSTRUCTIONS += " 实际发生日期必须来自原用户话：AI记day/month（包括同日起止range）或更正到精确日期时，date_evidence引用真实用户短句，date_source_message_id默认当前输入；历史原话可用共用read_history_message读取。余额观察日、回顾截止日、租金覆盖月份或发薪日程不能证明购买日。历史大件只有金额没有购买日时直接保留原历史范围，不可按‘现在余额更新时点’塞今天/本月，也不要让用户补表。即时资产核对使用reconcile_finance_assets；正式财务报告使用publish_finance_report内部调用同一核对并生成程序事实；内部transfer单列，永远不加到新增收入，不得另用calculate把transfer加回。unexplained_difference仅是已知流水口径未解释的资产差额，不是已发生消费，不得自动记账或称为实际日常开销。近似资产、范围部分相交及覆盖缺口在报告简述。"

FINANCE_INSTRUCTIONS += " 财务账本/预算/资产回顾报告必须使用publish_finance_report，不再自己编写数值正文交给通用publish_report。业务报告工具直接按同一账本快照和程序核对生成事实Markdown并交付本会话附件，不能传content或自由title。参数start_date/end_date；用户已有同范围期初期末资产观察时传opening_assets/closing_assets及approximate，否则两者省略即可，不要求用户补齐。报告不会猜购买日期、添加缴存等未确认情景、向用户展示内部ID/revision/coverage字段或补表清单。工具成功后直接给附件，必要时只概述回执事实，不再重算或追加模型假设。"

FINANCE_INSTRUCTIONS += " 面向用户只简述已完成的记录、预算调整和报告附件，用自然语言说明付款周期，不展示key、every_months、anchor_month等实现字段。已经保留为日期范围或近似资产差额的信息不妨碍本次记账与报告，不能列成‘需你确认’或‘待你补齐’清单，也不要要求用户重报过去几个月日常流水、大件月份或逐项对账。未解释差额只说明尚不能确定来源，不把某种消费列为‘最可能’，不将账本缺口推给用户。未来发薪规则不能证明历史到账日期，也不能提出据此拆分历史工资；未要求记录且金额未知的押金等不另行索要。只有缺失信息确实阻止当前必要动作且查不到原文时才追问一个必要问题；否则直接完成。"


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
    start_date: str
    end_date: str
    opening_assets: str | None = None
    closing_assets: str | None = None
    approximate: bool = True
    filename: str = Field(
        default="财务回顾.md", min_length=4, max_length=120, pattern=r"^[^/\\\x00-\x1f]+\.md$"
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


def create_finance_service_tools(
    settings, conversation_id: str, source_id: str, *, run=None, emit=None
):
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
        date_evidence: str | None = None,
        date_source_message_id: str | None = None,
    ) -> dict:
        """Record explicit CNY cash flow with stable distinct entry_key. Exact day: occurred_on YYYY-MM-DD. Month-only: date_precision=month,date_start=YYYY-MM. Uncertain range: date_precision=range,date_start/date_end YYYY-MM-DD. Never invent today. coverage_start/end are YYYY-MM costs covered by a payment. Withdrawals of provident funds, deposits or returned principal are existing-asset transfer, never income; new external earnings/contributions are income. A count of past payments does not prove months: preserve the user's stated whole period as range. Precise day/month or same-day range requires date_evidence quoting a user-stated ACTUAL event date; do not use an asset observation date, review cutoff, cost coverage or recurring rule. Refund references an expense. aggregate is an explicit cumulative total with period_start."""
        proof = verify_date_evidence(
            service.store,
            conversation_id=conversation_id,
            source_id=source_id,
            fields={
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
        return {**row, "verified": True, "date_verification": proof}

    @tool(args_schema=CorrectionArguments)
    async def correct_finance_transaction(
        transaction_id: str,
        entry_key: str,
        changes=None,
        changes_json: str | None = None,
        expected_revision: int | None = None,
        date_evidence: str | None = None,
        date_source_message_id: str | None = None,
    ) -> dict:
        """Correct an existing ID with structured changes object, e.g. changes={amount:'42'}. Read ID/revision first. Do not place amount at top level. Unknown fields are rejected. Legacy changes_json is accepted instead of changes, never together. Keep entry_key stable across retry. Precise date changes require top-level date_evidence and optional date_source_message_id referencing the actual user occurrence-date quote; other non-date changes need no new evidence."""
        fields = _changes(changes, changes_json, TransactionChanges)
        if not fields:
            raise StoreError(
                "invalid_finance_record", "At least one changed field is required", 422
            )
        with service.store._connection() as db:
            current = service._require(db, transaction_id)
        proof = verify_date_evidence(
            service.store,
            conversation_id=conversation_id,
            source_id=source_id,
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
        """Atomically create/correct/delete multiple records. Each operation is {operation:create|update|delete,transaction_id?,expected_revision?,fields:{...}}. Split by updating/deleting original plus creating distinct parts in ONE batch; default conserve_total=true checks each income/expense/transfer total. For an explicitly corrected total/classification set false with reason. Any failure rolls back all operations. Each precise-date create/change requires date_evidence and optional date_source_message_id at operation top level (outside fields). Never first record parts then delete original in separate tools."""
        values = [
            item.model_dump(exclude_unset=True) if isinstance(item, BaseModel) else item
            for item in operations
        ]
        proofs = []
        for operation in values:
            evidence = operation.pop("date_evidence", None)
            evidence_source_id = operation.pop("date_source_message_id", None)
            if operation["operation"] == "delete":
                proofs.append(None)
                continue
            current = None
            if operation["operation"] == "update":
                with service.store._connection() as db:
                    current = service._require(db, operation.get("transaction_id"))
            proofs.append(
                verify_date_evidence(
                    service.store,
                    conversation_id=conversation_id,
                    source_id=source_id,
                    fields=operation.get("fields") or {},
                    current=current,
                    evidence=evidence,
                    evidence_source_id=evidence_source_id,
                )
            )
        result = service.apply_transaction_batch(
            idempotency_key=key("batch", entry_key),
            operations=values,
            conserve_total=conserve_total,
            reason=reason,
            conversation_id=conversation_id,
            source_id=source_id,
        )
        return {**result, "date_verifications": proofs}

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
        from .finance_context import active_finance_input
        from .finance_report import build_finance_report, format_finance_completion
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
            start_date: str,
            end_date: str,
            opening_assets: str | None = None,
            closing_assets: str | None = None,
            approximate: bool = True,
            filename: str = "财务回顾.md",
        ) -> dict:
            """Deliver a verified finance ledger/budget/assets report as a real Markdown attachment in this conversation. No content/title input: facts, formulas, date precision, monthly costs and due cash come directly from one ledger snapshot. Give the observation period and optional BOTH same-scope opening/closing asset values; omit both for an ordinary report without assets. Unknown dates/coverage stay neutral gaps, never a request to fill forms. Use this for finance factual reports instead of composing arithmetic in publish_report. Transfers are excluded from income; unexplained differences are not new consumption."""
            if (opening_assets is None) != (closing_assets is None):
                raise StoreError(
                    "invalid_finance_report",
                    "Asset observations must be provided together, or omit both and publish the known ledger/budget facts. Do not ask the user to fill missing fields.",
                    422,
                )
            arguments = {
                "start_date": start_date,
                "end_date": end_date,
                "opening_assets": opening_assets,
                "closing_assets": closing_assets,
                "approximate": approximate,
                "filename": filename,
            }
            actual_input = active_finance_input.get() or source_id
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
                generated = await asyncio.to_thread(
                    build_finance_report,
                    service,
                    start_date=start_date,
                    end_date=end_date,
                    opening_assets=opening_assets,
                    closing_assets=closing_assets,
                    approximate=approximate,
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
