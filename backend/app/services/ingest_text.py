"""入库文本处理：复用门卫 `_normalize`，外加近重复告警（不自动去重）。"""

from __future__ import annotations

import hashlib
import logging
import re
from collections import defaultdict
from difflib import SequenceMatcher
from typing import Any

from app.security import _normalize

logger = logging.getLogger(__name__)

# NFKC 会把 ²→2。知识库面积单位必须保留上标，否则「0.1 m²」检索词永远对不上。
_UNIT_SUPER_RE = (
    (re.compile(r"(\d(?:\.\d+)?)\s*mm2\b"), r"\1 mm²"),
    (re.compile(r"(\d(?:\.\d+)?)\s*cm2\b"), r"\1 cm²"),
    (re.compile(r"(\d(?:\.\d+)?)\s*m2\b"), r"\1 m²"),
    (re.compile(r"(\d(?:\.\d+)?)\s*m3\b"), r"\1 m³"),
)


def restore_unit_superscripts(text: str) -> str:
    for pattern, repl in _UNIT_SUPER_RE:
        text = pattern.sub(repl, text)
    return text


def normalize_ingest_text(text: str) -> str:
    return restore_unit_superscripts(_normalize(text or ""))


def apply_normalize_to_node(node: Any) -> None:
    raw = getattr(node, "text", "") or ""
    normalized = normalize_ingest_text(raw)
    if normalized == raw:
        return
    if hasattr(node, "set_content"):
        node.set_content(normalized)
    else:
        node.text = normalized


def near_duplicate_warnings(nodes: list[Any]) -> list[str]:
    """同归一化正文出现在不同 doc_key 下则告警。不删除任何节点。"""
    buckets: dict[str, list[str]] = defaultdict(list)
    for node in nodes:
        text = (getattr(node, "text", "") or "").strip()
        if not text:
            continue
        digest = hashlib.sha1(normalize_ingest_text(text).encode("utf-8")).hexdigest()
        metadata = getattr(node, "metadata", {}) or {}
        doc_key = str(metadata.get("doc_key") or metadata.get("file_name") or "?")
        buckets[digest].append(doc_key)

    warnings: list[str] = []
    for digest, doc_keys in buckets.items():
        unique = sorted(set(doc_keys))
        if len(unique) >= 2:
            msg = f"near-dup hash={digest[:12]} docs={unique} copies={len(doc_keys)}"
            warnings.append(msg)
            logger.warning("ingest %s", msg)
    # 跨文档高相似（PDF/md 近重复）——只告警，不删
    samples: list[tuple[str, str]] = []
    for node in nodes:
        text = normalize_ingest_text((getattr(node, "text", "") or "").strip())
        if len(text) < 80:
            continue
        metadata = getattr(node, "metadata", {}) or {}
        doc_key = str(metadata.get("doc_key") or metadata.get("file_name") or "?")
        samples.append((doc_key, text[:500]))
    seen: set[tuple[str, str]] = set()
    for i, (left_key, left_text) in enumerate(samples):
        for right_key, right_text in samples[i + 1 :]:
            if left_key == right_key:
                continue
            pair = tuple(sorted((left_key, right_key)))
            if pair in seen:
                continue
            ratio = SequenceMatcher(None, left_text, right_text).ratio()
            if ratio >= 0.85:
                seen.add(pair)
                msg = f"near-dup similar={ratio:.2f} docs={list(pair)}"
                warnings.append(msg)
                logger.warning("ingest %s", msg)

    if warnings:
        logger.warning("ingest near-dup alerts=%d (no auto-dedup)", len(warnings))
    return warnings
