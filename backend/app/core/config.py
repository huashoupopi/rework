from pathlib import Path
from urllib.parse import quote_plus

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE_PATH = Path(__file__).resolve().parent.parent.parent / ".env"


class Settings(BaseSettings):
    BASE_URL: Path = Path(__file__).resolve().parent.parent
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

    @model_validator(mode="after")
    def _build_derived_paths(self) -> "Settings":
        if not self.DATABASE_URL:
            pwd = quote_plus(self.DB_PASSWORD)
            self.DATABASE_URL = f"postgresql+asyncpg://{self.DB_USER}:{pwd}@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"
        return self


settings = Settings()
