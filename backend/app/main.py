import logging
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

# === 禁用代理，避免本地服务（Ollama）请求被拦截 ===
# 必须在 import FastAPI 和其他库之前设置，确保全局生效
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]:
    os.environ.pop(key, None)

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from app.core.database import engine, init_models  # noqa: E402
from app.core.logging import setup_logging  # noqa: E402
from app.routers import auth, chat, task, user  # noqa: E402
from app.services.yolo_service import YOLOService  # noqa: E402

# 给每一个文件一个独立的logger，方便定位来源
logger = logging.getLogger(__name__)

APP_DIR = Path(__file__).resolve().parent

if (APP_DIR.parent / "static").exists():
    STATIC_DIR = APP_DIR.parent / "static"
else:
    STATIC_DIR = Path("app/static").resolve()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    setup_logging()
    logger.info("Starting up...")
    await init_models()

    # 其他启动服务 例如YOLO模型加载等
    YOLOService.load_model()
    yield
    # 其他关闭服务
    logger.info("Shutting down...")
    await engine.dispose()


app = FastAPI(lifespan=lifespan)

# 挂载路由
app.include_router(auth.router, prefix="/api")
app.include_router(user.router, prefix="/api")
app.include_router(task.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
# 挂载静态文件
if not STATIC_DIR.exists():
    os.makedirs(STATIC_DIR)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# 配置跨域
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check():
    return {"status": "ok"}
