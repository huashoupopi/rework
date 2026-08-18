# 从零理解项目部署（小白版）

> 读完这篇文档，你会理解：为什么需要 Docker、Nginx、docker-compose，
> 它们各自在做什么，以及你的项目是怎么从「本地跑起来」变成「别人也能用」的。
> 所有概念都用生活类比解释，所有代码都逐行注释。

---

## 第一章：先搞懂一个问题——"部署"到底在干什么？

### 你现在是怎么开发的？

```
你的电脑（MacBook）
  ├── 终端 1：cd backend && uv run fastapi dev     ← 启动后端
  ├── 终端 2：cd frontend && pnpm dev              ← 启动前端
  ├── 终端 3：PostgreSQL 在本机跑着                  ← 数据库
  └── 终端 4：Redis 在本机跑着                       ← 缓存
```

这样跑有什么问题？

- **只有你自己能用。** 同事/面试官打不开你的 `localhost:5173`
- **换一台电脑就跑不起来。** 要重新装 Python 3.12、Node 20、PostgreSQL、Redis...
- **环境不一致。** 你的 Mac 能跑，服务器的 Linux 可能跑不起来

**"部署"就是把你本机跑的这一套东西，打包成任何一台机器都能跑的形式。**

---

## 第二章：Docker——把整个环境装进箱子

### 2.1 用搬家来理解 Docker

```
没有 Docker 的部署 = 搬家时一件件搬：
  "这个沙发要搬、这个书架要搬、这个灯要搬..."
  到了新家发现：插座不对、门太窄沙发进不去、少搬了一箱书

有了 Docker 的部署 = 把整个房间装进集装箱：
  "把房间原封不动装进箱子，运到哪里打开都一样"
  不管新家在北京还是上海，打开就能用
```

Docker 的三个核心概念：

| 概念 | 类比 | 说明 |
|------|------|------|
| **镜像（Image）** | 一张装好系统的光盘 | 包含了运行环境 + 你的代码 + 所有依赖，是只读的 |
| **容器（Container）** | 用光盘启动的一台虚拟电脑 | 镜像的运行实例，可以启动、停止、删除 |
| **Dockerfile** | 刻录光盘的步骤说明 | 告诉 Docker 怎么一步步制作镜像 |

### 2.2 一个最简单的例子

假设你要把一个 Python 脚本交给别人运行：

```dockerfile
# Dockerfile

FROM python:3.12      # 第 1 步：拿一张装好 Python 3.12 的空白光盘
WORKDIR /app          # 第 2 步：在里面创建一个文件夹
COPY hello.py .       # 第 3 步：把你的代码复制进去
CMD ["python", "hello.py"]  # 第 4 步：告诉它「启动时运行这个」
```

```bash
docker build -t my-hello .    # 刻录光盘（制作镜像）
docker run my-hello           # 用光盘启动一台电脑（运行容器）
```

**就这么简单。** 不管对方电脑有没有装 Python，都能运行。

### 2.3 你必须会的 Docker 命令

```bash
# 日常最常用的（先记这几个就够）
docker compose up --build -d    # 构建并启动所有服务（-d 是后台运行）
docker compose down             # 停掉所有服务
docker compose logs -f          # 看日志（-f 是实时跟踪，像 tail -f）
docker compose ps               # 看哪些服务在跑、状态如何
docker compose restart backend  # 重启某个服务

# 进入容器内部（就像 SSH 进一台远程服务器）
docker compose exec backend bash

# 调试用
docker compose logs -f backend  # 只看后端日志
docker compose logs -f worker   # 只看 Worker 日志
```

---

## 第三章：为什么你的项目需要 5 个"箱子"？

### 3.1 你的项目有哪些部分？

你在本地开发时，这些东西全跑在一台电脑上。
但在 Docker 里，我们把它们拆成 5 个独立的容器：

