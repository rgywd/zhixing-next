"""Build a readable finance report from one deterministic, read-only snapshot."""

import re
from decimal import Decimal

from .finance_service import _date, _error

_UUID = re.compile(r"\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b", re.I)
_MAX_BYTES = 256 * 1024
_DETAIL_LIMIT = 100


def _plain(value, limit=140):
    value = _UUID.sub("已省略内部标识", str(value or ""))
    value = re.sub(r"[\x00-\x1f\x7f]+", " ", value).strip()
    return value[:limit] + ("…" if len(value) > limit else "")


def _inline(value, limit=140):
    value = _plain(value, limit).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return re.sub(r"([\\`*_{}\[\]()#+.!|~>-])", r"\\\1", value)


def _cash(value):
    return f"¥{value}" if value is not None else "尚无足够记录"


def _month_label(value):
    return f"{value[:4]}年{int(value[5:7])}月"


def _record_date(row):
    if row["entry_type"] == "aggregate":
        return f"{row['period_start']} 至 {row['date_end']}（累计）"
    if row["date_precision"] == "month":
        return f"{_month_label(row['date_start'][:7])}（具体日期未确定）"
    if row["date_precision"] == "range":
        return f"{row['date_start']} 至 {row['date_end']}（具体付款日未确定）"
    return row["occurred_on"]


def _budget_facts(summary):
    budget, totals = summary["budget"], summary["totals"]
    income, target = summary["projection"]["income"], budget["savings_target"]
    expense, reserved = totals["expense"], summary["reservations"]["total"]
    remaining = summary["remaining"]["total_spend_budget"]
    formula = None
    if all(value is not None for value in (income, target, expense, reserved, remaining)):
        calculated = Decimal(income) - Decimal(target) - Decimal(expense) - Decimal(reserved)
        if calculated != Decimal(remaining):
            raise _error(
                "Budget report values are inconsistent", "finance_report_inconsistent", 409
            )
        formula = (
            f"计入预算收入 {income} - 结余目标 {target} - 已记净支出 {expense} "
            f"- 待付预留 {reserved} = 剩余可支配 {remaining} 元。"
        )
    commitments = [
        {
            "label": _plain(item["label"], 100),
            **{
                key: item[key]
                for key in (
                    "monthly_cost",
                    "cash_due",
                    "remaining_due",
                    "next_due_on",
                    "next_due_month",
                    "next_due_precision",
                )
            },
        }
        for item in summary["commitments"]["items"]
    ]
    return {
        "month": summary["month"],
        "expected_income": budget["expected_income"],
        "budget_income": income,
        "received_income": totals["income"],
        "savings_target": target,
        "recorded_expense": expense,
        "reserved_cash": reserved,
        "total_spend_budget": remaining,
        "daily_budget": summary["remaining"]["daily_budget"],
        "configured_daily_budget": budget["daily_budget"],
        "monthly_cost": summary["commitments"]["monthly_cost"],
        "cash_due": summary["commitments"]["cash_due"],
        "formula": formula,
        "commitments": commitments,
        "expected_income_on": summary["expected_income_on"],
        "income_schedule": (
            {
                "rule": summary["income_schedule"]["rule"],
                "calendar_basis": summary["income_schedule"]["calendar_basis"],
            }
            if summary["income_schedule"]
            else None
        ),
    }


