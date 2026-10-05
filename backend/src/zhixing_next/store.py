"""Single-host product state. Network/model work never runs inside these transactions."""

import json
import os
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
CUSTOM_AGENT_TOOLS = {"inspect_environment", "list_directory", "read_text_file", "read_document", "view_image", "write_text_file", "fetch_public_page"}
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
    request_json = result.pop("request_json", None)
    if "role" in result and request_json and json.loads(request_json).get("source_run_id"):
        result["origin"] = "assistant_task"
    result.pop("workspace_path", None)
    result.pop("content_key", None)
    for key in ("blocked", "cancel_requested", "enabled", "visible"):
        if key in result:
            result[key] = bool(result[key])
    if "tools_json" in result:
        result["tools"] = json.loads(result.pop("tools_json"))
    if "attachments_json" in result:
        result["attachments"] = json.loads(result.pop("attachments_json"))
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
            if version > 11:
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
            if version < 6:
                db.execute("CREATE TABLE search_providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('brave','tavily','serper')),api_key TEXT NOT NULL,created_at TEXT NOT NULL)")
                db.execute("ALTER TABLE runs ADD COLUMN search_provider_id TEXT")
                db.execute("PRAGMA user_version=6")
            if version < 7:
                db.execute("ALTER TABLE conversations ADD COLUMN memory_reset_revision INTEGER NOT NULL DEFAULT 0")
                db.execute("CREATE TABLE memory_exposures(memory_id TEXT NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id),PRIMARY KEY(memory_id,conversation_id))")
                db.execute("PRAGMA user_version=7")
            if version < 8:
                db.execute("CREATE TABLE resources(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),path TEXT NOT NULL,name TEXT NOT NULL,mime_type TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL)")
                db.execute("ALTER TABLE messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'")
                db.execute("ALTER TABLE runs ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'")
                db.execute("UPDATE agents SET instructions=replace(instructions,'；截图识别尚未接入。','。截图中清楚可见的金额也属于用户提供的信息；看不清时只追问必要的问题。') WHERE id='finance'")
                finance = db.execute("SELECT tools_json FROM agents WHERE id='finance'").fetchone()
                if finance:
                    db.execute("UPDATE agents SET tools_json=? WHERE id='finance'", (_json(sorted(set(json.loads(finance[0])) | {"view_image"})),))
                db.execute("PRAGMA user_version=8")
            if version < 9:
                db.execute("ALTER TABLE runs ADD COLUMN recovery_enabled INTEGER NOT NULL DEFAULT 0")
                db.execute("ALTER TABLE runs ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0")
                db.execute("ALTER TABLE runs ADD COLUMN phase TEXT NOT NULL DEFAULT 'normal'")
                db.execute("CREATE TABLE operations(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),call_id TEXT NOT NULL,tool TEXT NOT NULL,args_json TEXT NOT NULL,plan_json TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(run_id,call_id))")
                db.execute("CREATE TABLE approvals(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),operation_id TEXT,kind TEXT NOT NULL,details_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL,decided_at TEXT)")
                db.execute("CREATE INDEX approvals_pending ON approvals(run_id,state)")
                db.execute("PRAGMA user_version=9")
            if version < 10:
                from .catalog import migrate

                migrate(db, settings)
                db.execute("PRAGMA user_version=10")
            if version < 11:
                if "model_id" not in {row[1] for row in db.execute("PRAGMA table_info(agents)")}:
                    db.execute("ALTER TABLE agents ADD COLUMN model_id TEXT")
                db.execute("CREATE TABLE IF NOT EXISTS agent_model_configs(run_id TEXT NOT NULL REFERENCES runs(id),model_id TEXT NOT NULL,config_json TEXT NOT NULL,api_key TEXT,PRIMARY KEY(run_id,model_id))")
                db.execute("CREATE TABLE IF NOT EXISTS run_agent_assignments(run_id TEXT NOT NULL REFERENCES runs(id),agent_id TEXT NOT NULL,model_id TEXT,PRIMARY KEY(run_id,agent_id))")
                db.execute("INSERT OR IGNORE INTO run_agent_assignments SELECT r.id,a.id,a.model_id FROM runs r CROSS JOIN agents a WHERE r.status IN ('queued','running','interrupted')")
                db.execute("CREATE TABLE IF NOT EXISTS run_usage(run_id TEXT PRIMARY KEY REFERENCES runs(id),model_attempts INTEGER NOT NULL DEFAULT 0,tool_calls INTEGER NOT NULL DEFAULT 0,input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0,unknown_usage INTEGER NOT NULL DEFAULT 0,active_seconds REAL NOT NULL DEFAULT 0,loop_signature TEXT,loop_call_id TEXT,loop_count INTEGER NOT NULL DEFAULT 0)")
                db.execute("CREATE TABLE IF NOT EXISTS input_requests(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),question TEXT NOT NULL,options_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',answer TEXT,created_at TEXT NOT NULL,answered_at TEXT)")
                db.execute("CREATE TABLE IF NOT EXISTS task_steps(run_id TEXT NOT NULL REFERENCES runs(id),id TEXT NOT NULL,description TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',evidence_json TEXT,PRIMARY KEY(run_id,id))")
                db.execute("CREATE TABLE IF NOT EXISTS processes(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),container TEXT NOT NULL,command TEXT NOT NULL,state TEXT NOT NULL,exit_code INTEGER,created_at TEXT NOT NULL)")
                db.execute("PRAGMA user_version=11")
            db.commit()
        if os.name != "nt":
            self.db_path.chmod(0o600)

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

    def list_memories(self, cursor=0, limit=50, query=""):
        with self._connection() as db:
            rows = db.execute(
                "SELECT rowid AS seq,* FROM memories WHERE rowid>? "
                "AND instr(lower(content),lower(?))>0 ORDER BY rowid LIMIT ?",
                (cursor, query.strip(), limit + 1),
            ).fetchall()
            return self._page(rows, limit)

    def memory_candidates(self, limit=200, offset=0):
        # ponytail: bounded scan; add an index when real memory volume exceeds this window.
        with self._connection() as db:
            return [dict(row) for row in db.execute(
                "SELECT id,content,updated_at FROM memories ORDER BY updated_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()]

    def memory_status(self):
        with self._connection() as db:
            rows = db.execute(
                "SELECT memory_processed,COUNT(*) AS count FROM runs "
                "WHERE status='completed' GROUP BY memory_processed"
            ).fetchall()
            counts = {row["memory_processed"]: row["count"] for row in rows}
            return {"pending": counts.get(0, 0), "failed": counts.get(-1, 0)}

    def memory_reset_revision(self, conversation_id):
        with self._connection() as db:
            row = db.execute(
                "SELECT memory_reset_revision FROM conversations WHERE id=?", (conversation_id,)
            ).fetchone()
            return row[0] if row else 0

    def record_memory_exposure(self, conversation_id, memory_versions):
        if not memory_versions:
            return
        with self._connection(write=True) as db:
            if not db.execute("SELECT 1 FROM conversations WHERE id=?", (conversation_id,)).fetchone():
                return
            for memory_id, read_version in memory_versions.items():
                current = db.execute(
                    "SELECT updated_at FROM memories WHERE id=?", (memory_id,)
                ).fetchone()
                if current and current["updated_at"] == read_version:
                    db.execute(
                        "INSERT OR IGNORE INTO memory_exposures VALUES(?,?)",
                        (memory_id, conversation_id),
                    )
                else:
                    # A correction or forget raced with this read; clear its stale
                    # checkpoint next turn even if it was not previously exposed.
                    db.execute(
                        "UPDATE conversations SET memory_reset_revision=memory_reset_revision+1 WHERE id=?",
                        (conversation_id,),
                    )

    @staticmethod
    def _memory_context_targets(db, memory_id, conversation_id=None):
        targets = {row[0] for row in db.execute(
            "SELECT conversation_id FROM memory_exposures WHERE memory_id=? "
            "UNION SELECT m.conversation_id FROM memories f "
            "JOIN messages m ON m.id=f.source_message_id WHERE f.id=?",
            (memory_id, memory_id),
        )}
        if conversation_id:
            targets.add(conversation_id)
        return targets

    @staticmethod
    def _reset_memory_contexts(db, memory_id, targets):
        db.executemany(
            "UPDATE conversations SET memory_reset_revision=memory_reset_revision+1 WHERE id=?",
            ((identifier,) for identifier in targets),
        )
        db.execute("DELETE FROM memory_exposures WHERE memory_id=?", (memory_id,))

    @classmethod
    def _forget_memory(cls, db, memory_id, expected_updated_at=None, conversation_id=None):
        targets = cls._memory_context_targets(db, memory_id, conversation_id)
        query = "DELETE FROM memories WHERE id=?"
        parameters = [memory_id]
        if expected_updated_at is not None:
            query += " AND updated_at=?"
            parameters.append(expected_updated_at)
        removed = db.execute(query, parameters).rowcount
        if removed:
            cls._reset_memory_contexts(db, memory_id, targets)
        return bool(removed)

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
            current = self._require(db, "memories", memory_id)
            if current["content"] == content:
                return _record(current)
            targets = self._memory_context_targets(db, memory_id)
            try:
                db.execute(
                    "UPDATE memories SET content=?,content_key=?,updated_at=? WHERE id=?",
                    (content, content.casefold(), timestamp(), memory_id),
                )
            except sqlite3.IntegrityError as exc:
                raise StoreError("memory_conflict", "Memory already exists") from exc
            self._reset_memory_contexts(db, memory_id, targets)
            self._retire_memory_runs(db)
            return _record(self._require(db, "memories", memory_id))

    def delete_memory(self, memory_id):
        with self._connection(write=True) as db:
            self._require(db, "memories", memory_id)
            self._forget_memory(db, memory_id)
            self._retire_memory_runs(db)

    @staticmethod
    def _retire_memory_runs(db, before_seq=None):
        # Older extraction, including a failed pass retried later, must not add
        # back a fact the user corrected or forgot. Newer input remains eligible.
        db.execute(
            "UPDATE runs SET memory_processed=1 WHERE memory_processed IN (-1,0) "
            "AND (? IS NULL OR seq<?)",
            (before_seq, before_seq),
        )

    def next_memory_run(self):
        with self._connection() as db:
            row = db.execute(
                "SELECT id,conversation_id,message_id,prompt,result FROM runs "
                "WHERE status='completed' AND memory_processed=0 ORDER BY seq LIMIT 1"
            ).fetchone()
            return dict(row) if row else None

    def memory_context(self, run_id, *, include_previous_assistant=False):
        with self._connection() as db:
            run = self._require(db, "runs", run_id)
            rows = db.execute(
                "SELECT role,content FROM messages WHERE run_id=? AND role='user' "
                "AND json_extract(request_json,'$.source_run_id') IS NULL "
                "AND status='applied' ORDER BY seq",
                (run_id,),
            ).fetchall()
            context = [dict(row) for row in rows]
            if include_previous_assistant:
                previous = db.execute(
                    "SELECT role,content FROM messages WHERE conversation_id=? AND status='applied' "
                    "AND seq<(SELECT seq FROM messages WHERE id=?) ORDER BY seq DESC LIMIT 1",
                    (run["conversation_id"], run["message_id"]),
                ).fetchone()
                if previous and previous["role"] == "assistant":
                    context.insert(0, dict(previous))
            return context

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
                    existing = db.execute("SELECT content FROM memories WHERE id=?", (action["id"],)).fetchone()
                    if existing and existing["content"] != content:
                        targets = self._memory_context_targets(
                            db, action["id"], run["conversation_id"]
                        )
                        try:
                            changed = db.execute(
                                "UPDATE memories SET content=?,content_key=?,updated_at=? "
                                "WHERE id=? AND updated_at=?",
                                (content, content.casefold(), timestamp(), action["id"], action["expected_updated_at"]),
                            ).rowcount
                            if changed:
                                self._reset_memory_contexts(db, action["id"], targets)
                                self._retire_memory_runs(db, run["seq"])
                        except sqlite3.IntegrityError:
                            pass
                elif operation == "forget":
                    if self._forget_memory(
                        db, action["id"], action["expected_updated_at"], run["conversation_id"]
                    ):
                        self._retire_memory_runs(db, run["seq"])
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

    def create_agent(self, *, name, description, instructions, tools, visible, model_id=None):
        if set(tools) - CUSTOM_AGENT_TOOLS:
            raise StoreError("tool_not_allowed", "This tool belongs to a fixed service agent", 422)
        identifier, now = str(uuid4()), timestamp()
        with self._connection(write=True) as db:
            if model_id is not None and model_id not in self.runtime_settings(db).models:
                raise StoreError("unknown_model", "Choose an enabled model", 422)
            db.execute("INSERT INTO agents(id,kind,service,name,description,instructions,tools_json,visible,created_at,updated_at) VALUES(?,'custom',NULL,?,?,?,?,?,?,?)", (identifier, name, description, instructions, _json(sorted(set(tools))), visible, now, now))
            db.execute("UPDATE agents SET model_id=? WHERE id=?", (model_id, identifier))
            return _record(self._require(db, "agents", identifier))

    def update_agent(self, agent_id, *, name, description, instructions, tools, visible, model_id=None):
        with self._connection(write=True) as db:
            agent = self._require(db, "agents", agent_id)
            if agent["kind"] == "custom" and set(tools) - CUSTOM_AGENT_TOOLS:
                raise StoreError("tool_not_allowed", "This tool belongs to a fixed service agent", 422)
            if model_id is not None and model_id not in self.runtime_settings(db).models:
                raise StoreError("unknown_model", "Choose an enabled model", 422)
            if agent["kind"] == "service" and sorted(set(tools)) != json.loads(agent["tools_json"]):
                raise StoreError("tool_not_allowed", "Service agent tools are fixed by the service", 422)
            db.execute("UPDATE agents SET name=?,description=?,instructions=?,tools_json=?,visible=?,updated_at=? WHERE id=?", (name, description, instructions, _json(sorted(set(tools))), visible, timestamp(), agent_id))
            db.execute("UPDATE agents SET model_id=? WHERE id=?", (model_id, agent_id))
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

    def get_project(self, project_id):
        with self._connection() as db:
            return dict(self._require(db, "projects", project_id))

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

    def _model_roles(self, db, models):
        configured = {row["role"]: row["model_id"] for row in db.execute("SELECT role,model_id FROM model_roles")}
        roles = {role: configured.get(role, self.settings.roles.get(role)) for role in ("chat", "task", "memory")}
        roles = {role: model_id if model_id in models else None for role, model_id in roles.items()}
        roles["memory"] = roles["memory"] or roles["chat"]
        return roles

    def runtime_settings(self, db=None):
        from .catalog import active_configs

        if db is None:
            with self._connection() as connection:
                return self.runtime_settings(connection)
        models = active_configs(db)
        return self.settings.model_copy(update={"models": models, "roles": self._model_roles(db, models)})

    def settings_for_run(self, run):
        from .config import ModelConfig

        with self._connection() as db:
            saved = db.execute("SELECT * FROM run_model_configs WHERE run_id=?", (run["id"],)).fetchone()
            if saved is None or json.loads(saved["config_json"]) is None:
                return self.settings.model_copy(update={"models": {}, "roles": {}})
            config = ModelConfig(**(json.loads(saved["config_json"]) | {"api_key_env": None, "api_key": saved["api_key"]}))
            models = {run["model_id"]: config}
            for child in db.execute("SELECT * FROM agent_model_configs WHERE run_id=?", (run["id"],)):
                models[child["model_id"]] = ModelConfig(**(json.loads(child["config_json"]) | {"api_key_env": None, "api_key": child["api_key"]}))
            return self.settings.model_copy(update={"models": models})

    def agents_for_run(self, run):
        # Freeze model selection while keeping current tool restrictions. Deleted
        # agents stay unavailable and newly added agents cannot retarget a queue.
        with self._connection() as db:
            assignments = {row["agent_id"]: row["model_id"] for row in db.execute("SELECT * FROM run_agent_assignments WHERE run_id=?", (run["id"],))}
        return [agent | {"model_id": assignments[agent["id"]]} for agent in self.list_agents()["items"] if agent["id"] in assignments]

    def model_roles(self):
        return self.runtime_settings().roles

    def set_model_role(self, role, model_id):
        with self._connection(write=True) as db:
            if model_id not in self.runtime_settings(db).models:
                raise StoreError("unknown_model", "Choose an enabled model", 422)
            db.execute(
                "INSERT INTO model_roles(role,model_id) VALUES(?,?) "
                "ON CONFLICT(role) DO UPDATE SET model_id=excluded.model_id",
                (role, model_id),
            )
            return self.runtime_settings(db).roles

    def set_conversation_model(self, conversation_id, model_id, reasoning_effort):
        with self._connection(write=True) as db:
            models = self.runtime_settings(db).models
            if model_id is not None and model_id not in models:
                raise StoreError("unknown_model", "Choose an enabled model", 422)
            conversation = self._require(db, "conversations", conversation_id)
            selected = self._conversation_model(db, conversation, "chat", model_id, use_preference=False)
            if reasoning_effort is not None and (
                selected not in models or reasoning_effort not in models[selected].reasoning_levels
            ):
                raise StoreError("unsupported_reasoning", "This model does not support that thinking depth", 422)
            db.execute(
                "UPDATE conversations SET model_id=?,reasoning_effort=? WHERE id=?",
                (model_id, reasoning_effort, conversation_id),
            )
            return _record(self._require(db, "conversations", conversation_id))

    def _role_model(self, db, role):
        return self.runtime_settings(db).roles.get(role)

    def list_search_providers(self):
        with self._connection() as db:
            return {"items": [dict(id=row["id"], name=row["name"], kind=row["kind"]) for row in db.execute("SELECT id,name,kind FROM search_providers ORDER BY created_at,id")], "next_cursor": None}

    def get_search_provider(self, identifier):
        with self._connection() as db:
            return dict(self._require(db, "search_providers", identifier))

    def create_search_provider(self, *, name, kind, api_key):
        identifier, now = str(uuid4()), timestamp()
        with self._connection(write=True) as db:
            db.execute("INSERT INTO search_providers(id,name,kind,api_key,created_at) VALUES(?,?,?,?,?)", (identifier, name, kind, api_key.strip(), now))
        return {"id": identifier, "name": name, "kind": kind}

    def delete_search_provider(self, identifier):
        with self._connection(write=True) as db:
            self._require(db, "search_providers", identifier)
            if db.execute("SELECT 1 FROM runs WHERE search_provider_id=? AND status IN ('queued','running') LIMIT 1", (identifier,)).fetchone():
                raise StoreError("provider_in_use", "This search provider is used by a pending run")
            db.execute("DELETE FROM search_providers WHERE id=?", (identifier,))

    def workspace_for(self, conversation_id):
        with self._connection() as db:
            return Path(self._require(db, "conversations", conversation_id)["workspace_path"])

    def register_resource(self, identifier, conversation_id, *, path, name, mime_type, size, sha256):
        with self._connection(write=True) as db:
            self._require(db, "conversations", conversation_id)
            previous = db.execute("SELECT * FROM resources WHERE id=?", (identifier,)).fetchone()
            if previous and any(previous[key] != value for key, value in {
                "conversation_id": conversation_id, "path": path, "sha256": sha256,
            }.items()):
                raise StoreError("upload_conflict", "Resource ID belongs to another upload")
            db.execute("INSERT OR IGNORE INTO resources VALUES(?,?,?,?,?,?,?,?)",
                       (identifier, conversation_id, path, name, mime_type, size, sha256, timestamp()))
            return dict(self._require(db, "resources", identifier))

    def get_resource(self, identifier, conversation_id=None):
        with self._connection() as db:
            resource = self._require(db, "resources", identifier)
            if conversation_id:
                self._check_resource_scope(db, resource, conversation_id)
            return dict(resource)

    def list_resources(self, conversation_id=None, cursor=0, limit=50, query="", *, before=None, latest=False):
        with self._connection() as db:
            if conversation_id:
                workspace = self._require(db, "conversations", conversation_id)["workspace_path"]
            else:
                workspace = None
            if latest or before is not None:
                rows = db.execute(
                    "SELECT r.rowid AS seq,r.* FROM resources r "
                    "JOIN conversations c ON c.id=r.conversation_id "
                    "WHERE (? IS NULL OR r.rowid<?) AND (? IS NULL OR c.workspace_path=?) "
                    "AND instr(lower(r.name),lower(?))>0 ORDER BY r.rowid DESC LIMIT ?",
                    (before, before, workspace, workspace, query.strip(), limit + 1),
                ).fetchall()
                items = [dict(row) for row in reversed(rows[:limit])]
                return {
                    "items": items,
                    "next_cursor": None,
                    "previous_cursor": str(items[0]["seq"]) if len(rows) > limit else None,
                }
            rows = db.execute(
                "SELECT r.rowid AS seq,r.* FROM resources r "
                "JOIN conversations c ON c.id=r.conversation_id "
                "WHERE r.rowid>? AND (? IS NULL OR c.workspace_path=?) "
                "AND instr(lower(r.name),lower(?))>0 ORDER BY r.rowid LIMIT ?",
                (cursor, workspace, workspace, query.strip(), limit + 1),
            ).fetchall()
            return self._page(rows, limit)

    def _check_resource_scope(self, db, resource, conversation_id):
        owner = self._require(db, "conversations", resource["conversation_id"])
        target = self._require(db, "conversations", conversation_id)
        if owner["workspace_path"] != target["workspace_path"]:
            raise StoreError("attachment_scope", "Choose an attachment from this conversation or project", 403)

    def list_conversations(self, cursor=0, limit=50, *, before=None, latest=False, project_id=None):
        with self._connection() as db:
            if project_id is not None:
                self._require(db, "projects", project_id)
            if latest or before is not None:
                rows = db.execute(
                    "SELECT rowid AS seq,* FROM conversations WHERE (? IS NULL OR project_id=?) AND (? IS NULL OR rowid<?) ORDER BY rowid DESC LIMIT ?",
                    (project_id, project_id, before, before, limit + 1),
                ).fetchall()
                items = [_record(row) for row in reversed(rows[:limit])]
                return {
                    "items": items,
                    "next_cursor": None,
                    "previous_cursor": str(items[0]["seq"]) if len(rows) > limit else None,
                }
            rows = db.execute(
                "SELECT rowid AS seq,* FROM conversations WHERE (? IS NULL OR project_id=?) AND rowid>? ORDER BY rowid LIMIT ?",
                (project_id, project_id, cursor, limit + 1),
            ).fetchall()
            return self._page(rows, limit)

    def recent_conversations(self, limit=10):
        with self._connection() as db:
            rows = db.execute(
                "SELECT rowid AS seq,* FROM conversations ORDER BY updated_at DESC,rowid DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return {"items": [_record(row) for row in rows], "next_cursor": None}

    def search_conversations(self, query, *, sort="relevance", limit=50):
        """Search titles and message text across the complete local history."""
        terms = query.strip().split()
        if not terms:
            return {"items": []}
        # LIKE is sufficient for a single person's local history. Escape wildcards so
        # a typed percent or underscore cannot turn into a broad history query.
        escaped = [term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") for term in terms]
        title_filter = " AND ".join("c.title LIKE ? ESCAPE '\\'" for _ in escaped)
        message_filter = " AND ".join("content LIKE ? ESCAPE '\\'" for _ in escaped)
        patterns = [f"%{term}%" for term in escaped]
        if sort == "relevance":
            order = f"CASE WHEN {title_filter} THEN 1 ELSE 0 END DESC, c.updated_at DESC"
            rank_args = patterns
        else:
            order = f"c.updated_at {'ASC' if sort == 'oldest' else 'DESC'}"
            rank_args = []
        with self._connection() as db:
            rows = db.execute(
                "SELECT c.id,c.title,c.agent_id,c.updated_at,m.id AS message_id,"
                "m.seq AS message_seq,m.content FROM conversations c "
                "LEFT JOIN messages m ON m.seq=(SELECT matching.seq FROM messages matching "
                "WHERE matching.conversation_id=c.id AND matching.status!='rejected' "
                f"AND {message_filter} ORDER BY matching.seq DESC LIMIT 1) "
                f"WHERE ({title_filter}) OR EXISTS (SELECT 1 FROM messages "
                "WHERE conversation_id=c.id AND status!='rejected' "
                f"AND {message_filter}) "
                f" ORDER BY {order} LIMIT ?",
                (*patterns, *patterns, *patterns, *rank_args, limit),
            ).fetchall()
        lowered = [term.casefold() for term in terms]
        results = []
        for row in rows:
            title = row["title"]
            content = row["content"] or ""
            text = " ".join(content.split())
            first = min((text.casefold().find(term) for term in lowered if term in text.casefold()), default=0)
            start = max(0, first - 32)
            snippet = ("…" if start else "") + text[start:start + 150] + ("…" if len(text) > start + 150 else "")
            results.append({
                "conversation_id": row["id"], "title": title, "agent_id": row["agent_id"],
                "updated_at": row["updated_at"], "message_id": row["message_id"],
                "message_seq": row["message_seq"], "snippet": snippet,
            })
        return {"items": results}

    def _conversation_model(self, db, conversation, kind, override=None, *, use_preference=True):
        if override:
            return override
        if use_preference and kind == "chat" and conversation["model_id"]:
            return conversation["model_id"]
        if conversation["agent_id"]:
            assigned = self._require(db, "agents", conversation["agent_id"])["model_id"]
            if assigned:
                if assigned not in self.runtime_settings(db).models:
                    raise StoreError("unknown_model", "助手模型已停用或移除，请重新选择模型。", 422)
                return assigned
        return self._role_model(db, kind)

    def _enqueue(self, db, conversation_id, message_id, content, kind, request_json, model_override=None, reasoning_override=None, search_provider_id=None):
        run_id, now = str(uuid4()), timestamp()
        conversation = self._require(db, "conversations", conversation_id)
        model_id = self._conversation_model(db, conversation, kind, model_override)
        reasoning_effort = reasoning_override if reasoning_override is not None else (
            conversation["reasoning_effort"]
            if kind == "chat" else None
        )
        if reasoning_override is None and reasoning_effort is not None:
            config = self.runtime_settings(db).models.get(model_id)
            if config is not None and reasoning_effort not in config.reasoning_levels:
                reasoning_effort = None
        db.execute(
            "INSERT INTO messages(id,conversation_id,role,content,intent,run_id,status,created_at,request_json) VALUES(?,?,'user',?,'queue',?,'accepted',?,?)",
            (message_id, conversation_id, content, run_id, now, request_json),
        )
        db.execute(
            "INSERT INTO runs(id,conversation_id,message_id,kind,prompt,created_at,model_id,reasoning_effort,search_provider_id) VALUES(?,?,?,?,?,?,?,?,?)",
            (run_id, conversation_id, message_id, kind, content, now, model_id, reasoning_effort, search_provider_id),
        )
        from .catalog import snapshot

        snapshot(db, run_id, model_id)
        from .models import model_key

        models = self.runtime_settings(db).models
        db.execute("INSERT INTO run_agent_assignments SELECT ?,id,model_id FROM agents", (run_id,))
        for child in db.execute("SELECT DISTINCT model_id FROM agents WHERE model_id IS NOT NULL"):
            if child[0] in models:
                config = models[child[0]]
                db.execute("INSERT INTO agent_model_configs VALUES(?,?,?,?)", (run_id, child[0], _json(config.model_dump(mode="json")), model_key(config)))
        db.execute("UPDATE conversations SET updated_at=? WHERE id=?", (now, conversation_id))
        return run_id

    def submit_message(
        self, conversation_id, *, id, content, intent="queue", kind="chat", target_run_id=None,
        model_id=None, reasoning_effort=None, search_provider_id=None, attachments=None, source_run_id=None,
    ):
        attachments = attachments or []
        if (source_run_id is None and len(attachments) > 8) or len(set(attachments)) != len(attachments):
            raise StoreError("invalid_attachments", "Choose at most eight distinct attachments", 422)
        if not content.strip() and not attachments:
            raise StoreError("empty_message", "Provide text or attachments", 422)
        request_json = _json(
            {
                "conversation_id": conversation_id,
                "content": content,
                "intent": intent,
                "kind": kind,
                "target_run_id": target_run_id,
                **({"model_id": model_id} if model_id is not None else {}),
                **({"reasoning_effort": reasoning_effort} if reasoning_effort is not None else {}),
                **({"search_provider_id": search_provider_id} if search_provider_id is not None else {}),
                **({"attachments": attachments} if attachments else {}),
                **({"source_run_id": source_run_id} if source_run_id else {}),
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
            if source_run_id:
                source = self._require(db, "runs", source_run_id)
                if source["conversation_id"] != conversation_id or source["kind"] != "chat" or source["status"] != "running" or kind != "task" or intent != "queue":
                    raise StoreError("invalid_task_source", "Background tasks must originate in this active chat", 422)
            resources = []
            for identifier in attachments:
                resource = self._require(db, "resources", identifier)
                self._check_resource_scope(db, resource, conversation_id)
                resources.append(dict(resource))
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
                conversation = self._require(db, "conversations", conversation_id)
                models = self.runtime_settings(db).models
                if model_id is not None and model_id not in models:
                    raise StoreError("unknown_model", "Choose an enabled model", 422)
                selected_model = self._conversation_model(db, conversation, kind, model_id)
                if reasoning_effort is not None and (
                    selected_model not in models
                    or reasoning_effort not in models[selected_model].reasoning_levels
                ):
                    raise StoreError("unsupported_reasoning", "This model does not support that thinking depth", 422)
                if search_provider_id is not None:
                    self._require(db, "search_providers", search_provider_id)
                run_id = self._enqueue(db, conversation_id, id, content, kind, request_json, model_id, reasoning_effort, search_provider_id)
            if any(item["mime_type"].startswith("image/") for item in resources):
                from .config import ModelConfig

                saved = db.execute("SELECT config_json FROM run_model_configs WHERE run_id=?", (run_id,)).fetchone()
                config = ModelConfig.model_validate_json(saved[0]) if saved and saved[0] != "null" else None
                if config is not None and not config.image_input:
                    raise StoreError("image_not_supported", "当前模型未启用图片输入，请选择支持图片的模型。", 422)
            db.execute("UPDATE messages SET attachments_json=? WHERE id=?", (_json(resources), id))
            if intent != "steer":
                db.execute("UPDATE runs SET attachments_json=? WHERE id=?", (_json(resources), run_id))
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

    def run_attachments(self, run_id):
        with self._connection() as db:
            rows = db.execute("SELECT attachments_json FROM messages WHERE run_id=? AND role='user' AND status!='rejected' ORDER BY seq", (run_id,)).fetchall()
            return list({item["id"]: item for row in rows for item in json.loads(row[0])}.values())

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
                WHERE r.kind=? AND r.status='queued' AND r.phase NOT IN ('approval','input') AND c.blocked=0
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

    def add_event(self, run_id, type, data, *, allow_terminal=False):
        with self._connection(write=True) as db:
            run = self._require(db, "runs", run_id)
            if run["status"] == "running" or allow_terminal:
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
        if status in {"cancelled", "completed", "failed"}:
            db.execute("DELETE FROM run_agent_assignments WHERE run_id=?", (run["id"],))
            db.execute("DELETE FROM agent_model_configs WHERE run_id=?", (run["id"],))
            db.execute("DELETE FROM run_model_configs WHERE run_id=?", (run["id"],))
            db.execute("UPDATE approvals SET state='cancelled',decided_at=? WHERE run_id=? AND state='pending'", (now, run["id"]))
            db.execute("UPDATE input_requests SET state='cancelled' WHERE run_id=? AND state='pending'", (run["id"],))
        db.execute(
            "UPDATE messages SET status='rejected' WHERE run_id=? AND status='accepted'",
            (run["id"],),
        )
        # Withdrawing a queued follow-up changes no active execution or prior failure block.
        should_block = status != "completed" and not (
            status == "cancelled" and run["status"] == "queued" and run["started_at"] is None
        )
        db.execute(
            "UPDATE conversations SET blocked=MAX(blocked,?),updated_at=? WHERE id=?",
            (int(should_block), now, run["conversation_id"]),
        )
        if status in {"completed", "failed"} and result is not None:
            artifacts = [json.loads(row[0])["resource"] for row in db.execute(
                "SELECT data FROM events WHERE run_id=? AND type='artifact' ORDER BY seq", (run["id"],)
            )]
            attachments = list({item["id"]: item for item in artifacts}.values())
            db.execute(
                "INSERT INTO messages(id,conversation_id,role,content,intent,run_id,status,created_at,attachments_json) VALUES(?,?,'assistant',?,'queue',?,'applied',?,?)",
                (str(uuid4()), run["conversation_id"], result, run["id"], now, _json(attachments)),
            )
        self._event(db, run["id"], status, {"result": result, "error": error})

    def finish_run(self, run_id, status, result=None, error=None):
        if status not in TERMINAL:
            raise ValueError("finish_run requires a terminal status")
        with self._connection(write=True) as db:
            run = self._require(db, "runs", run_id)
            self._finish(db, run, status, result, error)

    def enable_recovery(self, run_id):
        with self._connection(write=True) as db:
            db.execute("UPDATE runs SET recovery_enabled=1 WHERE id=? AND status='running'", (run_id,))

    def pause_run(self, run_id):
        with self._connection(write=True) as db:
            run = self._require(db, "runs", run_id)
            if run["cancel_requested"]:
                self._finish(db, run, "cancelled")
                return
            pending = db.execute("SELECT 1 FROM approvals WHERE run_id=? AND state='pending'", (run_id,)).fetchone()
            db.execute("UPDATE runs SET status='queued',phase=? WHERE id=?", ("approval" if pending else "input" if db.execute("SELECT 1 FROM input_requests WHERE run_id=? AND state='pending'", (run_id,)).fetchone() else "recovering", run_id))
            phase = db.execute("SELECT phase FROM runs WHERE id=?", (run_id,)).fetchone()[0]
            self._event(db, run_id, "paused", {"reason": phase if phase in {"approval", "input"} else "resume"})

    def interrupt_run(self, run_id):
        with self._connection(write=True) as db:
            self._recover_run(db, self._require(db, "runs", run_id))

    def _recover_run(self, db, run):
        if run["cancel_requested"]:
            self._finish(db, run, "cancelled")
        elif run["recovery_enabled"] and run["recovery_count"] < 3:
            pending = db.execute("SELECT 1 FROM approvals WHERE run_id=? AND state='pending'", (run["id"],)).fetchone()
            db.execute("UPDATE runs SET status='queued',phase=?,recovery_count=recovery_count+1,finished_at=NULL WHERE id=?", ("approval" if pending else "input" if db.execute("SELECT 1 FROM input_requests WHERE run_id=? AND state='pending'", (run["id"],)).fetchone() else "recovering", run["id"]))
            self._event(db, run["id"], "recovering", {"attempt": run["recovery_count"] + 1})
        else:
            self._finish(db, run, "interrupted", error="运行未能安全自动恢复，已保留步骤回执。请检查后继续原任务。")

    def resume_run(self, run_id):
        with self._connection(write=True) as db:
            run = self._require(db, "runs", run_id)
            if run["status"] == "queued" and run["phase"] == "recovering":
                return _record(run)
            if run["status"] != "interrupted" or not run["recovery_enabled"] or run["cancel_requested"]:
                raise StoreError("cannot_resume", "只有带恢复记录的中断任务可以继续", 422)
            if db.execute("SELECT 1 FROM runs WHERE conversation_id=? AND seq>? AND started_at IS NOT NULL", (run["conversation_id"], run["seq"])).fetchone():
                raise StoreError("context_advanced", "该会话已执行后续任务，请发送新要求核对结果", 409)
            db.execute("UPDATE runs SET status='queued',phase='recovering',finished_at=NULL,error=NULL,recovery_count=0 WHERE id=?", (run_id,))
            # Resuming this exact run also restores its unconsumed instructions.
            # Terminal interruption rejected them for UI clarity; they must not be lost.
            db.execute("UPDATE messages SET status='accepted' WHERE run_id=? AND intent='steer' AND status='rejected'", (run_id,))
            db.execute("UPDATE conversations SET blocked=0 WHERE id=?", (run["conversation_id"],))
            self._event(db, run_id, "recovering", {"requested": True})
            return _record(self._require(db, "runs", run_id))

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
                self._recover_run(db, row)

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

    def list_schedules(self, cursor=0, limit=50, *, ids=None):
        with self._connection() as db:
            clause = " AND id IN (" + ",".join("?" for _ in ids) + ")" if ids else ""
            rows = db.execute(
                f"SELECT rowid AS seq,* FROM schedules WHERE rowid>?{clause} ORDER BY rowid LIMIT ?",
                (cursor, *(ids or []), limit + 1),
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