```
┌─────────────────────────────────────────────────────┐
│                     你的电脑                          │
│                                                       │
│   ┌───────────┐  ┌──────────┐  ┌───────────────────┐ │
│   │ PostgreSQL│  │  Redis   │  │  你的代码          │ │
│   │  数据库    │  │  缓存    │  │ (前端+后端+Worker) │ │
│   └───────────┘  └──────────┘  └───────────────────┘ │
│        全部混在一起，像一个大杂烩                        │
└─────────────────────────────────────────────────────┘

                    ↓ Docker 化后 ↓

┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│ postgres │ │  redis   │ │ backend  │ │  worker  │ │ frontend │
│  数据库   │ │   缓存   │ │ API 服务 │ │ 后台任务  │ │ 网页界面  │
│          │ │          │ │          │ │          │ │ (Nginx)  │
└──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘
    独立运行      独立运行     独立运行      独立运行      独立运行
```

### 3.2 每个"箱子"是干什么的？

**箱子 1：PostgreSQL（数据库）**
```
存什么：用户账号、任务记录、聊天记录、知识库文档
类比：  一个大文件柜，所有数据都存在这里
为什么独立：数据库是有状态的，数据必须持久保存，不能随便删
```

**箱子 2：Redis（缓存 + 队列）**
```
存什么：
  - 任务结果缓存（查过的不用再查数据库）
  - 限流计数器（每分钟最多上传 20 次）
  - Token 黑名单（登出后 Token 立即失效）
  - 任务队列（YOLO 推理任务排队等待执行）
类比：  一个超快的便利贴板 + 一个排号机
```

**箱子 3：Backend（FastAPI API 服务）**
```
做什么：处理所有 /api/* 请求——登录、上传图片、聊天、知识库管理
类比：  餐厅的服务员，接收点单、传菜、结账
```

**箱子 4：Worker（Arq 异步任务）**
```
做什么：执行耗时操作——YOLO 图片检测、知识库索引重建
类比：  餐厅的厨师，在后厨慢慢做菜
为什么和 Backend 分开？
  如果服务员自己去做菜（API 自己跑 YOLO），其他客人就没人招待了
  分开后，服务员把菜单丢给厨师，自己继续接待下一个客人
```

**箱子 5：Frontend（Nginx + 前端页面）**
```
做什么：
  1. 把 React 构建出来的 HTML/JS/CSS 发给浏览器
  2. 把浏览器发来的 /api/* 请求转发给后端
类比：  餐厅的前台，指引客人去对的地方
```

### 3.3 它们怎么通信？

```
用户浏览器
    │
    │ 访问 http://你的服务器
    ▼
┌──────────────────────────────────┐
│         frontend (Nginx)          │
│                                    │
│  请求 /tasks → 返回 index.html     │ ← 前端页面
│  请求 /api/* → 转发给 backend      │ ← API 代理
│  请求 /static/* → 转发给 backend   │ ← 图片文件
└──────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────┐
│         backend (FastAPI)         │
│                                    │
│  处理请求 → 查数据库 → 返回结果      │
│  收到上传 → 创建任务 → 丢给 Redis   │
└──────────────────────────────────┘
          │              │
          ▼              ▼
┌──────────────┐  ┌──────────────┐
│  PostgreSQL  │  │    Redis     │
│   (数据库)    │  │  (缓存+队列)  │
└──────────────┘  └──────────────┘
                         │
                         ▼
              ┌──────────────────┐
              │  worker (Arq)     │
              │ 从队列取任务执行    │
              │ YOLO推理/知识库重建 │
              └──────────────────┘
```

---

## 第四章：Nginx——餐厅前台

### 4.1 为什么需要 Nginx？

**问题场景：没有 Nginx 的情况**

```
你的项目：
  前端跑在 :5173（Vite 开发服务器）
  后端跑在 :8000（FastAPI）

用户要记两个地址？不行。
而且 Vite 开发服务器不适合生产环境（慢、不安全、不稳定）。
```

**解决方案：加一个 Nginx 当"前台"**

```
用户只需要访问一个地址：http://你的服务器（默认端口 80）

Nginx 根据请求路径自动分流：
  /tasks、/chat、/login   → 返回前端页面（React 处理）
  /api/tasks、/api/chat   → 转发给后端 FastAPI
  /static/uploads/xxx.jpg → 转发给后端取图片
```

