"""超参搬家：默认值必须与搬前一致。不 import rag_service。"""

from app.core.config import settings


def test_retrieval_settings_keep_legacy_defaults():
    assert settings.RETRIEVAL_TOP_K == 10
    assert settings.RERANK_TOP_N == 5
    assert settings.SOURCE_THRESHOLD == -6.0
    assert settings.RRF_K == 60
