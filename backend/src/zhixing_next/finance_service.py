"""Deterministic monthly finance records; balances remain separate observations."""

import calendar
import hashlib
import json
import re
from contextlib import nullcontext
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
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


def _commitment_purposes(item):
    """Conservative duplicate candidates, not a general semantic identity claim."""
    label = item.get("label", "").lower()
    normalized = re.sub(r"[^\w]", "", label)
    purposes = {"label:" + normalized}
    if item.get("purpose"):
        purposes.add("purpose:" + re.sub(r"[^\w]", "", item["purpose"].lower()))
    for purpose, pattern in {
        "housing": r"房租|租金|租住|租房|\brent\b|\brental\b",
        "commute": r"通勤|地铁|\bcommut(?:e|ing)\b|\bsubway\b",
        "telecom": r"话费|手机套餐|移动通信|通讯费|通信费|\bmobile plan\b|\bphone bill\b",
    }.items():
        if re.search(pattern, label):
            purposes.add("purpose:" + purpose)
    # Different insurers/subscription products can coexist. Only normalize their
    # harmless recurrence suffixes, never collapse all insurance/subscriptions.
    clean = re.sub(r"[（(][^）)]*(?:月度|年度|预留|分摊|每月|每年|季度)[^）)]*[）)]", "", label)
    purposes.add("label:" + re.sub(r"[^\w]", "", clean))
    return purposes


def _explicit_existing_asset_move(category, note):
    value = category + " " + note
    patterns = (
        r"(?:公积金|存款|账户余额|已有余额|原有资产|储蓄|自己账户|自有账户).{0,24}(?:提取|提现|提款|取出|转出|转入)",
        r"(?:提取|提现|提款|取出).{0,12}(?:公积金|存款|账户余额|储蓄)",
        r"(?:赎回|取回|收回).{0,8}本金",
        r"(?:provident fund|savings|deposit|existing balance|own account).{0,24}(?:withdrawal|withdraw|transfer)",
        r"(?:withdraw|withdrawal).{0,12}(?:provident fund|savings|deposit|existing balance)",
        r"(?:redeem|redemption).{0,12}principal",
    )
    return any(re.search(pattern, value, re.IGNORECASE) for pattern in patterns)


