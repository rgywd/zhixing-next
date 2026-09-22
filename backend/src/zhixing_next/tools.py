"""Small, bounded host file tools. These are not a command sandbox."""

from __future__ import annotations

import contextlib
import io
import os
import platform
import stat
import uuid
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterator

from langchain_core.tools import tool

if TYPE_CHECKING:
    from .config import Settings

MAX_FILE_BYTES = 256 * 1024
MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
MAX_DIRECTORY_ENTRIES = 200
_PRIVATE_DIRS = {
    ".ssh",
    ".aws",
    ".azure",
    ".config",
    ".codex",
    ".gnupg",
    ".git",
    ".docker",
    ".kube",
    "__pycache__",
}
_PRIVATE_NAMES = {
    "credentials",
    "credentials.json",
    "auth.json",
    "config.toml",
    "zhixing_token",
    "id_rsa",
    "id_ed25519",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".git-credentials",
}


def capability_status(settings: Settings) -> dict[str, Any]:
    return {
        "execution_available": False,
        "file_tools_available": True,
        "execution_reason": "Shell is disabled until an operating-system sandbox is configured and verified.",
    }


class FileAccess:
    """Authorize real paths before I/O; reject links and sensitive service files.

    POSIX opens traverse directory descriptors with O_NOFOLLOW. Windows checks
    reparse points and opened-file identity; this is a file API for a trusted
    single-user host, not isolation from a hostile local process changing paths.
    """

    def __init__(self, settings: Settings, workspace: Path):
        self.settings = settings
        self.workspace = workspace.absolute()
        self.roots = [(self.workspace, True)] + [
            (g.path.absolute(), g.writable) for g in settings.grants
        ]

    @staticmethod
    def _private(path: Path) -> bool:
        return any(
            part.lower() in _PRIVATE_DIRS
            or part.lower() in _PRIVATE_NAMES
            or part.lower().startswith(".env")
            or part.lower().endswith((".pem", ".key", ".p12", ".pfx"))
            for part in path.parts
        )

    @staticmethod
    def _assert_no_links(path: Path) -> None:
        for part in (path, *path.parents):
            try:
                info = part.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(
                stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0
            ):
                raise PermissionError("Symbolic links and reparse points are not allowed.")
            if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
                raise PermissionError("Hard-linked files are not allowed.")

    def authorize(self, supplied: str, *, write: bool = False) -> tuple[Path, Path]:
        if not supplied or "\x00" in supplied or any(part == ".." for part in Path(supplied).parts):
            raise PermissionError("A valid path without parent traversal is required.")
        requested = Path(supplied)
        # Windows alternate data streams and drive-relative paths are ambiguous.
        if os.name == "nt" and (
            ":" in str(requested).replace(requested.drive, "", 1)
            or requested.drive
            and not requested.is_absolute()
            or any(
                part.endswith((" ", "."))
                for part in requested.parts
                if part not in {requested.anchor, "."}
            )
            or any(
                part.split(".", 1)[0].upper()
                in {
                    "CON",
                    "PRN",
                    "AUX",
                    "NUL",
                    *(f"COM{i}" for i in range(1, 10)),
                    *(f"LPT{i}" for i in range(1, 10)),
                }
                for part in requested.parts
            )
        ):
            raise PermissionError(
                "Reserved, alternate-stream, or ambiguous Windows paths are not allowed."
            )
        path = requested if requested.is_absolute() else self.workspace / requested
        self._assert_no_links(path)
        path = path.resolve()
        if self._private(path):
            raise PermissionError(
                "Credential and private service paths are not available to file tools."
            )
        config_file = getattr(self.settings, "config_file", None)
        if config_file is not None and path == config_file.resolve():
            raise PermissionError("The service configuration is not available to file tools.")
        data_dir = self.settings.data_dir.resolve()
        if path.is_relative_to(data_dir) and not path.is_relative_to(
            self.settings.workspace_root.resolve()
        ):
            raise PermissionError("The service data directory is not available to file tools.")
        source_dir = Path(__file__).resolve().parent
        if path.is_relative_to(source_dir):
            raise PermissionError("The service source directory is not available to file tools.")
        allowed = []
        for root, writable in self.roots:
            self._assert_no_links(root)
            root = root.resolve()
            if path.is_relative_to(root) and (not write or writable):
                allowed.append(root)
        if not allowed:
            raise PermissionError("Path is outside the permitted read/write directories.")
        return path, max(allowed, key=lambda root: len(root.parts))

    @contextlib.contextmanager
    def _parent(self, path: Path, root: Path) -> Iterator[int | None]:
        if os.name != "posix":
            self._assert_no_links(path.parent)
            yield None
            return
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        fd = os.open(root, flags)
        try:
            for part in path.parent.relative_to(root).parts:
                child = os.open(part, flags, dir_fd=fd)
                os.close(fd)
                fd = child
            yield fd
        finally:
            os.close(fd)

    @contextlib.contextmanager
    def _directory(self, path: Path, root: Path) -> Iterator[int | Path]:
        if os.name != "posix":
            self._assert_no_links(path)
            yield path
            return
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        if path == root:
            fd = os.open(path, flags)
        else:
            with self._parent(path, root) as parent:
                fd = os.open(path.name, flags, dir_fd=parent)
        try:
            yield fd
        finally:
            os.close(fd)

    def list_directory(self, supplied: str = ".") -> dict[str, Any]:
        path, root = self.authorize(supplied)
        entries = []
        # Bounded output and scanning; callers navigate directories explicitly.
        scanned = 0
        with self._directory(path, root) as directory, os.scandir(directory) as listing:
            for entry in listing:
                scanned += 1
                if scanned > MAX_DIRECTORY_ENTRIES:
                    break
                try:
                    child, _ = self.authorize(str(path / entry.name))
                    info = child.lstat()
                except (PermissionError, FileNotFoundError):
                    continue
                entries.append(
                    {
                        "name": entry.name,
                        "kind": "directory" if stat.S_ISDIR(info.st_mode) else "file",
                        "bytes": info.st_size,
                    }
                )
        return {"path": str(path), "entries": entries, "truncated": scanned > MAX_DIRECTORY_ENTRIES}

    def read_bytes(self, supplied: str, *, limit: int = MAX_DOCUMENT_BYTES) -> tuple[Path, bytes]:
        path, root = self.authorize(supplied)
        if path == root:
            raise IsADirectoryError("Choose a text file within a permitted directory.")
        with self._parent(path, root) as directory:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
            fd = os.open(path.name if directory is not None else path, flags, dir_fd=directory)
            with os.fdopen(fd, "rb") as file:
                info = os.fstat(file.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink > 1:
                    raise PermissionError("Only ordinary, non-linked files are supported.")
                if os.name != "posix":
                    self._assert_no_links(path)
                    if not os.path.samestat(info, path.stat()):
                        raise PermissionError("The file changed during authorization.")
                data = file.read(limit + 1)
        if len(data) > limit:
            raise ValueError(f"File exceeds the {limit}-byte limit.")
        return path, data

    def read_text(self, supplied: str) -> dict[str, Any]:
        path, data = self.read_bytes(supplied, limit=MAX_FILE_BYTES)
        return {"path": str(path), "content": data.decode("utf-8"), "bytes": len(data)}

    def write_text(self, supplied: str, content: str, *, overwrite: bool = False) -> dict[str, Any]:
        return self.write_bytes(
            supplied, content.encode("utf-8"), overwrite=overwrite, limit=MAX_FILE_BYTES
        )

    def write_bytes(
        self,
        supplied: str,
        data: bytes,
        *,
        overwrite: bool = False,
        limit: int = MAX_DOCUMENT_BYTES,
    ) -> dict[str, Any]:
        if len(data) > limit:
            raise ValueError(f"Content exceeds the {limit}-byte limit.")
        path, root = self.authorize(supplied, write=True)
        if path == root:
            raise IsADirectoryError("Choose a file within a permitted directory.")
        if path.exists() and not overwrite:
            raise FileExistsError(
                "File exists; set overwrite=true only when replacement is intended."
            )
        temp_name = f".zhixing-{uuid.uuid4().hex}.tmp"
        with self._parent(path, root) as directory:
            temp = temp_name if directory is not None else path.parent / temp_name
            target = path.name if directory is not None else path
            fd = os.open(
                temp,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0),
                0o600,
                dir_fd=directory,
            )
            try:
                with os.fdopen(fd, "wb") as file:
                    file.write(data)
                    file.flush()
                    os.fsync(file.fileno())
                self.authorize(supplied, write=True)
                if overwrite:
                    os.replace(temp, target, src_dir_fd=directory, dst_dir_fd=directory)
                else:
                    # Link publication is atomic and cannot clobber a racing writer.
                    os.link(
                        temp,
                        target,
                        src_dir_fd=directory,
                        dst_dir_fd=directory,
                        follow_symlinks=False,
                    )
                    os.unlink(temp, dir_fd=directory)
                if directory is not None:
                    os.fsync(directory)
            finally:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(temp, dir_fd=directory)
        return {"path": str(path), "bytes": len(data), "replaced": overwrite}

    def read_document(self, supplied: str, *, start: int = 1, count: int = 10) -> dict[str, Any]:
        if start < 1 or not 1 <= count <= 20:
            raise ValueError("start must be at least 1; count must be between 1 and 20.")
        path, data = self.read_bytes(supplied)
        suffix = path.suffix.lower()
        if suffix == ".docx":
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = archive.infolist()
                if (
                    len(entries) > 1000
                    or sum(entry.file_size for entry in entries) > 20 * 1024 * 1024
                ):
                    raise ValueError("DOCX exceeds archive entry or expanded-size limits.")
                document = archive.getinfo("word/document.xml")
                if document.file_size > 5 * 1024 * 1024 or document.flag_bits & 1:
                    raise ValueError("DOCX body is too large or encrypted.")
                with archive.open(document) as member:
                    body = member.read(5 * 1024 * 1024 + 1)
                if len(body) > 5 * 1024 * 1024:
                    raise ValueError("DOCX body exceeds the expanded-size limit.")
            xml = body.decode("utf-8-sig")
            if "<!DOCTYPE" in xml.upper() or "<!ENTITY" in xml.upper():
                raise ValueError("XML declarations containing entities are not supported.")
            root = ET.fromstring(xml)
            namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            # Preserve paragraph/table cell order without interpreting embedded objects.
            paragraphs = [
                "".join(text.text or "" for text in paragraph.findall(".//w:t", namespace))
                for paragraph in root.findall(".//w:p", namespace)
            ]
            unit = "paragraph"
            total = len(paragraphs)
            selected = paragraphs[start - 1 : start - 1 + count]
        elif suffix == ".pdf":
            from pypdf import PdfReader, apply_configuration

            with apply_configuration(
                maximum_declared_stream_length=2 * 1024 * 1024,
                array_based_stream_maximum_output_length=2 * 1024 * 1024,
                zlib_maximum_output_length=2 * 1024 * 1024,
                lzw_maximum_output_length=2 * 1024 * 1024,
                run_length_maximum_output_length=2 * 1024 * 1024,
                image_maximum_buffer_size=2 * 1024 * 1024,
                page_tree_maximum_entries=2000,
                page_tree_maximum_depth=32,
                xform_maximum_invocations_per_extraction=100,
                jbig2dec_binary=None,
            ):
                reader = PdfReader(io.BytesIO(data), strict=True)
                if reader.is_encrypted:
                    raise ValueError("Encrypted PDFs are not supported.")
                total = len(reader.pages)
                if total > 2000:
                    raise ValueError("PDF exceeds the 2000-page limit.")
                unit = "page"
                selected = []
                for page in reader.pages[start - 1 : start - 1 + count]:
                    stream = page.get_contents()
                    if stream is not None and len(stream.get_data()) > 2 * 1024 * 1024:
                        raise ValueError("PDF page content exceeds the extraction limit.")
                    selected.append(page.extract_text() or "")
        else:
            raise ValueError(
                "Only PDF and DOCX text extraction is supported; use read_text_file for UTF-8 files."
            )
        remaining = 20000
        items = []
        for index, text in enumerate(selected, start):
            if remaining <= 0:
                break
            excerpt = text[:remaining]
            items.append({"number": index, "text": excerpt, "truncated": len(excerpt) < len(text)})
            remaining -= len(excerpt)
        next_start = start + len(items)
        return {
            "path": str(path),
            "format": suffix[1:],
            "unit": unit,
            "total_units": total,
            "items": items,
            "next_start": next_start if next_start <= total else None,
            "truncated": len(items) < len(selected) or any(item["truncated"] for item in items),
            "note": "Text extraction only; layout, images, and OCR are not included. Empty PDF pages may be scanned images requiring OCR.",
        }


