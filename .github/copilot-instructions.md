# Copilot Instructions — WindSlice (rework)

## Project Overview

WindSlice is a wind turbine blade defect detection platform. The backend is a FastAPI + SQLAlchemy (async) application that accepts image uploads, runs YOLO object detection in background tasks, and exposes a RAG-based chat interface powered by Ollama for defect analysis Q&A.

## Tech Stack

- **Runtime**: Python 3.12, managed with `uv`
- **Framework**: FastAPI with async lifespan
- **Database**: PostgreSQL (asyncpg) with SQLAlchemy 2.0 async ORM
- **Migrations**: Alembic (async engine via `env.py`)
- **Auth**: JWT (PyJWT) + Argon2 password hashing (pwdlib)
- **ML**: Custom-trained YOLO model (ultralytics, installed as editable local package from `../ultralytics1`)
- **RAG/LLM**: LlamaIndex + Ollama (qwen3:14b default), pgvector for vector storage
- **Linter**: Ruff

## Commands

All commands run from the `backend/` directory:

```bash
# Install dependencies
uv sync

# Run dev server
uv run fastapi dev app/main.py

# Lint
uv run ruff check .
uv run ruff format .

# Run all tests
uv run pytest

# Run a single test
uv run pytest tests/test.py -k "test_name"

# Alembic migrations
uv run alembic upgrade head
uv run alembic revision --autogenerate -m "description"
```

## Architecture

```
backend/
├── app/
│   ├── main.py          # FastAPI app, lifespan (model loading, DB init), router mounting
│   ├── core/
│   │   ├── config.py    # pydantic-settings, reads .env, builds DATABASE_URL
│   │   ├── database.py  # async engine, sessionmaker, Base, get_db dependency
│   │   ├── security.py  # JWT creation, Argon2 password hashing
│   │   └── logging.py
│   ├── models/          # SQLAlchemy ORM models (User, Task, ChatMessage)
│   ├── schemas/         # Pydantic request/response schemas
│   ├── crud/            # DB query functions (thin layer over SQLAlchemy)
│   ├── routers/         # API endpoints, grouped by domain
│   │   ├── auth.py      # Also defines get_current_user dependency
│   │   ├── user.py
│   │   ├── task.py
│   │   └── chat.py
│   └── services/        # Business logic
│       ├── yolo_service.py      # Singleton YOLO model, class-method pattern
│       ├── file_service.py      # Upload/result file management
│       ├── report_service.py
│       └── rag_learning_demo.py # Teaching/demo RAG pipeline (keyword-based retrieval)
├── alembic/             # Migrations; env.py uses async engine from app config
├── knowledge_base/      # RAG document sources
└── static/              # Uploaded images and detection results
```

All API routes are mounted under `/api` prefix in `main.py`.

## Key Conventions

- **Async everywhere**: All DB operations, route handlers, and the Alembic env use async/await. Use `AsyncSession` from `get_db` dependency.
- **Background detection**: Image uploads trigger YOLO inference via `BackgroundTasks`. The background task opens its own `AsyncSessionLocal()` session — do not pass the request-scoped session into background tasks.
- **Auth dependency chain**: `get_current_user` (in `routers/auth.py`) is the standard dependency for protected routes. It decodes the JWT and returns a `User` ORM object. Superuser checks are done inline in route handlers.
- **Model imports in Alembic**: New ORM models must be explicitly imported in `alembic/env.py` for autogenerate to detect them.
- **`TYPE_CHECKING` for relationships**: Models use `from __future__ import annotations`-style forward refs with `if TYPE_CHECKING` blocks to avoid circular imports between User ↔ Task ↔ ChatMessage.
- **`server_default=func.now()`**: Timestamps use DB-side defaults, not Python-side `default=datetime.now`.
- **Ruff config**: Line length 99, rules include isort (I), pyupgrade (UP), bugbear (B), simplify (SIM). `E501` is ignored. `B008` is suppressed in router files (for `Depends()` in defaults). Run `ruff check` before committing.
- **Git guard**: A pre-commit hook (`.githooks/pre-commit`) blocks commits containing `.DS_Store`, `__pycache__`, `.pyc`, or `ultralytics1/` files. Setup via `scripts/setup_git_guard.sh`. Bypass with `BYPASS_GIT_GUARD=1 git commit`.
- **ultralytics1/**: A locally patched fork of the ultralytics library, installed as an editable dependency. It is gitignored from the main repo — do not modify or commit files in this directory.
- **Environment**: Config is loaded from `backend/.env` via pydantic-settings. Required vars: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `SECRET_KEY`. Optional: `YOLO_MODEL_PATH`, `OLLAMA_BASE_URL`, `LLM_MODEL_NAME`.
- **Chinese UI strings**: User-facing error messages and API tag names are in Chinese (e.g., `detail="用户名已存在"`). Keep this convention for consistency.