### 4.2 Nginx 配置文件逐行解释

你项目里的 `frontend/myapp/nginx.conf`：

```nginx
server {
    listen 80;
    # ↑ 监听 80 端口。80 是 HTTP 的默认端口，
    #   所以用户访问 http://你的域名 不用加端口号。

    server_name _;
    # ↑ 匹配所有域名。_ 是通配符。
    #   如果你有域名，可以改成 server_name rework.example.com;

    root /usr/share/nginx/html;
    # ↑ 前端文件放在哪里。
    #   Docker 构建时，React 的构建产物（dist/）被复制到了这个目录。

    index index.html;
    # ↑ 默认首页文件名。
```

**第一块：最关键的 SPA 路由处理**

```nginx
    location / {
        try_files $uri $uri/ /index.html;
    }
```

这三行解决了一个大问题。让我解释：

```
场景：用户在浏览器地址栏输入 http://你的服务器/tasks

没有 try_files 时：
  Nginx 去找 /usr/share/nginx/html/tasks 这个文件
  → 不存在（因为 /tasks 是 React 的路由，不是一个真实文件）
  → 返回 404 错误页面
  → 用户看到一片空白 ❌

有了 try_files 时：
  第 1 步：找 /tasks 文件 → 不存在
  第 2 步：找 /tasks/ 目录 → 不存在
  第 3 步：返回 /index.html → React 启动 → React Router 看到路径是 /tasks
         → 渲染 TaskCenterPage ✅

这就是为什么所有 React/Vue 项目部署都需要这一行。
面试问到「SPA 刷新 404」，答案就是这一行。
```

**第二块：API 转发**

```nginx
    location /api/ {
        proxy_pass http://backend:8000/api/;
        # ↑ 把所有 /api/ 开头的请求转发给后端容器。
        #   "backend" 不是域名，是 docker-compose 里定义的服务名。
        #   Docker 会自动把 "backend" 解析成后端容器的 IP 地址。
        #
        #   用户请求：GET /api/tasks
        #   Nginx 转发：GET http://backend:8000/api/tasks
        #   后端返回结果 → Nginx 转发给用户

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # ↑ 把用户的真实信息传给后端。
        #   如果不加这些，后端看到的所有请求都来自 Nginx 的 IP，
        #   无法知道真实用户是谁、从哪来的。

        proxy_buffering off;
        # ↑ 【重要】关闭缓冲。
        #   正常情况：Nginx 把后端返回的数据攒够一块再发给用户（提高效率）
        #   但我们的聊天是流式输出（一个字一个字出现），
        #   如果开着缓冲 → 用户看到的是等半天然后一大段文字突然出现
        #   关掉缓冲 → 后端产生一个字，用户立刻看到一个字

        proxy_cache off;
        # ↑ 关闭缓存。API 返回的数据是实时的，不能用旧数据。

        proxy_read_timeout 300s;
        # ↑ 等待后端响应最长 5 分钟。
        #   为什么这么长？因为 RAG 流式生成可能需要几十秒到几分钟。
        #   默认是 60 秒，超过就断开，你会看到回答到一半突然断了。
    }
```

**第三块：图片和健康检查**

```nginx
    location /static/ {
        proxy_pass http://backend:8000/static/;
    }
    # ↑ 上传的图片和检测结果图存在后端容器里。
    #   前端通过 <img src="/static/uploads/xxx.jpg"> 访问。
    #   Nginx 把这些请求转发给后端。

    location /health {
        proxy_pass http://backend:8000/health;
    }
    location /ready {
        proxy_pass http://backend:8000/ready;
    }
    # ↑ 健康检查接口，Docker 用来判断服务是否正常。
}
```

### 4.3 "反向代理"用吃饭来理解

