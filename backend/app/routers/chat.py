import asyncio
import io
import logging
import re
import time
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import AsyncSessionLocal, get_db
from app.core.rate_limit import rate_limit
from app.core.redis import get_redis
from app.crud import chat as chat_crud
from app.models import task, user
from app.routers.auth import get_current_user
from app.schemas.chat import ChatHistoryResponse, ChatMessageSchema
from app.services.rag_service import RagService
from app.utils.stream_parser import ThinkStreamParser

logger = logging.getLogger(__name__)


def _deduplicate_content(content: str) -> str:
    """去重模型重复生成的回答段落。

    某些模型（特别是通过 LM Studio 运行的推理模型）会生成重复的回答，
    表现为同一段内容出现两次或多次。此函数检测并移除重复段。
    """
    text = content.strip()
    if not text:
        return text

    length = len(text)
    # 尝试从中间位置找到重复的前缀
    for split_pos in range(length // 3, length * 2 // 3):
        first_half = text[:split_pos].strip()
        second_half = text[split_pos:].strip()
        if first_half and second_half and first_half == second_half:
            logger.info("检测到重复回答 len=%d→%d", length, len(first_half))
            return first_half

    return text


router = APIRouter(tags=["chat"])

_ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
_MAX_IMAGE_SIZE_MB = 10
_USER_IMAGE_QUOTA = 100  # 每个用户最多保留 100 张聊天图片


def _strip_and_reencode(image_bytes: bytes, suffix: str) -> bytes:
    """
    剥离 EXIF 元数据 + 重编码图片。

    为什么需要这一步？
    - EXIF 字段可以嵌入任意文本（ImageDescription、UserComment 等）
    - Pillow 重新保存时会自动丢弃 EXIF 和隐藏数据
    - 重编码还能消除某些图片格式的隐写术载荷

    为什么不只用 piexif.remove()？
    - piexif 只处理 EXIF，不处理其他元数据（XMP、IPTC）
    - 重编码是更彻底的方案：所有非像素数据都丢弃
    """
    img = Image.open(io.BytesIO(image_bytes))
    # 转为 RGB（去除 alpha 通道中可能的隐藏数据）
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")
    buf = io.BytesIO()
    fmt = "PNG" if suffix.lower() == ".png" else "JPEG"
    img.save(buf, format=fmt, quality=90)
    return buf.getvalue()


@router.post("/chat/stream")
async def chat_stream(
    request: Request,
    question: str = Form(...),
    task_id: int | None = Form(None),
    images: list[UploadFile] = File(default=[]),
    current_user: user.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    normalized_question = question.strip()
    if not normalized_question:
        logger.warning(
            "chat event=bad_request user_id=%d task_id=%s reason=empty_question",
            current_user.id,
            task_id,
        )
        raise HTTPException(status_code=400, detail="问题不能为空")

    chat_started_at = time.perf_counter()
    requested_image_count = sum(1 for image in images if image.filename)
    logger.info(
        "chat event=start user_id=%d task_id=%s question_len=%d image_count=%d",
        current_user.id,
        task_id,
        len(normalized_question),
        requested_image_count,
    )

    # 限流
    await rate_limit(current_user.id, "chat_stream", limit=10, window=60)
    # 分布式锁
    r = get_redis()
    lock_key = f"lock:chat:{current_user.id}"
    acquired = await r.set(lock_key, "1", ex=120, nx=True)
    if not acquired:
        logger.warning(
            "chat event=lock_conflict user_id=%d task_id=%s",
            current_user.id,
            task_id,
        )
        raise HTTPException(status_code=409, detail="上一条消息还在生成中，请稍后")

    # 1. 处理上传图片 - 按用户分目录存储
    uploaded_image_paths: list[tuple[str, str | None]] = []
    if images:
        # 用户专属目录：static/uploads/chat/{user_id}/
        user_chat_dir = Path(settings.UPLOAD_DIR) / "chat" / str(current_user.id)
        user_chat_dir.mkdir(parents=True, exist_ok=True)

        for img_file in images:
            if not img_file.filename:
                continue
            if img_file.content_type not in _ALLOWED_IMAGE_TYPES:
                raise HTTPException(
                    status_code=400, detail=f"不支持的图片类型: {img_file.content_type}"
                )

            # 生成唯一文件名：时间戳 + UUID
            suffix = Path(img_file.filename).suffix or ".jpg"
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            unique_name = f"{timestamp}_{uuid.uuid4().hex[:8]}{suffix}"
            file_path = user_chat_dir / unique_name

            # 读取并保存
            content = await img_file.read()
            if len(content) > _MAX_IMAGE_SIZE_MB * 1024 * 1024:
                raise HTTPException(
                    status_code=400, detail=f"图片大小超过 {_MAX_IMAGE_SIZE_MB} MB"
                )

            # 剥离 EXIF + 重编码
            content = _strip_and_reencode(content, suffix)

            file_path.write_bytes(content)

            # 存储相对路径（相对于 static/）
            relative_path = f"uploads/chat/{current_user.id}/{unique_name}"
            uploaded_image_paths.append((relative_path, img_file.filename))

            logger.info(
                "用户上传聊天图片 user_id=%d path=%s size_kb=%d",
                current_user.id,
                relative_path,
                len(content) // 1024,
            )

    # 2. 存user消息 + 关联图片
    user_message = await chat_crud.create_message(
        db=db,
        user_id=current_user.id,
        role="user",
        content=question,
        task_id=task_id,
        image_paths=uploaded_image_paths if uploaded_image_paths else None,
    )

    # 3. 清理超出配额的旧图片
    if uploaded_image_paths:
        await _enforce_user_image_quota(db, current_user.id)

    # 4. 获取会话窗口
    session_messages: list[dict[str, str]] = []
    if settings.RAG_SESSION_MEMORY_ENABLED:
        history = await chat_crud.get_recent_chat_windows(
            db=db,
            user_id=current_user.id,
            task_id=task_id,
            turns=settings.RAG_SESSION_WINDOW_TURNS,
            before_message_id=user_message.id,
        )
        for msg in history:
            if msg.role in ("user", "assistant"):
                session_messages.append({"role": msg.role, "content": msg.content})

    # 5. 获取图片上下文
    image_context: dict | None = None
    if task_id:
        task_ = await db.get(task.Task, task_id)
        if task_ and task_.detect_result:
            image_context = task_.detect_result

    # 6. 准备视觉模型图片路径
    vision_image_paths: list[str] = []
    if settings.LLM_IS_VISION_MODEL:
        if uploaded_image_paths:
            # 用户上传的图片（转回绝对路径给视觉模型）
            static_dir = Path(settings.BASE_DIR).parent / "static"
            vision_image_paths = [
                str(static_dir / rel_path) for rel_path, _ in uploaded_image_paths
            ]
        elif task_id and task_:
            # 引用任务图片
            if task_.original_path:
                task_img_path = Path(settings.BASE_DIR).parent / "static" / task_.original_path
                if task_img_path.exists():
                    vision_image_paths = [str(task_img_path)]

    if vision_image_paths:
        logger.info("视觉模型将使用 %d 张图片", len(vision_image_paths))

    # 8. 流式生成器
    async def event_generator():
        full_response = ""
        parser = ThinkStreamParser()
        result_meta: dict = {}
        finish_reason = "ok"
        # 流式去重：缓冲式前缀指纹检测
        # 原理：捕获正文开头 N 字符作为指纹，后续逐字符增量匹配。
        # 新内容先进缓冲区而非直接 yield，匹配满指纹长度则确认重复并丢弃，
        # 不匹配则释放缓冲内容。最多延迟 N 字符的输出。
        _stream_stopped = False  # 确认重复的终止标志
        _think_ended = False
        _PREFIX_LEN = 15
        _prefix = ""  # 正文前缀指纹
        _match_cursor = 0  # 增量匹配位置
        _pending = ""  # 疑似重复的缓冲（未 yield）

        async with AsyncSessionLocal() as bg_session:
            try:
                async for raw_token in RagService.generate_chat_stream(
                    question=question,
                    image_context=image_context,
                    chat_window=session_messages,
                    vision_image_paths=vision_image_paths,
                    result_meta=result_meta,
                ):
                    parsed = parser.feed(raw_token)
                    if parsed:
                        full_response += parsed

                        # <<<SOURCES>>> 标记始终发送
                        if "<<<SOURCES>>>" in parsed:
                            yield parsed
                            continue

                        if _stream_stopped:
                            continue

                        # ---- THINK_END 之前：直接 yield ----
                        if not _think_ended:
                            if ThinkStreamParser.MARKER_END in parsed:
                                _think_ended = True
                                marker = ThinkStreamParser.MARKER_END
                                idx = parsed.index(marker)
                                # MARKER_END 及之前的部分直接发送
                                yield parsed[: idx + len(marker)]
                                # 切换 parser 为直通模式，释放缓冲区
                                buffered = parser.set_passthrough()
                                # MARKER_END 之后的内容 + 缓冲区残留 → 进入去重流程
                                after = parsed[idx + len(marker) :] + buffered
                                if after:
                                    safe = ""
                                    for ch in after:
                                        if not _prefix and ch.strip() == "":
                                            safe += ch
                                            continue
                                        if len(_prefix) < _PREFIX_LEN:
                                            _prefix += ch
                                            safe += ch
                                    if safe:
                                        yield safe
                            else:
                                yield parsed
                            await asyncio.sleep(0)
                            continue

                        # ---- THINK_END 之后：逐字符缓冲去重 ----
                        safe_to_yield = ""
                        for ch in parsed:
                            if _stream_stopped:
                                break

                            # 阶段1: 还在收集前缀指纹
                            if len(_prefix) < _PREFIX_LEN:
                                if not _prefix and ch.strip() == "":
                                    safe_to_yield += ch
                                    continue
                                _prefix += ch
                                safe_to_yield += ch
                                continue

                            # 阶段2: 前缀已满，增量匹配检测重复
                            if _match_cursor == 0 and ch.strip() == "":
                                # 空白字符（段落分隔符）在匹配开始前，先缓冲
                                _pending += ch
                            elif ch == _prefix[_match_cursor]:
                                _match_cursor += 1
                                _pending += ch
                                if _match_cursor >= _PREFIX_LEN:
                                    _stream_stopped = True
                                    logger.info(
                                        "流式去重：前缀重现确认 pending=%d",
                                        len(_pending),
                                    )
                                    break
                            else:
                                # 不匹配 → 释放缓冲
                                safe_to_yield += _pending + ch
                                _pending = ""
                                _match_cursor = 0

                        if safe_to_yield:
                            yield safe_to_yield

                    await asyncio.sleep(0)

                if not _stream_stopped:
                    if _pending:
                        yield _pending
                    remaining = parser.flush()
                    if remaining:
                        full_response += remaining
                        yield remaining
                else:
                    remaining = parser.flush()
                    if remaining:
                        full_response += remaining
                # 去掉思考内容和来源信息等标记，保留纯回答文本
                content_only = re.sub(
                    rf"{re.escape(ThinkStreamParser.MARKER_START)}"
                    rf".*?"
                    rf"{re.escape(ThinkStreamParser.MARKER_END)}",
                    "",
                    full_response,
                    flags=re.DOTALL,
                ).strip()

                content_only = re.sub(
                    r"\n?<<<SOURCES>>>.*?<<<SOURCES_END>>>",
                    "",
                    content_only,
                    flags=re.DOTALL,
                ).strip()

                # 去重：如果模型重复生成了相同的回答段落，只保留第一段
                content_only = _deduplicate_content(content_only)

                if not content_only:
                    content_only = "系统繁忙，未生成回答。"
                    yield content_only
                meta: dict = {}
                if parser.think_content:
                    meta["think"] = parser.think_content
                if result_meta.get("sources"):
                    meta["sources"] = result_meta["sources"]
                if result_meta.get("route"):
                    meta["route"] = result_meta["route"]
                if result_meta.get("finish_reason"):
                    meta["finish_reason"] = result_meta["finish_reason"]
                # eval 观测口字段（rewritten_query 仅多轮时出现；
                # retrieval_debug 仅 RAG_EVAL_DEBUG=1 时出现，生产零开销）
                if result_meta.get("rewritten_query"):
                    meta["rewritten_query"] = result_meta["rewritten_query"]
                if result_meta.get("retrieval_debug"):
                    meta["retrieval_debug"] = result_meta["retrieval_debug"]

                # output_safe, leak_desc = check_output_leak(content_only)
                # if not output_safe:
                #    if meta is None:
                #        meta = {}
                #    meta["leak_warning"] = leak_desc

                await chat_crud.create_message(
                    bg_session,
                    user_id=current_user.id,
                    role="assistant",
                    content=content_only,
                    task_id=task_id,
                    meta=meta or None,
                )
            except asyncio.CancelledError:
                finish_reason = "cancelled"
                logger.info("客户端断开，保存已生成内容 len=%d", len(full_response))
                # 客户端断开但已有内容时，仍然保存到数据库
                if full_response.strip():
                    partial = re.sub(
                        rf"{re.escape(ThinkStreamParser.MARKER_START)}"
                        rf".*?"
                        rf"{re.escape(ThinkStreamParser.MARKER_END)}",
                        "",
                        full_response,
                        flags=re.DOTALL,
                    ).strip()
                    partial = re.sub(
                        r"\n?<<<SOURCES>>>.*?<<<SOURCES_END>>>",
                        "",
                        partial,
                        flags=re.DOTALL,
                    ).strip()
                    if partial:
                        meta_cancel: dict = {}
                        if parser.think_content:
                            meta_cancel["think"] = parser.think_content
                        if result_meta.get("sources"):
                            meta_cancel["sources"] = result_meta["sources"]
                        await chat_crud.create_message(
                            bg_session,
                            user_id=current_user.id,
                            role="assistant",
                            content=partial,
                            task_id=task_id,
                            meta=meta_cancel or None,
                        )
                raise
            except Exception:
                finish_reason = "internal_error"
                logger.exception("流式生成失败")
                yield "\n[系统错误，请重试]"
            finally:
                total_ms = (time.perf_counter() - chat_started_at) * 1000
                final_reason = result_meta.get("finish_reason", finish_reason)
                logger.info(
                    "chat event=done user_id=%d task_id=%s finish_reason=%s route=%s "
                    "sources=%d response_len=%d total_ms=%.1f",
                    current_user.id,
                    task_id,
                    final_reason,
                    result_meta.get("route", "unknown"),
                    len(result_meta.get("sources") or []),
                    len(full_response),
                    total_ms,
                )
                await r.delete(lock_key)

    return StreamingResponse(
        event_generator(),
        media_type="text/plain",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.get("/chat/history", response_model=ChatHistoryResponse)
async def get_history(
    task_id: int | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    order: str = Query(default="asc", pattern="^(asc|desc)$"),
    before: int | None = Query(None),
    after: int | None = Query(None),
    current_user: user.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ChatHistoryResponse:
    history = await chat_crud.get_chat_history(
        db=db,
        user_id=current_user.id,
        task_id=task_id,
        limit=limit,
        order=order,
        before=before,
        after=after,
    )
    total = await chat_crud.count_chat_messages(db, user_id=current_user.id, task_id=task_id)
    items = [ChatMessageSchema.model_validate(msg) for msg in history]

    oldest_id = items[0].id if items else None
    newest_id = items[-1].id if items else None
    has_more = len(items) == limit
    return ChatHistoryResponse(
        items=items,
        total=total,
        has_more=has_more,
        oldest_id=oldest_id,
        newest_id=newest_id,
    )


async def _enforce_user_image_quota(db: AsyncSession, user_id: int) -> None:
    """
    清理超出配额的旧聊天图片。

    每个用户最多保留 _USER_IMAGE_QUOTA 张聊天图片，超出部分删除最旧的。
    """
    from sqlalchemy import select

    from app.models.chat import ChatImage, ChatMessage

    # 查询该用户的所有聊天图片，按创建时间倒序
    stmt = (
        select(ChatImage)
        .join(ChatMessage)
        .where(ChatMessage.user_id == user_id)
        .order_by(ChatImage.created_at.desc())
    )
    result = await db.execute(stmt)
    all_images = list(result.scalars().all())

    if len(all_images) > _USER_IMAGE_QUOTA:
        to_delete = all_images[_USER_IMAGE_QUOTA:]  # 超出配额的旧图片
        static_dir = Path(settings.BASE_DIR).parent / "static"

        for img in to_delete:
            # 删除文件
            file_path = static_dir / img.file_path
            try:
                file_path.unlink(missing_ok=True)
                logger.info("删除旧聊天图片 user_id=%d path=%s", user_id, img.file_path)
            except Exception as e:
                logger.warning("删除图片文件失败 path=%s error=%s", img.file_path, e)

            # 删除数据库记录
            await db.delete(img)

        await db.commit()
        logger.info("清理用户 %d 的 %d 张旧聊天图片", user_id, len(to_delete))
