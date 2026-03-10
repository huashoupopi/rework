from pathlib import Path
from urllib.parse import quote_plus

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE_PATH = Path(__file__).resolve().parent.parent.parent / ".env"


class Settings(BaseSettings):
    BASE_DIR: Path = Path(__file__).resolve().parent.parent
    DB_HOST: str = ""
    DB_PORT: int = 5433
    DB_USER: str = ""
    DB_PASSWORD: str = ""
    DB_NAME: str = ""
    DB_TABLE: str = ""
    DB_ECHO: bool = False
    DATABASE_URL: str = ""
    model_config = SettingsConfigDict(
        env_file=_ENV_FILE_PATH if _ENV_FILE_PATH.exists() else None,
        env_file_encoding="utf-8",
        extra="ignore",
    )
    YOLO_MODEL_PATH: str = "best.pt"

    SECRET_KEY: str = ""
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7

    ################################################# Ollama/LLM 配置
    LLM_MODEL_NAME: str = "qwen3.5:4b"
    OLLAMA_BASE_URL: str = "http://localhost:11434"
    OLLAMA_KEEP_ALIVE: str = "1h"
    LLM_IS_VISION_MODEL: bool = False
    UPLOAD_DIR: str = "static/uploads"

    ################################################# RAG相关配置
    RAG_SESSION_MEMORY_ENABLED: bool = True
    RAG_SESSION_WINDOW_TURNS: int = 4
    ################################################# RAG核心配置
    MODELS_DIR: str = str(Path(__file__).resolve().parent.parent.parent / "models")
    HF_HOME: str = ""
    HUGGINGFACE_HUB_CACHE: str = ""

    # RAG 并发与超时
    RAG_MAX_CONCURRENCY: int = 2
    RAG_OLLAMA_REQUEST_TIMEOUT_S: float = 60.0
    RAG_STREAM_TOTAL_TIMEOUT_S: float = 90.0

    # RAG 路由配置与置信度
    RAG_ROUTE_MIN_CONTEXT_NODES: int = 1
    RAG_ROUTE_MIN_TOP_SCORE: float = -2.0

    @model_validator(mode="after")
    def _build_derived_paths(self) -> "Settings":
        if not self.DATABASE_URL:
            pwd = quote_plus(self.DB_PASSWORD)
            self.DATABASE_URL = f"postgresql+asyncpg://{self.DB_USER}:{pwd}@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"
        Path(self.UPLOAD_DIR).mkdir(parents=True, exist_ok=True)
        model_path = Path(self.MODELS_DIR)
        if not self.HF_HOME:
            self.HF_HOME = str(model_path / "hfcache")
        if not self.HUGGINGFACE_HUB_CACHE:
            self.HUGGINGFACE_HUB_CACHE = str(model_path / "hf_cache")
        for dir in [self.MODELS_DIR, self.HF_HOME]:
            Path(dir).mkdir(parents=True, exist_ok=True)
        return self


settings = Settings()