```
你去饭店吃饭：

  没有前台的饭店：
    你自己进厨房找厨师："我要一碗面"
    → 不安全（客人能进厨房）
    → 不高效（厨师还得停下来招待你）
    → 不灵活（如果有两个厨师，你不知道找谁）

  有前台的饭店（= Nginx）：
    你告诉前台："我要一碗面"
    前台把菜单递给厨师（= 转发请求给后端）
    厨师做好了递给前台（= 后端返回响应）
    前台端给你（= Nginx 返回给浏览器）
    → 你根本不知道厨师是谁、在哪（隐藏后端）
    → 前台可以同时招待很多客人（高并发）
    → 如果有两个厨师，前台可以轮流分配（负载均衡）

  这就是「反向代理」。
  "反向"是指代理的是服务端（饭店），不是客户端（你）。
```

---

## 第五章：Dockerfile——制作"光盘"的步骤

### 5.1 后端 Dockerfile 用做便当来理解

```dockerfile
FROM python:3.12-slim AS base
# 第 1 步：拿一个便当盒（基础镜像）
#   python:3.12-slim = 装好了 Python 3.12 的 Linux 系统
#   slim 版本比较小（~150MB），够用了

RUN apt-get update && apt-get install -y libpq-dev libgl1 libglib2.0-0 curl
# 第 2 步：往便当盒里放一些必要的工具
#   libpq-dev = 连接 PostgreSQL 需要的库
#   libgl1    = YOLO 做图像处理需要的库
#   curl      = 健康检查用的命令行工具

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
# 第 3 步：装上 uv（Python 包管理器，你平时就在用）

WORKDIR /app
# 第 4 步：创建一个工作目录（相当于 cd /app）

COPY ultralytics1/ /ultralytics1/
# 第 5 步：把你本地修改的 YOLO 包复制进去

COPY backend/pyproject.toml ./
# 第 6 步：先只复制依赖清单
#
#   为什么不直接把所有代码一起复制？
#   因为 Docker 有个"缓存"机制：
#     - 如果这一步的文件没变，后面的步骤也不用重新执行
#     - pyproject.toml 很少变，代码经常变
#     - 所以先复制依赖清单 → 安装依赖 → 再复制代码
#     - 这样改代码时不用重新安装依赖，构建速度快很多

RUN uv sync --no-dev
# 第 7 步：安装所有依赖（不装开发依赖如 ruff、pytest）
#   这一步最耗时（可能几分钟），但只要 pyproject.toml 没变就会命中缓存

COPY backend/ .
# 第 8 步：复制所有代码

RUN mkdir -p static/uploads static/results knowledge_base managed_versions models
# 第 9 步：创建运行时需要的目录

EXPOSE 8000
# 第 10 步：声明这个容器监听 8000 端口（只是文档性质，不是真正开端口）

CMD ["uv", "run", "fastapi", "run", "app/main.py", "--host", "0.0.0.0", "--port", "8000"]
# 第 11 步：容器启动时执行的命令
#   相当于你在终端敲：uv run fastapi run app/main.py --host 0.0.0.0 --port 8000
```

### 5.2 前端 Dockerfile 用"两步法"来理解

```dockerfile
# ═══ 第一步：做菜（构建）═══
FROM node:20-alpine AS builder
# 拿一个装了 Node 20 的便当盒（alpine 版本超级小）

RUN npm install -g pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# 到这里，/app/dist/ 里就是构建好的 HTML/JS/CSS 文件了
# 但是这个"便当盒"里还装着 Node、pnpm、node_modules（巨大，~1GB）
# 我们不需要带着这些东西上路

# ═══ 第二步：打包（只拿成品）═══
FROM nginx:alpine
# 拿一个新的、干净的、只装了 Nginx 的小便当盒（~30MB）

COPY nginx.conf /etc/nginx/conf.d/default.conf
# 放入我们的 Nginx 配置

COPY --from=builder /app/dist /usr/share/nginx/html
# 关键！从第一步的便当盒里，只把 dist/ 目录拿过来
# Node、pnpm、node_modules、源码全部丢掉

# 最终镜像：Nginx（30MB）+ 你的前端文件（几 MB）= 约 35MB
# 而不是 Node + 源码 + node_modules = 约 1.2GB
```