def build_finance_report(
    service,
    *,
    start_date,
    end_date,
    opening_assets=None,
    closing_assets=None,
    approximate=True,
):
    """Return content and safe receipts; publishing is a separate journalled action."""
    start_date, end_date = _date(start_date), _date(end_date)
    if start_date > end_date:
        raise _error("Finance report start_date must not follow end_date")
    if (opening_assets is None) != (closing_assets is None):
        raise _error("Opening and closing asset observations must be provided together")
    if not isinstance(approximate, bool):
        raise _error("approximate must be a boolean")
    with service.store._connection() as db:
        db.execute("BEGIN")
        # Establish a snapshot before delegating, even when no asset observations exist.
        db.execute("SELECT COUNT(*) FROM finance_transactions").fetchone()
        reconcile = service.reconcile_assets(
            start_date=start_date,
            end_date=end_date,
            opening_assets=opening_assets,
            closing_assets=closing_assets,
            approximate=approximate,
            _db=db,
        )
        closing_month = end_date[:7]
        closing = service.summary(month=closing_month, as_of=end_date, _db=db)
        # Closing month plus at most two next payment months, derived from actual
        # commitments rather than invented monthly payment/earnings scenarios.
        due_months = sorted(
            {
                item["next_due_month"]
                for item in closing["commitments"]["items"]
                if item["next_due_month"] > closing_month
            }
        )[:2]
        summaries = [closing] + [
            service.summary(month=month, as_of=end_date, _db=db) for month in due_months
        ]
        # No list endpoint or pagination can hide a flow from this report's count.
        rows = [
            dict(row)
            for row in db.execute(
                "SELECT * FROM finance_transactions WHERE deleted=0 "
                "AND (CASE WHEN entry_type='aggregate' THEN period_start ELSE date_start END)<=? "
                "AND date_end>=? ORDER BY occurred_on,created_at,id",
                (end_date, start_date),
            )
        ]

    budgets = [_budget_facts(summary) for summary in summaries]
    lines = [
        "# 财务回顾",
        "",
        f"回顾期间：{start_date} 至 {end_date}。",
        "",
        "## 已知流水与资产",
        "",
    ]
    flows = reconcile["flows"]
    if reconcile["calculation"] is not None:
        lines += [
            f"期间已知收入 {_cash(flows['income'])}，支出 {_cash(flows['expense'])}，"
            f"退款 {_cash(flows['refund'])}，净支出 {_cash(flows['net_expense'])}。",
            f"内部转账共 {_cash(flows['transfer'])}，单独列示，不计入新增收入或合计资产变化。",
            "",
            reconcile["calculation"]["formula"],
            "",
            "这只是已知流水口径的资产核对。正差额是未解释净流出，负差额是未解释净流入；"
            "差额不是已经发生的消费或收入，也不会自动记账。期初与期末采用相同的账户范围。",
        ]
    else:
        lines += [
            f"期间已知收入 {_cash(flows['income'])}，支出 {_cash(flows['expense'])}，"
            f"退款 {_cash(flows['refund'])}，净支出 {_cash(flows['net_expense'])}。",
            f"内部转账共 {_cash(flows['transfer'])}，单独列示，不计入新增收入或合计资产变化。",
            "未提供同范围的期初、期末资产观察，本次只回顾账本和预算，不推算资产差额。",
        ]
    lines += [
        "",
        "## 预算与付款安排",
        "",
        "以下是已保存的预算安排，可以随实际情况调整；预计收入不等于已经到账。本月已归属收入仅统计日期已能归到该月的记录，跨月范围尚未归属不代表没有到账。",
        "",
    ]
    for budget in budgets:
        lines += [
            f"### {_month_label(budget['month'])}",
            "",
            f"预计收入 {_cash(budget['expected_income'])}；本月已归属收入 {_cash(budget['received_income'])}；"
            f"计入预算收入 {_cash(budget['budget_income'])}（预计与已归属收入不重复相加）。",
            f"结余目标 {_cash(budget['savings_target'])}；已记净支出 {_cash(budget['recorded_expense'])}；"
            f"待付现金预留 {_cash(budget['reserved_cash'])}。",
            f"剩余可支配 {_cash(budget['total_spend_budget'])}；日常预算剩余 {_cash(budget['daily_budget'])}。",
            budget["formula"] or "尚无足够记录，暂不推算剩余可支配金额。",
            "",
            f"固定及一次性安排的月成本合计 {_cash(budget['monthly_cost'])}；"
            f"本月到期现金合计 {_cash(budget['cash_due'])}。月成本用于理解负担，不替代实际到期付款或现金预留。",
        ]
        for item in budget["commitments"]:
            next_payment = (
                f"下一付款日 {item['next_due_on']}"
                if item["next_due_on"] is not None
                else f"下一付款月 {_month_label(item['next_due_month'])}（具体日未确定）"
            )
            lines.append(
                f"- {_inline(item['label'], 100)}：月成本 {_cash(item['monthly_cost'])}；"
                f"本月到期现金 {_cash(item['cash_due'])}；尚待支付 {_cash(item['remaining_due'])}；"
                f"{next_payment}。"
            )
        if budget["income_schedule"]:
            lines.append(
                f"预计发薪日 {budget['expected_income_on'] or '尚无足够记录'}，仅是日程安排，不能证明过去已经到账。"
                "未接入官方节假日调休；工作日按已保存的每周工作日和用户例外计算。"
            )
        lines.append("")

    lines += [
        "## 期间记录",
        "",
        f"共 {len(rows)} 笔记录，以下展示 {min(len(rows), _DETAIL_LIMIT)} 笔。",
    ]
    if len(rows) > _DETAIL_LIMIT:
        lines.append("其余记录可在账本中查看，期间合计使用全部符合范围的记录。")
    if rows:
        lines += ["", "| 日期 | 收支 | 金额 | 说明 |", "| --- | --- | ---: | --- |"]
    excluded = set(reconcile["excluded"]["transaction_ids"])
    covered = set(reconcile["included"]["covered_transaction_ids"])
    gaps = {item["code"] for item in reconcile["gaps"]}
    names = {"income": "收入", "expense": "支出", "refund": "退款", "transfer": "内部转账"}
    for row in rows[:_DETAIL_LIMIT]:
        notes = [_inline(row["category"], 100)]
        if row.get("coverage_start"):
            notes.append(
                f"支付对应{_month_label(row['coverage_start'])}至{_month_label(row['coverage_end'])}费用"
            )
        if row["id"] in excluded:
            notes.append("与核对区间或累计金额存在不确定重叠，未重复或猜测计入")
        elif row["id"] in covered:
            notes.append("已含在期间累计金额中")
        lines.append(
            f"| {_record_date(row)} | {names[row['kind']]} | {_cash(row['amount'])} | {'；'.join(notes)} |"
        )
    if not rows:
        lines.append("尚无足够记录；没有记录不代表没有消费。")

    if any(not summary["coverage"]["complete"] for summary in summaries):
        gaps.add("record_coverage_not_confirmed")
    notes = []
    if "approximate_assets" in gaps:
        notes.append("资产观察为近似值，核对差额也只是近似结果。")
    if "record_coverage_not_confirmed" in gaps:
        notes.append(
            "部分日期尚不能确认流水记录完整，因此不把漏记当作零开销，也不据此断言真实日均消费。"
        )
    if any("intersect" in gap or "overlap" in gap for gap in gaps):
        notes.append(
            "部分记录只有日期范围或与累计金额重叠，已保留原始范围，未猜测拆分到某天或某月。"
        )
    if "details_exceed_cumulative_total" in gaps:
        notes.append("明细与累计金额存在差异，本次保留可证明的明细净额，并注明核对范围。")
    if notes:
        lines += ["", "## 阅读说明", "", *[f"- {note}" for note in notes]]
    content = "\n".join(lines).rstrip() + "\n"
    if len(content.encode("utf-8")) > _MAX_BYTES:
        raise _error("Finance report exceeds the text size limit", "finance_report_too_large", 422)
    return {
        "content": content,
        "facts": {
            "period": {"start_date": start_date, "end_date": end_date},
            "assets": reconcile["assets"],
            "flows": flows,
            "calculation": reconcile["calculation"],
            "budgets": budgets,
            "record_count": len(rows),
            "shown_record_count": min(len(rows), _DETAIL_LIMIT),
            "gap_codes": sorted(gaps),
        },
    }


