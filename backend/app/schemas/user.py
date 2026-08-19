from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

# 为什么做输出分离？ UserCreate含密码，UserPublic不含密码，避免泄露敏感信息
# from_attributes=True 让pydantic模型可以直接从ORM对象创建实例，避免手动转换
# extra="forbid" 防什么？ 防客户端偷塞is_superuser:true提权


class UserBase(BaseModel):
    username: str
    full_name: str | None = None


class UserCreate(UserBase):
    password: str = Field(min_length=8, max_length=128)
    model_config = ConfigDict(extra="forbid")


class UserPublic(UserBase):
    id: int
    is_superuser: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
    """
    这种写法也行：
    class Config:
        from_attributes = True
    但是在pydantic v2中推荐使用ConfigDict，避免和pydantic v1的Config混淆
    """
