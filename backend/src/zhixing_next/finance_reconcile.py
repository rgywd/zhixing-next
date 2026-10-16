"""Read-only reconciliation of asset observations against known ledger flows."""

import calendar
from datetime import date
from decimal import Decimal


def reconcile_assets(
    service, *, start_date, end_date, opening_assets, closing_assets, approximate=True
):
    """Compute a difference without inventing expenses or allocating uncertain dates.

    Asset observations must cover the same set of accounts. Transfers have no direction
    in this ledger and represent internal moves; they are disclosed but never income.
    An aggregate is a net cumulative amount including details and refunds in its range.
    """
    # Local import lets FinanceService delegate here without a module import cycle.
    from .finance_service import ZERO, _date, _error, _fmt, _money

    start_date, end_date = _date(start_date), _date(end_date)
    if start_date > end_date:
        raise _error("Asset reconciliation start_date must not follow end_date")
    if not isinstance(approximate, bool):
        raise _error("approximate must be a boolean")
    opening, closing = Decimal(_money(opening_assets)), Decimal(_money(closing_assets))
    gaps = []

    def gap(code, message, rows=()):
        item = {"code": code, "message": message}
        if rows:
            item["transaction_ids"] = [row["id"] for row in rows]
        gaps.append(item)

    if approximate:
        gap("approximate_assets", "期初或期末资产为近似值，差额也只是近似核对结果。")

    coverage = []
    with service.store._connection() as db:
        db.execute("BEGIN")
        # A cumulative entry's period starts at period_start, not its final record date.
        # Read all intersecting entries in one consistent snapshot, without pagination.
        rows = [
            dict(row)
            for row in db.execute(
                "SELECT * FROM finance_transactions WHERE deleted=0 "
                "AND (CASE WHEN entry_type='aggregate' THEN period_start ELSE date_start END)<=? "
                "AND date_end>=? ORDER BY occurred_on,created_at,id",
                (end_date, start_date),
            )
        ]
        current = date.fromisoformat(start_date).replace(day=1)
        while current.isoformat() <= end_date:
            month = current.isoformat()[:7]
            month_end = current.replace(day=calendar.monthrange(current.year, current.month)[1])
            requested_start = max(start_date, current.isoformat())
            requested_end = min(end_date, month_end.isoformat())
            budget = service._budget(db, month)
            confirmed_start, confirmed_end = budget["coverage_start"], budget["coverage_through"]
            complete = bool(
                confirmed_start
                and confirmed_end
                and confirmed_start <= requested_start
                and confirmed_end >= requested_end
            )
            coverage.append(
                {
                    "month": month,
                    "requested_start": requested_start,
                    "requested_end": requested_end,
                    "confirmed_start": confirmed_start,
                    "confirmed_through": confirmed_end,
                    "complete": complete,
                }
            )
            if current.month == 12:
                if current.year == 9999:
                    break
                current = date(current.year + 1, 1, 1)
            else:
                current = date(current.year, current.month + 1, 1)

    if any(not item["complete"] for item in coverage):
        gap("record_coverage_not_confirmed", "区间内存在未确认完整记录的日期；漏记不能当作零开销。")

    def interval(row):
        return (
            row["period_start"] if row["entry_type"] == "aggregate" else row["date_start"],
            row["date_end"],
        )

    contained, excluded = [], []
    for row in rows:
        begin, end = interval(row)
        if begin < start_date or end > end_date:
            excluded.append(row)
            cumulative = row["entry_type"] == "aggregate"
            gap(
                "cumulative_partially_intersects_period"
                if cumulative
                else "transaction_partially_intersects_period",
                "累计区间仅部分落入核对期间，未猜测分摊金额。"
                if cumulative
                else "记录日期区间仅部分落入核对期间，未猜测分摊金额。",
                [row],
            )
        else:
            contained.append(row)

    aggregates = [row for row in contained if row["entry_type"] == "aggregate"]
    details = [row for row in contained if row["entry_type"] == "detail"]
    covered = {}
    accepted = []
    for row in details:
        begin, end = interval(row)
        matches = [
            aggregate
            for aggregate in aggregates
            if aggregate["kind"] == ("expense" if row["kind"] == "refund" else row["kind"])
            and aggregate["bucket"] == row["bucket"]
            and aggregate["period_start"] <= end
            and aggregate["date_end"] >= begin
        ]
        containing = [
            aggregate
            for aggregate in matches
            if aggregate["period_start"] <= begin and end <= aggregate["date_end"]
        ]
        if matches and not containing:
            excluded.append(row)
            gap(
                "uncertain_record_overlaps_cumulative_total",
                "这笔日期不确定的记录与已计入累计部分重叠；暂不重复计入，也不猜测拆分。",
                [row, *matches],
            )
            continue
        accepted.append(row)
        if containing:
            covered[row["id"]] = containing[0]["id"]

    income, net_expense, refunds, transfer = ZERO, ZERO, ZERO, ZERO
    for row in accepted:
        amount, kind = Decimal(row["amount"]), row["kind"]
        if kind == "transfer":
            transfer += amount
        if kind == "refund":
            refunds += amount
        if row["id"] in covered or kind == "transfer":
            continue
        if kind == "income":
            income += amount
        else:
            net_expense += -amount if kind == "refund" else amount

    for aggregate in aggregates:
        amount = Decimal(aggregate["amount"])
        detail_net = sum(
            (
                Decimal(row["amount"]) * (-1 if row["kind"] == "refund" else 1)
                for row in accepted
                if covered.get(row["id"]) == aggregate["id"]
            ),
            ZERO,
        )
        if detail_net > amount:
            gap(
                "details_exceed_cumulative_total",
                "已知明细净额超过累计，采用可证明的明细净额并保留冲突缺口。",
                [aggregate],
            )
        effective = max(amount, detail_net)
        if aggregate["kind"] == "income":
            income += effective
        else:
            net_expense += effective

    expected = opening + income - net_expense
    change, difference = closing - opening, expected - closing
    direction = (
        "unexplained_net_outflow"
        if difference > ZERO
        else "unexplained_net_inflow"
        if difference < ZERO
        else "balanced_known_flows"
    )
    included = [*aggregates, *accepted]
    return {
        "scope": "known_flows_only",
        "read_only": True,
        "period": {"start_date": start_date, "end_date": end_date},
        "assets": {"opening": _fmt(opening), "closing": _fmt(closing), "approximate": approximate},
        "flows": {
            "income": _fmt(income),
            "expense": _fmt(net_expense + refunds),
            "refund": _fmt(refunds),
            "net_expense": _fmt(net_expense),
            "transfer": _fmt(transfer),
            "transfer_excluded_from_asset_change": True,
            "expense_basis": "net_cumulative_expense_plus_known_refunds",
        },
        "calculation": {
            "expected_closing": _fmt(expected),
            "actual_net_change": _fmt(change),
            "unexplained_difference": _fmt(difference),
            "difference_meaning": direction,
            "formula": (
                f"期初资产 {_fmt(opening)} + 已知收入 {_fmt(income)} "
                f"- 已知净支出 {_fmt(net_expense)} = 预计期末资产 {_fmt(expected)}；"
                f"实际资产变化 {_fmt(closing)} - {_fmt(opening)} = {_fmt(change)}；"
                f"未解释差额 {_fmt(expected)} - {_fmt(closing)} = {_fmt(difference)}。"
            ),
            "interpretation": "正差额表示未解释净流出，负差额表示未解释净流入；均不是自动认定的消费或收入，不会写入账本。",
        },
        "included": {
            "count": len(included),
            "transaction_ids": [row["id"] for row in included],
            "covered_transaction_ids": list(covered),
        },
        "excluded": {"transaction_ids": [row["id"] for row in excluded]},
        "coverage": {"complete": all(item["complete"] for item in coverage), "months": coverage},
        "gaps": gaps,
        "assumptions": [
            "期初与期末资产使用相同账户范围；账本未记录账户范围，未自动验证这一点。",
            "内部转账只披露金额，不改变合计资产，不充当收入。",
            "累计净额已含同种类、同预算类别、区间内的明细与退款，未重复相加。",
        ],
    }
