"""Small real deliverables for chat agents, without Shell or virtual scratch files."""

import asyncio
import csv
import hashlib
import io
from pathlib import Path
from typing import Annotated

from filelock import FileLock
from langchain_core.tools import tool
from pydantic import Field

from .resources import capture_file, resource_bytes
from .tools import MAX_FILE_BYTES, FileAccess


def create_report_tool(settings, run, workspace, emit):
    access = FileAccess(settings, workspace)

    def publish(filename, content):
        if Path(filename).name != filename or "\\" in filename or len(filename.encode("utf-8")) > 180 or any(ord(char) < 32 for char in filename):
            raise ValueError("Use a filename without folders or control characters")
        suffix = Path(filename).suffix.lower()
        if suffix not in {".md", ".txt", ".csv"} or not content.strip() or "\0" in content:
            raise ValueError("Provide nonempty UTF-8 Markdown, plain text or CSV content")
        data = content.encode("utf-8")
        if len(data) > MAX_FILE_BYTES:
            raise ValueError("Report exceeds the 256 KiB limit")
        checks = ["utf8", "readback_sha256", "immutable_resource_sha256"]
        if suffix == ".csv":
            rows = list(csv.reader(io.StringIO(content), strict=True))
            if not rows or len(rows) > 10000:
                raise ValueError("CSV must contain 1–10000 rows")
            checks.append("csv_parse")
        digest = hashlib.sha256(data).hexdigest()
        relative = f"report-{digest[:20]}-{filename}"
        target, _ = access.authorize(relative, write=True)
        lock_root = settings.data_dir / "operation-locks"
        lock_root.mkdir(exist_ok=True, mode=0o700)
        with FileLock(lock_root / f"report-{digest}.lock", timeout=5):
            if target.exists():
                if access.read_bytes(relative, limit=MAX_FILE_BYTES)[1] != data:
                    raise ValueError("Existing report changed; no file was overwritten")
            else:
                access.write_bytes(relative, data, limit=MAX_FILE_BYTES)
            if hashlib.sha256(access.read_bytes(relative, limit=MAX_FILE_BYTES)[1]).hexdigest() != digest:
                raise ValueError("Report changed after writing")
            resource = capture_file(settings, run["conversation_id"], relative)
            if resource["sha256"] != digest or resource_bytes(settings, resource) != data:
                raise ValueError("Published resource failed its integrity check")
        return {"resource": resource, "verification": {"sha256": digest, "size": len(data), "format": suffix[1:], "checks": checks}}

    @tool
    async def publish_report(
        filename: Annotated[str, Field(min_length=1, max_length=120)],
        content: Annotated[str, Field(min_length=1, max_length=MAX_FILE_BYTES)],
    ) -> dict:
        """Create and deliver a real downloadable .md/.txt/.csv report in this conversation. Supply the complete report content, not a virtual file path. UTF-8 up to 256 KiB. Writes are content-addressed, read back and hash checked; repeated identical publications reuse one immutable resource. This tool does not execute code or validate the accuracy of the report's claims."""
        receipt = await asyncio.to_thread(publish, filename, content)
        await emit("artifact", receipt)
        return receipt

    return publish_report
