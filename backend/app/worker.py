"""
Arq Worker配置 - 独立进程运行
启动命令：
  uv run arq app.worker.WorkerSettings

Worker会自动：
1. 连接redis
2. 监听指定队列（默认为"arq:queue:default"）
3. 接收到任务后执行对应重试函数
3. 失败时自动按配置自动重试

注意：Worker 进程 和 API进程完全独立， 有各自的内存空间
"""

import logging

from app.core.redis import close_redis, init_redis, parse_redis_settings
from app.services.yolo_service import YOLOService
from app.tasks.eval_task import run_eval_batch
from app.tasks.knowledge_task import run_knowledge_rebuild
from app.tasks.yolo_task import run_yolo_detection

logger = logging.getLogger(__name__)


async def on_startup(ctx: dict) -> None:
    """
    Worker启动时的回调函数
    类似fastapi的lifespan startup
    """
    logger.info("Arq Worker启动...")
    YOLOService.load_model()
    await init_redis()


async def on_shutdown(ctx: dict) -> None:
    logger.info("Arq Worker关闭...")
    await close_redis()


class WorkerSettings:
    # 注册任务函数列表 Worker只执行这里注册的函数， 未注册的任务会被忽略
    functions = [run_yolo_detection, run_knowledge_rebuild, run_eval_batch]

    redis_settings = parse_redis_settings()

    # 并发控制
    max_jobs = 4
    """
    同时最多执行的任务数。

    根据你的模型和硬件调整：
    - 小参数模型（如 qwen3.5:4b）→ 可以 4-8 并发
    - 标准 YOLO 模型 → 建议 2 并发（GPU 显存限制）
    - 大模型 → 建议 1-2 并发
    """

    job_timeout = 600  # 单个任务超时时间（秒）
    """
    根据你的模型推理速度调整：
    - 小参数模型 → 120 秒够用
    - 标准模型 → 300 秒（5 分钟）
    - 大模型或复杂任务 → 600 秒（10 分钟）
    """

    # 重试配置
    retry_jobs = True
    max_tries = 3
    """
    失败自动重试，最多3次
    Arq的重试间隔是指数退避的：
    第一次重试：等待 ~10s
    第二次重试：等待 ~30s
    第三次重试：等待 ~90s

    为什么要重试？
    - GPU显存偶尔被其他进程占用 -》 OOM -〉 释放后重试就能成功
    - 文件系统偶尔 I/O 错误 -》 重试就能成功
    - 其他偶发错误 -》 重试就能成功
    """
    on_startup = on_startup
    on_shutdown = on_shutdown
    # ==== 定时任务（可选）
    # cron_jobs = [
    #   cron(cleanup_expired_files, hour=3, minute=0),  # 每天凌晨3点执行清理过期文件的任务
    #   cron(rebuild_knowledge_index, weekday=4, hour=2),  # 每周一凌晨重建索引
    # ]
