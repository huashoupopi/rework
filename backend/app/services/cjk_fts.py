"""应用侧中文预分词，配合 PG `text_search_config=simple`。

选定路线⑵（jieba），不选⑴ zhparser：CI 镜像钉死 pgvector/pgvector:0.8.2-pg16，
装中文分词扩展要改镜像。simple 只按空格切词，所以入库和查询都要先切好。

入库保留原文（embedding / eval 子串命中），另附一行空格分词给 FTS。
"""

from __future__ import annotations

import jieba

from app.security import _normalize


def tokenize_for_fts(text: str) -> str:
    """查询侧：先归一化再切词，让 ⻮轮箱 也能命中 齿轮 箱。"""
    normalized = _normalize(text or "")
    tokens = [token.strip() for token in jieba.cut(normalized) if token.strip()]
    return " ".join(tokens)


def index_text_with_fts(text: str) -> str:
    """入库侧：text 必须已是 normalize_ingest_text 的结果（含 m² 写回）。

    这里不再跑 _normalize，否则 ² 会被再次收成 2。
    """
    original = text or ""
    tokens = [token.strip() for token in jieba.cut(original) if token.strip()]
    fts_line = " ".join(tokens)
    if not fts_line or fts_line == original:
        return original
    return f"{original}\n{fts_line}"
