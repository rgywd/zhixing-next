"""Server-owned provider/model catalog and private, immutable run configurations."""

import json
import os
from uuid import uuid4

from pydantic import ValidationError

from .config import ModelConfig
from .models import model_key
from .reasoning import reasoning_metadata
from .store import StoreError

DEFAULT_URLS = {
    "chat_completions": "https://api.openai.com/v1",
    "responses": "https://api.openai.com/v1",
    "gemini": "https://generativelanguage.googleapis.com",
}
PROTOCOL_NAMES = {"chat_completions": "OpenAI 兼容", "responses": "OpenAI Responses", "gemini": "Gemini"}


def migrate(db, settings):
    # IF NOT EXISTS also permits old migration regression fixtures to reconstruct v1-v9.
    db.execute("CREATE TABLE IF NOT EXISTS model_providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,protocol TEXT NOT NULL,base_url TEXT NOT NULL,api_key TEXT,api_key_env TEXT,enabled INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1)")
    db.execute("CREATE TABLE IF NOT EXISTS provider_models(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE,config_json TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1)")
    db.execute("CREATE TABLE IF NOT EXISTS run_model_configs(run_id TEXT PRIMARY KEY REFERENCES runs(id),config_json TEXT NOT NULL,api_key TEXT)")
    grouped = {}
    for identifier, config in settings.models.items():
        name = config.provider or PROTOCOL_NAMES[config.protocol]
        group = (name, config.protocol, config.base_url or DEFAULT_URLS[config.protocol], config.api_key_env)
        if group not in grouped:
            provider_id = str(uuid4())
            db.execute("INSERT INTO model_providers(id,name,protocol,base_url,api_key_env) VALUES(?,?,?,?,?)", (provider_id, *group))
            grouped[group] = provider_id
        db.execute("INSERT INTO provider_models(id,provider_id,config_json) VALUES(?,?,?)", (identifier, grouped[group], json.dumps(model_fields(config))))
    for role, identifier in settings.roles.items():
        if identifier in settings.models:
            db.execute("INSERT OR IGNORE INTO model_roles(role,model_id) VALUES(?,?)", (role, identifier))
    for run in db.execute("SELECT id,model_id FROM runs WHERE status IN ('queued','running') OR (status='interrupted' AND recovery_enabled=1)").fetchall():
        snapshot(db, run["id"], run["model_id"])


def model_fields(config):
    return config.model_dump(include={"model", "display_name", "temperature", "reasoning_effort", "reasoning_levels", "timeout", "image_input", "context_window"})


def config_for(provider, model):
    return ModelConfig(**json.loads(model["config_json"]), protocol=provider["protocol"],
                       provider=provider["name"], base_url=provider["base_url"],
                       api_key=provider["api_key"], api_key_env=provider["api_key_env"])


def active_configs(db):
    configs = {}
    for provider in db.execute("SELECT * FROM model_providers WHERE enabled=1 ORDER BY rowid"):
        for model in db.execute("SELECT * FROM provider_models WHERE provider_id=? AND enabled=1 ORDER BY rowid", (provider["id"],)):
            configs[model["id"]] = config_for(provider, model)
    return configs


def snapshot(db, run_id, model_id):
    model = db.execute("SELECT * FROM provider_models WHERE id=?", (model_id,)).fetchone()
    if model is None:
        db.execute("INSERT OR IGNORE INTO run_model_configs(run_id,config_json) VALUES(?,'null')", (run_id,))
        return
    provider = db.execute("SELECT * FROM model_providers WHERE id=?", (model["provider_id"],)).fetchone()
    config = config_for(provider, model)
    # Freeze even a missing credential; later environment changes cannot retarget it.
    db.execute("INSERT OR IGNORE INTO run_model_configs(run_id,config_json,api_key) VALUES(?,?,?)", (run_id, config.model_dump_json(exclude={"api_key_env"}), model_key(config) or None))


def public_model(identifier, config, **extra):
    return dict(id=identifier, name=config.display_name or config.model, model=config.model,
                provider=config.provider or PROTOCOL_NAMES[config.protocol], protocol=config.protocol,
                ready=bool(model_key(config)), image_input=config.image_input, context_window=config.context_window,
                reasoning_levels=config.reasoning_levels, default_reasoning_effort=config.reasoning_effort,
                **reasoning_metadata(config),
                **extra)