def migrate(db):
    """Called by Store inside its migration transaction; never commits independently."""
    statements = [
        "CREATE TABLE IF NOT EXISTS finance_budgets(month TEXT NOT NULL,recurring INTEGER NOT NULL,data_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,PRIMARY KEY(month,recurring))",
        "CREATE TABLE IF NOT EXISTS finance_transactions(id TEXT PRIMARY KEY,kind TEXT NOT NULL,amount TEXT NOT NULL,occurred_on TEXT NOT NULL,bucket TEXT NOT NULL,category TEXT NOT NULL,note TEXT NOT NULL,commitment_key TEXT,related_transaction_id TEXT REFERENCES finance_transactions(id),conversation_id TEXT,source_id TEXT,entry_type TEXT NOT NULL DEFAULT 'detail',period_start TEXT,revision INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)",
        "CREATE INDEX IF NOT EXISTS finance_transactions_month ON finance_transactions(occurred_on,deleted)",
        "CREATE TABLE IF NOT EXISTS finance_mutations(key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL)",
    ]
    for statement in statements:
        db.execute(statement)
    columns = {row[1] for row in db.execute("PRAGMA table_info(finance_transactions)")}
    for name, declaration in {
        "date_precision": "TEXT NOT NULL DEFAULT 'day'",
        "date_start": "TEXT",
        "date_end": "TEXT",
        "coverage_start": "TEXT",
        "coverage_end": "TEXT",
    }.items():
        if name not in columns:
            db.execute(f"ALTER TABLE finance_transactions ADD COLUMN {name} {declaration}")
    db.execute(
        "UPDATE finance_transactions SET date_start=occurred_on,date_end=occurred_on WHERE date_start IS NULL AND date_precision='day'"
    )
    # Old mobile editors wrote whole snapshots. Convert overrides to field deltas so
    # changing a future target never freezes unrelated income or rent defaults.
    for row in db.execute("SELECT * FROM finance_budgets WHERE recurring=0").fetchall():
        data = json.loads(row["data_json"])
        if not data.get("__patch__"):
            inherited = FinanceService._budget(db, row["month"], include_override=False)
            data = FinanceService._as_patch(data, inherited)
            db.execute(
                "UPDATE finance_budgets SET data_json=? WHERE month=? AND recurring=0",
                (_json(data), row["month"]),
            )


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
    def _budget(db, month, include_override=True):
        rows = db.execute(
            "SELECT * FROM finance_budgets WHERE (recurring=1 AND month<=?) OR (recurring=0 AND month=?) ORDER BY recurring DESC,month",
            (month, month),
        ).fetchall()
        if not include_override:
            rows = [row for row in rows if row["recurring"]]
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
            "income_schedule": None,
            "revision": 0,
        }
        for row in rows:
            data = json.loads(row["data_json"])
            if not data.get("__patch__"):
                base.update(data)
            else:
                base.update({key: value for key, value in data.items() if not key.startswith("__")})
                commitments = {item["key"]: item for item in base["commitments"]}
                commitments.update(
                    {item["key"]: item for item in data.get("__commitments_upsert", [])}
                )
                for key in data.get("__commitment_keys_remove", []):
                    commitments.pop(key, None)
                base["commitments"] = list(commitments.values())
            if row["month"] != month:
                base["commitments"] = [
                    item for item in base["commitments"] if item["kind"] == "fixed"
                ]
                base["coverage_start"] = base["coverage_through"] = None
            base.update(
                month=month,
                source_month=row["month"],
                recurring=bool(row["recurring"]),
                revision=row["revision"],
                updated_at=row["updated_at"],
            )
        return base

    @staticmethod
    def _as_patch(data, inherited):
        if data.get("__patch__"):
            return data
        result = {"__patch__": True}
        for field, value in data.items():
            if field != "commitments" and value != inherited.get(field):
                result[field] = value
        current = {item["key"]: item for item in data.get("commitments", [])}
        previous = {item["key"]: item for item in inherited.get("commitments", [])}
        result["__commitments_upsert"] = [
            item for key, item in current.items() if item != previous.get(key)
        ]
        result["__commitment_keys_remove"] = sorted(previous.keys() - current.keys())
        return result

    @staticmethod
    def _commitments(items):
        from .finance_schema import Commitment

        if not isinstance(items, list) or len(items) > 100:
            raise _error("Invalid commitments")
        normalized = []
        for raw in items:
            try:
                item = Commitment.model_validate(raw).model_dump(exclude_none=True)
            except ValueError as exc:
                raise _error(f"Invalid commitment: {exc}") from None
            item.update(
                key=_text(item["key"], "commitment key", 100, False),
                label=_text(item["label"], "commitment label", 100, False),
                amount=_money(item["amount"]),
            )
            for field in ("anchor_month", "paid_through"):
                if item.get(field):
                    item[field] = _month(item[field])
            if item.get("every_months", 1) > 1 and not item.get("anchor_month"):
                raise _error("A multi-month payment needs anchor_month, its first known due month")
            if item.get("monthly_cost") is not None:
                item["monthly_cost"] = _money(item["monthly_cost"])
                derived = (Decimal(item["amount"]) / item.get("every_months", 1)).quantize(
                    Decimal("0.01"), rounding=ROUND_HALF_UP
                )
                if Decimal(item["monthly_cost"]) != derived:
                    raise _error(
                        "monthly_cost must equal the actual payment amount divided by every_months, rounded to cents. Do not substitute monthly cost for the actual quarterly payment."
                    )
            if item.get("purpose") is not None:
                item["purpose"] = _text(item["purpose"], "commitment purpose", 100, False)
            item["separate_from_keys"] = [
                _text(key, "separate commitment key", 100, False)
                for key in item.get("separate_from_keys", [])
            ]
            normalized.append(item)
        if len({item["key"] for item in normalized}) != len(normalized):
            raise _error("Commitment keys must be unique")
        return normalized

    @staticmethod
    def _income_schedule(value):
        from .finance_schema import IncomeSchedule

        if value is None:
            return None
        try:
            result = IncomeSchedule.model_validate(value).model_dump()
        except ValueError as exc:
            raise _error(f"Invalid income schedule: {exc}") from None
        if not result["weekdays"] or any(not 0 <= day <= 6 for day in result["weekdays"]):
            raise _error("weekdays must contain weekday numbers from Monday=0 to Sunday=6")
        for key in ("working_dates", "non_working_dates"):
            result[key] = [_date(day) for day in result[key]]
        if set(result["working_dates"]) & set(result["non_working_dates"]):
            raise _error("A date cannot be both working and non-working")
        result["calendar_basis"] = (
            "user_overrides"
            if result["working_dates"] or result["non_working_dates"]
            else "weekdays_only"
        )
        if result["rule"] == "day_of_month" and result["day"] is None:
            raise _error("day_of_month requires day")
        return result

    def patch_budget(
        self,
        *,
        month,
        idempotency_key,
        changes,
        recurring=True,
        expected_revision=None,
        expected_source_month=None,
    ):
        from .finance_schema import BudgetChanges

        month = _month(month)
        if not isinstance(recurring, bool):
            raise _error("Recurring must be true or false")
        try:
            changes = BudgetChanges.model_validate(changes).model_dump(exclude_unset=True)
        except ValueError as exc:
            raise _error(f"Invalid budget changes: {exc}") from None
        clear = set(changes.pop("clear_fields", []))
        if any(value is None for value in changes.values()):
            raise _error(
                "Null does not clear a budget. Omit unchanged fields, or name them in clear_fields"
            )
        if clear & changes.keys():
            raise _error("A field cannot be both changed and cleared")
        if "commitments" in changes:
            if "commitments_upsert" in changes:
                raise _error("Use commitments_upsert only; do not send both commitment lists")
            # Legacy tools sent a list as a replacement. Treat it as keyed upserts so omission never deletes.
            changes["commitments_upsert"] = changes.pop("commitments")
        upserts = self._commitments(changes.pop("commitments_upsert", []))
        removed = [
            _text(key, "commitment key", 100, False)
            for key in changes.pop("commitment_keys_remove", [])
        ]
        if set(removed) & {item["key"] for item in upserts}:
            raise _error("A commitment cannot be both changed and removed")
        for field in ("expected_income", "savings_target", "daily_budget"):
            if field in changes:
                changes[field] = _money(changes[field])
        if "income_schedule" in changes:
            changes["income_schedule"] = self._income_schedule(changes["income_schedule"])
        for field in ("coverage_start", "coverage_through"):
            if field in changes:
                changes[field] = _date(changes[field])
        changes.update({field: None for field in clear})
        request = {
            "op": "patch_budget",
            "month": month,
            "recurring": recurring,
            "changes": changes,
            "upserts": upserts,
            "removed": removed,
            "expected_revision": expected_revision,
            "expected_source_month": expected_source_month,
        }

        def operation(db):
            current = self._budget(db, month)
            candidates = {
                item["key"]: item for item in current["commitments"] if item["key"] not in removed
            }
            candidates.update({item["key"]: item for item in upserts})
            changed_keys = {item["key"] for item in upserts}
            items = list(candidates.values())
            for index, item in enumerate(items):
                for other in items[index + 1 :]:
                    if not changed_keys & {item["key"], other["key"]}:
                        continue
                    if (
                        item["kind"] != other["kind"]
                        or other["key"] in item.get("separate_from_keys", [])
                        or item["key"] in other.get("separate_from_keys", [])
                    ):
                        continue
                    if _commitment_purposes(item) & _commitment_purposes(other):
                        conflict = [
                            {
                                "key": value["key"],
                                "label": value["label"],
                                "amount": value["amount"],
                            }
                            for value in (item, other)
                        ]
                        raise _error(
                            "A same-purpose commitment already exists: "
                            + _json(conflict)
                            + ". Reuse its key or explicitly remove the replaced key in this same patch. For clearly independent costs only, name separate_from_keys. Nothing was saved.",
                            "duplicate_commitment",
                            409,
                        )
            if expected_revision is not None:
                current = self._budget(db, month)
                if (
                    current["revision"] != expected_revision
                    or current["source_month"] != expected_source_month
                ):
                    raise _error(
                        "This budget changed; reload before saving", "revision_conflict", 409
                    )
            previous = db.execute(
                "SELECT data_json FROM finance_budgets WHERE month=? AND recurring=?",
                (month, int(recurring)),
            ).fetchone()
            data = json.loads(previous[0]) if previous else {"__patch__": True}
            data.update(changes)
            if data.get("__patch__"):
                saved = {item["key"]: item for item in data.get("__commitments_upsert", [])}
                saved.update({item["key"]: item for item in upserts})
                removes = (set(data.get("__commitment_keys_remove", [])) | set(removed)) - {
                    item["key"] for item in upserts
                }
                for key in removed:
                    saved.pop(key, None)
                data["__commitments_upsert"] = list(saved.values())
                data["__commitment_keys_remove"] = sorted(removes)
            else:
                saved = {item["key"]: item for item in data.get("commitments", [])}
                saved.update({item["key"]: item for item in upserts})
                for key in removed:
                    saved.pop(key, None)
                data["commitments"] = list(saved.values())
            if recurring:
                override = db.execute(
                    "SELECT data_json FROM finance_budgets WHERE month=? AND recurring=0", (month,)
                ).fetchone()
                if override:
                    delta = self._as_patch(
                        json.loads(override[0]), self._budget(db, month, include_override=False)
                    )
                    for field in changes:
                        delta.pop(field, None)
                    changed_keys = {item["key"] for item in upserts} | set(removed)
                    delta["__commitments_upsert"] = [
                        item
                        for item in delta.get("__commitments_upsert", [])
                        if item["key"] not in changed_keys
                    ]
                    delta["__commitment_keys_remove"] = [
                        key
                        for key in delta.get("__commitment_keys_remove", [])
                        if key not in changed_keys
                    ]
                    db.execute(
                        "UPDATE finance_budgets SET data_json=?,revision=revision+1,updated_at=? WHERE month=? AND recurring=0",
                        (_json(delta), _now(), month),
                    )
            db.execute(
                "INSERT INTO finance_budgets VALUES(?,?,?,1,?) ON CONFLICT(month,recurring) DO UPDATE SET data_json=excluded.data_json,revision=finance_budgets.revision+1,updated_at=excluded.updated_at",
                (month, int(recurring), _json(data), _now()),
            )
            result = self._budget(db, month)
            a, b = result["coverage_start"], result["coverage_through"]
            if (a is None) != (b is None) or (
                a is not None and (a[:7] != month or b[:7] != month or a > b)
            ):
                raise _error(
                    "Coverage dates must be ordered within the selected month, or both cleared"
                )
            actual_commitments = {item["key"]: item for item in result["commitments"]}
            if any(actual_commitments.get(item["key"]) != item for item in upserts) or any(
                key in actual_commitments for key in removed
            ):
                raise _error(
                    "Commitment write verification failed; nothing was saved",
                    "write_verification_failed",
                    409,
                )
            for field, value in changes.items():
                if result[field] != value:
                    raise _error(
                        "Budget write was hidden by a month override; update that month explicitly",
                        "write_verification_failed",
                        409,
                    )
            verified = self.summary(month=month, _db=db)
            result["verification"] = {
                "saved_fields": sorted(changes),
                "effective_commitments": result["commitments"],
                "monthly_cost": verified["commitments"]["monthly_cost"],
                "cash_due": verified["commitments"]["cash_due"],
                "remaining_due": verified["reservations"]["total"],
                "items": verified["commitments"]["items"],
                "checked_against_saved_records": True,
            }
            return result

        return self._mutate(idempotency_key, request, operation)

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
        income_schedule=None,
        _db=None,
    ):
        month = _month(month)
        if not isinstance(recurring, bool):
            raise _error("Recurring must be true or false")
        normalized = self._commitments(commitments or [])
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
            "income_schedule": self._income_schedule(income_schedule),
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
            stored = (
                data
                if recurring
                else self._as_patch(data, self._budget(db, month, include_override=False))
            )
            db.execute(
                "INSERT INTO finance_budgets VALUES(?,?,?,1,?) ON CONFLICT(month,recurring) DO UPDATE SET data_json=excluded.data_json,revision=finance_budgets.revision+1,updated_at=excluded.updated_at",
                (month, int(recurring), _json(stored), _now()),
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
        precision = data.get("date_precision", "day")
        if precision not in {"day", "month", "range"}:
            raise _error("date_precision must be day, month or range")
        if (
            data.get("occurred_on")
            and data.get("date_end")
            and data["occurred_on"] != data["date_end"]
        ):
            raise _error(
                "occurred_on conflicts with date_end; provide one consistent date or range"
            )
        end = data.get("date_end") or data.get("occurred_on")
        begin = data.get("date_start")
        if precision == "month":
            value = begin or end
            if not isinstance(value, str) or len(value) not in {7, 10}:
                raise _error("A month-precision record needs an explicit YYYY-MM month")
            if len(value) == 10:
                _date(value)
            month = _month(value[:7])
            if any(other and other[:7] != month for other in (begin, end)):
                raise _error(
                    "Month precision means one explicitly known actual month. Keep the user's original period with date_precision=range and full YYYY-MM-DD endpoints; never invent individual payment months from a payment count or schedule."
                )
            begin = month + "-01"
            year, number = map(int, month.split("-"))
            end = f"{month}-{calendar.monthrange(year, number)[1]:02d}"
        elif precision == "day":
            end = _date(end)
            begin = begin or end
            if begin != end:
                raise _error("An exact day cannot contain a date range")
        else:
            begin, end = _date(begin), _date(end)
            if begin > end:
                raise _error("date_start must precede date_end")
        data.update(
            date_precision=precision, date_start=_date(begin), date_end=_date(end), occurred_on=end
        )
        if (data.get("coverage_start") is None) != (data.get("coverage_end") is None):
            raise _error("Payment coverage requires both start and end months")
        for field in ("coverage_start", "coverage_end"):
            data[field] = _month(data[field]) if data.get(field) is not None else None
        if data["coverage_start"] and (
            kind != "expense" or data["coverage_start"] > data["coverage_end"]
        ):
            raise _error("Payment coverage must be an ordered expense coverage range")
        data["bucket"] = data.get("bucket", "daily")
        data["category"] = _text(data.get("category", "其他"), "category", 100, False)
        data["note"] = _text(data.get("note", ""), "note")
        if kind == "income" and _explicit_existing_asset_move(data["category"], data["note"]):
            raise _error(
                "未保存：该描述明确涉及已有资产提取或转移，应使用kind=transfer，不能记为新增income。请保留提取的transfer记录，先查询get_finance_summary或reconcile_finance_assets核对后继续。不要靠修改分类或删除备注反复尝试新增缴存，也不要索要用户未提及的缴存确认。真正的新工资、新缴存或收益应按真实原话分别记录，收益与取回本金分开。",
                "existing_asset_is_transfer",
                422,
            )
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
            if data["date_end"] < original["date_start"]:
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
                "SELECT amount,date_end FROM finance_transactions WHERE related_transaction_id=? AND deleted=0",
                (identifier,),
            ).fetchall()
            if sum((Decimal(row[0]) for row in refunds), ZERO) > Decimal(data["amount"]):
                raise _error("Expense cannot be less than its refunds")
            if any(row[1] < data["date_start"] for row in refunds):
                raise _error("Expense date cannot follow its refunds")
        return data

    def create_transaction(self, *, idempotency_key, _db=None, **fields):
        allowed = {
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
            "date_precision",
            "date_start",
            "date_end",
            "coverage_start",
            "coverage_end",
        }
        if fields.keys() - allowed:
            raise _error(
                "Unknown transaction fields: " + ", ".join(sorted(fields.keys() - allowed))
            )
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
                "date_precision",
                "date_start",
                "date_end",
                "coverage_start",
                "coverage_end",
            ]
            db.execute(
                f"INSERT INTO finance_transactions(id,{','.join(columns)},created_at,updated_at) VALUES({','.join('?' for _ in range(len(columns) + 3))})",
                (identifier, *(data[column] for column in columns), now, now),
            )
            saved = self._require(db, identifier)
            if any(saved[column] != data[column] for column in columns):
                raise _error(
                    "Transaction write verification failed", "write_verification_failed", 409
                )
            return saved

        return (
            operation(_db) if _db is not None else self._mutate(idempotency_key, request, operation)
        )

    def update_transaction(
        self, identifier, *, idempotency_key, expected_revision=None, _db=None, **fields
    ):
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
            "date_precision",
            "date_start",
            "date_end",
            "coverage_start",
            "coverage_end",
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
            merged = {**current, **fields}
            if "occurred_on" in fields and not (
                {"date_start", "date_end", "date_precision"} & fields.keys()
            ):
                merged.update(date_start=None, date_end=None, date_precision="day")
            elif "date_start" in fields or "date_end" in fields or "date_precision" in fields:
                precision = merged.get("date_precision", "day")
                if precision == "day" and fields.get("occurred_on"):
                    merged.update(
                        date_start=fields.get("date_start"), date_end=fields.get("date_end")
                    )
                elif (
                    precision == "month"
                    and ("date_start" in fields or "occurred_on" in fields)
                    and "date_end" not in fields
                ):
                    merged["date_end"] = None
                merged["occurred_on"] = fields.get("occurred_on") or merged.get("date_end")
            data = self._validate_transaction(db, merged, identifier)
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
            saved = self._require(db, identifier)
            if any(saved[column] != data[column] for column in columns):
                raise _error(
                    "Transaction write verification failed", "write_verification_failed", 409
                )
            return saved

        if _db is not None:
            return operation(_db)
        return self._mutate(
            idempotency_key,
            {"op": "update", "id": identifier, "expected_revision": expected_revision, **fields},
            operation,
        )

    def delete_transaction(self, identifier, *, idempotency_key, _db=None):
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

        if _db is not None:
            return operation(_db)
        return self._mutate(idempotency_key, {"op": "delete", "id": identifier}, operation)

    def apply_transaction_batch(
        self,
        *,
        idempotency_key,
        operations,
        conserve_total=True,
        reason="",
        conversation_id=None,
        source_id=None,
    ):
        """One receipt/transaction; replacing/splitting records conserves each money flow by default."""
        from .finance_schema import BatchOperation

        try:
            operations = [
                BatchOperation.model_validate(item).model_dump(exclude_unset=True)
                for item in operations
            ]
        except ValueError as exc:
            raise _error(f"Invalid batch: {exc}") from None
        if not operations or len(operations) > 100:
            raise _error("A batch needs 1 to 100 operations")
        if not conserve_total and not _text(reason, "reason", 1000, False):
            raise _error("Changing a batch total requires an explicit reason")
        identifiers = [
            item.get("transaction_id") for item in operations if item["operation"] != "create"
        ]
        if any(not item for item in identifiers) or len(identifiers) != len(set(identifiers)):
            raise _error("Each existing transaction must be identified once per batch")
        request = {
            "op": "batch",
            "operations": operations,
            "conserve_total": conserve_total,
            "reason": reason,
            "conversation_id": conversation_id,
            "source_id": source_id,
        }

        def totals(records):
            result = {key: ZERO for key in ("expense", "income", "transfer")}
            for row in records:
                kind = row["kind"]
                result["expense" if kind == "refund" else kind] += Decimal(row["amount"]) * (
                    -1 if kind == "refund" else 1
                )
            return result

        def operation(db):
            before = [self._require(db, identifier) for identifier in identifiers]
            receipts, after = [], []
            for item in operations:
                op = item["operation"]
                fields = item.get("fields") or {}
                if op == "create":
                    if item.get("transaction_id") or item.get("expected_revision"):
                        raise _error("Create operations cannot reference an existing transaction")
                    receipt = self.create_transaction(
                        idempotency_key="batch",
                        _db=db,
                        **fields,
                        conversation_id=conversation_id,
                        source_id=source_id,
                    )
                elif op == "update":
                    if not fields:
                        raise _error("An update needs changed fields")
                    receipt = self.update_transaction(
                        item["transaction_id"],
                        idempotency_key="batch",
                        _db=db,
                        expected_revision=item.get("expected_revision"),
                        **fields,
                    )
                else:
                    if fields:
                        raise _error("A delete cannot contain changed fields")
                    current = self._require(db, item["transaction_id"])
                    if (
                        item.get("expected_revision") is not None
                        and current["revision"] != item["expected_revision"]
                    ):
                        raise _error(
                            "This record changed; reload before deleting", "revision_conflict", 409
                        )
                    receipt = self.delete_transaction(
                        item["transaction_id"], idempotency_key="batch", _db=db
                    )
                receipts.append({"operation": op, "record": receipt})
                if op != "delete":
                    after.append(receipt)
            previous, final = totals(before), totals(after)
            if identifiers and conserve_total and previous != final:
                raise _error(
                    "Split/replacement totals differ from their originals; nothing was saved",
                    "batch_total_mismatch",
                    409,
                )
            return {
                "items": receipts,
                "before": {key: _fmt(value) for key, value in previous.items()},
                "after": {key: _fmt(value) for key, value in final.items()},
                "conserved": previous == final,
                "verified": True,
            }

        return self._mutate(idempotency_key, request, operation)

    def reconcile_assets(
        self, *, start_date, end_date, opening_assets, closing_assets, approximate=True, _db=None
    ):
        from .finance_reconcile import reconcile_assets

        return reconcile_assets(
            self,
            start_date=start_date,
            end_date=end_date,
            opening_assets=opening_assets,
            closing_assets=closing_assets,
            approximate=approximate,
            _db=_db,
        )

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
            start = month + "-01"
            year, number = map(int, month.split("-"))
            end = f"{month}-{calendar.monthrange(year, number)[1]:02d}"
            total = db.execute(
                "SELECT COUNT(*) FROM finance_transactions WHERE date_start<=? AND date_end>=? AND deleted=0",
                (end, start),
            ).fetchone()[0]
            rows = db.execute(
                "SELECT * FROM finance_transactions WHERE date_start<=? AND date_end>=? AND deleted=0 ORDER BY occurred_on DESC,created_at DESC,id LIMIT ? OFFSET ?",
                (end, start, limit, offset),
            ).fetchall()
            return {"items": [self._record(row) for row in rows], "total": total}

    def summary(self, *, month=None, as_of=None, _db=None):
        month = _month(month)
        today = (
            date.fromisoformat(_date(as_of))
            if as_of
            else datetime.now(ZoneInfo("Asia/Shanghai")).date()
        )
        start = date.fromisoformat(month + "-01")
        last = date(start.year, start.month, calendar.monthrange(start.year, start.month)[1])
        through = min(today, last)
        with nullcontext(_db) if _db is not None else self.store._connection() as db:
            if not db.in_transaction:
                db.execute("BEGIN")
            budget = self._budget(db, month)
            rows = [
                self._record(row)
                for row in db.execute(
                    "SELECT * FROM finance_transactions WHERE date_start>=? AND date_end<=? AND deleted=0 ORDER BY occurred_on,id",
                    (start.isoformat(), last.isoformat()),
                )
            ]
            unallocated = [
                self._record(row)
                for row in db.execute(
                    "SELECT * FROM finance_transactions WHERE date_start<=? AND date_end>=? AND (substr(date_start,1,7)!=substr(date_end,1,7)) AND deleted=0 ORDER BY date_start,id",
                    (last.isoformat(), start.isoformat()),
                )
            ]
            payments = [
                self._record(row)
                for row in db.execute(
                    "SELECT * FROM finance_transactions WHERE commitment_key IS NOT NULL AND deleted=0 AND kind IN ('expense','refund')"
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
            if row["date_precision"] == "day":
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
                    and item["period_start"]
                    <= row["date_start"]
                    <= row["date_end"]
                    <= item["occurred_on"]
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
                    and aggregate["period_start"]
                    <= row["date_start"]
                    <= row["date_end"]
                    <= aggregate["occurred_on"]
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
        if any(
            row["date_precision"] != "day"
            and row["kind"]
            in {
                aggregate["kind"],
                "refund" if aggregate["kind"] == "expense" else aggregate["kind"],
            }
            and row["bucket"] == aggregate["bucket"]
            and row["date_start"] <= aggregate["occurred_on"]
            and row["date_end"] >= aggregate["period_start"]
            and not (
                aggregate["period_start"]
                <= row["date_start"]
                <= row["date_end"]
                <= aggregate["occurred_on"]
            )
            for row in details
            for aggregate in aggregates
        ):
            gaps.append("uncertain_record_overlaps_cumulative_total")
            assumptions.append("totals_include_potential_overlap_not_exact")
        reserves = {"fixed": ZERO, "one_time": ZERO}
        commitment_items, monthly_cost = [], ZERO
        month_number = start.year * 12 + start.month - 1
        for item in budget["commitments"]:
            every = item.get("every_months", 1)
            anchor = item.get("anchor_month", month)
            year, number = map(int, anchor.split("-"))
            anchor_number = year * 12 + number - 1
            due_this_month = (
                month_number >= anchor_number and (month_number - anchor_number) % every == 0
            )
            payment = Decimal(item["amount"])
            cost = (
                Decimal(item["monthly_cost"])
                if item.get("monthly_cost") is not None
                else (payment / every).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            )
            monthly_cost += cost
            cash_due = payment if due_this_month else ZERO
            paid_through = item.get("paid_through")
            allocated = ZERO
            payment_coverage = None
            for row in payments:
                original = (
                    originals.get(row.get("related_transaction_id"), row)
                    if row["kind"] == "refund"
                    else row
                )
                if original.get("commitment_key") != item["key"]:
                    continue
                cov_start, cov_end = original.get("coverage_start"), original.get("coverage_end")
                matches = (
                    cov_start <= month <= cov_end
                    if cov_start and cov_end
                    else original["date_start"][:7] == original["date_end"][:7] == month
                )
                if matches:
                    allocated += Decimal(row["amount"]) * (-1 if row["kind"] == "refund" else 1)
                if matches and cov_end and (not payment_coverage or cov_end > payment_coverage):
                    payment_coverage = cov_end
            if (
                payment_coverage
                and allocated >= payment
                and (not paid_through or payment_coverage > paid_through)
            ):
                paid_through = payment_coverage
            remaining_due = (
                ZERO if paid_through and month <= paid_through else max(ZERO, cash_due - allocated)
            )
            reserves[item["kind"]] += remaining_due
            next_number = max(month_number, anchor_number)
            if paid_through:
                paid_year, paid_month = map(int, paid_through.split("-"))
                next_number = max(next_number, paid_year * 12 + paid_month)
            elif cash_due and remaining_due == ZERO:
                next_number += 1
            next_number += (anchor_number - next_number) % every
            due_year, due_month = divmod(next_number, 12)
            due_month += 1
            next_due_month = f"{due_year:04d}-{due_month:02d}"
            next_due = None
            if item.get("due_day") is not None:
                due_day = min(item["due_day"], calendar.monthrange(due_year, due_month)[1])
                next_due = date(due_year, due_month, due_day).isoformat()
            commitment_items.append(
                {
                    "key": item["key"],
                    "label": item["label"],
                    "monthly_cost": _fmt(cost),
                    "cash_due": _fmt(cash_due),
                    "remaining_due": _fmt(remaining_due),
                    "next_due_on": next_due,
                    "next_due_month": next_due_month,
                    "next_due_precision": "day" if next_due is not None else "month",
                    "paid_through": paid_through,
                }
            )
        reserves["total"] = reserves["fixed"] + reserves["one_time"]
        if unallocated:
            gaps.append("cross_month_dates_unallocated")
        if any(row["date_precision"] != "day" and row["entry_type"] != "aggregate" for row in rows):
            gaps.append("transaction_day_unknown")
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
        if (
            complete
            and elapsed
            and today >= start
            and not any(
                gap in gaps for gap in ("transaction_day_unknown", "cross_month_dates_unallocated")
            )
        ):
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
                            <= row["date_start"]
                            <= row["date_end"]
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
        income_schedule = budget.get("income_schedule")
        expected_income_on = None
        if income_schedule:
            if income_schedule["rule"] == "last_business_day":
                from .common_tools import last_business_day

                try:
                    expected_income_on = last_business_day(
                        month,
                        weekdays=income_schedule["weekdays"],
                        working_dates=income_schedule["working_dates"],
                        non_working_dates=income_schedule["non_working_dates"],
                    )["date"]
                except ValueError:
                    gaps.append("income_schedule_has_no_working_date")
            else:
                expected_income_on = date(
                    start.year, start.month, min(income_schedule["day"], last.day)
                ).isoformat()
        return {
            "month": month,
            "budget": budget,
            "expected_income_on": expected_income_on,
            "totals": {
                **{key: _fmt(value) for key, value in sums.items()},
                "net": _fmt(sums["income"] - sums["expense"]),
            },
            "reservations": {key: _fmt(value) for key, value in reserves.items()},
            "commitments": {
                "monthly_cost": _fmt(monthly_cost),
                "cash_due": _fmt(
                    sum((Decimal(item["cash_due"]) for item in commitment_items), ZERO)
                ),
                "items": commitment_items,
            },
            "income_schedule": budget.get("income_schedule"),
            "unallocated": {
                "items": unallocated,
                "count": len(unallocated),
                "reason": "Exact month unknown; excluded from monthly totals, never assigned to the range end month",
            },
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
