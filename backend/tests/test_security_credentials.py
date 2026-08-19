"""2.5 凭证与口令：默认 access token ~2h；密码 8–128。

不 import app.main / RagService。
"""

from datetime import UTC, datetime, timedelta

import jwt
import pytest
from pydantic import ValidationError

from app.core.config import Settings
from app.core.security import create_access_token
from app.schemas.user import UserCreate


def test_access_token_default_ttl_is_two_hours():
    assert Settings.model_fields["ACCESS_TOKEN_EXPIRE_MINUTES"].default == 120


def test_create_access_token_honors_two_hour_delta():
    token = create_access_token({"sub": "1"}, timedelta(minutes=120))
    payload = jwt.decode(
        token,
        options={"verify_signature": False},
        algorithms=["HS256"],
    )
    exp = datetime.fromtimestamp(payload["exp"], tz=UTC)
    delta = (exp - datetime.now(UTC)).total_seconds()
    assert 119 * 60 < delta < 121 * 60


def test_password_too_short_rejected():
    with pytest.raises(ValidationError):
        UserCreate(username="alice", password="1234567")


def test_password_too_long_rejected():
    with pytest.raises(ValidationError):
        UserCreate(username="alice", password="a" * 129)


def test_password_min_length_accepted():
    user = UserCreate(username="alice", password="12345678")
    assert user.password == "12345678"


def test_password_max_length_accepted():
    user = UserCreate(username="alice", password="b" * 128)
    assert len(user.password) == 128
