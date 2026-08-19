"""上传图片：真实类型 / 大小 / 重编码。加锁前就能跑完的校验放这里。"""

from __future__ import annotations

import io
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from fastapi import HTTPException, UploadFile
from PIL import Image

from app.core.config import settings

ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_IMAGE_SIZE_MB = 10
_MAX_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024

_TYPE_TO_SUFFIX = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
_TYPE_TO_FORMAT = {
    "image/jpeg": "JPEG",
    "image/png": "PNG",
    "image/webp": "WEBP",
}


@dataclass(frozen=True)
class PreparedImage:
    content: bytes
    content_type: str
    suffix: str
    original_name: str | None


def sniff_image_type(content: bytes) -> str:
    if len(content) >= 3 and content[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if len(content) >= 8 and content[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp"
    raise HTTPException(status_code=400, detail="不支持的图片类型")


def strip_and_reencode(image_bytes: bytes, content_type: str) -> bytes:
    img = Image.open(io.BytesIO(image_bytes))
    if img.mode in ("RGBA", "P") and content_type != "image/png":
        img = img.convert("RGB")
    elif img.mode == "P":
        img = img.convert("RGBA")
    buf = io.BytesIO()
    fmt = _TYPE_TO_FORMAT[content_type]
    save_kwargs: dict = {}
    if fmt == "JPEG":
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        save_kwargs["quality"] = 90
    img.save(buf, format=fmt, **save_kwargs)
    return buf.getvalue()


def prepare_image_bytes(content: bytes, original_name: str | None = None) -> PreparedImage:
    if not content:
        raise HTTPException(status_code=400, detail="图片不能为空")
    if len(content) > _MAX_BYTES:
        raise HTTPException(status_code=400, detail=f"图片大小超过 {MAX_IMAGE_SIZE_MB} MB")
    content_type = sniff_image_type(content)
    encoded = strip_and_reencode(content, content_type)
    return PreparedImage(
        content=encoded,
        content_type=content_type,
        suffix=_TYPE_TO_SUFFIX[content_type],
        original_name=original_name,
    )


async def prepare_upload_images(images: list[UploadFile]) -> list[PreparedImage]:
    prepared: list[PreparedImage] = []
    for img_file in images:
        if not img_file.filename:
            continue
        content = await img_file.read()
        prepared.append(prepare_image_bytes(content, img_file.filename))
    return prepared


def persist_chat_images(user_id: int, prepared: list[PreparedImage]) -> list[tuple[str, str | None]]:
    user_chat_dir = Path(settings.UPLOAD_DIR) / "chat" / str(user_id)
    user_chat_dir.mkdir(parents=True, exist_ok=True)
    saved: list[tuple[str, str | None]] = []
    for item in prepared:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        unique_name = f"{timestamp}_{uuid.uuid4().hex[:8]}{item.suffix}"
        file_path = user_chat_dir / unique_name
        file_path.write_bytes(item.content)
        relative_path = f"uploads/chat/{user_id}/{unique_name}"
        saved.append((relative_path, item.original_name))
    return saved
