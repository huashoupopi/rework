"""鉴权后的聊天图片下载。独立路由，避免测试 import 拉起 RagService。"""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.static_paths import resolve_existing_file
from app.models.chat import ChatImage, ChatMessage
from app.models.user import User
from app.routers.auth import get_current_user

router = APIRouter(tags=["media"])


@router.get("/chat/images/{image_id}")
async def get_chat_image(
    image_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    image = await db.get(ChatImage, image_id)
    if image is None:
        raise HTTPException(status_code=404, detail="图片不存在")
    message = await db.get(ChatMessage, image.message_id)
    if message is None or message.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="图片不存在")
    path = resolve_existing_file(image.file_path)
    if path is None:
        raise HTTPException(status_code=404, detail="图片不存在")
    return FileResponse(path)
