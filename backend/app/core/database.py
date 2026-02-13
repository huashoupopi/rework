from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings


class Base(DeclarativeBase):
    pass


if not settings.DATABASE_URL:
    raise RuntimeError("DATABASE_URL is empty. Configure DB_* fields or DATABASE_URL in .env")

engine = create_async_engine(settings.DATABASE_URL, echo=settings.DB_ECHO)
# expire_on_commit=False 防止提交后对象过期，异步视图中更易用
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except:
            await session.rollback()
            raise
        finally:
            await session.close()


async def init_models():
    # 后续声明每个表 都继承 Base，lifespan挂一下
    pass
