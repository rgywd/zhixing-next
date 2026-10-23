"""Single SQLite source for the assistant's editable, evidence-bound growth."""

import json
import re
from contextlib import nullcontext
from uuid import uuid4

from pydantic import ValidationError

from .growth_schema import DEFAULT_PREFERENCES, GoalPatch, PreferencesPatch
from .store import StoreError, _json, timestamp

_KEY = re.compile(r"^[A-Za-z0-9\u3400-\u9fff][A-Za-z0-9\u3400-\u9fff_.:\-]{0,79}$")
_SECRET = re.compile(r"\bsk-[A-Za-z0-9_-]{16,}|\bghp_[A-Za-z0-9]{20,}|-----BEGIN .*PRIVATE KEY-----")


def migrate(db):
    for statement in (
        """CREATE TABLE IF NOT EXISTS growth_state(
            id INTEGER PRIMARY KEY CHECK(id=1), evolved_persona TEXT NOT NULL,
            persona_reason TEXT NOT NULL, persona_memory_refs_json TEXT NOT NULL,
            preferences_json TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS growth_skills(
            key TEXT PRIMARY KEY,content TEXT NOT NULL,reason TEXT NOT NULL,memory_refs_json TEXT NOT NULL,
            revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS growth_understanding(
            key TEXT PRIMARY KEY,content TEXT NOT NULL,memory_refs_json TEXT NOT NULL,
            revision INTEGER NOT NULL,updated_at TEXT NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS growth_goals(
            id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),
            title TEXT NOT NULL,context TEXT NOT NULL,topic TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active','paused','completed','cancelled')),
            next_check_at TEXT,interval_seconds INTEGER,revision INTEGER NOT NULL,
            created_at TEXT NOT NULL,updated_at TEXT NOT NULL)""",
        "CREATE INDEX IF NOT EXISTS growth_goals_due ON growth_goals(status,next_check_at)",
        """CREATE TABLE IF NOT EXISTS growth_receipts(
            operation_key TEXT PRIMARY KEY,request_json TEXT NOT NULL,result_json TEXT NOT NULL,
            created_at TEXT NOT NULL)""",
    ):
        db.execute(statement)
    db.execute("INSERT OR IGNORE INTO growth_state VALUES(1,'','','{}',?,0,?)",
               (_json(DEFAULT_PREFERENCES), timestamp()))


def _key(value):
    if not isinstance(value, str) or not _KEY.fullmatch(value):
        raise StoreError("invalid_growth", "Use a short stable key", 422)
    return value


def _text(value, maximum, *, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()) or _SECRET.search(value):
        raise StoreError("invalid_growth", "Growth text is empty, too long, or contains credentials", 422)
    return value.strip()


def _validate(model, changes):
    try:
        return model.model_validate(changes).model_dump(exclude_unset=True, mode="json")
    except (ValidationError, TypeError) as exc:
        raise StoreError("invalid_growth", "Invalid assistant growth fields", 422) from exc


