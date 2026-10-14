"""Deterministic monthly finance records; balances remain separate observations."""

import calendar
import hashlib
import json
import re
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from uuid import uuid4
from zoneinfo import ZoneInfo

KINDS = {"expense", "income", "transfer", "refund"}
BUCKETS = {"daily", "fixed", "one_time"}
ZERO = Decimal("0")


def _error(message, code="invalid_finance_record", status=422):
    from .store import StoreError

    return StoreError(code, message, status)


def _now():
    return datetime.now(UTC).isoformat(timespec="microseconds")


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _money(value, *, nullable=False):
    if value is None and nullable:
        return None
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise _error("Amount must be a decimal number") from None
    if (
        not number.is_finite()
        or number < 0
        or number >= Decimal("1000000000000")
        or number.as_tuple().exponent < -2
    ):
        raise _error("Amount must be nonnegative with at most two decimal places")
    return f"{number:.2f}"


def _fmt(value):
    return f"{value:.2f}" if value is not None else None


def _date(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise _error("Use a business date in YYYY-MM-DD format")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise _error("Invalid business date") from None
    return value


def _month(value=None):
    value = value or datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m")
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}", value):
        raise _error("Use a month in YYYY-MM format")
    _date(value + "-01")
    return value


def _text(value, name, maximum=1000, allow_empty=True):
    if (
        not isinstance(value, str)
        or len(value.strip()) > maximum
        or (not allow_empty and not value.strip())
    ):
        raise _error(f"Invalid {name}")
    return value.strip()


def migrate(db):
    """Called by Store inside the schema-v12 transaction; never commits independently."""
    statements = [
        "CREATE TABLE IF NOT EXISTS finance_budgets(month TEXT NOT NULL,recurring INTEGER NOT NULL,data_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,PRIMARY KEY(month,recurring))",
        "CREATE TABLE IF NOT EXISTS finance_transactions(id TEXT PRIMARY KEY,kind TEXT NOT NULL,amount TEXT NOT NULL,occurred_on TEXT NOT NULL,bucket TEXT NOT NULL,category TEXT NOT NULL,note TEXT NOT NULL,commitment_key TEXT,related_transaction_id TEXT REFERENCES finance_transactions(id),conversation_id TEXT,source_id TEXT,entry_type TEXT NOT NULL DEFAULT 'detail',period_start TEXT,revision INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)",
        "CREATE INDEX IF NOT EXISTS finance_transactions_month ON finance_transactions(occurred_on,deleted)",
        "CREATE TABLE IF NOT EXISTS finance_mutations(key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL)",
    ]
    for statement in statements:
        db.execute(statement)


