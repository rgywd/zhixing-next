"""Authenticated, provider-independent HTTP surface for the personal assistant."""

import asyncio
import hashlib
import hmac
import os
import sqlite3
import tempfile
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from filelock import Timeout
from starlette.exceptions import HTTPException

from . import files
from .config import Settings, load_settings
from .models import model_ready
from .schemas import (
    AgentInput,
    AgentUpdate,
    AssistantInput,
    ConversationInput,
    ConversationModelInput,
    MessageInput,
    ModelRoleInput,
    ProjectInput,
    ScheduleInput,
    ScheduleUpdate,
)
from .store import Store, StoreError

Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[int, Query(ge=0)]


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings if settings is not None else load_settings()
    store = Store(settings)
    app = FastAPI(title="知行 Next", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store = store
    app.state.settings = settings

    def error(status, code, message):
        return JSONResponse(
            status_code=status, content={"error": {"code": code, "message": message}}
        )

    @app.exception_handler(StoreError)
    async def store_error(_request: Request, exc: StoreError):
        return error(exc.status, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, _exc: RequestValidationError):
        # Validation errors can include input values; don't reflect tokens or arbitrary file content.
        return error(422, "validation_error", "Invalid request fields or query parameters")

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, exc: HTTPException):
        return error(exc.status_code, "http_error", "Request could not be handled")

    @app.exception_handler(sqlite3.OperationalError)
    async def database_error(_request: Request, _exc: sqlite3.OperationalError):
        return error(
            503,
            "storage_unavailable",
            "Storage is temporarily unavailable; retry the same request ID",
        )

    @app.exception_handler(Exception)
    async def server_error(_request: Request, _exc: Exception):
        return error(500, "internal_error", "The server could not complete the request")

    @app.exception_handler(PermissionError)
    async def file_permission_error(_request: Request, _exc: PermissionError):
        return error(
            403,
            "file_access_denied",
            "This file is outside the allowed workspace or is a protected path",
        )

    @app.exception_handler(FileNotFoundError)
    async def file_missing_error(_request: Request, _exc: FileNotFoundError):
        return error(404, "file_not_found", "The requested file was not found")

    @app.exception_handler(FileExistsError)
    async def file_exists_error(_request: Request, _exc: FileExistsError):
        return error(409, "upload_conflict", "The upload location is already occupied")

    @app.exception_handler(Timeout)
    async def file_busy_error(_request: Request, _exc: Timeout):
        return error(503, "upload_busy", "The file is being uploaded; retry using the same file ID")

    security = HTTPBearer(auto_error=False)

    def authenticate(
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(security)],
    ):
        if not settings.api_token:
            raise StoreError(
                "service_unconfigured", "Service access token has not been configured", 503
            )
        if credentials is None or not hmac.compare_digest(
            credentials.credentials.encode(), settings.api_token.encode()
        ):
            raise StoreError("unauthorized", "A valid service access token is required", 401)

    router = APIRouter(prefix="/v1", dependencies=[Depends(authenticate)])

    def check_window(cursor, before, latest):
        if (cursor and (latest or before is not None)) or (latest and before is not None):
            raise StoreError("validation_error", "Use cursor, before, or latest individually", 422)

    @app.get("/healthz")
    def health():
        return {"status": "ok"}

    @router.get("/status")
    def status():
        from .tools import capability_status

        roles = store.model_roles()
        ready = all(model_ready(settings, role, roles.get(role)) for role in ("chat", "task"))
        capability = capability_status(settings)
        return {
            "model_ready": ready,
            "worker_online": store.worker_online(),
            "sqlite_version": sqlite3.sqlite_version,
            "sqlite_journal_mode": store.journal_mode,
            **capability,
        }

    @router.get("/assistant")
    def assistant():
        return store.get_assistant()

    @router.put("/assistant")
    def update_assistant(body: AssistantInput):
        return store.set_assistant(**body.model_dump())

    @router.get("/models")
    def models():
        return {
            "items": [
                {
                    "id": identifier,
                    "name": config.display_name or config.model,
                    "model": config.model,
                    "provider": config.provider or {
                        "chat_completions": "OpenAI 兼容",
                        "responses": "OpenAI Responses",
                        "gemini": "Gemini",
                    }[config.protocol],
                    "protocol": config.protocol,
                    "ready": bool(os.environ.get(config.api_key_env, "").strip()),
                    "reasoning_levels": config.reasoning_levels,
                    "default_reasoning_effort": config.reasoning_effort,
                }
                for identifier, config in settings.models.items()
            ],
            "roles": store.model_roles(),
        }

    @router.put("/models/roles/{role}")
    def update_model_role(role: Literal["chat", "task", "memory"], body: ModelRoleInput):
        return store.set_model_role(role, body.model_id)

    @router.get("/agents")
    def agents():
        return store.list_agents()

    @router.post("/agents", status_code=201)
    def create_agent(body: AgentInput):
        return store.create_agent(**body.model_dump())

    @router.get("/agents/{agent_id}")
    def agent(agent_id: str):
        return store.get_agent(agent_id)

    @router.put("/agents/{agent_id}")
    def update_agent(agent_id: str, body: AgentUpdate):
        return store.update_agent(agent_id, **body.model_dump())

    @router.delete("/agents/{agent_id}")
    def delete_agent(agent_id: str):
        store.delete_agent(agent_id)
        return {"deleted": True}

    @router.get("/finance/observations")
    def finance_observations():
        return store.list_finance_observations()

    @router.get("/projects")
    def projects(cursor: Cursor = 0, limit: Limit = 50):
        return store.list_projects(cursor, limit)

    @router.post("/projects", status_code=201)
    def create_project(body: ProjectInput):
        return store.create_project(body.name)

    @router.get("/conversations")
    def conversations(
        cursor: Cursor = 0,
        limit: Limit = 50,
        before: Annotated[int | None, Query(ge=1)] = None,
        latest: bool = False,
    ):
        check_window(cursor, before, latest)
        return store.list_conversations(cursor, limit, before=before, latest=latest)

    @router.post("/conversations", status_code=201)
    def create_conversation(body: ConversationInput):
        return store.create_conversation(**body.model_dump())

    @router.get("/conversations/{conversation_id}")
    def conversation(conversation_id: str):
        return store.get_conversation(conversation_id)

    @router.put("/conversations/{conversation_id}/model")
    def update_conversation_model(conversation_id: str, body: ConversationModelInput):
        return store.set_conversation_model(conversation_id, **body.model_dump())

    @router.get("/conversations/{conversation_id}/files")
    def workspace_files(conversation_id: str):
        return files.list_files(settings, store.workspace_for(conversation_id))

    @router.get("/conversations/{conversation_id}/files/content")
    def download_file(
        conversation_id: str, path: Annotated[str, Query(min_length=1, max_length=2000)]
    ):
        try:
            location, content = files.read_file(
                settings, store.workspace_for(conversation_id), path
            )
        except ValueError as exc:
            raise StoreError(
                "file_too_large", "File exceeds the 20 MiB download limit", 413
            ) from exc
        except IsADirectoryError as exc:
            raise StoreError("not_a_file", "Choose a regular file", 422) from exc
        return Response(
            content,
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": "attachment; filename*=UTF-8''"
                + quote(location.name, safe=""),
                "X-Content-Type-Options": "nosniff",
            },
        )

    @router.put("/conversations/{conversation_id}/files/{file_id}")
    async def upload_file(
        conversation_id: str,
        file_id: UUID,
        request: Request,
        filename: Annotated[str, Query(min_length=1, max_length=200)],
    ):
        name = files.validate_filename(filename)
        workspace = store.workspace_for(conversation_id)
        if (
            request.headers.get("content-type", "").split(";")[0].lower()
            != "application/octet-stream"
        ):
            raise StoreError(
                "unsupported_media_type", "Upload raw bytes as application/octet-stream", 415
            )
        length = request.headers.get("content-length")
        if length is not None:
            try:
                if int(length) < 0 or int(length) > files.MAX_UPLOAD_BYTES:
                    raise StoreError("file_too_large", "File exceeds the 20 MiB upload limit", 413)
            except ValueError as exc:
                raise StoreError("validation_error", "Invalid Content-Length header", 422) from exc
        staging = settings.data_dir / "upload-staging"
        staging.mkdir(exist_ok=True)
        digest, size = hashlib.sha256(), 0
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=staging, delete=False) as output:
                temporary = Path(output.name)
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > files.MAX_UPLOAD_BYTES:
                        raise StoreError(
                            "file_too_large", "File exceeds the 20 MiB upload limit", 413
                        )
                    digest.update(chunk)
                    await asyncio.to_thread(output.write, chunk)
            return await asyncio.to_thread(
                files.complete_upload,
                settings,
                workspace,
                str(file_id),
                name,
                temporary,
                digest.hexdigest(),
            )
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    @router.get("/conversations/{conversation_id}/messages")
    def messages(
        conversation_id: str,
        cursor: Cursor = 0,
        limit: Limit = 50,
        before: Annotated[int | None, Query(ge=1)] = None,
        latest: bool = False,
    ):
        check_window(cursor, before, latest)
        return store.list_messages(conversation_id, cursor, limit, before=before, latest=latest)

    @router.post("/conversations/{conversation_id}/messages")
    def submit_message(conversation_id: str, body: MessageInput):
        return store.submit_message(conversation_id, **body.model_dump())

    @router.post("/conversations/{conversation_id}/resume")
    def resume(conversation_id: str):
        return store.resume_conversation(conversation_id)

    @router.get("/runs")
    def runs(
        conversation_id: str | None = None,
        cursor: Cursor = 0,
        limit: Limit = 50,
        before: Annotated[int | None, Query(ge=1)] = None,
        latest: bool = False,
        status: Literal["queued", "running", "completed", "failed", "cancelled", "interrupted"]
        | None = None,
    ):
        check_window(cursor, before, latest)
        return store.list_runs(
            conversation_id, cursor, limit, before=before, latest=latest, status=status
        )

    @router.get("/runs/{run_id}")
    def run(run_id: str):
        return store.get_run(run_id)

    @router.post("/runs/{run_id}/cancel")
    def cancel(run_id: str):
        return store.cancel_run(run_id)

    @router.get("/runs/{run_id}/events")
    def events(run_id: str, after: Cursor = 0, limit: Limit = 100):
        return store.list_events(run_id, after, limit)

    @router.get("/schedules")
    def schedules(cursor: Cursor = 0, limit: Limit = 50):
        return store.list_schedules(cursor, limit)

    @router.post("/schedules", status_code=201)
    def create_schedule(body: ScheduleInput):
        return store.create_schedule(**body.model_dump())

    @router.patch("/schedules/{schedule_id}")
    def update_schedule(schedule_id: str, body: ScheduleUpdate):
        return store.update_schedule(schedule_id, body.enabled)

    app.include_router(router)
    return app
