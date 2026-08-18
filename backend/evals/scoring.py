"""eval 30 分层判分模块（纯函数，无 I/O）。

设计约束：
- 每个函数只吃 Python 基本类型，不发请求、不读文件 → CI 可离线 import
- 每个函数返回 dict，必含 "pass": bool，其余是诊断字段（判挂时能看出为什么）
- case 即 eval30_cases.yaml 里一条的 dict 形状

判分口径见 eval30_审题报告_20260818.md §四（2026-08-18 所有者裁决）。

〔本文件骨架由 AI 搭建，全部函数体由所有者手写——2026-08-18〕
"""

from typing import Any

# ── 1. 路由层 ────────────────────────────────────────────────


def score_routing(case: dict[str, Any], route: str) -> dict[str, Any]:
    """判路由标签。

    输入:
        case["expect"]["route"] → "rag" 或 "fallback"
        route → 系统实际走的路由（runner 从 meta 里取出来传进来）
    返回:
        {"pass": bool, "expected": str, "actual": str}
    """
    expected = case["expect"]["route"]
    actual = route
    passed = expected == actual
    return {"pass": passed, "expected": expected, "actual": actual}


# ── 2. 门卫层 ────────────────────────────────────────────────


def score_guardrail(case: dict[str, Any], blocked: bool) -> dict[str, Any]:
    """判该拦的拦没拦、不该拦的放没放。

    输入:
        case["expect"]["should_block"] → bool
        blocked → 系统实际拦没拦（在线跑: runner 看 meta.finish_reason;
                  CI 离线跑: runner 用 score_injection() 分数过不过阈值算出来）
    返回:
        {"pass": bool, "expected_block": bool, "actual_block": bool}
    """
    expected_block = case["expect"]["should_block"]
    actual_block = blocked
    passed = expected_block == actual_block
    return {"pass": passed, "expected_block": expected_block, "actual_block": actual_block}


# ── 3. 生成层 ────────────────────────────────────────────────


def score_generation(case: dict[str, Any], answer: str) -> dict[str, Any]:
    """判答案的词面保真。

    输入:
        case["expect"] 可能含三个键（都可能缺席，缺席就跳过该项检查）:
            "must_mention": [词, ...]      → 每个词都必须出现在 answer 里
            "must_not_mention": [词, ...]  → 每个词都不许出现
            "must_precede": {"first": 词A, "second": 词B}
                → 若 A、B 都出现，A 的位置必须在 B 前面；
                  若 B 压根没出现，此项算过（裁决 D：G04 判序用）
        answer → 模型的完整回答文本
    返回:
        {"pass": bool,            # 三项检查全过才 True
         "missed": [漏掉的词],
         "banned_hits": [出现了的违禁词],
         "order_ok": bool}
    """
    missed = [w for w in case["expect"].get("must_mention", []) if w not in answer]
    banned_hits = [w for w in case["expect"].get("must_not_mention", []) if w in answer]
    must_precede = case["expect"].get("must_precede", {})
    order_ok = False
    if not must_precede:
        order_ok = True  # 没有要求顺序的情况，算过
    else:
        first_index = answer.find(must_precede["first"])
        second_index = answer.find(must_precede["second"])
        if second_index == -1:
            order_ok = True  # 裁决 D：若 B 压根没出现，此项算过
        elif first_index == -1:
            order_ok = False  # A 没出现，算不过
        else:
            order_ok = first_index < second_index  # A、B 都出现，A 必须在 B 前面

    return {
        "pass": not missed and not banned_hits and order_ok,
        "missed": missed,
        "banned_hits": banned_hits,
        "order_ok": order_ok,
    }


# ── 4. 多轮改写层 ────────────────────────────────────────────


