"""Immutable uploaded resources; model payloads are hydrated only at call time."""

import base64
import hashlib
import io
import mimetypes
import os
import tempfile
import warnings
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

from filelock import FileLock
from langchain_core.messages import HumanMessage
from PIL import Image, ImageOps, UnidentifiedImageError

from .config import Settings
from .store import Store, StoreError

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
MAX_IMAGE_PIXELS = 24_000_000


def image_preview(data: bytes) -> bytes:
    """Decode bounded pixels, remove metadata and normalize orientation for all protocols."""
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(data)) as source:
            if source.width * source.height > MAX_IMAGE_PIXELS:
                raise ValueError("Image exceeds the 24 megapixel limit")
            source.seek(0)
            image = ImageOps.exif_transpose(source).convert("RGB")
            image.thumbnail((2048, 2048))
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=88)
            return output.getvalue()


def register_upload(
    settings: Settings,
    conversation_id: str,
    identifier: str,
    upload: dict,
    temporary: Path,
    digest: str,
) -> dict:
    data = temporary.read_bytes()
    mime = mimetypes.guess_type(upload["name"])[0] or "application/octet-stream"
    preview = None
    if Path(upload["name"]).suffix.lower() in IMAGE_SUFFIXES:
        try:
            preview = image_preview(data)
        except (
            ValueError,
            OSError,
            UnidentifiedImageError,
            Image.DecompressionBombError,
            Image.DecompressionBombWarning,
        ) as exc:
            raise StoreError(
                "invalid_image", "图片无法读取或超过 2400 万像素，请换一张图片。", 422
            ) from exc
        with Image.open(io.BytesIO(data)) as original:
            mime = Image.MIME.get(original.format, "application/octet-stream")
    elif mime.startswith("image/"):
        # SVG/HEIC and other unsupported images remain ordinary downloadable files.
        mime = "application/octet-stream"
    root = settings.data_dir / "resources"
    root.mkdir(exist_ok=True)
    with FileLock(root / f"{identifier}.lock", timeout=5):
        destination = root / identifier
        if destination.exists():
            if hashlib.sha256(destination.read_bytes()).hexdigest() != digest:
                raise StoreError(
                    "upload_conflict", "This resource ID already has different content"
                )
        else:
            _atomic_write(destination, data)
        if preview is not None:
            _atomic_write(root / f"{identifier}.jpg", preview)
        return Store(settings).register_resource(
            identifier,
            conversation_id,
            **upload,
            mime_type=mime,
            sha256=digest,
        )


def _atomic_write(path: Path, data: bytes) -> None:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
            temporary = Path(output.name)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def resource_bytes(settings: Settings, resource: dict, *, preview=False) -> bytes:
    path = settings.data_dir / "resources" / (resource["id"] + (".jpg" if preview else ""))
    data = path.read_bytes()
    if not preview and hashlib.sha256(data).hexdigest() != resource["sha256"]:
        raise StoreError("resource_changed", "Original resource failed its integrity check")
    return data


def capture_file(settings: Settings, conversation_id: str, path: str) -> dict:
    from .files import read_file

    store = Store(settings)
    workspace = store.workspace_for(conversation_id)
    location, data = read_file(settings, workspace, path)
    digest = hashlib.sha256(data).hexdigest()
    identifier = str(uuid5(NAMESPACE_URL, f"{conversation_id}/{path}/{digest}"))
    with tempfile.NamedTemporaryFile(dir=settings.data_dir) as source:
        source.write(data)
        source.flush()
        return register_upload(
            settings,
            conversation_id,
            identifier,
            {"path": path, "name": location.name, "size": len(data)},
            Path(source.name),
            digest,
        )


def input_message(content: str, identifier: str, attachments: list[dict]) -> HumanMessage:
    labels = "\n".join(
        f"附件：{item['name']} (resource_id={item['id']}, 工作文件={item['path']})"
        for item in attachments
    )
    return HumanMessage(
        content="\n\n".join(part for part in (content, labels) if part),
        id=identifier,
        additional_kwargs={"zhixing_attachments": attachments} if attachments else {},
    )


def hydrate_messages(settings: Settings, messages: list, *, image_input: bool) -> list:
    result = []
    for message in messages:
        if not image_input and isinstance(message.content, list):
            # view_image tool results also survive model switches in the checkpoint.
            blocks = [
                item
                for item in message.content
                if not isinstance(item, dict) or item.get("type") not in {"image_url", "image"}
            ]
            if len(blocks) != len(message.content):
                blocks.append(
                    {
                        "type": "text",
                        "text": "当前模型无法查看历史工具返回的图片，不要猜测图片内容。",
                    }
                )
                message = message.model_copy(update={"content": blocks})
        attachments = message.additional_kwargs.get("zhixing_attachments", [])
        images = [item for item in attachments if item["mime_type"].startswith("image/")]
        if not images:
            result.append(message)
            continue
        blocks = [{"type": "text", "text": message.content}]
        if image_input:
            for item in images:
                data = resource_bytes(settings, item, preview=True)
                blocks.append(
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": "data:image/jpeg;base64," + base64.b64encode(data).decode(),
                        },
                    }
                )
        else:
            blocks.append(
                {
                    "type": "text",
                    "text": "当前模型不支持查看历史图片；附件引用仍保留，不要猜测图片内容。",
                }
            )
        result.append(
            message.model_copy(
                update={
                    "content": blocks,
                    "additional_kwargs": {
                        key: value
                        for key, value in message.additional_kwargs.items()
                        if key != "zhixing_attachments"
                    },
                }
            )
        )
    return result


def create_image_tool(settings: Settings, workspace: Path, conversation_id: str):
    from langchain_core.tools import tool

    from .tools import FileAccess

    @tool
    def view_image(path: str = "", resource_id: str = "") -> list[dict]:
        """View an uploaded resource by its resource_id or a generated PNG/JPEG/WebP image by workspace-relative path. Use this to inspect actual rendered pages and charts."""
        if resource_id:
            item = Store(settings).get_resource(resource_id, conversation_id)
            if not item["mime_type"].startswith("image/"):
                raise ValueError("Resource is not a supported image")
            data = resource_bytes(settings, item, preview=True)
        else:
            _, raw = FileAccess(settings, workspace).read_bytes(
                path.removeprefix("/workspace/"), limit=20 * 1024 * 1024
            )
            data = image_preview(raw)
        return [
            {
                "type": "image_url",
                "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(data).decode()},
            }
        ]

    return view_image
