import asyncio

from sqlalchemy import select

from app.core.database import AsyncSessionLocal
from app.core.security import get_password_hash
from app.models.user import User


async def create_admin(username: str, password: str, full_name: str) -> None:
    async with AsyncSessionLocal() as db:
        # 检查管理员是否已存在
        result = await db.execute(select(User).where(User.username == username))
        existing_user = result.scalars().first()
        if existing_user:
            print(f"管理员 '{username}' 已存在")
            return

        # 创建管理员用户
        hashed_password = get_password_hash(password)
        admin_user = User(
            username=username,
            hashed_password=hashed_password,
            full_name=full_name,
            is_superuser=True,
        )
        db.add(admin_user)
        await db.commit()
        print(f"管理员 '{username}' 创建成功")


if __name__ == "__main__":
    # 这里可以改成从环境变量或命令行参数获取管理员信息
    admin_username = "admin"
    admin_password = "admin"
    admin_full_name = "管理员"

    asyncio.run(create_admin(admin_username, admin_password, admin_full_name))