**这叫「多阶段构建」。面试经常问。**
核心思想：构建环境和运行环境分开，最终镜像只包含运行需要的东西。

---

## 第六章：docker-compose——一键启动所有箱子

### 6.1 没有 docker-compose 的痛苦

如果没有 docker-compose，你要手动启动每个容器：

```bash
# 启动 PostgreSQL
docker run -d --name postgres -e POSTGRES_PASSWORD=xxx -v pgdata:/var/lib/postgresql/data pgvector/pgvector:0.8.2-pg16

# 启动 Redis
docker run -d --name redis redis:7-alpine redis-server --requirepass xxx --appendonly yes

# 启动后端（还要手动指定网络、环境变量、端口映射...）
docker run -d --name backend --link postgres --link redis -e DB_HOST=postgres -p 8000:8000 ...

# 启动 Worker
docker run -d --name worker --link postgres --link redis ...

# 启动前端
docker run -d --name frontend --link backend -p 80:80 ...
```

**五个容器，五条长命令，容易写错，难以维护。**

### 6.2 有了 docker-compose

```bash
docker compose up --build -d    # 一条命令，全部启动
docker compose down             # 一条命令，全部停止
```

docker-compose.yml 就是一份"菜单"，写好了每个服务要什么：

### 6.3 本项目 docker-compose.yml 逐段解释

**PostgreSQL 服务：**

```yaml
services:
  postgres:
    image: pgvector/pgvector:0.8.2-pg16
    # ↑ 钉 0.8.2，修 CVE-2026-3172（并行 HNSW 建索引溢出）
    #   pgvector 是 PostgreSQL + 向量检索扩展（RAG 用）

    restart: unless-stopped
    # ↑ 崩溃了自动重启。手动 docker stop 的不会重启。
    #   生产环境必须加，否则数据库崩了整个系统就瘫了。

    environment:
      POSTGRES_PASSWORD: ${DB_PASSWORD:?请在 .env 中设置 DB_PASSWORD}
    # ↑ 容器启动时创建数据库，用这个密码。
    #   ${DB_PASSWORD} 从项目根目录的 .env 文件读取。
    #   :? 表示"如果没设置就报错并提示"，防止裸密码启动。

    volumes:
      - postgres_data:/var/lib/postgresql/data
    # ↑ 把数据库文件存在一个叫 postgres_data 的"储物柜"里。
    #   没有这行 → 容器删了数据就没了 → 灾难！
    #   有了这行 → 容器删了重建，数据还在。

    ports:
      - "${DB_PORT:-5433}:5432"
    # ↑ 把容器内的 5432 端口映射到宿主机的 5433 端口。
    #   格式：宿主机端口:容器端口
    #   为什么用 5433？避免和你本机的 PostgreSQL（5432）冲突。

    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER:-postgres}"]
      interval: 10s
      timeout: 5s
      retries: 5
    # ↑ 每 10 秒检查一次数据库是否准备好了。
    #   其他服务（backend）设了 depends_on: condition: service_healthy，
    #   会等这个检查通过后才启动。
```

**Redis 服务：**

```yaml
  redis:
    image: redis:7-alpine
    command: redis-server --requirepass ${REDIS_PASSWORD} --appendonly yes
    # ↑ --requirepass：设置密码。没密码的 Redis 等于裸奔。
    #   --appendonly yes：开启持久化，Redis 数据写入磁盘。
    #   没有这个 → Redis 重启后所有数据丢失（缓存没了、队列里的任务没了）。

    volumes:
      - redis_data:/data
    # ↑ 持久化数据存在 redis_data 这个"储物柜"里。
```

**Backend 服务：**

