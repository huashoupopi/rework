import asyncio
import json
import logging
import time

from app.core.database import AsyncSessionLocal
from app.core.redis import get_redis
from app.models.task import Task, TaskStatus
from app.services.yolo_service import YOLOService

logger = logging.getLogger(__name__)


async def run_yolo_detection(ctx: dict, task_id: int) -> dict:
    """
    YOLO推理任务函数
    Args:
        ctx: Arq注入的上下文，包含Redis连接等
            ctx['redis'] - Arq Redis连接 可与访问Redis
        task_id: 任务ID
    Returns:
        任务结果dict（会被序列化到Redis，可通过job.result()获取）
    """
    t0 = time.perf_counter()
    logger.info("开始YOLO推理 task_id=%d", task_id)

    async with AsyncSessionLocal() as db:
        task = await db.get(Task, task_id)
        if not task:
            logger.error("任务ID task_id=%d 不存在", task_id)
            return {"task_id": task_id, "error": "Task not found"}

        if task.status == TaskStatus.COMPLETED.value:
            logger.info("任务已完成， 跳过task_id=%d", task_id)
            return {"task_id": task_id, "status": "already_completed"}

        try:
            result = await asyncio.to_thread(
                YOLOService.predict, task.original_path, task.result_path
            )
            task.detect_result = result
            task.status = TaskStatus.COMPLETED.value
            await db.commit()

            # 写入redis缓存，一小时过期
            # 必须存user_id, 读缓存时要校验
            r = get_redis()
            await r.set(
                f"task:result:{task_id}",
                json.dumps(
                    {
                        "id": task_id,
                        "uuid": task.uuid,
                        "file_name": task.file_name,
                        "user_id": task.user_id,
                        "status": TaskStatus.COMPLETED.value,
                        "original_path": task.original_path,
                        "result_path": task.result_path,
                        "detect_result": result,
                        "created_at": task.created_at.isoformat(),
                    }
                ),
                ex=3600,  # 一小时过期
            )
            logger.info("任务结果已缓存 task_id=%d TTL=3600s", task_id)
            duration_ms = (time.perf_counter() - t0) * 1000
            logger.info(
                "YOLO推理成功 task_id=%d duration_ms=%.1f detections=%d",
                task_id,
                duration_ms,
                result.get("total", 0),
            )
            return {
                "task_id": task_id,
                "status": "completed",
                "detections": result.get("total", 0),
                "duration_ms": round(duration_ms, 1),
            }

        except Exception:
            task.status = TaskStatus.FAILED.value
            await db.commit()

            duration_ms = (time.perf_counter() - t0) * 1000
            logger.exception("YOLO推理失败 task_id=%d duration_ms=%.1f", task_id, duration_ms)

            # 抛出异常 -》Arq会自动重试（如果retry_jobs=True）
            # 不抛出异常 -》Arq 认为任务成功完成，任务状态为FAILED，不会重试
            raise
