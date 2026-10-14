"""Health records and current agreements, shared by HTTP and agent tools.

No model calls take place in these transactions. Missing records remain unknown;
recommendations are separate from food actually eaten.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Literal
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

if TYPE_CHECKING:
    from .store import Store


def _error(message: str, code: str = "invalid_health_record", status: int = 422):
    from .store import StoreError

    return StoreError(code, message, status)


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="microseconds")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _day(value: str) -> str:
    try:
        return date.fromisoformat(value).isoformat()
    except (TypeError, ValueError) as exc:
        raise _error("Use a calendar date in YYYY-MM-DD format") from exc


def _instant(value: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError
        # Keep the stated local date; timestamps also retain their offset.
        return parsed.isoformat(timespec="seconds")
    except (TypeError, ValueError) as exc:
        raise _error("A date and time with its UTC offset is required") from exc


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, allow_inf_nan=False)


class EntryInput(Input):
    id: str | None = Field(default=None, min_length=1, max_length=180, pattern=r"^[\w:-]+$")
    revision: int | None = Field(default=None, ge=1)
    source_id: str | None = Field(default=None, max_length=200)
    conversation_id: str | None = Field(default=None, max_length=200)


class ProfileInput(Input):
    revision: int | None = Field(default=None, ge=0)
    height_cm: float | None = Field(default=None, gt=0, le=300)
    activity_limitations: list[str] = Field(default_factory=list, max_length=30)
    food_allergies: list[str] = Field(default_factory=list, max_length=30)
    food_exclusions: list[str] = Field(default_factory=list, max_length=30)
    preferences: list[str] = Field(default_factory=list, max_length=30)
    goals: list[str] = Field(default_factory=list, max_length=30)
    note: str = Field(default="", max_length=4000)

    @field_validator("activity_limitations", "food_allergies", "food_exclusions", "preferences", "goals")
    @classmethod
    def concise_items(cls, value):
        if any(not item.strip() or len(item) > 500 for item in value):
            raise ValueError("Each item must be nonempty and at most 500 characters")
        return list(dict.fromkeys(item.strip() for item in value))


class RuleInput(EntryInput):
    content: str = Field(min_length=1, max_length=2000)
    kind: Literal["restriction", "preference", "guideline"] = "guideline"
    status: Literal["active", "paused", "proposed"] = "active"
    effective_from: str | None = None
    effective_until: str | None = None
    excluded_terms: list[str] = Field(default_factory=list, max_length=30)
    origin: Literal["user", "professional", "assistant_proposal"] = "user"
    confirmed: bool = False

    @model_validator(mode="after")
    def validate_dates(self):
        for value in (self.effective_from, self.effective_until):
            if value:
                _day(value)
        if self.effective_from and self.effective_until and self.effective_until < self.effective_from:
            raise ValueError("The effective period ends before it begins")
        if self.origin == "assistant_proposal" and not self.confirmed and self.status == "active":
            self.status = "proposed"
        if any(not term.strip() or len(term) > 200 for term in self.excluded_terms):
            raise ValueError("Exclusion terms must be nonempty, bounded text")
        self.excluded_terms = list(dict.fromkeys(term.strip() for term in self.excluded_terms))
        return self


MealType = Literal["breakfast", "lunch", "dinner", "snack", "other"]


class EnergyEstimate(Input):
    minimum: float = Field(ge=0, le=30000)
    maximum: float = Field(ge=0, le=30000)
    basis: str = Field(min_length=1, max_length=1000)
    unit: Literal["kcal"] = "kcal"

    @model_validator(mode="after")
    def ordered(self):
        if self.maximum < self.minimum:
            raise ValueError("Estimate maximum must not be below minimum")
        return self


class MealInput(EntryInput):
    occurred_at: str
    meal_type: MealType = "other"
    description: str = Field(default="", max_length=4000)
    portion: str = Field(default="", max_length=2000)
    status: Literal["recorded", "skipped"] = "recorded"
    recommendation_id: str | None = Field(default=None, max_length=180)
    note: str = Field(default="", max_length=4000)
    estimated_energy: EnergyEstimate | None = None

    @model_validator(mode="after")
    def actual_record(self):
        self.occurred_at = _instant(self.occurred_at)
        if self.status == "recorded" and not self.description:
            raise ValueError("Describe the food actually eaten")
        if self.status == "skipped" and self.estimated_energy:
            raise ValueError("A skipped meal cannot have estimated intake")
        return self


class WeightInput(EntryInput):
    measured_at: str
    value: float = Field(gt=0, le=1500)
    unit: Literal["kg", "lb"] = "kg"
    note: str = Field(default="", max_length=2000)

    @field_validator("measured_at")
    @classmethod
    def timestamp(cls, value):
        return _instant(value)


class StepsInput(EntryInput):
    measured_at: str
    value: int = Field(ge=0, le=200000, strict=True)
    note: str = Field(default="", max_length=2000)

    @field_validator("measured_at")
    @classmethod
    def timestamp(cls, value):
        return _instant(value)


class RecommendationOption(Input):
    id: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(min_length=1, max_length=2000)
    ingredients: list[str] = Field(default_factory=list, max_length=40)
    portion: str = Field(default="", max_length=1000)
    substitutions: list[str] = Field(default_factory=list, max_length=20)
    reason: str = Field(default="", max_length=2000)
    note: str = Field(default="", max_length=2000)
    estimated_energy: EnergyEstimate | None = None
    cost_note: str = Field(default="", max_length=500)


class RecommendationInput(EntryInput):
    context_revision: int = Field(ge=0)
    target_date: str
    meal_type: MealType = "other"
    context: str = Field(default="", max_length=4000)
    options: list[RecommendationOption] = Field(min_length=1, max_length=5)
    note: str = Field(default="", max_length=2000)

    @field_validator("target_date")
    @classmethod
    def valid_date(cls, value):
        return _day(value)

    @model_validator(mode="after")
    def unique_options(self):
        if len({item.id for item in self.options}) != len(self.options):
            raise ValueError("Each candidate needs a unique option ID")
        return self


class FeedbackInput(EntryInput):
    action: Literal["accepted", "replaced", "declined"]
    option_id: str | None = Field(default=None, max_length=100)
    note: str = Field(default="", max_length=4000)


class ReminderSlot(Input):
    id: str = Field(min_length=1, max_length=100)
    time: str = Field(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    meal_type: MealType = "other"
    kind: Literal["meal", "review"] = "meal"


class RemindersInput(Input):
    revision: int | None = Field(default=None, ge=0)
    enabled: bool = False
    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=100)
    slots: list[ReminderSlot] = Field(default_factory=list, max_length=12)
    quiet_start: str | None = Field(default=None, pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    quiet_end: str | None = Field(default=None, pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    max_per_day: int = Field(default=3, ge=1, le=12)
    paused_dates: list[str] = Field(default_factory=list, max_length=90)
    tone: str = Field(default="温和提醒", max_length=200)

    @model_validator(mode="after")
    def valid_preferences(self):
        try:
            ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("An IANA timezone is required") from exc
        if len({slot.id for slot in self.slots}) != len(self.slots):
            raise ValueError("Reminder slot IDs must be unique")
        self.paused_dates = sorted({_day(value) for value in self.paused_dates})
        if bool(self.quiet_start) != bool(self.quiet_end):
            raise ValueError("Quiet hours require both start and end")
        return self


_MODELS = {"rules": RuleInput, "meals": MealInput, "weights": WeightInput, "steps": StepsInput,
           "recommendations": RecommendationInput, "feedback": FeedbackInput}
_TABLES = {kind: f"health_{kind}" for kind in _MODELS}


def migrate(db: sqlite3.Connection) -> None:
    """Called by Store inside its v12 transaction; never commits independently."""
    db.execute("CREATE TABLE IF NOT EXISTS health_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0,profile_json TEXT NOT NULL,profile_revision INTEGER NOT NULL DEFAULT 0,reminders_json TEXT NOT NULL,reminders_revision INTEGER NOT NULL DEFAULT 0)")
    db.execute("INSERT OR IGNORE INTO health_state(id,profile_json,reminders_json) VALUES(1,?,?)",
               (_json(ProfileInput().model_dump(exclude={"revision"})),
                _json(RemindersInput().model_dump(exclude={"revision"}))))
    for table in _TABLES.values():
        db.execute(f"CREATE TABLE IF NOT EXISTS {table}(id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 1,data_json TEXT NOT NULL,entry_date TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)")
        db.execute(f"CREATE INDEX IF NOT EXISTS {table}_date ON {table}(entry_date,created_at)")
    db.execute("CREATE TABLE IF NOT EXISTS health_writes(operation_key TEXT PRIMARY KEY,request_json TEXT NOT NULL,entity_kind TEXT NOT NULL,entity_id TEXT NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS health_mutations(operation_key TEXT PRIMARY KEY,request_json TEXT NOT NULL,result_json TEXT NOT NULL)")


class HealthService:
    def __init__(self, store: Store):
        self.store = store

    @staticmethod
    def _validate(model, data):
        try:
            return model.model_validate(data).model_dump()
        except ValidationError as exc:
            raise _error("Invalid health fields; check dates, values and required descriptions") from exc

    @staticmethod
    def _state(db):
        return db.execute("SELECT * FROM health_state WHERE id=1").fetchone()

    @staticmethod
    def _bump(db):
        db.execute("UPDATE health_state SET revision=revision+1 WHERE id=1")

    @staticmethod
    def _today(db):
        reminders = json.loads(HealthService._state(db)["reminders_json"])
        return datetime.fromisoformat(_now()).astimezone(ZoneInfo(reminders["timezone"])).date().isoformat()

    @staticmethod
    def _row(row):
        if row is None:
            raise _error("Health record was not found", "not_found", 404)
        result = json.loads(row["data_json"])
        return {**result, "id": row["id"], "revision": row["revision"],
                "created_at": row["created_at"], "updated_at": row["updated_at"]}

    def profile(self) -> dict:
        with self.store._connection() as db:
            state = self._state(db)
            return {**json.loads(state["profile_json"]), "revision": state["profile_revision"]}

    def reminders(self) -> dict:
        with self.store._connection() as db:
            state = self._state(db)
            return {**json.loads(state["reminders_json"]), "revision": state["reminders_revision"]}

    @staticmethod
    def _replay(db, operation_key, request):
        if not operation_key:
            return None
        row = db.execute("SELECT * FROM health_mutations WHERE operation_key=?", (operation_key,)).fetchone()
        if not row:
            return None
        if row["request_json"] != request:
            raise _error("This request ID identifies a different change", "idempotency_conflict", 409)
        return json.loads(row["result_json"])

    @staticmethod
    def _receipt(db, operation_key, request, result):
        if operation_key:
            db.execute("INSERT INTO health_mutations VALUES(?,?,?)", (operation_key, request, _json(result)))
        return result

    def _set_singleton(self, kind, data, *, operation_key=None):
        payload = self._validate(ProfileInput if kind == "profile" else RemindersInput, data)
        revision = payload.pop("revision")
        serialized = _json(payload)
        request = _json({"kind": kind, "data": data})
        with self.store._connection(write=True) as db:
            replay = self._replay(db, operation_key, request)
            if replay is not None:
                return replay
            state = self._state(db)
            current = state[f"{kind}_revision"]
            if serialized == state[f"{kind}_json"]:
                return self._receipt(db, operation_key, request, {**payload, "revision": current})
            if revision is None or revision != current:
                raise _error("This setting changed; reload it before saving", "revision_conflict", 409)
            db.execute(f"UPDATE health_state SET {kind}_json=?,{kind}_revision={kind}_revision+1 WHERE id=1", (serialized,))
            if kind == "profile":
                self._bump(db)
            return self._receipt(db, operation_key, request, {**payload, "revision": current + 1})

    def set_profile(self, data, *, operation_key=None):
        return self._set_singleton("profile", data, operation_key=operation_key)

    def set_reminders(self, data, *, operation_key=None):
        return self._set_singleton("reminders", data, operation_key=operation_key)

    @staticmethod
    def _entry_date(kind, payload):
        if kind == "meals":
            return payload["occurred_at"][:10]
        if kind in {"weights", "steps"}:
            return payload["measured_at"][:10]
        if kind == "recommendations":
            return payload["target_date"]
        return _now()[:10]

    def _require(self, db, kind, identifier, include_deleted=False):
        clause = "" if include_deleted else " AND deleted=0"
        row = db.execute(f"SELECT * FROM {_TABLES[kind]} WHERE id=?{clause}", (identifier,)).fetchone()
        return self._row(row)

    @staticmethod
    def _list(db, kind, *, start=None, end=None, limit=100):
        clauses, args = ["deleted=0"], []
        if start:
            clauses.append("entry_date>=?")
            args.append(_day(start))
        if end:
            clauses.append("entry_date<=?")
            args.append(_day(end))
        args.append(min(max(int(limit), 1), 500))
        return db.execute(f"SELECT * FROM {_TABLES[kind]} WHERE {' AND '.join(clauses)} ORDER BY entry_date DESC,created_at DESC,id DESC LIMIT ?", args).fetchall()

    def list(self, kind, *, start=None, end=None, limit=100):
        if kind not in _TABLES or kind == "feedback":
            raise _error("Unknown health record type")
        with self.store._connection() as db:
            items = [self._row(row) for row in self._list(db, kind, start=start, end=end, limit=limit)]
            if kind == "weights":
                items = [self._weight(item) for item in items]
            if kind == "recommendations":
                items = [self._recommendation(db, item) for item in items]
            return {"items": items}

    @staticmethod
    def _active_rules(db, day):
        rules = [HealthService._row(row) for row in HealthService._list(db, "rules", limit=500)]
        return [item for item in rules if item["status"] == "active"
                and (not item["effective_from"] or item["effective_from"] <= day)
                and (not item["effective_until"] or item["effective_until"] >= day)]

    def _check_recommendation(self, db, payload):
        state = self._state(db)
        if payload["target_date"] < self._today(db):
            raise _error("This meal date has passed; generate a current recommendation", "stale_health_context", 409)
        if payload["context_revision"] != state["revision"]:
            raise _error("Health records or agreements changed; read current context and regenerate", "stale_health_context", 409)
        profile = json.loads(state["profile_json"])
        rules = self._active_rules(db, payload["target_date"])
        terms = profile["food_allergies"] + profile["food_exclusions"]
        for rule in rules:
            if rule["kind"] == "restriction":
                terms.extend(rule["excluded_terms"])
        if terms and any(not option["ingredients"] for option in payload["options"]):
            raise _error("Known food restrictions require candidate ingredient information; clarify before recommending", "ingredients_required")
        for option in payload["options"]:
            searchable = _json({key: option[key] for key in ("title", "description", "ingredients", "portion", "substitutions")}).casefold()
            if any(term.casefold() in searchable for term in terms):
                raise _error("A candidate conflicts with a known food restriction. List only actual proposed foods and substitutions in candidate fields; put avoidance, allergy and cross-contact notices in the recommendation-level note, not candidate food lists.", "health_restriction_conflict")
            # Exclude common explicit punitive/extreme strategies. This is a
            # bounded additional check, not a replacement for clinical judgment.
            unsafe = r"(?:惩罚|补偿).{0,8}(?:跑步|运动|断食)|(?:全天|连续多日|连续几天)(?:不吃|禁食|断食)|(?:催吐|泻药减肥)"
            if profile["activity_limitations"] and re.search(r"跑步|跳绳|跳跃|深蹲|爬楼", searchable):
                raise _error("Meal advice must respect the recorded activity limitations", "health_activity_conflict")
            if re.search(unsafe, searchable):
                raise _error("Recommendations must not prescribe punitive or extreme restriction", "unsafe_health_recommendation")
        return {"profile_revision": state["profile_revision"],
                "rule_revisions": [{"id": item["id"], "revision": item["revision"]} for item in rules],
                "rule_snapshots": [{key: item[key] for key in (
                    "id", "revision", "content", "kind", "effective_from", "effective_until", "excluded_terms", "origin"
                )} for item in rules],
                "record_revision": state["revision"],
                "food_restrictions": terms,
                "activity_limitations": profile["activity_limitations"],
                "ingredient_notice": "成分仅依据已提供信息；过敏和交叉接触仍需向供应方确认" if profile["food_allergies"] else "份量和营养估计以已提供信息为准"}

    def create(self, kind, data, *, operation_key: str | None = None):
        if kind not in _MODELS or kind == "feedback":
            raise _error("Unknown health record type")
        payload = self._validate(_MODELS[kind], data)
        identifier = payload.pop("id") or str(uuid4())
        payload.pop("revision")
        request = _json({key: value for key, value in payload.items() if key != "conversation_id"})
        operation_key = operation_key or f"create:{kind}:{identifier}"
        with self.store._connection(write=True) as db:
            previous = db.execute("SELECT * FROM health_writes WHERE operation_key=?", (operation_key,)).fetchone()
            if previous:
                if previous["request_json"] != request or previous["entity_kind"] != kind:
                    raise _error("This request ID already identifies different health data", "idempotency_conflict", 409)
                result = self._require(db, kind, previous["entity_id"], include_deleted=True)
                result["deleted"] = bool(db.execute(f"SELECT deleted FROM {_TABLES[kind]} WHERE id=?", (previous["entity_id"],)).fetchone()[0])
                if kind == "recommendations":
                    return self._recommendation(db, result)
                return self._weight(result) if kind == "weights" else result
            if db.execute(f"SELECT 1 FROM {_TABLES[kind]} WHERE id=?", (identifier,)).fetchone():
                raise _error("This record ID is already in use", "idempotency_conflict", 409)
            if kind == "meals" and payload["recommendation_id"]:
                self._require(db, "recommendations", payload["recommendation_id"])
            if kind == "recommendations":
                payload["basis"] = self._check_recommendation(db, payload)
            now = _now()
            db.execute(f"INSERT INTO {_TABLES[kind]}(id,data_json,entry_date,created_at,updated_at) VALUES(?,?,?,?,?)", (identifier, _json(payload), self._entry_date(kind, payload), now, now))
            db.execute("INSERT INTO health_writes VALUES(?,?,?,?)", (operation_key, request, kind, identifier))
            if kind != "recommendations":
                self._bump(db)
            result = self._require(db, kind, identifier)
            if kind == "recommendations":
                return self._recommendation(db, result)
            return self._weight(result) if kind == "weights" else result

    def update(self, kind, identifier, data, *, operation_key=None):
        if kind not in {"rules", "meals", "weights", "steps"}:
            raise _error("This health record cannot be edited")
        payload = self._validate(_MODELS[kind], data)
        supplied_id = payload.pop("id")
        if supplied_id and supplied_id != identifier:
            raise _error("The record ID cannot change")
        revision = payload.pop("revision")
        request = _json({"kind": kind, "id": identifier, "data": data})
        with self.store._connection(write=True) as db:
            replay = self._replay(db, operation_key, request)
            if replay is not None:
                return replay
            current = self._require(db, kind, identifier)
            current_payload = {key: value for key, value in current.items()
                               if key not in {"id", "revision", "created_at", "updated_at"}}
            # Preserve provenance unless explicitly supplied.
            for field in ("source_id", "conversation_id"):
                if payload[field] is None:
                    payload[field] = current_payload.get(field)
            if _json(payload) == _json(current_payload):
                result = self._weight(current) if kind == "weights" else current
                return self._receipt(db, operation_key, request, result)
            if revision is None or revision != current["revision"]:
                raise _error("This record changed; reload it before correcting", "revision_conflict", 409)
            if kind == "meals" and payload["recommendation_id"]:
                self._require(db, "recommendations", payload["recommendation_id"])
            db.execute(f"UPDATE {_TABLES[kind]} SET revision=revision+1,data_json=?,entry_date=?,updated_at=? WHERE id=?", (_json(payload), self._entry_date(kind, payload), _now(), identifier))
            self._bump(db)
            result = self._require(db, kind, identifier)
            result = self._weight(result) if kind == "weights" else result
            return self._receipt(db, operation_key, request, result)

    def delete(self, kind, identifier, revision, *, operation_key=None):
        if kind not in {"rules", "meals", "weights", "steps"}:
            raise _error("This health record cannot be deleted")
        request = _json({"kind": kind, "id": identifier, "revision": revision})
        with self.store._connection(write=True) as db:
            replay = self._replay(db, operation_key, request)
            if replay is not None:
                return replay
            row = db.execute(f"SELECT * FROM {_TABLES[kind]} WHERE id=?", (identifier,)).fetchone()
            current = self._row(row)
            if row["deleted"]:
                return self._receipt(db, operation_key, request, {"id": identifier, "deleted": True})
            if revision != current["revision"]:
                raise _error("This record changed; reload it before deleting", "revision_conflict", 409)
            db.execute(f"UPDATE {_TABLES[kind]} SET deleted=1,revision=revision+1,updated_at=? WHERE id=?", (_now(), identifier))
            self._bump(db)
            return self._receipt(db, operation_key, request, {"id": identifier, "deleted": True})

    def feedback(self, recommendation_id, data, *, operation_key=None):
        payload = self._validate(FeedbackInput, data)
        identifier = payload.pop("id") or str(uuid4())
        payload.pop("revision")
        payload["recommendation_id"] = recommendation_id
        request = _json({key: value for key, value in payload.items() if key != "conversation_id"})
        operation_key = operation_key or f"feedback:{identifier}"
        with self.store._connection(write=True) as db:
            previous = db.execute("SELECT * FROM health_writes WHERE operation_key=?", (operation_key,)).fetchone()
            if previous:
                if previous["request_json"] != request or previous["entity_kind"] != "feedback":
                    raise _error("This request ID already identifies different feedback", "idempotency_conflict", 409)
                return self._require(db, "feedback", previous["entity_id"])
            recommendation = self._require(db, "recommendations", recommendation_id)
            if payload["option_id"] and payload["option_id"] not in {item["id"] for item in recommendation["options"]}:
                raise _error("Choose an option from this recommendation")
            if payload["action"] == "accepted" and not payload["option_id"]:
                raise _error("An accepted recommendation requires the selected option")
            if payload["action"] == "accepted" and self._recommendation(db, recommendation)["status"] != "current":
                raise _error("Agreements or records changed; refresh this recommendation first", "stale_health_context", 409)
            now = _now()
            try:
                db.execute("INSERT INTO health_feedback(id,data_json,entry_date,created_at,updated_at) VALUES(?,?,?,?,?)", (identifier, _json(payload), now[:10], now, now))
                db.execute("INSERT INTO health_writes VALUES(?,?,?,?)", (operation_key, request, "feedback", identifier))
            except sqlite3.IntegrityError as exc:
                raise _error("This feedback ID is already in use", "idempotency_conflict", 409) from exc
            # Feedback is in the context read by future recommendations. Accepted
            # food still needs an actual meal record; it never becomes intake.
            self._bump(db)
            return self._require(db, "feedback", identifier)

    @staticmethod
    def _weight(item):
        value = Decimal(str(item["value"]))
        if item["unit"] == "lb":
            value *= Decimal("0.45359237")
        return {**item, "value_kg": round(float(value), 3)}

    def _recommendation(self, db, item):
        feedback = [self._row(row) for row in self._list(db, "feedback", limit=500)]
        feedback = [row for row in feedback if row["recommendation_id"] == item["id"]]
        fresh = item["context_revision"] == self._state(db)["revision"] and item["target_date"] >= self._today(db)
        return {**item, "status": "current" if fresh else "stale",
                "latest_feedback": feedback[0] if feedback else None}

    def summary(self, day=None):
        with self.store._connection() as db:
            db.execute("BEGIN")
            state = self._state(db)
            reminders = {**json.loads(state["reminders_json"]), "revision": state["reminders_revision"]}
            day = _day(day) if day else self._today(db)
            profile = {**json.loads(state["profile_json"]), "revision": state["profile_revision"]}
            all_rules = [self._row(row) for row in self._list(db, "rules", limit=500)]
            meals = [self._row(row) for row in self._list(db, "meals", start=day, end=day, limit=100)]
            # Keep a bounded recent history for the agent's next-meal/review context.
            recent_meals = [self._row(row) for row in self._list(db, "meals", end=day, limit=30)]
            weights = [self._weight(self._row(row)) for row in self._list(db, "weights", end=day, limit=30)]
            steps = [self._row(row) for row in self._list(db, "steps", start=day, end=day, limit=30)]
            recommendations = [self._recommendation(db, self._row(row)) for row in self._list(db, "recommendations", limit=30)]
            choices = []
            for recommendation in recommendations:
                if recommendation["latest_feedback"]:
                    choices.append({**recommendation, "actual_meals": [item for item in recent_meals if item["recommendation_id"] == recommendation["id"]]})
            ordered_weights = sorted(weights, key=lambda item: (datetime.fromisoformat(item["measured_at"]), item["id"]))
            # Daily medians keep repeat same-day measurements from creating a
            # fictitious multi-day trend; do not assume readings share a protocol.
            daily = {}
            for item in ordered_weights:
                daily.setdefault(item["measured_at"][:10], []).append(item["value_kg"])
            medians = []
            for measured_day, values in sorted(daily.items()):
                values.sort()
                n = len(values)
                median = (values[(n - 1) // 2] + values[n // 2]) / 2
                medians.append((measured_day, median))
            trend = {"count": len(weights), "days": len(medians),
                     "change_kg": round(medians[-1][1] - medians[0][1], 3) if len(medians) > 1 else None,
                     "first_date": medians[0][0] if medians else None,
                     "last_date": medians[-1][0] if medians else None,
                     "latest_kg": ordered_weights[-1]["value_kg"] if ordered_weights else None,
                     "notice": "仅比较已记录测量；衣着、时间与测量条件可能不同"}
            return {"date": day, "revision": state["revision"], "profile": profile,
                    "rules": self._active_rules(db, day), "all_rules": all_rules,
                    "meals": meals, "recent_meals": recent_meals, "weights": weights, "steps": steps,
                    "recommendations": recommendations, "reminders": reminders,
                    "review": {"recorded_meals": sum(item["status"] == "recorded" for item in meals),
                               "skipped_meals": sum(item["status"] == "skipped" for item in meals),
                               "coverage": "仅代表已记录内容，未记录表示未知", "weight_trend": trend,
                               "recent_choices": choices, "unknown_is_not_nonadherence": True,
                               "next_step_context": "根据当前约定、已记录饮食和选择困难调整下一餐；不因漏记、单日体重波动而要求补偿或惩罚"}}


def source_key(source_id: str, entry_key: str) -> str:
    """Stable across run retries and main/child routing of the same input."""
    if not source_id or not entry_key.strip() or len(entry_key) > 200:
        raise _error("A source message ID and a stable entry key are required")
    return hashlib.sha256(f"{source_id}:{entry_key.strip()}".encode()).hexdigest()