class GrowthService:
    def __init__(self, store):
        self.store = store

    @staticmethod
    def _versions(db):
        return {row["id"]: row["updated_at"] for row in db.execute("SELECT id,updated_at FROM memories")}

    @staticmethod
    def _refs(value, versions):
        if value is None:
            return {}
        if isinstance(value, list):
            if any(not isinstance(key, str) or key not in versions for key in value):
                raise StoreError("stale_growth_evidence", "Referenced memory is no longer current")
            value = {key: versions[key] for key in value}
        if not isinstance(value, dict) or len(value) > 100 or any(
            not isinstance(key, str) or not isinstance(version, str) or key not in versions
            or versions[key] != version for key, version in value.items()
        ):
            raise StoreError("stale_growth_evidence", "Referenced memory is no longer current")
        return value

    @staticmethod
    def _valid_refs(refs, versions):
        return all(key in versions and versions[key] == version for key, version in refs.items())

    def snapshot(self, db=None):
        with self.store._connection() if db is None else nullcontext(db) as connection:
            row = dict(connection.execute("SELECT * FROM growth_state WHERE id=1").fetchone())
            versions = self._versions(connection)
            persona_refs = json.loads(row["persona_memory_refs_json"])
            result = {
                "revision": row["revision"], "updated_at": row["updated_at"],
                "evolved_persona": row["evolved_persona"] if self._valid_refs(persona_refs, versions) else "",
                "persona_reason": row["persona_reason"] if self._valid_refs(persona_refs, versions) else "",
                "persona_memory_refs": persona_refs if self._valid_refs(persona_refs, versions) else {},
                "preferences": json.loads(row["preferences_json"]),
                "learned_skills": [], "understanding": [],
                "goals": [dict(item) for item in connection.execute("SELECT * FROM growth_goals ORDER BY created_at,id")],
                "memory_versions": versions,
            }
            for table, output in (("growth_skills", "learned_skills"), ("growth_understanding", "understanding")):
                for saved in connection.execute(f"SELECT * FROM {table} ORDER BY key"):
                    item = dict(saved)
                    refs = json.loads(item.pop("memory_refs_json"))
                    if self._valid_refs(refs, versions):
                        result[output].append({**item, "memory_refs": refs})
            return result

    def read_state(self):
        return self.snapshot()

    @staticmethod
    def _check_revision(db, expected):
        actual = db.execute("SELECT revision FROM growth_state WHERE id=1").fetchone()[0]
        if expected is not None and expected != actual:
            raise StoreError("revision_conflict", "Assistant state changed; read the latest state before updating")
        return actual

    @staticmethod
    def _bump(db):
        db.execute("UPDATE growth_state SET revision=revision+1,updated_at=? WHERE id=1", (timestamp(),))
        db.execute("UPDATE heartbeat_state SET next_check_at=? WHERE id=1", (timestamp(),))

    @staticmethod
    def _receipt(db, key, request):
        if key is None:
            return None
        _text(key, 300)
        row = db.execute("SELECT request_json,result_json FROM growth_receipts WHERE operation_key=?", (key,)).fetchone()
        if row:
            if row["request_json"] != _json(request):
                raise StoreError("idempotency_conflict", "Operation key was already used for different growth data")
            return json.loads(row["result_json"])
        return None

    @staticmethod
    def _save_receipt(db, key, request, result):
        if key is not None:
            db.execute("INSERT INTO growth_receipts VALUES(?,?,?,?)", (key, _json(request), _json(result), timestamp()))
        return result

    def patch_preferences(self, changes, conversation_id=None, *, operation_key=None):
        changes = _validate(PreferencesPatch, changes)
        request = {"method": "preferences", "changes": changes.copy(), "conversation_id": conversation_id}
        with self.store._connection(write=True) as db:
            if (receipt := self._receipt(db, operation_key, request)) is not None:
                return receipt
            self._check_revision(db, changes.pop("expected_revision", None))
            preferences = json.loads(db.execute("SELECT preferences_json FROM growth_state WHERE id=1").fetchone()[0])
            previous = _json(preferences)
            for field, value in changes.items():
                if field in {"topics", "guidance"}:
                    if value is None:
                        raise StoreError("invalid_growth", "Use null on a map entry to remove that preference", 422)
                    for key, content in value.items():
                        _text(key, 80)
                        if content is None:
                            preferences[field].pop(key, None)
                        else:
                            preferences[field][key] = _text(content, 1000)
                    if len(preferences[field]) > 40:
                        raise StoreError("growth_limit", "Too many proactive preference entries", 422)
                elif value is None and field not in {"snooze_until", "quiet_start", "quiet_end"}:
                    raise StoreError("invalid_growth", "This preference cannot be cleared", 422)
                else:
                    preferences[field] = value
            if (preferences["quiet_start"] is None) != (preferences["quiet_end"] is None):
                raise StoreError("invalid_growth", "Set or clear both quiet hours", 422)
            if conversation_id is not None:
                self.store._require(db, "conversations", conversation_id)
                preferences["target_conversation_id"] = conversation_id
            if preferences["enabled"] and not preferences["target_conversation_id"]:
                raise StoreError("missing_proactive_destination", "Choose a conversation for proactive messages", 422)
            if previous != _json(preferences):
                db.execute("UPDATE growth_state SET preferences_json=? WHERE id=1", (_json(preferences),))
                self._bump(db)
            result = {**preferences, "revision": self._check_revision(db, None),
                      "updated_at": db.execute("SELECT updated_at FROM growth_state WHERE id=1").fetchone()[0]}
            return self._save_receipt(db, operation_key, request, result)

    def update_persona(self, content, reason, *, expected_revision=None, memory_refs=None, operation_key=None):
        content, reason = _text(content, 6000, empty=True), _text(reason, 1000)
        request = {"method": "persona", "content": content, "reason": reason,
                   "expected_revision": expected_revision, "memory_refs": memory_refs}
        with self.store._connection(write=True) as db:
            if (receipt := self._receipt(db, operation_key, request)) is not None:
                return receipt
            self._check_revision(db, expected_revision)
            refs = self._refs(memory_refs, self._versions(db))
            old = db.execute("SELECT evolved_persona,persona_reason,persona_memory_refs_json FROM growth_state WHERE id=1").fetchone()
            if tuple(old) != (content, reason, _json(refs)):
                db.execute("UPDATE growth_state SET evolved_persona=?,persona_reason=?,persona_memory_refs_json=? WHERE id=1", (content, reason, _json(refs)))
                self._bump(db)
            result = {"evolved_persona": content, "persona_reason": reason, "memory_refs": refs,
                      "revision": self._check_revision(db, None),
                      "updated_at": db.execute("SELECT updated_at FROM growth_state WHERE id=1").fetchone()[0]}
            return self._save_receipt(db, operation_key, request, result)

    def _save_skill(self, db, key, content, reason, refs):
        old = db.execute("SELECT * FROM growth_skills WHERE key=?", (key,)).fetchone()
        if old and (old["content"], old["reason"], old["memory_refs_json"]) == (content, reason, _json(refs)):
            return False
        if old is None and db.execute("SELECT COUNT(*) FROM growth_skills").fetchone()[0] >= 50:
            raise StoreError("growth_limit", "Too many learned procedures", 422)
        now = timestamp()
        db.execute("""INSERT INTO growth_skills VALUES(?,?,?,?,1,?,?) ON CONFLICT(key) DO UPDATE SET
            content=excluded.content,reason=excluded.reason,memory_refs_json=excluded.memory_refs_json,
            revision=growth_skills.revision+1,updated_at=excluded.updated_at""",
                   (key, content, reason, _json(refs), now, now))
        return True

    def save_skill(self, key, content, reason, *, expected_revision=None, memory_refs=None, operation_key=None):
        key, content, reason = _key(key), _text(content, 4000), _text(reason, 1000)
        request = {"method": "skill", "key": key, "content": content, "reason": reason,
                   "expected_revision": expected_revision, "memory_refs": memory_refs}
        with self.store._connection(write=True) as db:
            if (receipt := self._receipt(db, operation_key, request)) is not None:
                return receipt
            self._check_revision(db, expected_revision)
            if self._save_skill(db, key, content, reason, self._refs(memory_refs, self._versions(db))):
                self._bump(db)
            result = next(item for item in self.snapshot(db)["learned_skills"] if item["key"] == key)
            return self._save_receipt(db, operation_key, request, result)

    def delete_skill(self, key, *, expected_revision=None, operation_key=None):
        key = _key(key)
        request = {"method": "delete_skill", "key": key, "expected_revision": expected_revision}
        with self.store._connection(write=True) as db:
            if (receipt := self._receipt(db, operation_key, request)) is not None:
                return receipt
            self._check_revision(db, expected_revision)
            if db.execute("DELETE FROM growth_skills WHERE key=?", (key,)).rowcount:
                self._bump(db)
            return self._save_receipt(db, operation_key, request, {"deleted": key, "revision": self._check_revision(db, None)})

    def save_goal(self, changes, id=None, conversation_id=None, *, operation_key=None):
        changes = _validate(GoalPatch, changes)
        identifier = _key(id) if id is not None else str(uuid4())
        request = {"method": "goal", "id": id, "changes": changes.copy(), "conversation_id": conversation_id}
        with self.store._connection(write=True) as db:
            if (receipt := self._receipt(db, operation_key, request)) is not None:
                return receipt
            old = db.execute("SELECT * FROM growth_goals WHERE id=?", (identifier,)).fetchone()
            expected = changes.pop("expected_revision", None)
            if expected is not None and expected != (old["revision"] if old else 0):
                raise StoreError("revision_conflict", "Goal changed; read it again before updating")
            if old is None:
                if conversation_id is None:
                    raise StoreError("missing_proactive_destination", "A goal needs its conversation", 422)
                self.store._require(db, "conversations", conversation_id)
            elif conversation_id is not None and old["conversation_id"] != conversation_id:
                raise StoreError("goal_conversation_conflict", "The goal belongs to another conversation")
            now = timestamp()
            merged = dict(old) if old else {"id": identifier, "conversation_id": conversation_id,
                     "title": "", "context": "", "topic": "general", "status": "active",
                     "next_check_at": None, "interval_seconds": None, "revision": 0,
                     "created_at": now, "updated_at": now}
            merged.update(changes)
            for field, limit in (("title", 200), ("context", 4000), ("topic", 80)):
                merged[field] = _text(merged[field], limit, empty=field == "context")
            if merged["status"] is None:
                raise StoreError("invalid_growth", "A goal needs its status", 422)
            if merged["status"] in {"active", "paused"} and (old is None or old["status"] in {"completed", "cancelled"}):
                if db.execute("SELECT COUNT(*) FROM growth_goals WHERE status IN ('active','paused')").fetchone()[0] >= 100:
                    raise StoreError("growth_limit", "Too many active goals", 422)
            if merged["status"] in {"completed", "cancelled"}:
                merged["next_check_at"] = None
            if old is None or any(merged[key] != old[key] for key in changes):
                merged["revision"] += 1
                merged["updated_at"] = now
                db.execute("""INSERT INTO growth_goals VALUES(:id,:conversation_id,:title,:context,:topic,:status,
                    :next_check_at,:interval_seconds,:revision,:created_at,:updated_at) ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title,context=excluded.context,topic=excluded.topic,status=excluded.status,
                    next_check_at=excluded.next_check_at,interval_seconds=excluded.interval_seconds,
                    revision=excluded.revision,updated_at=excluded.updated_at""", merged)
                self._bump(db)
            return self._save_receipt(db, operation_key, request, merged)

    def apply_maintenance(self, changes, expected_revision, memory_versions, db=None):
        """Commit a background snapshot only while every canonical source is current."""
        with self.store._connection(write=True) if db is None else nullcontext(db) as connection:
            if self._check_revision(connection, None) != expected_revision or self._versions(connection) != memory_versions:
                return False
            if not isinstance(changes, dict) or set(changes) - {"evolved_persona", "persona_reason", "persona_memory_refs", "learned_skills", "understanding"}:
                raise StoreError("invalid_growth", "Invalid maintenance fields", 422)
            changed = False
            if "evolved_persona" in changes:
                content = _text(changes["evolved_persona"], 6000, empty=True)
                reason = _text(changes.get("persona_reason", "从已确认的互动中调整表达方式"), 1000)
                refs = self._refs(changes.get("persona_memory_refs", []), memory_versions)
                if content and not refs:
                    raise StoreError("missing_growth_evidence", "Background persona changes need current saved memory references", 422)
                old = connection.execute("SELECT evolved_persona,persona_reason,persona_memory_refs_json FROM growth_state WHERE id=1").fetchone()
                if tuple(old) != (content, reason, _json(refs)):
                    connection.execute("UPDATE growth_state SET evolved_persona=?,persona_reason=?,persona_memory_refs_json=? WHERE id=1", (content, reason, _json(refs)))
                    changed = True
            for field in ("learned_skills", "understanding"):
                items = changes.get(field, [])
                if not isinstance(items, list) or len(items) > 8:
                    raise StoreError("invalid_growth", "A maintenance pass may update at most eight notes", 422)
                for item in items:
                    if not isinstance(item, dict):
                        raise StoreError("invalid_growth", "Invalid maintenance note", 422)
                    key, content = _key(item.get("key")), _text(item.get("content"), 4000 if field == "learned_skills" else 2000)
                    refs = self._refs(item.get("memory_refs", []), memory_versions)
                    if not refs:
                        raise StoreError("missing_growth_evidence", "Background notes need current saved memory references", 422)
                    if field == "learned_skills":
                        changed |= self._save_skill(connection, key, content, _text(item.get("reason", "来自已确认的经验"), 1000), refs)
                    else:
                        old = connection.execute("SELECT * FROM growth_understanding WHERE key=?", (key,)).fetchone()
                        if old and (old["content"], old["memory_refs_json"]) == (content, _json(refs)):
                            continue
                        if old is None and connection.execute("SELECT COUNT(*) FROM growth_understanding").fetchone()[0] >= 40:
                            raise StoreError("growth_limit", "Too many understanding notes", 422)
                        connection.execute("""INSERT INTO growth_understanding VALUES(?,?,?,1,?) ON CONFLICT(key)
                            DO UPDATE SET content=excluded.content,memory_refs_json=excluded.memory_refs_json,
                            revision=growth_understanding.revision+1,updated_at=excluded.updated_at""", (key, content, _json(refs), timestamp()))
                        changed = True
            if changed:
                self._bump(connection)
            return True
