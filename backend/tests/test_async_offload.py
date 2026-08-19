"""F4/F5：同步阻塞卸到线程。

不 import app.services.rag_service / app.main：CI 收集阶段会拉起
llama-index + sentence_transformers，与 datasets 冲突。
F4 行为用源码结构断言；loop-lag 数字走 scripts/measure_async_block.py。
"""

from __future__ import annotations

import ast
import asyncio
import io
import time
from pathlib import Path

import pytest
from fastapi import HTTPException, UploadFile
from starlette.datastructures import Headers

BACKEND = Path(__file__).resolve().parents[1]


def _class_fn(tree: ast.AST, class_name: str, fn_name: str) -> ast.AST:
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            for item in node.body:
                if (
                    isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and item.name == fn_name
                ):
                    return item
    raise AssertionError(f"{class_name}.{fn_name} not found")


def _calls_name(fn: ast.AST, name: str) -> bool:
    for node in ast.walk(fn):
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id == name:
                return True
            if isinstance(func, ast.Attribute) and func.attr == name:
                return True
        if isinstance(node, ast.Attribute) and node.attr == name:
            return True
        if isinstance(node, ast.Name) and node.id == name:
            return True
    return False


def test_initialize_offloads_sync_load_via_to_thread():
    src = (BACKEND / "app" / "services" / "rag_service.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    initialize = _class_fn(tree, "RagService", "initialize")
    load_sync = _class_fn(tree, "RagService", "_load_models_sync")
    assert isinstance(initialize, ast.AsyncFunctionDef)
    assert isinstance(load_sync, ast.FunctionDef)
    assert _calls_name(initialize, "to_thread")
    assert _calls_name(initialize, "_load_models_sync")
    assert not _calls_name(initialize, "HuggingFaceEmbedding")
    assert _calls_name(load_sync, "HuggingFaceEmbedding")
    assert _calls_name(load_sync, "FlagEmbeddingReranker")


def test_lifespan_still_warms_rag_before_yield():
    src = (BACKEND / "app" / "main.py").read_text(encoding="utf-8")
    assert "await RagService.initialize()" in src
    init_at = src.index("await RagService.initialize()")
    yield_at = src.index("yield")
    assert init_at < yield_at


def _module_fn(tree: ast.AST, fn_name: str) -> ast.AST:
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == fn_name:
            return node
    raise AssertionError(f"{fn_name} not found")


async def test_to_thread_keeps_event_loop_ticking():
    """对照：同一把 loop-lag 尺子，to_thread 不应出现接近 sleep 时长的空洞。"""
    interval = 0.05
    samples: list[float] = []

    async def ping() -> None:
        deadline = time.perf_counter() + 0.5
        while time.perf_counter() < deadline:
            t0 = time.perf_counter()
            await asyncio.sleep(interval)
            samples.append(time.perf_counter() - t0)

    ping_task = asyncio.create_task(ping())
    await asyncio.to_thread(time.sleep, 0.3)
    await ping_task
    assert samples
    assert max(samples) < 0.2


def test_save_file_uses_to_thread():
    src = (BACKEND / "app" / "services" / "file_service.py").read_text(encoding="utf-8")
    fn = _class_fn(ast.parse(src), "FileService", "save_file")
    assert isinstance(fn, ast.AsyncFunctionDef)
    assert _calls_name(fn, "to_thread")
    assert _calls_name(fn, "prepare_image_bytes")
    assert _calls_name(fn, "write_bytes")


def test_prepare_upload_images_uses_to_thread():
    src = (BACKEND / "app" / "services" / "image_guard.py").read_text(encoding="utf-8")
    fn = _module_fn(ast.parse(src), "prepare_upload_images")
    assert isinstance(fn, ast.AsyncFunctionDef)
    assert _calls_name(fn, "to_thread")
    assert _calls_name(fn, "prepare_image_bytes")


def test_upload_route_offloads_duplicate_prepare():
    src = (BACKEND / "app" / "routers" / "task.py").read_text(encoding="utf-8")
    fn = _module_fn(ast.parse(src), "upload_tasks")
    assert _calls_name(fn, "to_thread")
    assert _calls_name(fn, "prepare_image_bytes")


async def test_save_file_pillow_does_not_stall_event_loop(monkeypatch, tmp_path):
    from app.services import file_service
    from app.services.image_guard import PreparedImage

    monkeypatch.setattr(file_service, "UPLOAD_DIR", tmp_path)

    def slow_prepare(content: bytes, original_name: str | None = None) -> PreparedImage:
        time.sleep(0.3)
        return PreparedImage(
            content=b"ok",
            content_type="image/jpeg",
            suffix=".jpg",
            original_name=original_name,
        )

    monkeypatch.setattr(file_service, "prepare_image_bytes", slow_prepare)

    samples: list[float] = []

    async def ping() -> None:
        deadline = time.perf_counter() + 0.45
        while time.perf_counter() < deadline:
            t0 = time.perf_counter()
            await asyncio.sleep(0.05)
            samples.append(time.perf_counter() - t0)

    upload = UploadFile(
        file=io.BytesIO(b"fake-bytes"),
        filename="a.jpg",
        headers=Headers({"content-type": "image/jpeg"}),
    )
    ping_task = asyncio.create_task(ping())
    await file_service.FileService.save_file(upload)
    await ping_task
    assert samples
    assert max(samples) < 0.2


async def test_save_file_propagates_http_exception(monkeypatch, tmp_path):
    from app.services import file_service

    monkeypatch.setattr(file_service, "UPLOAD_DIR", tmp_path)

    def boom(content: bytes, original_name: str | None = None):
        raise HTTPException(status_code=400, detail="图片不能为空")

    monkeypatch.setattr(file_service, "prepare_image_bytes", boom)
    upload = UploadFile(
        file=io.BytesIO(b"x"),
        filename="a.jpg",
        headers=Headers({"content-type": "image/jpeg"}),
    )
    with pytest.raises(HTTPException) as exc:
        await file_service.FileService.save_file(upload)
    assert exc.value.status_code == 400