def create_file_tools(settings: Settings, workspace: Path) -> list[Any]:
    access = FileAccess(settings, workspace)

    @tool
    def inspect_environment() -> dict[str, Any]:
        """Inspect OS and permitted directories, without reading environment variables or credentials."""
        return {
            "os": platform.system(),
            "architecture": platform.machine(),
            "workspace": str(access.workspace),
            "directories": [
                {"path": str(root), "writable": writable} for root, writable in access.roots
            ],
            **capability_status(settings),
        }

    @tool
    def list_directory(path: str = ".") -> dict[str, Any]:
        """List up to 200 entries in a permitted physical directory; relative paths use the project workspace."""
        return access.list_directory(path)

    @tool
    def read_text_file(path: str) -> dict[str, Any]:
        """Read a UTF-8 physical file up to 256 KiB in an authorized directory."""
        return access.read_text(path)

    @tool
    def write_text_file(path: str, content: str, overwrite: bool = False) -> dict[str, Any]:
        """Atomically write a UTF-8 physical file up to 256 KiB; its parent directory must already exist."""
        return access.write_text(path, content, overwrite=overwrite)

    @tool
    def read_document(path: str, start: int = 1, count: int = 10) -> dict[str, Any]:
        """Extract bounded text from PDF pages or DOCX paragraphs, with 1-based start and at most 20 units; no OCR or image interpretation."""
        return access.read_document(path, start=start, count=count)

    return [inspect_environment, list_directory, read_text_file, write_text_file, read_document]