class Catalog:
    def __init__(self, store):
        self.store = store

    def _provider(self, db, identifier):
        return self.store._require(db, "model_providers", identifier)

    def _public(self, db, provider):
        models = [public_model(row["id"], config_for(provider, row), enabled=bool(row["enabled"]),
                               temperature=json.loads(row["config_json"]).get("temperature"),
                               timeout=json.loads(row["config_json"]).get("timeout", 60))
                  for row in db.execute("SELECT * FROM provider_models WHERE provider_id=? ORDER BY rowid", (provider["id"],))]
        key = provider["api_key"] or os.environ.get(provider["api_key_env"] or "", "").strip()
        return dict(id=provider["id"], name=provider["name"], protocol=provider["protocol"],
                    base_url=provider["base_url"], enabled=bool(provider["enabled"]), revision=provider["revision"],
                    has_api_key=bool(key), credential_source="stored" if provider["api_key"] else "environment" if provider["api_key_env"] else "none",
                    models=models)

    def list(self):
        with self.store._connection() as db:
            return {"items": [self._public(db, row) for row in db.execute("SELECT * FROM model_providers ORDER BY rowid")]}

    def get(self, identifier):
        with self.store._connection() as db:
            return self._public(db, self._provider(db, identifier))

    def _check_revision(self, provider, revision):
        if provider["revision"] != revision:
            raise StoreError("catalog_changed", "配置已在别处更新，请刷新后再修改。")

    def create(self, body):
        identifier = str(uuid4())
        with self.store._connection(write=True) as db:
            db.execute("INSERT INTO model_providers(id,name,protocol,base_url,api_key,enabled) VALUES(?,?,?,?,?,?)", (identifier, body.name, body.protocol, body.base_url, body.api_key, body.enabled))
            return self._public(db, self._provider(db, identifier))

    def update(self, identifier, body):
        with self.store._connection(write=True) as db:
            previous = self._provider(db, identifier)
            self._check_revision(previous, body.revision)
            key = body.api_key if body.api_key is not None else previous["api_key"]
            env = previous["api_key_env"] if body.api_key is None else None
            if body.clear_api_key:
                key, env = None, None
            # Reject incompatible protocol changes instead of erasing model capability choices.
            candidate = dict(previous, name=body.name, protocol=body.protocol, base_url=body.base_url, api_key=key, api_key_env=env)
            for model in db.execute("SELECT * FROM provider_models WHERE provider_id=?", (identifier,)):
                try:
                    config_for(candidate, model)
                except ValidationError:
                    raise StoreError("incompatible_models", "现有模型的思考设置不支持该协议，请先修改模型或新建供应商。", 422) from None
            db.execute("UPDATE model_providers SET name=?,protocol=?,base_url=?,api_key=?,api_key_env=?,enabled=?,revision=revision+1 WHERE id=?", (body.name, body.protocol, body.base_url, key, env, body.enabled, identifier))
            self._clear_unavailable(db)
            return self._public(db, self._provider(db, identifier))

    def delete(self, identifier, revision):
        with self.store._connection(write=True) as db:
            self._check_revision(self._provider(db, identifier), revision)
            db.execute("DELETE FROM model_providers WHERE id=?", (identifier,))
            self._clear_unavailable(db)

    def save_models(self, identifier, body, model_id=None):
        with self.store._connection(write=True) as db:
            provider = self._provider(db, identifier)
            self._check_revision(provider, body.revision)
            inputs = [body.model] if model_id else body.models
            if model_id:
                old = self.store._require(db, "provider_models", model_id)
                if old["provider_id"] != identifier:
                    raise StoreError("not_found", "模型不属于该供应商。", 404)
            known = {json.loads(row[0])["model"] for row in db.execute("SELECT config_json FROM provider_models WHERE provider_id=? AND id!=?", (identifier, model_id or ""))}
            for item in inputs:
                if item.model in known and (not model_id or item.model != json.loads(old["config_json"])["model"]):
                    if model_id:
                        raise StoreError("duplicate_model", "该供应商中已有相同模型 ID。", 409)
                    continue  # Discovery retries and repeated selections are idempotent.
                try:
                    config = ModelConfig(**item.model_dump(exclude={"enabled"}), protocol=provider["protocol"])
                except ValidationError:
                    raise StoreError("invalid_model", "模型参数或思考档位不适用于该协议。", 422) from None
                config_json = json.dumps(model_fields(config))
                if model_id:
                    db.execute("UPDATE provider_models SET config_json=?,enabled=? WHERE id=?", (config_json, item.enabled, model_id))
                    db.execute("UPDATE conversations SET reasoning_effort=NULL WHERE model_id=? AND reasoning_effort NOT IN (SELECT value FROM json_each(?))", (model_id, json.dumps(config.reasoning_levels)))
                else:
                    db.execute("INSERT INTO provider_models(id,provider_id,config_json,enabled) VALUES(?,?,?,?)", (str(uuid4()), identifier, config_json, item.enabled))
                known.add(item.model)
            db.execute("UPDATE model_providers SET revision=revision+1 WHERE id=?", (identifier,))
            self._clear_unavailable(db)
            return self._public(db, self._provider(db, identifier))

    def delete_model(self, identifier, model_id, revision):
        with self.store._connection(write=True) as db:
            self._check_revision(self._provider(db, identifier), revision)
            model = self.store._require(db, "provider_models", model_id)
            if model["provider_id"] != identifier:
                raise StoreError("not_found", "模型不属于该供应商。", 404)
            db.execute("DELETE FROM provider_models WHERE id=?", (model_id,))
            db.execute("UPDATE model_providers SET revision=revision+1 WHERE id=?", (identifier,))
            self._clear_unavailable(db)
            return self._public(db, self._provider(db, identifier))

    def _clear_unavailable(self, db):
        db.execute("UPDATE conversations SET model_id=NULL,reasoning_effort=NULL WHERE model_id IS NOT NULL AND model_id NOT IN (SELECT m.id FROM provider_models m JOIN model_providers p ON m.provider_id=p.id WHERE m.enabled=1 AND p.enabled=1)")
        # Explicit empty role prevents a TOML fallback from silently re-enabling a removed default.
        db.execute("UPDATE model_roles SET model_id='' WHERE model_id NOT IN (SELECT m.id FROM provider_models m JOIN model_providers p ON m.provider_id=p.id WHERE m.enabled=1 AND p.enabled=1)")

    def connection(self, identifier, model_id=None):
        with self.store._connection() as db:
            provider = self._provider(db, identifier)
            if model_id:
                model = self.store._require(db, "provider_models", model_id)
                if model["provider_id"] != identifier:
                    raise StoreError("not_found", "模型不属于该供应商。", 404)
                return config_for(provider, model)
            return ModelConfig(protocol=provider["protocol"], model="discovery", base_url=provider["base_url"], api_key=provider["api_key"], api_key_env=provider["api_key_env"])
