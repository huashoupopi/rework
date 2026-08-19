"""2.6 顺手小修：上传真实类型/大小、裸 except、kill 后 wait、去掉共享 Redis aclose。"""

from __future__ import annotations

import inspect
from io import BytesIO

import pytest
from fastapi import HTTPException
from PIL import Image

from app.core import database as database_mod
from app.services import knowledge_service
from app.services.image_guard import MAX_IMAGE_SIZE_MB, prepare_image_bytes
from app.tasks import knowledge_task


def _png_bytes() -> bytes:
    buf = BytesIO()
    Image.new("RGB", (2, 2), color=(10, 20, 30)).save(buf, format="PNG")
    return buf.getvalue()


def test_prepare_image_rejects_non_image_magic():
    with pytest.raises(HTTPException) as exc:
        prepare_image_bytes(b"%PDF-1.4 not-an-image", "x.pdf")
    assert exc.value.status_code == 400


def test_prepare_image_rejects_oversized():
    huge = b"\xff\xd8\xff" + b"\x00" * (MAX_IMAGE_SIZE_MB * 1024 * 1024 + 1)
    with pytest.raises(HTTPException) as exc:
        prepare_image_bytes(huge, "big.jpg")
    assert exc.value.status_code == 400


def test_prepare_image_reencodes_png():
    prepared = prepare_image_bytes(_png_bytes(), "a.png")
    assert prepared.content_type == "image/png"
    assert prepared.suffix == ".png"
    assert prepared.content.startswith(b"\x89PNG")


def test_get_db_does_not_use_bare_except():
    src = inspect.getsource(database_mod.get_db)
    assert "except Exception" in src
    assert "except:" not in src.replace("except Exception", "")


def test_knowledge_timeout_waits_after_kill():
    src = inspect.getsource(knowledge_task.run_knowledge_rebuild)
    kill_at = src.index("process.kill()")
    wait_at = src.index("process.wait()")
    assert wait_at > kill_at


def test_knowledge_service_does_not_aclose_shared_redis():
    running_src = inspect.getsource(knowledge_service.set_rebuild_running)
    check_src = inspect.getsource(knowledge_service.is_rebuild_running)
    assert "aclose" not in running_src
    assert "aclose" not in check_src
