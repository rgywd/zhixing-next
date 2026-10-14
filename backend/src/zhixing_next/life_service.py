"""One actual meal and its explicit payment share a short atomic SQLite transaction."""

import json
from contextlib import contextmanager
from datetime import UTC, datetime

from .finance_service import FinanceService
from .health_service import HealthService, source_key


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _error(message, code="invalid_life_record", status=422):
    from .store import StoreError

    return StoreError(code, message, status)


def migrate(db):
    """Part of Store's v12 migration; does not start or commit a transaction."""
    db.execute(
        "CREATE TABLE IF NOT EXISTS life_events(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,entry_key TEXT NOT NULL,conversation_id TEXT NOT NULL,finance_id TEXT,meal_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(source_id,entry_key))"
    )
    db.execute(
        "CREATE TABLE IF NOT EXISTS life_receipts(operation_key TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES life_events(id),request_json TEXT NOT NULL,result_json TEXT NOT NULL)"
    )


class _TransactionStore:
    """Existing domain services use the caller's transaction, without nested commits."""

    def __init__(self, store, db):
        self.settings, self.db_path = store.settings, store.db_path
        self.db = db

    @contextmanager
    def _connection(self, write=False):
        yield self.db


class LifeService:
    def __init__(self, store):
        self.store = store

    @staticmethod
    def _operation(source_id, entry_key, operation):
        return "life:" + operation + ":" + source_key(source_id, entry_key)

    @staticmethod
    def _replay(db, operation_key, request):
        row = db.execute(
            "SELECT * FROM life_receipts WHERE operation_key=?", (operation_key,)
        ).fetchone()
        if row:
            if row["request_json"] != request:
                raise _error(
                    "This request ID identifies different meal/payment data",
                    "idempotency_conflict",
                    409,
                )
            return json.loads(row["result_json"])
        return None

    @staticmethod
    def _receipt(db, operation_key, event_id, request, result):
        db.execute(
            "INSERT INTO life_receipts VALUES(?,?,?,?)",
            (operation_key, event_id, request, _json(result)),
        )
        return result

    @staticmethod
    def _meal_payload(meal):
        if not isinstance(meal, dict) or meal.keys() - {
            "occurred_at",
            "meal_type",
            "description",
            "portion",
            "status",
            "recommendation_id",
            "note",
            "estimated_energy",
        }:
            raise _error("Specify only actual meal fields")
        return dict(meal)

    def record_meal(
        self, *, source_id, entry_key, conversation_id, meal, amount=None, occurred_on=None, note=""
    ):
        operation_key = self._operation(source_id, entry_key, "record")
        event_id = "life:" + source_key(source_id, entry_key)
        request = _json({"meal": meal, "amount": amount, "occurred_on": occurred_on, "note": note})
        meal_payload = self._meal_payload(meal)
        if amount is not None and occurred_on is None:
            raise _error("An explicit payment needs its business date")
        with self.store._connection(write=True) as db:
            replay = self._replay(db, operation_key, request)
            if replay is not None:
                return replay
            if db.execute("SELECT 1 FROM life_events WHERE id=?", (event_id,)).fetchone():
                raise _error(
                    "This meal event already exists; correct it in place",
                    "idempotency_conflict",
                    409,
                )
            bound = _TransactionStore(self.store, db)
            # Both domain mutation receipts also roll back when either write fails.
            finance = None
            if amount is not None:
                finance = FinanceService(bound).create_transaction(
                    idempotency_key=operation_key + ":finance",
                    kind="expense",
                    amount=amount,
                    occurred_on=occurred_on,
                    bucket="daily",
                    category="餐饮",
                    note=note,
                    conversation_id=conversation_id,
                    source_id=source_id,
                )
            actual = HealthService(bound).create(
                "meals",
                {
                    **meal_payload,
                    "id": "life-meal:" + source_key(source_id, entry_key),
                    "source_id": source_id,
                    "conversation_id": conversation_id,
                },
                operation_key=operation_key + ":meal",
            )
            now = datetime.now(UTC).isoformat(timespec="microseconds")
            db.execute(
                "INSERT INTO life_events VALUES(?,?,?,?,?,?,?)",
                (
                    event_id,
                    source_id,
                    entry_key,
                    conversation_id,
                    finance["id"] if finance else None,
                    actual["id"],
                    now,
                ),
            )
            result = {
                "event_id": event_id,
                "saved": True,
                "atomic": True,
                "finance": finance,
                "meal": actual,
                "payment_recorded": finance is not None,
            }
            return self._receipt(db, operation_key, event_id, request, result)

    def correct_meal(
        self, event_id, *, source_id, entry_key, meal_changes=None, finance_changes=None
    ):
        operation_key = self._operation(source_id, entry_key, "correct")
        meal_changes = self._meal_payload(meal_changes or {})
        finance_changes = dict(finance_changes or {})
        if finance_changes.keys() - {"amount", "occurred_on", "note", "category"}:
            raise _error(
                "Linked meal payments support amount, business date, category and note corrections"
            )
        request = _json(
            {"event_id": event_id, "meal_changes": meal_changes, "finance_changes": finance_changes}
        )
        if not meal_changes and not finance_changes:
            raise _error("Provide a meal or payment correction")
        with self.store._connection(write=True) as db:
            replay = self._replay(db, operation_key, request)
            if replay is not None:
                return replay
            event = db.execute("SELECT * FROM life_events WHERE id=?", (event_id,)).fetchone()
            if event is None:
                raise _error("Linked meal event not found", "not_found", 404)
            bound = _TransactionStore(self.store, db)
            health = HealthService(bound)
            actual = health._require(db, "meals", event["meal_id"])
            finance = (
                FinanceService(bound)._require(db, event["finance_id"])
                if event["finance_id"]
                else None
            )
            if finance_changes and finance is None:
                raise _error(
                    "This event has no payment; record an explicitly supplied payment separately"
                )
            if meal_changes:
                payload = {
                    key: value
                    for key, value in actual.items()
                    if key not in {"created_at", "updated_at"}
                }
                payload.update(meal_changes)
                actual = health.update(
                    "meals", event["meal_id"], payload, operation_key=operation_key + ":meal"
                )
            if finance_changes:
                finance = FinanceService(bound).update_transaction(
                    event["finance_id"],
                    idempotency_key=operation_key + ":finance",
                    expected_revision=finance["revision"],
                    **finance_changes,
                )
            result = {
                "event_id": event_id,
                "saved": True,
                "atomic": True,
                "finance": finance,
                "meal": actual,
                "payment_recorded": finance is not None,
            }
            return self._receipt(db, operation_key, event_id, request, result)

    def list_events(self, source_id=None, limit=30):
        if not isinstance(limit, int) or not 1 <= limit <= 100:
            raise _error("Invalid limit")
        with self.store._connection() as db:
            rows = db.execute(
                "SELECT * FROM life_events WHERE (? IS NULL OR source_id=?) ORDER BY created_at DESC,id LIMIT ?",
                (source_id, source_id, limit),
            ).fetchall()
            result = []
            for row in rows:
                # Deleted domain records remain visibly linked; querying must not undo them.
                meal = db.execute(
                    "SELECT deleted FROM health_meals WHERE id=?", (row["meal_id"],)
                ).fetchone()
                finance = (
                    db.execute(
                        "SELECT deleted FROM finance_transactions WHERE id=?", (row["finance_id"],)
                    ).fetchone()
                    if row["finance_id"]
                    else None
                )
                result.append(
                    {
                        **dict(row),
                        "meal_deleted": bool(meal[0]) if meal else True,
                        "finance_deleted": bool(finance[0]) if finance else None,
                    }
                )
            return {"items": result}