```yaml
  backend:
    build:
      context: .
      dockerfile: backend/Dockerfile
    # ↑ context: . 表示构建上下文是项目根目录。
    #   因为 Dockerfile 里需要访问 ultralytics1/（在根目录），
    #   所以不能把上下文设为 backend/。

    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    # ↑ 等 postgres 和 redis 健康检查通过后，才启动 backend。
    #   如果不加 condition，只保证启动顺序，不保证就绪。
    #   PostgreSQL 容器启动了但数据库还在初始化 → backend 连接报错。

    env_file:
      - ./backend/.env
    # ↑ 从 backend/.env 加载所有环境变量。
    #   你开发时用的那个 .env 文件，这里也用。

    environment:
      DB_HOST: postgres
      DB_PORT: 5432
      REDIS_URL: "redis://:${REDIS_PASSWORD}@redis:6379/0"
    # ↑ 覆盖 .env 里的值。
    #   你的 .env 里写的是 DB_HOST=localhost（开发用），
    #   但在 Docker 里，数据库不在 localhost，而是另一个容器。
    #   容器之间通过服务名（"postgres"）通信，不是 localhost。
    #   这里的 environment 会覆盖 env_file 里的同名变量。

    volumes:
      - backend_static:/app/static
      - backend_models:/app/models
    # ↑ 把上传文件和模型缓存存在持久化"储物柜"里。
    #   容器重建后这些文件还在。

    ports:
      - "8000:8000"
    # ↑ 开发调试时可以直接访问 localhost:8000。
    #   生产环境用户通过 Nginx（:80）访问，不直接访问 8000。
```

**Worker 服务：**

```yaml
  worker:
    build:
      context: .
      dockerfile: backend/Dockerfile
    # ↑ 和 backend 用同一个 Dockerfile！
    #   同一个镜像，同一套代码和依赖。

    command: ["uv", "run", "arq", "app.worker.WorkerSettings"]
    # ↑ 关键区别：覆盖了 Dockerfile 里的 CMD。
    #   backend 启动的是 FastAPI（API 服务器），
    #   worker 启动的是 Arq（任务消费者）。
    #   同一个镜像，不同的启动命令 → 不同的职责。
```

**Frontend 服务：**

```yaml
  frontend:
    build:
      context: ./frontend/myapp
    # ↑ 构建上下文是前端目录。
    #   用里面的 Dockerfile 构建（Node 编译 + Nginx 托管）。

    depends_on:
      - backend
    # ↑ 等 backend 启动后再启动。
    #   因为 Nginx 要转发请求给 backend，backend 必须先启动。

    ports:
      - "80:80"
    # ↑ 用户通过 80 端口访问。
    #   http://你的域名 → 就是这个端口。
```

**Volume 定义：**

```yaml
volumes:
  postgres_data:    # 数据库文件——最重要，丢了 = 所有数据没了
  redis_data:       # Redis 持久化数据
  backend_static:   # 上传的图片、检测结果图
  backend_models:   # HuggingFace 模型缓存（几 GB，避免重复下载）
  backend_knowledge:  # 知识库文档
  backend_versions:   # 文档版本归档
```

---

## 第七章：环境变量——"钥匙"不能放在代码里

### 7.1 为什么用 .env 文件？

```python
# ❌ 绝对不能这样写
DATABASE_URL = "postgresql://postgres:admin@localhost:5432/wind_db"
API_KEY = "nvapi-xxx"

# ✅ 应该这样写
DATABASE_URL = os.getenv("DATABASE_URL")
API_KEY = os.getenv("LLM_API_KEY")
```

原因：
- 代码会提交到 Git → 密码暴露给所有能看到仓库的人
- 不同环境（开发/测试/生产）密码不同，不能写死在代码里
- API Key 泄露 → 别人用你的配额 → 你付钱

### 7.2 本项目的 .env 结构

```
项目根目录/.env        ← docker-compose 读（只放 compose 需要的变量）
backend/.env           ← FastAPI 读（放所有应用配置）
backend/.env.example   ← 模板，提交到 Git，告诉别人需要哪些变量
```

### 7.3 .env 绝对不能提交到 Git

你的 `.gitignore` 里已经有了：
```
.env
.env.*
!.env.example    ← 只有模板可以提交
```

---

## 第八章：数据库迁移——不能删表重建

### 8.1 开发 vs 生产的区别

