import logging
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


if not settings.DATABASE_URL:
    raise RuntimeError("DATABASE_URL is empty. Configure DB_* fields or DATABASE_URL in .env")

"""
PostgreSQL连接池说明：
1. 这里是应用ORM的主AsyncEngine:同一进程内 不管是get_db()还是直接用AsyncSessionLocal，
只要复用这个engine 就共用同一套连接池。
2. 当前没有显式传pool_size / max_oveflow淡出，因此使用SQLAlchemy的默认值:
pool_size=5 max_overflow=10 pool_timeout=30s
3. 这表示单个engine的理论上限是15(5个常驻+10个临时overflow)
4. 这个项目当前的默认连接预算不能只看这里，因为API的PGVectorStore worker进程 build_knowledge子进程
都会额外创建独立engine
5. 以当前的默认值估算：
- 常驻运行：API ORM 1 套 + API PGVector 2套 + worker ORM 1套 = 4套pool
=> 4 × 15 = 60 个理论连接上限
   - 知识库重建时：再增加 build_knowledge 的 ORM 1 套 + PGVector 2 套
    => 7 × 15 = 105 个理论连接上限
6. 如果后续要显式收紧连接预算，建议优先考虑：
    pool_size=3, max_overflow=2    这样常驻预算约 20，重建峰值约 35。
7. 这里暂时保留库默认值，不修改运行行为；这段注释仅用于提示总连接预算。
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=settings.DB_ECHO,
    pool_size=3,
    max_overflow=2,
    pool_timeout=30,
    pool_pre_ping=True,
)

"""
engine = create_async_engine(settings.DATABASE_URL, echo=settings.DB_ECHO)
# expire_on_commit=False 防止提交后对象过期，异步视图中更易用
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except:
            logger.exception("Database session error")
            await session.rollback()
            raise
        finally:
            await session.close()


async def init_models():
    # 后续声明每个表 都继承 Base，lifespan挂一下
    pass
