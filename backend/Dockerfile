# ── Backend Dockerfile (FastAPI + Arq Worker) ──
# 构建上下文为项目根目录（docker-compose 中 context: .）
FROM python:3.12-slim AS base

# Debian apt 清华镜像加速
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources

# 系统依赖：asyncpg 需要 libpq，Pillow/OpenCV 需要图像库
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libpq-dev \
        libgl1 \
        libglib2.0-0 \
        curl \
    && rm -rf /var/lib/apt/lists/*

# 安装 uv 南京大学镜像
COPY --from=ghcr.nju.edu.cn/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# 先复制 ultralytics 本地包（pyproject.toml 引用了它）
COPY ultralytics1/ /ultralytics1/

# 一次性复制所有代码（包括 pyproject.toml）
# 不单独缓存依赖层：需要修改 pyproject.toml 后再 sync，避免 COPY 覆盖修改
COPY backend/ .

# 修改 pyproject.toml：
# 1. ultralytics 路径改为容器内绝对路径
# 2. torch/torchvision 强制从 PyTorch CPU 索引安装（避免 CUDA 版本不匹配）
RUN sed -i 's|path = "../ultralytics1"|path = "/ultralytics1"|' pyproject.toml && \
    sed -i '/\[tool\.uv\.sources\]/a torch = { index = "pytorch" }\ntorchvision = { index = "pytorch" }' pyproject.toml && \
    printf '\n[[tool.uv.index]]\nurl = "https://download.pytorch.org/whl/"\nname = "pytorch"\nexplicit = true\n' >> pyproject.toml

# 安装依赖（torch/torchvision 从 CPU 索引安装，其余从清华镜像）
RUN uv sync --no-dev --extra yolo --python /usr/local/bin/python3

# 确保运行时目录存在
RUN mkdir -p static/uploads static/results knowledge_base managed_versions models

# 将 .venv/bin 加入 PATH，运行时直接使用已安装的包
# 不用 uv run：避免启动时因 Python 符号链接失效而重建虚拟环境
ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8000

# 默认启动 API 服务（Worker 在 docker-compose 中覆盖 command）
CMD ["fastapi", "run", "app/main.py", "--host", "0.0.0.0", "--port", "8000"]