```
开发环境：
  "表结构改了？删库重建呗。"
  → drop table → create table → 数据没了无所谓

生产环境：
  "表结构改了？里面有 10 万条用户数据！"
  → 不能删表 → 只能"迁移"（在现有表上加列、改类型、加索引）
```

### 8.2 Alembic 做什么

Alembic 就是数据库表结构的 Git —— 每次修改生成一个"版本"，按顺序执行。

```
init → add_users → add_tasks → add_chat → add_knowledge → fix_columns → HEAD
 ↑                                                                         ↑
 最早的版本                                                             最新的版本
```

### 8.3 你需要记住的命令

```bash
# Docker 环境下执行迁移
docker compose exec backend uv run alembic upgrade head

# 如果你改了模型（加了字段等），生成新迁移
docker compose exec backend uv run alembic revision --autogenerate -m "描述"

# 看当前迁移到哪个版本了
docker compose exec backend uv run alembic current
```

---

## 第九章：健康检查——怎么知道服务有没有活着

### 9.1 两种健康检查

```
存活检查 /health：
  "你还活着吗？"
  只检查 FastAPI 进程是否在运行。
  回答："活着"（200 OK）

就绪检查 /ready：
  "你能正常工作吗？"
  检查 FastAPI + 数据库连接 + Redis 连接。
  如果数据库挂了 → 回答："不行"（503）→ Docker 可以决定重启
```

### 9.2 为什么需要就绪检查

```
没有就绪检查的场景：
  FastAPI 进程活着 → /health 说一切正常
  但 PostgreSQL 挂了 → 所有 API 返回 500 错误
  Docker 不知道 → 不重启 → 用户一直看到错误
  你睡着了 → 第二天才发现

有了就绪检查：
  /ready 每 15 秒检查一次 DB 和 Redis
  PostgreSQL 挂了 → /ready 返回 503
  Docker 发现连续 3 次失败 → 标记为 unhealthy → 可以自动重启
```

---

## 第十章：完整部署步骤（照着做就行）

### 首次部署

```bash
# 1. 进入项目目录
cd /path/to/rework

# 2. 确认配置文件
#    检查 .env（根目录）里的 DB_PASSWORD 和 REDIS_PASSWORD
#    检查 backend/.env 里的所有配置

# 3. 一键构建并启动
docker compose up --build -d

# 4. 等待启动（首次构建可能需要 5-10 分钟）
docker compose ps
# 看到所有服务 STATUS 都是 Up 就成功了

# 5. 执行数据库迁移
docker compose exec backend uv run alembic upgrade head

# 6. 创建管理员账号
docker compose exec backend uv run python create_admin.py

# 7. 打开浏览器访问
# http://localhost → 看到登录页面就成功了！
```

### 日常操作速查

```bash
# 看日志（出问题第一步）
docker compose logs -f

# 只看后端日志
docker compose logs -f backend

# 重启后端
docker compose restart backend

# 更新代码后重新部署
git pull
docker compose up --build -d

# 进入后端容器调试
docker compose exec backend bash

# 进入数据库
docker compose exec postgres psql -U postgres wind_db

# 完全停止
docker compose down

# 停止并删除所有数据（谨慎！）
docker compose down -v
```

---

## 第十一章：出问题了怎么办

### 问题 1：容器启动失败

```bash
# 看哪个服务挂了
docker compose ps
# STATUS 不是 Up 的就是有问题的

# 看它的日志
docker compose logs backend
# 日志最后几行通常就是报错原因
```

### 问题 2：前端页面打不开

```
可能原因：
  1. frontend 容器没启动 → docker compose ps 检查
  2. 端口被占用 → lsof -i :80 看谁占了
  3. Nginx 配置错误 → docker compose logs frontend 看报错
```

### 问题 3：API 请求报 502

```
502 = Nginx 无法连接到后端

检查步骤：
  1. docker compose ps → backend 是否在运行？
  2. docker compose logs backend → 后端是否报错？
  3. 如果后端刚重启，等几秒再试（初始化需要时间）
```

