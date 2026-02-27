import asyncio
import logging

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import AsyncSessionLocal, get_db
from app.crud.task import get_tasks_paginated
from app.models.task import Task, TaskStatus
from app.models.user import User
from app.routers.auth import get_current_user
from app.schemas.task import TaskPaginationSchema, TaskSchema
from app.services.file_service import FileService
from app.services.yolo_service import YOLOService

logger = logging.getLogger(__name__)

router = APIRouter(tags=["任务管理(Tasks)"])


async def background_detect_task(task_id: int, file_path: str, result_path: str) -> None:
    logger.info("[后台] 开始处理任务 ID: %d", task_id)
    try:
        async with AsyncSessionLocal() as db:
            task: Task | None = await db.get(Task, task_id)
            if not task:
                return
            detect_result = await asyncio.to_thread(YOLOService.predict, file_path, result_path)
            task.status = TaskStatus.COMPLETED.value
            task.result_path = result_path
            task.detect_result = detect_result
            await db.commit()
            logger.info("[后台] 任务 ID %d 处理完成 total=%s", task_id, detect_result["total"])
    except Exception:
        logger.exception("处理任务 ID %d 时发生错误", task_id)
        async with AsyncSessionLocal() as db:
            task: Task | None = await db.get(Task, task_id)
            if task:
                task.status = TaskStatus.FAILED.value
                await db.commit()


@router.post("tasks/upload", response_model=list[TaskSchema])
async def uoload_tasks(
    files: list[UploadFile],
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[Task]:
    created_tasks = []
    for file in files:
        if not file.content_type.startswith("image/"):
            continue
        uuid_str, file_name, save_path = await FileService.save_file(file)
        result_path = FileService.get_result_path(uuid_str, file_name)
        new_task = Task(
            user_id=current_user.id,
            uuid=uuid_str,
            file_name=file_name,
            original_path=save_path,
            result_path=result_path,
            status=TaskStatus.PROGRESSING.value,
        )
        db.add(new_task)
        await db.commit()
        await db.refresh(new_task)
        background_tasks.add_task(background_detect_task, new_task.id, save_path, result_path)
        created_tasks.append(new_task)
    if not created_tasks:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="请至少上传一个有效的图片文件"
        )
    return created_tasks


@router.get("/tasks", response_model=TaskPaginationSchema)
async def get_tasks(
    skip: int = Query(0, ge=0),
    limit: int = Query(10, ge=1),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TaskPaginationSchema:
    result = await get_tasks_paginated(db, current_user.id, current_user.is_superuser, skip, limit)
    return result


@router.get("/tasks/{task_id}", response_model=TaskSchema)
async def get_task_detail(
    task_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Task:
    task = await db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务未找到")
    if task.user_id != current_user.id and not current_user.is_superuser:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="没有权限访问此任务")
    return task


@router.delete("/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_task(
    task_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    task = await db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="任务未找到")
    if task.user_id != current_user.id and not current_user.is_superuser:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="没有权限删除此任务")
    FileService.delete_file(task.uuid, task.file_name)
    await db.delete(task)
    await db.commit()
