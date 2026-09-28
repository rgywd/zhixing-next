"""Single-host product state. Network/model work never runs inside these transactions."""

import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from uuid import uuid4

from .config import Settings
from .sqlite_policy import safe_journal_mode

TERMINAL = {"completed", "failed", "cancelled", "interrupted"}
_CREDENTIAL_WORDS = re.compile(
    r"api[_ -]?key|password|passwd|token|secret|cookie|密码|密钥|私钥|恢复密钥"
    r"|\bsk-[A-Za-z0-9_-]{10,}|\bghp_[A-Za-z0-9]{20,}|-----BEGIN .*PRIVATE KEY-----",
    re.I,
)


class StoreError(Exception):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def timestamp(value: datetime | None = None) -> str:
    return (value or datetime.now(UTC)).astimezone(UTC).isoformat(timespec="microseconds")


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _record(row):
    if row is None:
        return None
    result = dict(row)
    result.pop("request_json", None)
    result.pop("workspace_path", None)
    result.pop("content_key", None)
    for key in ("blocked", "cancel_requested", "enabled", "visible"):
        if key in result:
            result[key] = bool(result[key])
    if "tools_json" in result:
        result["tools"] = json.loads(result.pop("tools_json"))
    return result


def _memory_content(content):
    if not isinstance(content, str):
        raise StoreError("invalid_memory", "Memory must be text", 422)
    content = " ".join(content.split())
    if not content or len(content) > 500 or _CREDENTIAL_WORDS.search(content):
        raise StoreError("invalid_memory", "Memory is empty, too long, or contains credential material", 422)
    return content