### 问题 4：聊天回复不是逐字出现

```
原因：Nginx 的 proxy_buffering 没关
检查：nginx.conf 中 /api/ 下是否有 proxy_buffering off;
```

### 问题 5：数据库连接失败

```
日志报：connection refused 或 could not connect to server

检查：
  1. docker compose ps → postgres 是否 healthy？
  2. docker compose exec backend env | grep DB_HOST
     → 如果显示 localhost 就错了，应该是 postgres
  3. 密码是否匹配 → 对比 .env 和 docker-compose.yml
```

---

## 第十二章：面试怎么说这些

### 当面试官问"你的项目怎么部署的？"

```
回答框架（30秒版）：
"项目用 Docker Compose 编排了 5 个服务：
 PostgreSQL 做持久化存储，Redis 做缓存和任务队列，
 FastAPI 提供 API，Arq Worker 处理异步任务如 YOLO 推理，
 前端用 Vite 构建后由 Nginx 托管，Nginx 同时做反向代理把 /api 请求转发给后端。
 数据库迁移用 Alembic，敏感配置走环境变量。"
```

### 高频追问及回答

| 问题 | 简短回答 |
|------|---------|
| 镜像和容器的区别？ | 镜像是只读模板（光盘），容器是运行实例（用光盘启动的电脑） |
| 为什么用 Nginx 不直接暴露 FastAPI？ | FastAPI 是应用服务器，不擅长静态文件分发和 SSL。Nginx 做反向代理、静态文件、SPA 路由处理 |
| SPA 刷新 404 怎么解决？ | Nginx 的 `try_files $uri $uri/ /index.html` |
| 反向代理是什么？ | 用户只访问 Nginx，Nginx 帮忙转发给后端，用户不知道后端在哪 |
| 为什么 API 和 Worker 分开？ | API 负责接请求，Worker 负责耗时任务。不分开的话推理时 API 会卡死 |
| 多阶段构建是什么？ | 第一阶段编译代码，第二阶段只拿产物，最终镜像不含构建工具，体积小 |
| 环境变量为什么不写在代码里？ | 代码会入 Git，密码会泄露。不同环境配置不同，不能写死 |
| 容器数据怎么持久化？ | 用 Docker Volume，容器删了重建数据还在 |
| 健康检查怎么做的？ | `/health` 检查进程存活，`/ready` 检查数据库和 Redis 是否可用 |
| 流式响应部署要注意什么？ | Nginx 必须关闭 `proxy_buffering`，否则数据会被缓冲，不是实时推送 |

---

## 附录：术语速查表

| 术语 | 一句话解释 |
|------|-----------|
| Docker | 把应用和环境打包成"集装箱"，到处都能运行 |
| 镜像 (Image) | 只读模板，包含操作系统 + 应用 + 依赖 |
| 容器 (Container) | 镜像的运行实例，轻量级虚拟机 |
| Dockerfile | 制作镜像的脚本 |
| docker-compose | 同时管理多个容器的编排工具 |
| Volume | Docker 的持久化存储，容器删了数据不丢 |
| Nginx | Web 服务器 + 反向代理 |
| 反向代理 | 在用户和后端之间加一层"前台"，转发请求 |
| SPA | 单页应用（React/Vue），只有一个 HTML，路由由 JS 处理 |
| try_files | Nginx 指令，按顺序尝试文件，找不到就回退 |
| proxy_pass | Nginx 指令，把请求转发给另一个服务 |
| proxy_buffering | Nginx 是否缓冲后端响应，流式必须关闭 |
| 健康检查 | 定期检查服务是否正常运行 |
| 存活探针 | 检查进程是否活着 |
| 就绪探针 | 检查依赖（DB、Redis）是否可用 |
| Alembic | Python 数据库迁移工具（表结构版本管理） |
| 迁移 | 增量修改数据库表结构，不删表不丢数据 |
| .env | 环境变量文件，存密码和配置，不提交到 Git |
| server_default | 数据库层面的默认值，不依赖 ORM |
