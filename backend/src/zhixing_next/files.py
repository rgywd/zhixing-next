"""Workspace-only file transfer; execution grants do not expand mobile downloads."""

import hashlib
import os
import re
import stat
from pathlib import Path

from filelock import FileLock

from .config import Settings
from .store import StoreError
from .tools import FileAccess

MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_LIST_FILES = 200
MAX_LIST_DIRECTORIES = 200


def workspace_access(settings: Settings, workspace: Path) -> FileAccess:
    return FileAccess(settings.model_copy(update={"grants": []}), workspace)


def validate_filename(name: str) -> str:
    if (
        not name
        or len(name) > 200
        or name in {".", ".."}
        or name != name.strip()
        or name.endswith(".")
        or name.startswith(".zhixing-")
        or re.search(r'[\x00-\x1f/\\:<>"|?*]', name)
        or re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", name, re.IGNORECASE)
    ):
        raise StoreError(
            "invalid_filename", "Provide a plain file name without directory components", 422
        )
    return name


def _mkdir(access: FileAccess, parent: Path, name: str):
    child, root = access.authorize(str(parent / name), write=True)
    with access._directory(parent, root) as directory:
        try:
            if isinstance(directory, int):
                os.mkdir(name, mode=0o700, dir_fd=directory)
                os.fsync(directory)
            else:
                child.mkdir(mode=0o700)
        except FileExistsError:
            pass
    child, _ = access.authorize(str(child), write=True)
    if not child.is_dir():
        raise StoreError("upload_conflict", "Upload location is already occupied")
    return child


def complete_upload(
    settings: Settings, workspace: Path, file_id: str, name: str, temporary: Path, digest: str
):
    """Publish once; a retry reads the committed file instead of rewriting it."""
    access = workspace_access(settings, workspace)
    lock_dir = settings.data_dir / "upload-locks"
    lock_dir.mkdir(exist_ok=True)
    lock_name = hashlib.sha256(f"{workspace}\0{file_id}".encode()).hexdigest()
    with FileLock(lock_dir / f"{lock_name}.lock", timeout=5):
        uploads = _mkdir(access, workspace, "uploads")
        directory = _mkdir(access, uploads, file_id)
        target = directory / name
        access.authorize(str(target), write=True)
        existing = []
        with (
            access._directory(directory, workspace) as directory_handle,
            os.scandir(directory_handle) as entries,
        ):
            for entry in entries:
                if not entry.name.startswith(".zhixing-"):
                    existing.append(entry.name)
                    if len(existing) > 1:
                        break
        if existing:
            if len(existing) != 1 or existing[0] != name:
                raise StoreError("upload_conflict", "This file ID has already been used")
            _, previous = access.read_bytes(str(target), limit=MAX_UPLOAD_BYTES)
            if hashlib.sha256(previous).hexdigest() != digest:
                raise StoreError(
                    "upload_conflict", "This file ID has already been used for different content"
                )
            size = len(previous)
        else:
            data = temporary.read_bytes()
            access.write_bytes(str(target), data, limit=MAX_UPLOAD_BYTES)
            size = len(data)
    return {"path": target.relative_to(workspace).as_posix(), "name": name, "size": size}


def list_files(settings: Settings, workspace: Path):
    access = workspace_access(settings, workspace)
    pending = ["."]
    items, visited, truncated = [], 0, False
    while pending and len(items) < MAX_LIST_FILES and visited < MAX_LIST_DIRECTORIES:
        relative = pending.pop()
        visited += 1
        listing = access.list_directory(relative)
        truncated |= listing["truncated"]
        for entry in listing["entries"]:
            if entry["name"].startswith(".zhixing-"):
                continue
            candidate = Path(relative) / entry["name"]
            try:
                path, _ = access.authorize(candidate.as_posix())
                info = path.lstat()
            except (PermissionError, FileNotFoundError):
                continue
            if stat.S_ISDIR(info.st_mode):
                pending.append(candidate.as_posix())
            elif stat.S_ISREG(info.st_mode):
                items.append(
                    {
                        "path": path.relative_to(workspace).as_posix(),
                        "name": path.name,
                        "size": info.st_size,
                    }
                )
            if len(items) >= MAX_LIST_FILES:
                truncated = True
                break
    return {
        "items": sorted(items, key=lambda item: item["path"]),
        "next_cursor": None,
        "truncated": truncated or bool(pending),
    }


def read_file(settings: Settings, workspace: Path, relative: str):
    if not relative or "\\" in relative or ":" in relative or Path(relative).is_absolute():
        raise PermissionError("Choose a relative workspace path")
    return workspace_access(settings, workspace).read_bytes(relative, limit=MAX_UPLOAD_BYTES)
