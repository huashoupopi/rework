import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from app.core.config import settings

# === 禁用代理，避免本地服务（Ollama）请求被拦截 ===
# 必须在 import FastAPI 和其他库之前设置，确保全局生效
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]:
    os.environ.pop(key, None)
os.environ["HF_HOME"] = settings.HF_HOME
os.environ["HUGGINGFACE_HUB_CACHE"] = settings.HUGGINGFACE_HUB_CACHE
os.environ["LLAMA_INDEX_CACHE_DIR"] = settings.HF_HOME

from fastapi import FastAPI, HTTPException  # noqa: E402
from sqlalchemy import text as sa_text  # noqa: E402

from app.core.cors import apply_cors  # noqa: E402
from app.core.database import engine, init_models  # noqa: E402
from app.core.logging import setup_logging  # noqa: E402
from app.core.redis import (  # noqa: E402
    close_redis,
    get_redis,  # noqa: E402
    init_redis,
)
from app.core.request_context import RequestContextMiddleware  # noqa: E402
from app.core.static_paths import ensure_static_dir, mount_public_static  # noqa: E402
from app.routers import (  # noqa: E402
    auth,
    chat,
    conversation,
    eval_report,
    knowledge,
    media,
    task,
    user,
)
from app.services.rag_service import RagService  # noqa: E402

# 给每一个文件一个独立的logger，方便定位来源
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    setup_logging()
    logger.info("Starting up...")
    await init_models()

    # 其他启动服务 例如RAG redis
    await RagService.initialize()  # 初始化RAG服务，加载模型和索引等
    await init_redis()  # 初始化Redis连接池
    yield
    await close_redis()  # 关闭Redis连接池
    # 其他关闭服务
    logger.info("Shutting down...")
    await engine.dispose()


app = FastAPI(lifespan=lifespan)

# 挂载路由
app.include_router(auth.router, prefix="/api")
app.include_router(user.router, prefix="/api")
app.include_router(task.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(conversation.router, prefix="/api")
app.include_router(knowledge.router, prefix="/api")
app.include_router(eval_report.router, prefix="/api")
app.include_router(media.router, prefix="/api")
# 只挂公开目录。uploads/results 必须走鉴权 FileResponse
ensure_static_dir()
mount_public_static(app)
apply_cors(app)
app.add_middleware(RequestContextMiddleware)


@app.get("/health")
async def health_check():
    return {"status": "ok"}


@app.get("/ready")
async def readiness_check():
    """就绪探针 - 检查 DB + Redis"""
    checks = {}
    try:
        async with engine.connect() as conn:
            await conn.execute(sa_text("SELECT 1"))
        checks["database"] = "ok"
    except Exception:
        checks["database"] = "fail"

    try:
        r = get_redis()
        await r.ping()
        checks["redis"] = "ok"
    except Exception:
        checks["redis"] = "fail"

    if any(v != "ok" for v in checks.values()):
        raise HTTPException(status_code=503, detail=checks)
    return {"status": "ready", **checks}