class FinanceService:
    def __init__(self, store):
        self.store = store

    def _mutate(self, key, request, operation):
        key = _text(key, "idempotency key", 300, False)
        fingerprint = hashlib.sha256(_json(request).encode()).hexdigest()
        with self.store._connection(write=True) as db:
            previous = db.execute("SELECT * FROM finance_mutations WHERE key=?", (key,)).fetchone()
            if previous:
                if previous["request_hash"] != fingerprint:
                    raise _error(
                        "This request ID was already used for different fields",
                        "idempotency_conflict",
                        409,
                    )
                return json.loads(previous["result_json"])
            result = operation(db)
            db.execute(
                "INSERT INTO finance_mutations VALUES(?,?,?,?)",
                (key, fingerprint, _json(result), _now()),
            )
            return result

    @staticmethod
    def _record(row):
        result = dict(row)
        result["deleted"] = bool(result["deleted"])
        return result

    def _require(self, db, identifier):
        row = db.execute(
            "SELECT * FROM finance_transactions WHERE id=? AND deleted=0", (identifier,)
        ).fetchone()
        if row is None:
            raise _error("Finance transaction not found", "not_found", 404)
        return self._record(row)

    def get_budget(self, month=None):
        month = _month(month)
        with self.store._connection() as db:
            db.execute("BEGIN")
            return self._budget(db, month)

    @staticmethod
    def _budget(db, month):
        row = db.execute(
            "SELECT * FROM finance_budgets WHERE month=? AND recurring=0", (month,)
        ).fetchone()
        if row is None:
            row = db.execute(
                "SELECT * FROM finance_budgets WHERE month<=? AND recurring=1 ORDER BY month DESC LIMIT 1",
                (month,),
            ).fetchone()
        base = {
            "month": month,
            "source_month": None,
            "recurring": True,
            "expected_income": None,
            "savings_target": None,
            "daily_budget": None,
            "commitments": [],
            "coverage_start": None,
            "coverage_through": None,
            "revision": 0,
        }
        if row:
            base.update(json.loads(row["data_json"]))
            base.update(
                month=month,
                source_month=row["month"],
                recurring=bool(row["recurring"]),
                revision=row["revision"],
                updated_at=row["updated_at"],
            )
            if row["month"] != month:
                base["commitments"] = [
                    item for item in base["commitments"] if item["kind"] == "fixed"
                ]
                base["coverage_start"] = base["coverage_through"] = None
        return base

    def set_budget(
        self,
        *,
        month,
        idempotency_key,
        recurring=True,
        expected_income=None,
        savings_target=None,
        daily_budget=None,
        commitments=None,
        coverage_start=None,
        coverage_through=None,
        expected_revision=None,
        expected_source_month=None,
        _db=None,
    ):
        month = _month(month)
        if not isinstance(recurring, bool):
            raise _error("Recurring must be true or false")
        normalized = []
        if not isinstance(commitments or [], list) or len(commitments or []) > 100:
            raise _error("Invalid commitments")
        for item in commitments or []:
            if not isinstance(item, dict) or item.get("kind") not in {"fixed", "one_time"}:
                raise _error("Commitment kind must be fixed or one_time")
            normalized.append(
                {
                    "key": _text(item.get("key"), "commitment key", 100, False),
                    "label": _text(item.get("label"), "commitment label", 100, False),
                    "amount": _money(item.get("amount")),
                    "kind": item["kind"],
                }
            )
        if len({item["key"] for item in normalized}) != len(normalized):
            raise _error("Commitment keys must be unique")
        if (coverage_start is None) != (coverage_through is None):
            raise _error("Specify both coverage dates or neither")
        if coverage_start is not None:
            _date(coverage_start)
            _date(coverage_through)
            if (
                coverage_start[:7] != month
                or coverage_through[:7] != month
                or coverage_start > coverage_through
            ):
                raise _error("Coverage dates must be ordered within the selected month")
        data = {
            "expected_income": _money(expected_income, nullable=True),
            "savings_target": _money(savings_target, nullable=True),
            "daily_budget": _money(daily_budget, nullable=True),
            "commitments": normalized,
            "coverage_start": coverage_start,
            "coverage_through": coverage_through,
        }

        def operation(db):
            if expected_revision is not None:
                current = self._budget(db, month)
                if (
                    current["revision"] != expected_revision
                    or current["source_month"] != expected_source_month
                ):
                    raise _error(
                        "This budget changed; reload before saving", "revision_conflict", 409
                    )
            db.execute(
                "INSERT INTO finance_budgets VALUES(?,?,?,1,?) ON CONFLICT(month,recurring) DO UPDATE SET data_json=excluded.data_json,revision=finance_budgets.revision+1,updated_at=excluded.updated_at",
                (month, int(recurring), _json(data), _now()),
            )
            if recurring:
                # An explicit new default from this month supersedes its old override.
                db.execute("DELETE FROM finance_budgets WHERE month=? AND recurring=0", (month,))
            return self._budget(db, month)

        if _db is not None:
            return operation(_db)
        return self._mutate(
            idempotency_key,
            {
                "op": "budget",
                "month": month,
                "recurring": recurring,
                "expected_revision": expected_revision,
                "expected_source_month": expected_source_month,
                **data,
            },
            operation,
        )

    def delete_budget(self, *, month, recurring, idempotency_key):
        month = _month(month)

        def operation(db):
            db.execute(
                "DELETE FROM finance_budgets WHERE month=? AND recurring=?", (month, int(recurring))
            )
            return self._budget(db, month)

        return self._mutate(
            idempotency_key,
            {"op": "delete_budget", "month": month, "recurring": recurring},
            operation,
        )

    def _validate_transaction(self, db, data, identifier=None):
        kind = data.get("kind")
        if kind not in KINDS or data.get("bucket", "daily") not in BUCKETS:
            raise _error("Invalid transaction kind or bucket")
        data["amount"] = _money(data.get("amount"))
        if Decimal(data["amount"]) <= 0:
            raise _error("Transaction amount must be positive")
        data["occurred_on"] = _date(data.get("occurred_on"))
        data["bucket"] = data.get("bucket", "daily")
        data["category"] = _text(data.get("category", "其他"), "category", 100, False)
        data["note"] = _text(data.get("note", ""), "note")
        for field in ("commitment_key", "conversation_id", "source_id"):
            data[field] = (
                _text(data[field], field, 200, False) if data.get(field) is not None else None
            )
        data["related_transaction_id"] = data.get("related_transaction_id")
        if kind == "refund":
            if not data["related_transaction_id"] or data["related_transaction_id"] == identifier:
                raise _error("A refund must reference its original expense")
            original = self._require(db, data["related_transaction_id"])
            if original["kind"] != "expense" or original["entry_type"] != "detail":
                raise _error("Refunds must reference a detailed expense")
            refunds = db.execute(
                "SELECT amount FROM finance_transactions WHERE related_transaction_id=? AND deleted=0 AND id!=?",
                (original["id"], identifier or ""),
            ).fetchall()
            if sum((Decimal(row[0]) for row in refunds), ZERO) + Decimal(data["amount"]) > Decimal(
                original["amount"]
            ):
                raise _error("Refunds cannot exceed the original expense")
            if data["occurred_on"] < original["occurred_on"]:
                raise _error("Refund date cannot precede the expense")
            data["bucket"] = original["bucket"]
            data["commitment_key"] = original["commitment_key"]
        elif data["related_transaction_id"]:
            raise _error("Only refunds reference an original expense")
        if data["commitment_key"] and kind not in {"expense", "refund"}:
            raise _error("Only an expense or refund can match a spending commitment")
        if data["commitment_key"] and kind == "expense":
            commitment = next(
                (
                    item
                    for item in self._budget(db, data["occurred_on"][:7])["commitments"]
                    if item["key"] == data["commitment_key"]
                ),
                None,
            )
            if commitment and commitment["kind"] != data["bucket"]:
                raise _error("Payment bucket must match its spending commitment")
        data["entry_type"] = data.get("entry_type", "detail")
        data["period_start"] = data.get("period_start")
        if data["entry_type"] not in {"detail", "aggregate"}:
            raise _error("Invalid entry type")
        if data["entry_type"] == "aggregate":
            if kind not in {"expense", "income"} or data["commitment_key"]:
                raise _error("Cumulative totals support income or unlinked expense only")
            start = _date(data["period_start"])
            if start[:7] != data["occurred_on"][:7] or start > data["occurred_on"]:
                raise _error("Cumulative total range must be ordered within one month")
            overlap = db.execute(
                "SELECT 1 FROM finance_transactions WHERE entry_type='aggregate' AND kind=? AND bucket=? AND deleted=0 AND id!=? AND period_start<=? AND occurred_on>=?",
                (kind, data["bucket"], identifier or "", data["occurred_on"], start),
            ).fetchone()
            if overlap:
                raise _error("Cumulative totals cannot overlap; correct the existing total")
        elif data["period_start"] is not None:
            raise _error("Only cumulative totals have a period start")
        if identifier and kind == "expense":
            refunds = db.execute(
                "SELECT amount,occurred_on FROM finance_transactions WHERE related_transaction_id=? AND deleted=0",
                (identifier,),
            ).fetchall()
            if sum((Decimal(row[0]) for row in refunds), ZERO) > Decimal(data["amount"]):
                raise _error("Expense cannot be less than its refunds")
            if any(row[1] < data["occurred_on"] for row in refunds):
                raise _error("Expense date cannot follow its refunds")
        return data

    def create_transaction(self, *, idempotency_key, **fields):
        request = {"op": "create", **fields}

        def operation(db):
            data = self._validate_transaction(db, dict(fields))
            identifier, now = str(uuid4()), _now()
            columns = [
                "kind",
                "amount",
                "occurred_on",
                "bucket",
                "category",
                "note",
                "commitment_key",
                "related_transaction_id",
                "conversation_id",
                "source_id",
                "entry_type",
                "period_start",
            ]
            db.execute(
                f"INSERT INTO finance_transactions(id,{','.join(columns)},created_at,updated_at) VALUES({','.join('?' for _ in range(len(columns) + 3))})",
                (identifier, *(data[column] for column in columns), now, now),
            )
            return self._require(db, identifier)

        return self._mutate(idempotency_key, request, operation)

    def update_transaction(self, identifier, *, idempotency_key, expected_revision=None, **fields):
        allowed = {
            "kind",
            "amount",
            "occurred_on",
            "bucket",
            "category",
            "note",
            "commitment_key",
            "related_transaction_id",
            "entry_type",
            "period_start",
        }
        if fields.keys() - allowed:
            raise _error("Unknown transaction fields")

        def operation(db):
            current = self._require(db, identifier)
            if expected_revision is not None and current["revision"] != expected_revision:
                raise _error(
                    "This record changed; reload before correcting it", "revision_conflict", 409
                )
            if (
                current["kind"] == "expense"
                and (
                    fields.get("kind", "expense") != "expense"
                    or fields.get("entry_type", current["entry_type"]) != "detail"
                )
                and db.execute(
                    "SELECT 1 FROM finance_transactions WHERE related_transaction_id=? AND deleted=0",
                    (identifier,),
                ).fetchone()
            ):
                raise _error("Correct or delete refunds before changing this expense kind")
            data = self._validate_transaction(db, {**current, **fields}, identifier)
            columns = sorted(allowed)
            db.execute(
                f"UPDATE finance_transactions SET {','.join(column + '=?' for column in columns)},revision=revision+1,updated_at=? WHERE id=?",
                (*(data[column] for column in columns), _now(), identifier),
            )
            # Refund allocations follow corrected classifications; money/date stay unchanged.
            if data["kind"] == "expense":
                db.execute(
                    "UPDATE finance_transactions SET bucket=?,commitment_key=?,revision=revision+1,updated_at=? WHERE related_transaction_id=? AND deleted=0",
                    (data["bucket"], data["commitment_key"], _now(), identifier),
                )
            return self._require(db, identifier)

        return self._mutate(
            idempotency_key,
            {"op": "update", "id": identifier, "expected_revision": expected_revision, **fields},
            operation,
        )

    def delete_transaction(self, identifier, *, idempotency_key):
        def operation(db):
            row = db.execute(
                "SELECT * FROM finance_transactions WHERE id=?", (identifier,)
            ).fetchone()
            if row is None:
                raise _error("Finance transaction not found", "not_found", 404)
            if db.execute(
                "SELECT 1 FROM finance_transactions WHERE related_transaction_id=? AND deleted=0",
                (identifier,),
            ).fetchone():
                raise _error("Delete or correct linked refunds before deleting the expense")
            db.execute(
                "UPDATE finance_transactions SET deleted=1,revision=revision+1,updated_at=? WHERE id=? AND deleted=0",
                (_now(), identifier),
            )
            return {"deleted": True, "id": identifier}

        return self._mutate(idempotency_key, {"op": "delete", "id": identifier}, operation)

    def list_transactions(self, *, month=None, limit=50, offset=0):
        month = _month(month)
        if (
            not isinstance(limit, int)
            or not 1 <= limit <= 100
            or not isinstance(offset, int)
            or offset < 0
        ):
            raise _error("Invalid pagination")
        with self.store._connection() as db:
            db.execute("BEGIN")
            total = db.execute(
                "SELECT COUNT(*) FROM finance_transactions WHERE occurred_on LIKE ? AND deleted=0",
                (month + "-%",),
            ).fetchone()[0]
            rows = db.execute(
                "SELECT * FROM finance_transactions WHERE occurred_on LIKE ? AND deleted=0 ORDER BY occurred_on DESC,created_at DESC,id LIMIT ? OFFSET ?",
                (month + "-%", limit, offset),
            ).fetchall()
            return {"items": [self._record(row) for row in rows], "total": total}

    def summary(self, *, month=None, as_of=None):
        month = _month(month)
        today = (
            date.fromisoformat(_date(as_of))
            if as_of
            else datetime.now(ZoneInfo("Asia/Shanghai")).date()
        )
        start = date.fromisoformat(month + "-01")
        last = date(start.year, start.month, calendar.monthrange(start.year, start.month)[1])
        through = min(today, last)
        with self.store._connection() as db:
            db.execute("BEGIN")
            budget = self._budget(db, month)
            rows = [
                self._record(row)
                for row in db.execute(
                    "SELECT * FROM finance_transactions WHERE occurred_on LIKE ? AND deleted=0 ORDER BY occurred_on,id",
                    (month + "-%",),
                )
            ]
            originals = {
                row["id"]: self._record(row)
                for row in db.execute(
                    "SELECT * FROM finance_transactions WHERE kind='expense' AND deleted=0"
                )
            }
        # Full-month totals deliberately include every record, independent of list pagination.
        sums = {
            key: ZERO
            for key in ("income", "expense", "daily", "fixed", "one_time", "refund", "transfer")
        }
        aggregates = [row for row in rows if row["entry_type"] == "aggregate"]
        details = [row for row in rows if row["entry_type"] == "detail"]
        gaps, assumptions = [], []
        allocations = {}
        days = set()
        for row in details:
            amount, kind = Decimal(row["amount"]), row["kind"]
            bucket = (
                originals.get(row["related_transaction_id"], row)["bucket"]
                if kind == "refund"
                else row["bucket"]
            )
            days.add(row["occurred_on"])
            if kind == "transfer":
                sums["transfer"] += amount
                continue
            covered = next(
                (
                    item
                    for item in aggregates
                    if item["kind"] == ("expense" if kind == "refund" else kind)
                    and item["bucket"] == bucket
                    and item["period_start"] <= row["occurred_on"] <= item["occurred_on"]
                ),
                None,
            )
            if covered is None:
                if kind == "income":
                    sums["income"] += amount
                else:
                    signed = -amount if kind == "refund" else amount
                    sums["expense"] += signed
                    sums[bucket] += signed
            if kind == "refund":
                sums["refund"] += amount
            key = (
                originals.get(row["related_transaction_id"], row).get("commitment_key")
                if kind == "refund"
                else row.get("commitment_key")
            )
            original_date = (
                originals.get(row["related_transaction_id"], row)["occurred_on"]
                if kind == "refund"
                else row["occurred_on"]
            )
            if key and kind in {"expense", "refund"} and original_date[:7] == month:
                allocation_key = (key, bucket)
                allocations[allocation_key] = allocations.get(allocation_key, ZERO) + (
                    -amount if kind == "refund" else amount
                )
        for aggregate in aggregates:
            amount = Decimal(aggregate["amount"])
            detail_net = sum(
                (
                    (-Decimal(row["amount"]) if row["kind"] == "refund" else Decimal(row["amount"]))
                    for row in details
                    if (
                        row["kind"] == aggregate["kind"]
                        or (aggregate["kind"] == "expense" and row["kind"] == "refund")
                    )
                    and row["bucket"] == aggregate["bucket"]
                    and aggregate["period_start"] <= row["occurred_on"] <= aggregate["occurred_on"]
                ),
                ZERO,
            )
            if detail_net > amount:
                gaps.append("details_exceed_cumulative_total")
                amount = detail_net
            sums[aggregate["kind"]] += amount
            if aggregate["kind"] == "expense":
                sums[aggregate["bucket"]] += amount
            assumptions.append("cumulative_total_includes_details_in_its_range")
        reserves = {"fixed": ZERO, "one_time": ZERO}
        for item in budget["commitments"]:
            reserves[item["kind"]] += max(
                ZERO, Decimal(item["amount"]) - allocations.get((item["key"], item["kind"]), ZERO)
            )
        reserves["total"] = reserves["fixed"] + reserves["one_time"]
        expected = (
            Decimal(budget["expected_income"]) if budget["expected_income"] is not None else None
        )
        income = max(expected, sums["income"]) if expected is not None else sums["income"]
        if expected is not None and income > sums["income"]:
            assumptions.append("expected_income_includes_received_income")
        target = Decimal(budget["savings_target"]) if budget["savings_target"] is not None else None
        daily_budget = (
            Decimal(budget["daily_budget"]) if budget["daily_budget"] is not None else None
        )
        available = (
            income - target - sums["expense"] - reserves["total"]
            if target is not None and expected is not None
            else None
        )
        daily_remaining = daily_budget - sums["daily"] if daily_budget is not None else None
        if available is not None:
            daily_remaining = (
                min(available, daily_remaining) if daily_remaining is not None else available
            )
        unmatched_fixed = any(
            row["kind"] == "expense"
            and row["bucket"] in {"fixed", "one_time"}
            and not row.get("commitment_key")
            for row in rows
        )
        if unmatched_fixed and reserves["total"] > 0:
            gaps.append("unmatched_spending_may_overlap_reservations")
        cov_start, cov_end = budget["coverage_start"], budget["coverage_through"]
        elapsed = max(0, (through - start).days + 1)
        complete = bool(
            cov_start == start.isoformat()
            and cov_end
            and cov_end >= through.isoformat()
            and elapsed
        )
        if not complete:
            gaps.append("record_coverage_not_confirmed")
        if expected is None:
            gaps.append("expected_income_unknown")
        if target is None:
            gaps.append("savings_target_unset")
        remaining_days = max(0, (last - max(start, through)).days) if through >= start else last.day
        daily_projection = None
        daily_average = None
        basis = None
        if complete and elapsed and today >= start:
            # Only use explicitly confirmed calendar coverage; an unrecorded day is otherwise unknown.
            daily_to_date = sum(
                (
                    Decimal(row["amount"]) * (-1 if row["kind"] == "refund" else 1)
                    for row in details
                    if row["kind"] in {"expense", "refund"}
                    and row["bucket"] == "daily"
                    and row["occurred_on"] <= through.isoformat()
                ),
                ZERO,
            )
            # A cumulative daily total also contributes, without adding covered detail twice.
            for aggregate in aggregates:
                if (
                    aggregate["kind"] == "expense"
                    and aggregate["bucket"] == "daily"
                    and aggregate["occurred_on"] <= through.isoformat()
                ):
                    covered_net = sum(
                        (
                            Decimal(row["amount"]) * (-1 if row["kind"] == "refund" else 1)
                            for row in details
                            if row["kind"] in {"expense", "refund"}
                            and row["bucket"] == "daily"
                            and aggregate["period_start"]
                            <= row["occurred_on"]
                            <= aggregate["occurred_on"]
                        ),
                        ZERO,
                    )
                    daily_to_date += max(Decimal(aggregate["amount"]), covered_net) - covered_net
            daily_average = max(ZERO, daily_to_date) / Decimal(elapsed)
            daily_projection = daily_average * Decimal(remaining_days)
            basis = "confirmed_coverage_run_rate"
        elif daily_budget is not None:
            daily_projection = max(ZERO, daily_budget - sums["daily"])
            basis = "configured_daily_budget"
            assumptions.append("projection_uses_budget_not_observed_spending_rate")
        if remaining_days == 0:
            daily_projection, basis = ZERO, "month_ended"
        expense_projection = (
            sums["expense"] + reserves["total"] + daily_projection
            if daily_projection is not None
            else None
        )
        savings = (
            income - expense_projection
            if expected is not None and expense_projection is not None
            else None
        )
        return {
            "month": month,
            "budget": budget,
            "totals": {
                **{key: _fmt(value) for key, value in sums.items()},
                "net": _fmt(sums["income"] - sums["expense"]),
            },
            "reservations": {key: _fmt(value) for key, value in reserves.items()},
            "remaining": {
                "daily_budget": _fmt(daily_remaining),
                "total_spend_budget": _fmt(available),
                "savings_target_headroom": _fmt(savings - target)
                if savings is not None and target is not None
                else None,
            },
            "projection": {
                "income": _fmt(income) if expected is not None else None,
                "received_income": _fmt(sums["income"]),
                "expected_income_remaining": _fmt(max(ZERO, expected - sums["income"]))
                if expected is not None
                else None,
                "expense": _fmt(expense_projection),
                "savings": _fmt(savings),
                "daily_basis": basis,
                "assumptions": sorted(set(assumptions)),
                "reliable": complete and not gaps,
            },
            "coverage": {
                "recorded_days": len(days),
                "from": cov_start,
                "through": cov_end,
                "complete": complete,
                "gaps": sorted(set(gaps)),
            },
            "daily_average": {
                "amount": _fmt(daily_average),
                "days": elapsed if complete else None,
                "from": cov_start if complete else None,
                "through": through.isoformat() if complete else None,
                "basis": "confirmed_calendar_coverage" if complete else "unknown_coverage",
            },
            "record_count": len(rows),
        }
