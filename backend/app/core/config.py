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
    #################################################
    ALLOWED_ORIGINS: list[str] = ["http://localhost:5173"]

    ################################################# LLM 配置
    LLM_MODEL_NAME: str = "qwen3.5:4b"
    LLM_IS_VISION_MODEL: bool = False
    UPLOAD_DIR: str = "static/uploads"

    # LLM 提供商协议: "openai" (NVIDIA/DeepSeek/通义千问/LM Studio) | "ollama"
    LLM_PROVIDER: str = "openai"
    # OpenAI 兼容配置（所有 /v1/chat/completions 协议的提供商共用）
    LLM_API_BASE: str = "http://localhost:1234/v1"
    LLM_API_KEY: str = "no-key"
    LLM_ENABLE_THINKING: bool = False
    # Ollama 专有配置
    OLLAMA_BASE_URL: str = "http://localhost:11434"
    OLLAMA_KEEP_ALIVE: str = "1h"

    ################################################# RAG相关配置
    RAG_SESSION_MEMORY_ENABLED: bool = True
    RAG_SESSION_WINDOW_TURNS: int = 4
    ################################################# RAG核心配置
    MODELS_DIR: str = str(Path(__file__).resolve().parent.parent.parent / "models")
    HF_HOME: str = ""
    HUGGINGFACE_HUB_CACHE: str = ""
    LLAMA_INDEX_CACHE_DIR: str = ""

    # RAG 并发与超时
    RAG_MAX_CONCURRENCY: int = 2
    RAG_OLLAMA_REQUEST_TIMEOUT_S: float = 60.0
    RAG_STREAM_TOTAL_TIMEOUT_S: float = 120.0

    # RAG 路由配置与置信度
    RAG_ROUTE_MIN_CONTEXT_NODES: int = 1
    RAG_ROUTE_MIN_TOP_SCORE: float = -2.0

    # eval 观测口（eval30 检索层判分用；生产必须保持 False——meta 会带全量 chunk 文本）
    RAG_EVAL_DEBUG: bool = False

    # === 知识库配置 ===
    KNOWLEDGE_DIR: str = str(Path(__file__).resolve().parent.parent.parent / "knowledge_base")
    MANAGED_VERSIONS_DIR: str = ""  # 版本归档目录，_build_derived_paths 自动填充
    ALLOWED_DOC_SUFFIXES: str = ".pdf,.md,.markdown"  # 逗号分隔

    # 默认分块参数（数据库有 KnowledgeChunkConfig 表可覆盖）
    CHUNK_SIZE: int = 800
    CHUNK_OVERLAP: int = 150
    CHUNK_MIN_LEN: int = 20

    # 重建超时
    KNOWLEDGE_BUILD_TIMEOUT_S: int = 600

    # Docling 模型缓存路径（PDF 解析模型，避免下载到系统默认目录）
    DOCLING_CACHE_DIR: str = ""  # _build_derived_paths 自动填充

    # === 安全配置 ===
    INJECTION_BLOCK_THRESHOLD: int = 6
    INJECTION_SANITIZE_THRESHOLD: int = 3
    INJECTION_CONTEXT_THRESHOLD: int = 3

    # === Redis 配置 ===
    REDIS_URL: str = ""
    REDIS_MAX_CONNECTIONS: int = 10

    @model_validator(mode="after")
    def _build_derived_paths(self) -> "Settings":
        if not self.DATABASE_URL:
            pwd = quote_plus(self.DB_PASSWORD)
            self.DATABASE_URL = f"postgresql+asyncpg://{self.DB_USER}:{pwd}@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"
        Path(self.UPLOAD_DIR).mkdir(parents=True, exist_ok=True)
        model_path = Path(self.MODELS_DIR)
        if not self.HF_HOME:
            self.HF_HOME = str(model_path / "hf_cache")
        if not self.HUGGINGFACE_HUB_CACHE:
            self.HUGGINGFACE_HUB_CACHE = str(model_path / "hf_cache")
        if not self.LLAMA_INDEX_CACHE_DIR:
            self.LLAMA_INDEX_CACHE_DIR = str(model_path / "hf_cache")
        for dir in [self.MODELS_DIR, self.HF_HOME, self.LLAMA_INDEX_CACHE_DIR]:
            Path(dir).mkdir(parents=True, exist_ok=True)
        # 知识库目录
        kb_path = Path(self.KNOWLEDGE_DIR)
        kb_path.mkdir(parents=True, exist_ok=True)
        if not self.MANAGED_VERSIONS_DIR:
            self.MANAGED_VERSIONS_DIR = str(kb_path.parent / "managed_versions")
        Path(self.MANAGED_VERSIONS_DIR).mkdir(parents=True, exist_ok=True)

        # Docling 缓存目录
        if not self.DOCLING_CACHE_DIR:
            self.DOCLING_CACHE_DIR = str(Path(self.MODELS_DIR) / "docling_cache")
        Path(self.DOCLING_CACHE_DIR).mkdir(parents=True, exist_ok=True)
        return self


settings = Settings()