class Store:
    def __init__(self, settings: Settings):
        self.settings = settings
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        settings.workspace_root.mkdir(parents=True, exist_ok=True)
        self.db_path = settings.data_dir / "app.sqlite"
        with self._connection() as db:
            self.journal_mode = db.execute(f"PRAGMA journal_mode={safe_journal_mode()}").fetchone()[
                0
            ]
            db.execute("BEGIN IMMEDIATE")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > 5:
                raise RuntimeError("Database schema is newer than this server")
            if version == 0:
                # Individual statements keep schema creation and its version in one transaction.
                for statement in _SCHEMA:
                    db.execute(statement)
            if version < 2:
                db.execute("CREATE TABLE agents(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('service','custom')),service TEXT UNIQUE,name TEXT NOT NULL,description TEXT NOT NULL,instructions TEXT NOT NULL,tools_json TEXT NOT NULL,visible INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)")
                db.execute("ALTER TABLE conversations ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL")
                now = timestamp()
                db.execute("INSERT INTO agents(id,kind,service,name,description,instructions,tools_json,visible,created_at,updated_at) VALUES('finance','service','finance','财务助手','整理账户、收支与扣费问题。','只记录用户明确提供的金额，不猜测扣款链路。记录是观察值，不自动对账或计算总资产；截图识别尚未接入。','[]',1,?,?)", (now, now))
                db.execute("PRAGMA user_version=2")
            if version < 3:
                db.execute("CREATE TABLE finance_observations(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('balance','income','expense')),platform TEXT NOT NULL,amount TEXT NOT NULL,note TEXT NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id),created_at TEXT NOT NULL)")
                db.execute("UPDATE agents SET tools_json='[\"list_finance_observations\",\"record_finance_observation\",\"remove_finance_observation\"]' WHERE id='finance'")
                db.execute("PRAGMA user_version=3")
            if version < 4:
                db.execute("ALTER TABLE conversations ADD COLUMN model_id TEXT")
                db.execute("ALTER TABLE conversations ADD COLUMN reasoning_effort TEXT")
                db.execute("ALTER TABLE runs ADD COLUMN model_id TEXT")
                db.execute("ALTER TABLE runs ADD COLUMN reasoning_effort TEXT")
                db.execute("CREATE TABLE model_roles(role TEXT PRIMARY KEY,model_id TEXT NOT NULL)")
                db.execute("PRAGMA user_version=4")
            if version < 5:
                db.execute("CREATE TABLE memories(id TEXT PRIMARY KEY,content TEXT NOT NULL,content_key TEXT NOT NULL UNIQUE,source_message_id TEXT REFERENCES messages(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL)")
                db.execute("ALTER TABLE runs ADD COLUMN memory_processed INTEGER NOT NULL DEFAULT 0 CHECK(memory_processed IN (-1,0,1))")
                # Do not silently reinterpret old conversations as new memory input.
                db.execute("UPDATE runs SET memory_processed=1")
                db.execute("PRAGMA user_version=5")
            db.commit()

    @contextmanager
    def _connection(self, write=False):
        db = sqlite3.connect(self.db_path, timeout=5, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=5000")
        db.execute("PRAGMA synchronous=FULL")
        try:
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            if write:
                db.commit()
        except BaseException:
            if db.in_transaction:
                db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _require(db, table, identifier):
        # table is an internal constant from the methods below, never client input.
        row = db.execute(f"SELECT * FROM {table} WHERE id=?", (identifier,)).fetchone()
        if row is None:
            raise StoreError("not_found", "Resource not found", 404)
        return row

    @staticmethod
    def _event(db, run_id, event_type, data):
        db.execute(
            "INSERT INTO events(run_id,type,data,created_at) VALUES(?,?,?,?)",
            (run_id, event_type, _json(data), timestamp()),
        )

    @staticmethod
    def _page(rows, limit, cursor_key="seq"):
        return {
            "items": [_record(row) for row in rows[:limit]],
            "next_cursor": str(rows[limit - 1][cursor_key]) if len(rows) > limit else None,
        }

    def get_assistant(self):
        with self._connection() as db:
            row = db.execute("SELECT name,persona FROM assistant WHERE id=1").fetchone()
            return dict(row)

    def list_memories(self, cursor=0, limit=50):
        with self._connection() as db:
            rows = db.execute(
                "SELECT rowid AS seq,* FROM memories WHERE rowid>? ORDER BY rowid LIMIT ?",
                (cursor, limit + 1),
            ).fetchall()
            return self._page(rows, limit)

    def memory_candidates(self, limit=200):
        # ponytail: bounded scan; add an index when real memory volume exceeds this window.
        with self._connection() as db:
            return [dict(row) for row in db.execute(
                "SELECT id,content,updated_at FROM memories ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            ).fetchall()]

    def memory_status(self):
        with self._connection() as db:
            rows = db.execute(
                "SELECT memory_processed,COUNT(*) AS count FROM runs "
                "WHERE status='completed' GROUP BY memory_processed"
            ).fetchall()
            counts = {row["memory_processed"]: row["count"] for row in rows}
            return {"pending": counts.get(0, 0), "failed": counts.get(-1, 0)}

    def add_memory(self, content, source_message_id=None):
        content = _memory_content(content)
        key = content.casefold()
        with self._connection(write=True) as db:
            if source_message_id:
                self._require(db, "messages", source_message_id)
            existing = db.execute("SELECT * FROM memories WHERE content_key=?", (key,)).fetchone()
            if existing:
                return _record(existing)
            identifier, now = str(uuid4()), timestamp()
            db.execute(
                "INSERT INTO memories VALUES(?,?,?,?,?,?)",
                (identifier, content, key, source_message_id, now, now),
            )
            return _record(self._require(db, "memories", identifier))

    def update_memory(self, memory_id, content):
        content = _memory_content(content)
        with self._connection(write=True) as db:
            self._require(db, "memories", memory_id)
            try:
                db.execute(
                    "UPDATE memories SET content=?,content_key=?,updated_at=? WHERE id=?",
                    (content, content.casefold(), timestamp(), memory_id),
                )
            except sqlite3.IntegrityError as exc:
                raise StoreError("memory_conflict", "Memory already exists") from exc
            return _record(self._require(db, "memories", memory_id))

    def delete_memory(self, memory_id):
        with self._connection(write=True) as db:
            self._require(db, "memories", memory_id)
            db.execute("DELETE FROM memories WHERE id=?", (memory_id,))
            # Old in-flight runs must not recreate a fact the user just forgot.
            db.execute("UPDATE runs SET memory_processed=1 WHERE memory_processed=0")

    def next_memory_run(self):
        with self._connection() as db:
            row = db.execute(
                "SELECT id,conversation_id,message_id,prompt,result FROM runs "
                "WHERE status='completed' AND memory_processed=0 ORDER BY seq LIMIT 1"
            ).fetchone()
            return dict(row) if row else None

    def memory_context(self, run_id):
        with self._connection() as db:
            run = self._require(db, "runs", run_id)
            rows = db.execute(
                "SELECT role,content FROM messages WHERE conversation_id=? AND status='applied' "
                "AND seq<=(SELECT MAX(seq) FROM messages WHERE run_id=?) "
                "ORDER BY seq DESC LIMIT 8",
                (run["conversation_id"], run_id),
            ).fetchall()
            return [dict(row) for row in reversed(rows)]

    def apply_memory_actions(self, run_id, actions):
        with self._connection(write=True) as db:
            run = self._require(db, "runs", run_id)
            if run["status"] != "completed" or run["memory_processed"] != 0:
                return False
            for action in actions:
                operation = action["op"]
                try:
                    content = _memory_content(action.get("content")) if operation in {"add", "replace"} else ""
                except StoreError:
                    continue
                if operation == "add":
                    db.execute(
                        "INSERT OR IGNORE INTO memories VALUES(?,?,?,?,?,?)",
                        (str(uuid4()), content, content.casefold(), run["message_id"], timestamp(), timestamp()),
                    )
                elif operation == "replace":
                    existing = db.execute("SELECT id FROM memories WHERE id=?", (action["id"],)).fetchone()
                    if existing:
                        try:
                            db.execute(
                                "UPDATE memories SET content=?,content_key=?,updated_at=? "
                                "WHERE id=? AND updated_at=?",
                                (content, content.casefold(), timestamp(), action["id"], action["expected_updated_at"]),
                            )
                        except sqlite3.IntegrityError:
                            pass
                elif operation == "forget":
                    removed = db.execute(
                        "DELETE FROM memories WHERE id=? AND updated_at=?",
                        (action["id"], action["expected_updated_at"]),
                    ).rowcount
                    if removed:
                        db.execute(
                            "UPDATE runs SET memory_processed=1 WHERE seq<? AND memory_processed=0",
                            (run["seq"],),
                        )
            db.execute("UPDATE runs SET memory_processed=1 WHERE id=?", (run_id,))
            return True

    def fail_memory_run(self, run_id):
        with self._connection(write=True) as db:
            db.execute(
                "UPDATE runs SET memory_processed=-1 WHERE id=? AND status='completed' AND memory_processed=0",
                (run_id,),
            )

    def add_memory_failure_notice(self, run_id):
        with self._connection(write=True) as db:
            run = self._require(db, "runs", run_id)
            db.execute(
                "INSERT INTO messages(id,conversation_id,role,content,intent,run_id,status,created_at) "
                "VALUES(?,?,'assistant',?,'queue',?,'applied',?)",
                (str(uuid4()), run["conversation_id"], "记忆整理暂时失败，刚才的记住或忘记要求尚未生效。", run_id, timestamp()),
            )

    def retry_memory_runs(self):
        with self._connection(write=True) as db:
            return db.execute(
                "UPDATE runs SET memory_processed=0 WHERE status='completed' AND memory_processed=-1"
            ).rowcount

    def set_assistant(self, name, persona):
        with self._connection(write=True) as db:
            db.execute("UPDATE assistant SET name=?,persona=? WHERE id=1", (name, persona))
        return {"name": name, "persona": persona}

    def list_agents(self):
        with self._connection() as db:
            return {"items": [_record(row) for row in db.execute("SELECT * FROM agents ORDER BY CASE kind WHEN 'service' THEN 0 ELSE 1 END,created_at,id").fetchall()], "next_cursor": None}

    def get_agent(self, agent_id):
        with self._connection() as db:
            return _record(self._require(db, "agents", agent_id))

    def create_agent(self, *, name, description, instructions, tools, visible):
        if set(tools) - {"inspect_environment", "list_directory", "read_text_file", "read_document", "write_text_file", "fetch_public_page"}:
            raise StoreError("tool_not_allowed", "This tool belongs to a fixed service agent", 422)
        identifier, now = str(uuid4()), timestamp()
        with self._connection(write=True) as db:
            db.execute("INSERT INTO agents(id,kind,service,name,description,instructions,tools_json,visible,created_at,updated_at) VALUES(?,'custom',NULL,?,?,?,?,?,?,?)", (identifier, name, description, instructions, _json(sorted(set(tools))), visible, now, now))
            return _record(self._require(db, "agents", identifier))

    def update_agent(self, agent_id, *, name, description, instructions, tools, visible):
        with self._connection(write=True) as db:
            agent = self._require(db, "agents", agent_id)
            if agent["kind"] == "service" and sorted(set(tools)) != json.loads(agent["tools_json"]):
                raise StoreError("tool_not_allowed", "Service agent tools are fixed by the service", 422)
            db.execute("UPDATE agents SET name=?,description=?,instructions=?,tools_json=?,visible=?,updated_at=? WHERE id=?", (name, description, instructions, _json(sorted(set(tools))), visible, timestamp(), agent_id))
            return _record(self._require(db, "agents", agent_id))

    def delete_agent(self, agent_id):
        with self._connection(write=True) as db:
            agent = self._require(db, "agents", agent_id)
            if agent["kind"] == "service":
                raise StoreError("fixed_agent", "Service agents cannot be deleted")
            active = db.execute("SELECT 1 FROM runs r JOIN conversations c ON c.id=r.conversation_id WHERE c.agent_id=? AND r.status IN ('queued','running') LIMIT 1", (agent_id,)).fetchone()
            if active:
                raise StoreError("agent_busy", "Finish or cancel this agent's queued work first")
            db.execute("DELETE FROM agents WHERE id=?", (agent_id,))

    def record_finance_observation(self, *, kind, platform, amount, note, conversation_id):
        if kind not in {"balance", "income", "expense"} or not 1 <= len(platform.strip()) <= 100 or len(note) > 1000:
            raise StoreError("invalid_finance_record", "Invalid finance observation", 422)
        try:
            value = Decimal(amount)
        except (InvalidOperation, ValueError):
            raise StoreError("invalid_finance_record", "Amount must be a decimal number", 422) from None
        if not value.is_finite() or value < 0 or value >= Decimal("1000000000000") or value.as_tuple().exponent < -2:
            raise StoreError("invalid_finance_record", "Amount must be nonnegative with at most two decimal places", 422)
        identifier = str(uuid4())
        with self._connection(write=True) as db:
            self._require(db, "conversations", conversation_id)
            db.execute("INSERT INTO finance_observations VALUES(?,?,?,?,?,?,?)", (identifier, kind, platform.strip(), f"{value:.2f}", note.strip(), conversation_id, timestamp()))
            return dict(db.execute("SELECT * FROM finance_observations WHERE id=?", (identifier,)).fetchone())

    def list_finance_observations(self):
        with self._connection() as db:
            balances = db.execute("SELECT * FROM finance_observations WHERE kind='balance' AND rowid IN (SELECT MAX(rowid) FROM finance_observations WHERE kind='balance' GROUP BY platform) ORDER BY platform").fetchall()
            recent = db.execute("SELECT * FROM finance_observations WHERE kind!='balance' ORDER BY rowid DESC LIMIT 20").fetchall()
            return {"balances": [dict(row) for row in balances], "recent": [dict(row) for row in recent]}

    def remove_finance_observation(self, observation_id):
        with self._connection(write=True) as db:
            changed = db.execute("DELETE FROM finance_observations WHERE id=?", (observation_id,)).rowcount
            if not changed:
                raise StoreError("not_found", "Finance observation not found", 404)

    def create_project(self, name):
        identifier = str(uuid4())
        path = self.settings.workspace_root / "projects" / identifier
        path.mkdir(parents=True)
        with self._connection(write=True) as db:
            db.execute(
                "INSERT INTO projects(id,name,workspace_path,created_at) VALUES(?,?,?,?)",
                (identifier, name, str(path.resolve()), timestamp()),
            )
            return dict(self._require(db, "projects", identifier))

    def list_projects(self, cursor=0, limit=50):
        with self._connection() as db:
            rows = db.execute(
                "SELECT rowid AS seq,* FROM projects WHERE rowid>? ORDER BY rowid LIMIT ?",
                (cursor, limit + 1),
            ).fetchall()
            page = self._page(rows, limit)
            for result, row in zip(page["items"], rows):
                result["workspace_path"] = row["workspace_path"]
                result.pop("seq", None)
            return page

    def create_conversation(self, title, project_id=None, agent_id=None):
        identifier = str(uuid4())
        with self._connection() as db:
            project = self._require(db, "projects", project_id) if project_id else None
            if agent_id:
                self._require(db, "agents", agent_id)
        workspace = (
            Path(project["workspace_path"])
            if project
            else self.settings.workspace_root / "conversations" / identifier
        )
        workspace.mkdir(parents=True, exist_ok=True)
        now = timestamp()
        with self._connection(write=True) as db:
            db.execute(
                "INSERT INTO conversations(id,title,project_id,workspace_path,created_at,updated_at,agent_id) VALUES(?,?,?,?,?,?,?)",
                (identifier, title, project_id, str(workspace.resolve()), now, now, agent_id),
            )
            return _record(self._require(db, "conversations", identifier))

    def get_conversation(self, conversation_id):
        with self._connection() as db:
            return _record(self._require(db, "conversations", conversation_id))

    def model_roles(self):
        with self._connection() as db:
            configured = {row["role"]: row["model_id"] for row in db.execute(
                "SELECT role,model_id FROM model_roles"
            )}
            roles = {
                role: configured.get(role, self.settings.roles.get(role))
                for role in ("chat", "task", "memory")
            }
            if roles["memory"] not in self.settings.models:
                roles["memory"] = roles["chat"]
            return roles

    def set_model_role(self, role, model_id):
        if model_id not in self.settings.models:
            raise StoreError("unknown_model", "Choose a configured model", 422)
        with self._connection(write=True) as db:
            db.execute(
                "INSERT INTO model_roles(role,model_id) VALUES(?,?) "
                "ON CONFLICT(role) DO UPDATE SET model_id=excluded.model_id",
                (role, model_id),
            )
        return self.model_roles()

    def set_conversation_model(self, conversation_id, model_id, reasoning_effort):
        if model_id is not None and model_id not in self.settings.models:
            raise StoreError("unknown_model", "Choose a configured model", 422)
        with self._connection(write=True) as db:
            conversation = self._require(db, "conversations", conversation_id)
            if conversation["agent_id"] is not None:
                raise StoreError("agent_model", "Model controls belong to main assistant chats", 422)
            selected = model_id or self._role_model(db, "chat")
            if reasoning_effort is not None and (
                selected not in self.settings.models
                or reasoning_effort not in self.settings.models[selected].reasoning_levels
            ):
                raise StoreError("unsupported_reasoning", "This model does not support that thinking depth", 422)
            db.execute(
                "UPDATE conversations SET model_id=?,reasoning_effort=? WHERE id=?",
                (model_id, reasoning_effort, conversation_id),
            )
            return _record(self._require(db, "conversations", conversation_id))

    def _role_model(self, db, role):
        row = db.execute("SELECT model_id FROM model_roles WHERE role=?", (role,)).fetchone()
        return row["model_id"] if row else self.settings.roles.get(role)

    def workspace_for(self, conversation_id):
        with self._connection() as db:
            return Path(self._require(db, "conversations", conversation_id)["workspace_path"])

    def list_conversations(self, cursor=0, limit=50, *, before=None, latest=False):
        with self._connection() as db:
            if latest or before is not None:
                rows = db.execute(
                    "SELECT rowid AS seq,* FROM conversations WHERE (? IS NULL OR rowid<?) ORDER BY rowid DESC LIMIT ?",
                    (before, before, limit + 1),
                ).fetchall()
                items = [_record(row) for row in reversed(rows[:limit])]
                return {
                    "items": items,
                    "next_cursor": None,
                    "previous_cursor": str(items[0]["seq"]) if len(rows) > limit else None,
                }
            rows = db.execute(
                "SELECT rowid AS seq,* FROM conversations WHERE rowid>? ORDER BY rowid LIMIT ?",
                (cursor, limit + 1),
            ).fetchall()
            return self._page(rows, limit)

    def _enqueue(self, db, conversation_id, message_id, content, kind, request_json):
        run_id, now = str(uuid4()), timestamp()
        conversation = self._require(db, "conversations", conversation_id)
        model_id = (
            conversation["model_id"]
            if kind == "chat" and conversation["agent_id"] is None and conversation["model_id"]
            else self._role_model(db, kind)
        )
        reasoning_effort = (
            conversation["reasoning_effort"]
            if kind == "chat" and conversation["agent_id"] is None else None
        )
        db.execute(
            "INSERT INTO messages(id,conversation_id,role,content,intent,run_id,status,created_at,request_json) VALUES(?,?,'user',?,'queue',?,'accepted',?,?)",
            (message_id, conversation_id, content, run_id, now, request_json),
        )
        db.execute(
            "INSERT INTO runs(id,conversation_id,message_id,kind,prompt,created_at,model_id,reasoning_effort) VALUES(?,?,?,?,?,?,?,?)",
            (run_id, conversation_id, message_id, kind, content, now, model_id, reasoning_effort),
        )
        db.execute("UPDATE conversations SET updated_at=? WHERE id=?", (now, conversation_id))
        return run_id

    def submit_message(
        self, conversation_id, *, id, content, intent="queue", kind="chat", target_run_id=None
    ):
        request_json = _json(
            {
                "conversation_id": conversation_id,
                "content": content,
                "intent": intent,
                "kind": kind,
                "target_run_id": target_run_id,
            }
        )
        with self._connection(write=True) as db:
            self._require(db, "conversations", conversation_id)
            previous = db.execute("SELECT * FROM messages WHERE id=?", (id,)).fetchone()
            if previous:
                if previous["request_json"] != request_json:
                    raise StoreError(
                        "id_conflict", "Message ID already exists with different content"
                    )
                return {
                    "message": _record(previous),
                    "run": _record(self._require(db, "runs", previous["run_id"])),
                }
            if intent == "steer":
                run = self._require(db, "runs", target_run_id)
                if (
                    run["conversation_id"] != conversation_id
                    or run["status"] != "running"
                    or run["cancel_requested"]
                ):
                    raise StoreError(
                        "stale_steer", "The target run is no longer accepting guidance"
                    )
                run_id = run["id"]
                now = timestamp()
                db.execute(
                    "INSERT INTO messages(id,conversation_id,role,content,intent,run_id,status,created_at,request_json) VALUES(?,?,'user',?,'steer',?,'accepted',?,?)",
                    (id, conversation_id, content, run_id, now, request_json),
                )
                db.execute(
                    "UPDATE conversations SET updated_at=? WHERE id=?", (now, conversation_id)
                )
            else:
                run_id = self._enqueue(db, conversation_id, id, content, kind, request_json)
            return {
                "message": _record(self._require(db, "messages", id)),
                "run": _record(self._require(db, "runs", run_id)),
            }

    def list_messages(self, conversation_id, cursor=0, limit=50, *, before=None, latest=False):
        with self._connection() as db:
            self._require(db, "conversations", conversation_id)
            if latest or before is not None:
                rows = db.execute(
                    "SELECT * FROM messages WHERE conversation_id=? AND (? IS NULL OR seq<?) ORDER BY seq DESC LIMIT ?",
                    (conversation_id, before, before, limit + 1),
                ).fetchall()
                items = [_record(row) for row in reversed(rows[:limit])]
                return {
                    "items": items,
                    "next_cursor": None,
                    "previous_cursor": str(items[0]["seq"]) if len(rows) > limit else None,
                }
            rows = db.execute(
                "SELECT * FROM messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?",
                (conversation_id, cursor, limit + 1),
            ).fetchall()
            return self._page(rows, limit)

    def get_run(self, run_id):
        with self._connection() as db:
            return _record(self._require(db, "runs", run_id))

    def list_runs(
        self, conversation_id=None, cursor=0, limit=50, *, before=None, latest=False, status=None
    ):
        with self._connection() as db:
            if conversation_id:
                self._require(db, "conversations", conversation_id)
            if latest or before is not None:
                rows = db.execute(
                    "SELECT * FROM runs WHERE (? IS NULL OR conversation_id=?) AND (? IS NULL OR status=?) AND (? IS NULL OR seq<?) ORDER BY seq DESC LIMIT ?",
                    (conversation_id, conversation_id, status, status, before, before, limit + 1),
                ).fetchall()
                items = [_record(row) for row in reversed(rows[:limit])]
                return {
                    "items": items,
                    "next_cursor": None,
                    "previous_cursor": str(items[0]["seq"]) if len(rows) > limit else None,
                }
            rows = db.execute(
                "SELECT * FROM runs WHERE seq>? AND (? IS NULL OR conversation_id=?) AND (? IS NULL OR status=?) ORDER BY seq LIMIT ?",
                (cursor, conversation_id, conversation_id, status, status, limit + 1),
            ).fetchall()
            return self._page(rows, limit)

    def claim_next(self, kind):
        with self._connection(write=True) as db:
            row = db.execute(
                """SELECT r.*,c.workspace_path,c.agent_id FROM runs r JOIN conversations c ON c.id=r.conversation_id
                WHERE r.kind=? AND r.status='queued' AND c.blocked=0
                  AND NOT EXISTS(SELECT 1 FROM runs active WHERE active.conversation_id=r.conversation_id AND active.status='running')
                  AND NOT EXISTS(SELECT 1 FROM runs earlier WHERE earlier.conversation_id=r.conversation_id AND earlier.status='queued' AND earlier.seq<r.seq)
                ORDER BY r.seq LIMIT 1""",
                (kind,),
            ).fetchone()
            if row is None:
                return None
            now = timestamp()
            db.execute("UPDATE runs SET status='running',started_at=? WHERE id=?", (now, row["id"]))
            db.execute("UPDATE messages SET status='applied' WHERE id=?", (row["message_id"],))
            self._event(db, row["id"], "started", {})
            result = _record(self._require(db, "runs", row["id"]))
            result["workspace_path"] = row["workspace_path"]
            result["agent_id"] = row["agent_id"]
            return result

    def get_controls(self, run_id):
        with self._connection() as db:
            run = self._require(db, "runs", run_id)
            steers = db.execute(
                "SELECT * FROM messages WHERE run_id=? AND intent='steer' AND status='accepted' ORDER BY seq",
                (run_id,),
            ).fetchall()
            return {
                "cancel_requested": bool(run["cancel_requested"]),
                "steers": [_record(row) for row in steers],
            }

    def acknowledge_steers(self, run_id, ids):
        with self._connection(write=True) as db:
            run = self._require(db, "runs", run_id)
            if run["status"] != "running":
                return
            applied = []
            for identifier in ids:
                changed = db.execute(
                    "UPDATE messages SET status='applied' WHERE id=? AND run_id=? AND intent='steer' AND status='accepted'",
                    (identifier, run_id),
                ).rowcount
                if changed:
                    applied.append(identifier)
            if applied:
                self._event(db, run_id, "steer_applied", {"message_ids": applied})

    def add_event(self, run_id, type, data):
        with self._connection(write=True) as db:
            run = self._require(db, "runs", run_id)
            if run["status"] == "running":
                self._event(db, run_id, type, data)

    def list_events(self, run_id, after=0, limit=100):
        with self._connection() as db:
            self._require(db, "runs", run_id)
            rows = db.execute(
                "SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?",
                (run_id, after, limit + 1),
            ).fetchall()
            page = self._page(rows, limit)
            for item in page["items"]:
                item["data"] = json.loads(item["data"])
            return page

    def _finish(self, db, run, status, result=None, error=None):
        if run["status"] in TERMINAL:
            return
        if status == "completed" and run["cancel_requested"]:
            status = "cancelled"
        now = timestamp()
        db.execute(
            "UPDATE runs SET status=?,result=?,error=?,finished_at=? WHERE id=?",
            (status, result, error, now, run["id"]),
        )
        db.execute(
            "UPDATE messages SET status='rejected' WHERE run_id=? AND status='accepted'",
            (run["id"],),
        )
        # Withdrawing a queued follow-up changes no active execution or prior failure block.
        should_block = status != "completed" and not (
            status == "cancelled" and run["status"] == "queued"
        )
        db.execute(
            "UPDATE conversations SET blocked=MAX(blocked,?),updated_at=? WHERE id=?",
            (int(should_block), now, run["conversation_id"]),
        )
        if status == "completed" and result is not None:
            db.execute(
                "INSERT INTO messages(id,conversation_id,role,content,intent,run_id,status,created_at) VALUES(?,?,'assistant',?,'queue',?,'applied',?)",
                (str(uuid4()), run["conversation_id"], result, run["id"], now),
            )
        self._event(db, run["id"], status, {"result": result, "error": error})

    def finish_run(self, run_id, status, result=None, error=None):
        if status not in TERMINAL:
            raise ValueError("finish_run requires a terminal status")
        with self._connection(write=True) as db:
            run = self._require(db, "runs", run_id)
            self._finish(db, run, status, result, error)

    def cancel_run(self, run_id):
        with self._connection(write=True) as db:
            run = self._require(db, "runs", run_id)
            if run["status"] not in TERMINAL:
                db.execute("UPDATE runs SET cancel_requested=1 WHERE id=?", (run_id,))
                if run["status"] == "queued":
                    self._finish(db, run, "cancelled")
            return _record(self._require(db, "runs", run_id))

    def resume_conversation(self, conversation_id):
        with self._connection(write=True) as db:
            self._require(db, "conversations", conversation_id)
            db.execute(
                "UPDATE conversations SET blocked=0,updated_at=? WHERE id=?",
                (timestamp(), conversation_id),
            )
            return _record(self._require(db, "conversations", conversation_id))

    def recover_interrupted(self):
        with self._connection(write=True) as db:
            for row in db.execute("SELECT * FROM runs WHERE status='running'").fetchall():
                self._finish(
                    db,
                    row,
                    "interrupted",
                    error="Worker stopped before completion; inspect prior tool receipts before retrying",
                )

    def create_schedule(self, *, id, conversation_id, prompt, next_run_at, interval_seconds=None):
        due = (
            timestamp(next_run_at)
            if isinstance(next_run_at, datetime)
            else timestamp(datetime.fromisoformat(next_run_at))
        )
        request_json = _json(
            {
                "conversation_id": conversation_id,
                "prompt": prompt,
                "next_run_at": due,
                "interval_seconds": interval_seconds,
            }
        )
        with self._connection(write=True) as db:
            self._require(db, "conversations", conversation_id)
            existing = db.execute("SELECT * FROM schedules WHERE id=?", (id,)).fetchone()
            if existing:
                if existing["request_json"] != request_json:
                    raise StoreError(
                        "id_conflict", "Schedule ID already exists with different content"
                    )
                return _record(existing)
            db.execute(
                "INSERT INTO schedules(id,conversation_id,prompt,next_run_at,interval_seconds,created_at,request_json) VALUES(?,?,?,?,?,?,?)",
                (id, conversation_id, prompt, due, interval_seconds, timestamp(), request_json),
            )
            return _record(self._require(db, "schedules", id))

    def list_schedules(self, cursor=0, limit=50):
        with self._connection() as db:
            rows = db.execute(
                "SELECT rowid AS seq,* FROM schedules WHERE rowid>? ORDER BY rowid LIMIT ?",
                (cursor, limit + 1),
            ).fetchall()
            page = self._page(rows, limit)
            for item in page["items"]:
                item.pop("seq", None)
            return page

    def update_schedule(self, schedule_id, enabled):
        with self._connection(write=True) as db:
            self._require(db, "schedules", schedule_id)
            db.execute("UPDATE schedules SET enabled=? WHERE id=?", (int(enabled), schedule_id))
            return _record(self._require(db, "schedules", schedule_id))

    def tick_schedules(self, now=None):
        current = now or datetime.now(UTC)
        with self._connection(write=True) as db:
            schedules = db.execute(
                """SELECT s.* FROM schedules s WHERE s.enabled=1 AND s.next_run_at<=?
                AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=s.last_run_id AND r.status IN ('queued','running'))
                ORDER BY s.next_run_at""",
                (timestamp(current),),
            ).fetchall()
            for schedule in schedules:
                # Uniqueness and queue insertion share the transaction with advancing the due time.
                inserted = db.execute(
                    "INSERT OR IGNORE INTO schedule_fires(schedule_id,scheduled_at) VALUES(?,?)",
                    (schedule["id"], schedule["next_run_at"]),
                ).rowcount
                if inserted:
                    run_id = self._enqueue(
                        db,
                        schedule["conversation_id"],
                        str(uuid4()),
                        schedule["prompt"],
                        "task",
                        None,
                    )
                    db.execute(
                        "UPDATE schedules SET last_run_id=? WHERE id=?", (run_id, schedule["id"])
                    )
                if schedule["interval_seconds"] is None:
                    db.execute("UPDATE schedules SET enabled=0 WHERE id=?", (schedule["id"],))
                else:
                    due = datetime.fromisoformat(schedule["next_run_at"])
                    interval = schedule["interval_seconds"]
                    missed = int((current - due).total_seconds() // interval) + 1
                    next_due = due + timedelta(seconds=missed * interval)
                    db.execute(
                        "UPDATE schedules SET next_run_at=? WHERE id=?",
                        (timestamp(next_due), schedule["id"]),
                    )

    def heartbeat(self):
        with self._connection(write=True) as db:
            db.execute(
                "INSERT INTO worker_state(id,heartbeat_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at",
                (timestamp(),),
            )

    def worker_online(self):
        with self._connection() as db:
            row = db.execute("SELECT heartbeat_at FROM worker_state WHERE id=1").fetchone()
            if row is None:
                return False
            age = (datetime.now(UTC) - datetime.fromisoformat(row[0])).total_seconds()
            return 0 <= age < 15


_SCHEMA = [
    "CREATE TABLE assistant(id INTEGER PRIMARY KEY CHECK(id=1),name TEXT NOT NULL,persona TEXT NOT NULL)",
    "INSERT INTO assistant VALUES(1,'知行','')",
    "CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,workspace_path TEXT NOT NULL,created_at TEXT NOT NULL)",
    "CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL,project_id TEXT REFERENCES projects(id),workspace_path TEXT NOT NULL,blocked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)",
    "CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL REFERENCES conversations(id),role TEXT NOT NULL CHECK(role IN ('user','assistant')),content TEXT NOT NULL,intent TEXT NOT NULL CHECK(intent IN ('queue','steer')),run_id TEXT,status TEXT NOT NULL CHECK(status IN ('accepted','applied','rejected')),created_at TEXT NOT NULL,request_json TEXT)",
    "CREATE INDEX messages_conversation ON messages(conversation_id,seq)",
    "CREATE INDEX messages_controls ON messages(run_id,intent,status)",
    "CREATE TABLE runs(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL REFERENCES conversations(id),message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),kind TEXT NOT NULL CHECK(kind IN ('chat','task')),status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled','interrupted')),prompt TEXT NOT NULL,cancel_requested INTEGER NOT NULL DEFAULT 0,result TEXT,error TEXT,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT)",
    "CREATE INDEX runs_queue ON runs(status,kind,seq)",
    "CREATE INDEX runs_conversation ON runs(conversation_id,status,seq)",
    "CREATE UNIQUE INDEX one_running_per_conversation ON runs(conversation_id) WHERE status='running'",
    "CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL)",
    "CREATE INDEX events_run ON events(run_id,seq)",
    "CREATE TABLE schedules(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),prompt TEXT NOT NULL,next_run_at TEXT NOT NULL,interval_seconds INTEGER CHECK(interval_seconds>0),enabled INTEGER NOT NULL DEFAULT 1,last_run_id TEXT REFERENCES runs(id),created_at TEXT NOT NULL,request_json TEXT NOT NULL)",
    "CREATE TABLE schedule_fires(schedule_id TEXT NOT NULL REFERENCES schedules(id),scheduled_at TEXT NOT NULL,PRIMARY KEY(schedule_id,scheduled_at))",
    "CREATE TABLE worker_state(id INTEGER PRIMARY KEY CHECK(id=1),heartbeat_at TEXT NOT NULL)",
]