def score_multi_turn(case: dict[str, Any], rewritten: str) -> dict[str, Any]:
    """判改写后的查询是否补全了指代。

    输入:
        case["expect"] 含:
            "rewritten_must_contain": [实体词, ...]  → 改写结果必须包含
            "rewritten_must_not_equal": 原句          → 可能缺席；存在时改写结果不许原样等于它
        rewritten → 系统改写后的查询（runner 从 meta.rewritten_query 取）
    返回:
        {"pass": bool, "missing": [漏掉的实体], "unchanged": bool}
    """
    rewritten_must_contain = case["expect"]["rewritten_must_contain"]
    rewritten_must_not_equal = case["expect"].get("rewritten_must_not_equal", None)
    missing = [w for w in rewritten_must_contain if w not in rewritten]
    unchanged = (
        rewritten.strip() == rewritten_must_not_equal.strip()
        if rewritten_must_not_equal
        else False
    )
    return {"pass": not missing and not unchanged, "missing": missing, "unchanged": unchanged}


# ── 5. 检索层（最难，最后写）─────────────────────────────────


def _first_rank(term: str, chunks: list[str]) -> int | None:
    """返回 term 在 chunks 里第一次出现的名次（从 1 数），没出现就返回 None。"""
    for rank, chunk in enumerate(chunks, start=1):
        if term in chunk:
            return rank
    return None


def score_retrieval(
    case: dict[str, Any],
    pre_chunks: list[str],
    post_chunks: list[str],
) -> dict[str, Any]:
    """判检索命中 + 算 MRR。命中定义在 chunk 级（裁决 A）。

    输入:
        case["expect"]["terms"] → 期望出现在检出 chunk 文本里的词
        pre_chunks  → rerank 前 top10 的 chunk 文本，按名次排（第 0 个 = 第 1 名）
        post_chunks → rerank 后 top5 的 chunk 文本，按名次排
    要算的东西（对每个 term）:
        - 它在 pre_chunks 里第一次出现在第几名（没出现 = 未命中）
        - 它在 post_chunks 里第一次出现在第几名
    汇总:
        - hit_at_10: 在 rerank 前 top10 命中的 term 数 / term 总数
        - hit_at_5:  在 rerank 后 top5  命中的 term 数 / term 总数
        - mrr: 对每个 term 取 1/首次命中名次（名次从 1 数），未命中记 0，再求平均
               （按 rerank 后的名次算）
        - pass 口径（所有者裁定 2026-08-18）: **并集覆盖**——所有 term 都能在
          post_chunks 的某个 chunk 里找到，各自在哪个 chunk 都行。
          弃「单 chunk 全含」的理由: R10 的四个词横跨 §2.2/§2.3 两段、R04 跨
          §2.4/§3.4，单 chunk 全含使这些题结构上永远不可能通过，违反
          「入卷题必须今天能过」原则（审题报告 §四裁决 B 同源）。
    返回:
        {"pass": bool, "hit_at_10": float, "hit_at_5": float,
         "mrr": float, "term_ranks": {term: 名次或 None}}
    """
    terms = case["expect"]["terms"]
    pre_term_ranks: dict[str, int | None] = {}
    post_term_ranks: dict[str, int | None] = {}
    for term in terms:
        rank = _first_rank(term, pre_chunks)
        pre_term_ranks[term] = rank

    for term in terms:
        rank = _first_rank(term, post_chunks)
        post_term_ranks[term] = rank

    hit_at_10 = sum(1 for r in pre_term_ranks.values() if r is not None) / len(terms)
    hit_at_5 = sum(1 for r in post_term_ranks.values() if r is not None) / len(terms)
    mrr = sum(1 / rank for rank in post_term_ranks.values() if rank is not None) / len(terms)

    passed = all(rank is not None for rank in post_term_ranks.values())
    return {
        "pass": passed,
        "hit_at_10": round(hit_at_10, 2),
        "hit_at_5": round(hit_at_5, 2),
        "mrr": round(mrr, 2),
        "term_ranks": post_term_ranks,
    }
