import asyncio
import hashlib
import json
import logging
from datetime import UTC, datetime
from pathlib import Path

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse, Response, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.rate_limit import rate_limit
from app.core.redis import get_arq_redis, get_redis
from app.core.static_paths import resolve_existing_file
from app.crud.task import get_tasks_paginated
from app.models.task import Task, TaskStatus
from app.models.user import User
from app.routers.auth import get_current_user
from app.schemas.task import TaskPaginationSchema, TaskSchema
from app.services.file_service import FileService
from app.services.image_guard import prepare_image_bytes
from app.services.task_export import export_csv_text, export_json_body

logger = logging.getLogger(__name__)

router = APIRouter(tags=["任务管理(Tasks)"])


@router.post("/tasks/upload", response_model=list[TaskSchema])
async def upload_tasks(
    files: list[UploadFile] = File(),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[Task]:
    # 限流
    await rate_limit(current_user.id, "upload", limit=20, window=60)  # 每分钟最多上传20次
    created_tasks = []
    r = get_redis()
    arq = get_arq_redis()  # 获取Arq Redis连接

    for file in files:
        content = await file.read()
        await asyncio.to_thread(prepare_image_bytes, content, file.filename)
        await file.seek(0)

        # 分布式锁：防重复提交
        file_hash = hashlib.md5(content).hexdigest()
        lock_key = f"lock:upload:{current_user.id}:{file_hash}"
        # SET NX: key不存在时设置成功并返回True，存在时返回False
        acquired = await r.set(lock_key, "1", nx=True, ex=30)
        if not acquired:
            logger.info(
                "跳过重复文件 user_id=%d file=%s file_hash=%s",
                current_user.id,
                file.filename,
                file_hash,
            )
            continue
        uuid_str, file_name, save_path = await FileService.save_file(file)
        result_path = FileService.get_result_path(uuid_str, Path(save_path).name)
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
        # background_tasks.add_task(background_detect_task, new_task.id, save_path, result_path)
        job = await arq.enqueue_job(
            "run_yolo_detection",
            new_task.id,
            _job_id=f"yolo_{new_task.id}",
        )
        logger.info(
            "YOLO 任务已入队 task_id=%d job_id=%s", new_task.id, job.job_id if job else "duplicate"
        )

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


# 批量下载 要移动到/task/{task_id}之前 Fastapi按照注册顺序匹配
@router.get("/tasks/batch/download")
async def batch_download_tasks(
    task_ids: list[int] = Query(),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    if not task_ids:
        raise HTTPException(status_code=400, detail="无任务ID提供")
    if len(task_ids) > 20:
        raise HTTPException(status_code=400, detail="一次最多下载20个任务")
    tasks = []
    for task_id in task_ids:
        task = await db.get(Task, task_id)
        if not task:
            raise HTTPException(status_code=404, detail=f"任务ID {task_id} 未找到")
        if not current_user.is_superuser and task.user_id != current_user.id:
            raise HTTPException(status_code=403, detail=f"没有权限访问任务ID {task_id}")
        if not task.result_path or not Path(task.result_path).exists():
            raise HTTPException(status_code=404, detail=f"任务ID {task_id} 的结果文件未找到")
        tasks.append(task)
    zip_path = FileService.create_zip_for_tasks(tasks)
    return StreamingResponse(
        content=zip_path,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="tasks.zip"'},
    )


@router.get("/tasks/{task_id}/export")
async def export_task(
    task_id: int,
    format: str = Query(..., pattern="^(json|csv)$"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    task = await db.get(Task, task_id)
    if not task or (task.user_id != current_user.id and not current_user.is_superuser):
        raise HTTPException(status_code=404, detail="任务不存在")
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    if format == "json":
        body = export_json_body(task)
        return Response(
            content=json.dumps(body, ensure_ascii=False),
            media_type="application/json",
            headers={
                "Content-Disposition": f'attachment; filename="task_{task.id}_{stamp}.json"'
            },
        )
    csv_text = export_csv_text(task)
    return Response(
        content=csv_text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="task_{task.id}_{stamp}.csv"'},
    )


@router.get("/tasks/{task_id}/image")
async def get_task_image(
    task_id: int,
    kind: str = Query(..., pattern="^(original|result)$"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    task = await db.get(Task, task_id)
    if not task or (task.user_id != current_user.id and not current_user.is_superuser):
        raise HTTPException(status_code=404, detail="任务不存在")
    stored = task.original_path if kind == "original" else task.result_path
    path = resolve_existing_file(stored)
    if path is None:
        raise HTTPException(status_code=404, detail="图片不存在")
    return FileResponse(path)


@router.get("/tasks/{task_id}", response_model=TaskSchema)
async def get_task_detail(
    task_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Task:
    r = get_redis()
    # 先查redis缓存
    cached = await r.get(f"task:result:{task_id}")
    if cached:
        data = json.loads(cached)
        if data.get("user_id") != current_user.id and not current_user.is_superuser:
            raise HTTPException(status_code=404, detail="任务不存在")
        logger.debug("缓存命中 task_id=%d", task_id)
        return data
    # 缓存未命中再查数据库
    task = await db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    if task.user_id != current_user.id and not current_user.is_superuser:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="没有权限访问此任务")

    # 回填数据 只缓存已完成的任务
    if task.status == TaskStatus.COMPLETED.value:
        await r.set(
            f"task:result:{task_id}",
            json.dumps(
                {
                    "id": task.id,
                    "uuid": task.uuid,
                    "file_name": task.file_name,
                    "user_id": task.user_id,
                    "status": task.status,
                    "original_path": task.original_path,
                    "result_path": task.result_path,
                    "detect_result": task.detect_result,
                    "created_at": task.created_at.isoformat(),
                }
            ),
            ex=3600,  # 一小时过期
        )
        logger.debug("缓存回填 task_id=%d", task_id)
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


# 单张图片下载
@router.get("/tasks/{task_id}/download/image")
async def download_result_image(
    task_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    task = await db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务未找到")
    if not current_user.is_superuser and task.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="没有权限访问此任务")
    if not task.result_path or not Path(task.result_path).exists():
        raise HTTPException(status_code=404, detail="结果文件未找到")
    original_name = Path(task.file_name).stem
    ext = Path(task.file_name).suffix
    download_name = f"{original_name}_result{ext}"
    return FileResponse(
        path=task.result_path,
        filename=download_name,
        media_type="image/jpeg",
    )
