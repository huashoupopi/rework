import asyncio
import json
import logging
import re
import uuid
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import AsyncSessionLocal, get_db
from app.crud import chat as chat_crud
from app.models import task, user
from app.routers.auth import get_current_user
from app.schemas.chat import ChatHistoryResponse, ChatMessageSchema
from app.utils.stream_parser import ThinkStreamParser

logger = logging.getLogger(__name__)

router = APIRouter(tags=["chat"])

_ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
_MAX_IMAGE_SIZE_MB = 10
_USER_IMAGE_QUOTA = 100  # 每个用户最多保留 100 张聊天图片


@router.post("/chat/stream")
async def chat_stream(
    request: Request,
    question: str = Form(...),
    task_id: int | None = Form(None),
    images: list[UploadFile] = File(default=[]),
    current_user: user.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    if not question.strip():
        raise HTTPException(status_code=400, detail="问题不能为空")

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

    # 7. 构建messages
    messages = _build_messages(
        question=question,
        session_messages=session_messages,
        image_context=image_context,
    )

    # 8. 流式生成器
    async def event_generator():
        parser = ThinkStreamParser()
        all_yielded: list[str] = []

        async with AsyncSessionLocal() as bg_session:
            try:
                async with httpx.AsyncClient() as client:
                    async with client.stream(
                        "POST",
                        f"{settings.OLLAMA_BASE_URL}/api/chat",
                        json={
                            "model": settings.LLM_MODEL_NAME,
                            "messages": messages,
                            "stream": True,
                        },
                        timeout=90.0,
                    ) as resp:
                        async for line in resp.aiter_lines():
                            if await request.is_disconnected():
                                logger.info("客户端已断开连接，停止生成")
                                break
                            if not line:
                                continue
                            data = json.loads(line)
                            raw_token = data.get("message", {}).get("content", "")

                            if raw_token:
                                parsed = parser.feed(raw_token)
                                if parsed:
                                    all_yielded.append(parsed)
                                    yield parsed
                            if data.get("done"):
                                break
                            await asyncio.sleep(0)
                    remaining = parser.flush()
                    if remaining:
                        all_yielded.append(remaining)
                        yield remaining

                full_output = "".join(all_yielded)
                content_only = re.sub(
                    rf"{re.escape(ThinkStreamParser.MARKER_START)}"
                    rf".*?"
                    rf"{re.escape(ThinkStreamParser.MARKER_END)}",
                    "",
                    full_output,
                    flags=re.DOTALL,
                ).strip()

                if not content_only:
                    content_only = "系统繁忙，未生成回答。"
                    yield content_only
                meta: dict | None = None
                if parser.think_content:
                    meta = {
                        "think": parser.think_content,
                    }
                await chat_crud.create_message(
                    bg_session,
                    user_id=current_user.id,
                    role="assistant",
                    content=content_only,
                    task_id=task_id,
                    meta=meta,
                )
            except asyncio.CancelledError:
                logger.info("生成任务被取消")
                raise
            except Exception:
                logger.exception("流式生成失败")
                yield "\n[系统错误，请重试]"

    return StreamingResponse(
        event_generator(),
        media_type="text/plain",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


def _build_messages(
    question: str,
    session_messages: list[dict[str, str]],
    image_context: dict | None = None,
) -> list[dict[str, str]]:
    """构建发送给 Ollama 的 messages 列表"""
    messages: list[dict[str, str]] = []

    system_content = "你是一个专业的风电叶片缺陷分析助手。请根据用户的问题给出准确、专业的回答。"

    if image_context and isinstance(image_context, dict):
        total = image_context.get("total", 0)
        objects = image_context.get("objects", []) or []
        defect_lines = [
            f"- {obj.get('class', 'unknown')} (置信度: {obj.get('confidence', 'N/A')})"
            for obj in objects
        ]
        defect_str = "\n".join(defect_lines) or "- 无"
        system_content += (
            f"\n\n当前图像检测结果（共 {total} 个缺陷）:\n{defect_str}\n"
            "当用户询问「这张图」或「这个缺陷」时，请结合以上检测结果回答。"
        )

    messages.append({"role": "system", "content": system_content})

    for msg in session_messages:
        messages.append({"role": msg["role"], "content": msg["content"]})

    messages.append({"role": "user", "content": question})
    return messages


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
