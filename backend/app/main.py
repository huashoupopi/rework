import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.core.database import engine, init_models

APP_DIR = Path(__file__).resolve().parent
print(f"APP_DIR: {APP_DIR}")

if (APP_DIR.parent / "static").exists():
    STATIC_DIR = APP_DIR.parent / "static"
else:
    STATIC_DIR = Path("app/static").resolve()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    print("Starting up...")
    await init_models()

    # 其他启动服务 例如YOLO模型加载等
    yield
    # 其他关闭服务
    print("Shutting down...")
    await engine.dispose()


app = FastAPI(lifespan=lifespan)

# 挂载路由
# app.include_router()
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