def format_finance_completion(facts):
    """Describe only the delivered report; do not infer missing transactions/actions."""
    period, flows = facts["period"], facts["flows"]
    start, end = _date(period["start_date"]), _date(period["end_date"])
    count = facts["record_count"]
    if type(count) is not int or count < 0:
        raise _error(
            "Finance report has an invalid record count", "finance_report_inconsistent", 409
        )
    lines = [
        "财务回顾已交付，可直接打开附件。",
        f"本报告涵盖 {start} 至 {end} 的 {count} 条记录：已知收入 {_cash(flows['income'])}，净支出 {_cash(flows['net_expense'])}。内部转账 {_cash(flows['transfer'])} 单列，不计入新增收入。",
    ]
    closing = next((item for item in facts.get("budgets", []) if item["month"] == end[:7]), None)
    arrangements = []
    if closing is not None:
        if closing.get("savings_target") is not None:
            arrangements.append(f"本月结余目标 {_cash(closing['savings_target'])}，可以调整")
        rentals = [
            item
            for item in closing.get("commitments", [])
            if re.search(r"房租|租金|租房|租住|\brent\b|\brental\b", item["label"], re.I)
        ]
        # Several independent properties need the report's full list; a short
        # completion must not choose or combine their cash obligations.
        if len(rentals) == 1:
            rent = rentals[0]
            month = rent.get("next_due_month")
            if rent.get("next_due_precision") == "day" and rent.get("next_due_on"):
                timing = _date(rent["next_due_on"])
            elif month:
                timing = f"{_month_label(month)}（具体日未确定）"
            else:
                timing = None
            if timing:
                payment = f"下一房租付款安排为 {timing}"
                scheduled = next(
                    (item for item in facts.get("budgets", []) if item["month"] == month), None
                )
                if scheduled:
                    matches = [
                        item
                        for item in scheduled.get("commitments", [])
                        if item["label"] == rent["label"] and item.get("next_due_month") == month
                    ]
                    if (
                        len(matches) == 1
                        and matches[0].get("cash_due") is not None
                        and Decimal(matches[0]["cash_due"]) > 0
                    ):
                        payment += f"，到期现金 {_cash(matches[0]['cash_due'])}"
                arrangements.append(payment)
    if arrangements:
        lines.append("；".join(arrangements) + "。")
    calculation = facts.get("calculation")
    if calculation is not None:
        difference = calculation["unexplained_difference"]
        approximate = bool((facts.get("assets") or {}).get("approximate"))
        qualifier = "约 " if approximate else ""
        if Decimal(difference) == 0:
            lines.append(f"已知流水口径核对差额 {qualifier}{_cash(difference)}。")
        else:
            lines.append(
                f"已知流水口径核对差额 {qualifier}{_cash(difference)}，仅为未解释的资产变化，未认定为消费。"
            )
    return "\n\n".join(lines)
