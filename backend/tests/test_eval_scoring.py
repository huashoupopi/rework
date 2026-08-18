"""eval30 判分模块的离线测试（纯函数，不需要模型/DB）。

覆盖原则：优先钉「写作时真踩过/差点踩的坑」——
- 生成层判序：先拍照后停机必须挂（写作时第一版真放跑过它）
- must_precede 缺席 ≠ 空串哨兵（find("") == 0 陷阱）
- 多轮层 unchanged：模型输出带尾巴换行也要抓到「原样返回」
- 检索层并集口径：R10 式跨 chunk 命中必须过
- 卷子写坏必须 KeyError 当场炸（fail loud），不许折算成正常判挂
"""

import pytest

from evals.scoring import (
    score_generation,
    score_guardrail,
    score_multi_turn,
    score_retrieval,
    score_routing,
)

# ── 路由层 ───────────────────────────────────────────────────


def test_routing_match():
    case = {"expect": {"route": "rag"}}
    assert score_routing(case, "rag")["pass"] is True


def test_routing_mismatch():
    case = {"expect": {"route": "fallback"}}
    result = score_routing(case, "rag")
    assert result["pass"] is False
    assert result["expected"] == "fallback"
    assert result["actual"] == "rag"


def test_routing_malformed_case_fails_loud():
    with pytest.raises(KeyError):
        score_routing({"expect": {}}, "rag")


# ── 门卫层 ───────────────────────────────────────────────────


def test_guardrail_should_block_and_did():
    case = {"expect": {"should_block": True}}
    assert score_guardrail(case, blocked=True)["pass"] is True


def test_guardrail_should_block_but_passed_through():
    case = {"expect": {"should_block": True}}
    assert score_guardrail(case, blocked=False)["pass"] is False


def test_guardrail_false_positive_detected():
    """误杀：不该拦的被拦 → 挂。"""
    case = {"expect": {"should_block": False}}
    assert score_guardrail(case, blocked=True)["pass"] is False


def test_guardrail_malformed_case_fails_loud():
    with pytest.raises(KeyError):
        score_guardrail({"expect": {}}, blocked=True)


# ── 生成层 ───────────────────────────────────────────────────


def test_generation_all_present():
    case = {"expect": {"must_mention": ["停机", "导雷"]}}
    result = score_generation(case, "先停机，再修导雷系统")
    assert result["pass"] is True
    assert result["missed"] == []


def test_generation_missing_keyword():
    case = {"expect": {"must_mention": ["停机", "炭化"]}}
    result = score_generation(case, "先停机就行")
    assert result["pass"] is False
    assert result["missed"] == ["炭化"]


def test_generation_banned_phrase():
    case = {"expect": {"must_mention": ["隐裂"], "must_not_mention": ["不知道"]}}
    result = score_generation(case, "隐裂我不知道怎么查")
    assert result["pass"] is False
    assert result["banned_hits"] == ["不知道"]


def test_generation_order_correct():
    """G04 正样本：先停机后拍照 → 过。"""
    case = {
        "expect": {
            "must_mention": ["停机"],
            "must_precede": {"first": "停机", "second": "拍照"},
        }
    }
    assert score_generation(case, "先停机锁定，然后拍照记录上报")["pass"] is True


def test_generation_order_violated():
    """G04 作弊案：先拍照后停机 → 必须挂（第一版真放跑过它）。"""
    case = {
        "expect": {
            "must_mention": ["停机"],
            "must_precede": {"first": "停机", "second": "拍照"},
        }
    }
    result = score_generation(case, "先拍照记录上报，然后停机")
    assert result["order_ok"] is False
    assert result["pass"] is False


def test_generation_order_second_absent_passes():
    """裁决 D：答案压根没提拍照 → 判序算过。"""
    case = {
        "expect": {
            "must_mention": ["停机"],
            "must_precede": {"first": "停机", "second": "拍照"},
        }
    }
    assert score_generation(case, "必须立即停机并评估")["pass"] is True


def test_generation_order_first_absent_fails():
    """提了拍照没提停机 → 判序挂。"""
    case = {
        "expect": {
            "must_mention": ["停机"],
            "must_precede": {"first": "停机", "second": "拍照"},
        }
    }
    result = score_generation(case, "先拍照记录上报")
    assert result["order_ok"] is False


def test_generation_no_precede_key_passes_order():
    """must_precede 整个缺席（36 题里只有 G04 有）→ order_ok 恒真，不许被空串哨兵坑。"""
    case = {"expect": {"must_mention": ["底漆"]}}
    result = score_generation(case, "涂刷底漆后再上面漆")
    assert result["order_ok"] is True
    assert result["pass"] is True


# ── 多轮改写层 ───────────────────────────────────────────────


def test_multi_turn_rewrite_ok():
    case = {"expect": {"rewritten_must_contain": ["腐蚀"], "rewritten_must_not_equal": "那腐蚀呢？"}}
    result = score_multi_turn(case, "风机叶片腐蚀应该怎么修复")
    assert result["pass"] is True


def test_multi_turn_missing_entity():
    case = {"expect": {"rewritten_must_contain": ["隐裂"]}}
    result = score_multi_turn(case, "这个的检测方法是什么")
    assert result["pass"] is False
    assert result["missing"] == ["隐裂"]


def test_multi_turn_lazy_rewriter_caught_despite_trailing_newline():
    """改写引擎原样返回 + 尾巴换行 → 仍要抓到 unchanged（strip 剥的是模型侧）。"""
    case = {"expect": {"rewritten_must_contain": ["腐蚀"], "rewritten_must_not_equal": "那腐蚀呢？"}}
    result = score_multi_turn(case, "那腐蚀呢？\n")
    assert result["unchanged"] is True
    assert result["pass"] is False


# ── 检索层 ───────────────────────────────────────────────────


def test_retrieval_union_across_chunks_passes():
    """R10 式：terms 分布在不同 chunk（并集口径的存在理由）。"""
    case = {"expect": {"terms": ["层间", "线状"]}}
    post = ["隐裂：内部层间分离", "裂纹：可见线状裂缝"]
    result = score_retrieval(case, pre_chunks=post, post_chunks=post)
    assert result["pass"] is True
    assert result["term_ranks"] == {"层间": 1, "线状": 2}


def test_retrieval_miss_fails_with_fractions():
    case = {"expect": {"terms": ["敲击法", "热像仪"]}}
    pre = ["敲击法与超声波", "热像仪扫描", "无关"]
    post = ["敲击法与超声波"]  # rerank 把热像仪那条排掉了
    result = score_retrieval(case, pre_chunks=pre, post_chunks=post)
    assert result["pass"] is False
    assert result["hit_at_10"] == 1.0
    assert result["hit_at_5"] == 0.5
    assert result["term_ranks"]["热像仪"] is None


def test_retrieval_mrr_arithmetic():
    """rank 1 和 rank 2 各一个 → MRR = (1/1 + 1/2) / 2 = 0.75。"""
    case = {"expect": {"terms": ["停机", "炭化"]}}
    post = ["必须停机", "清除炭化材料"]
    result = score_retrieval(case, pre_chunks=post, post_chunks=post)
    assert result["mrr"] == 0.75


def test_retrieval_unhit_term_counts_zero_in_mrr():
    """未命中记 0 进分母：命中 rank1 + 未命中 → MRR = (1 + 0) / 2 = 0.5。"""
    case = {"expect": {"terms": ["停机", "不存在的词"]}}
    post = ["必须停机"]
    result = score_retrieval(case, pre_chunks=post, post_chunks=post)
    assert result["mrr"] == 0.5
    assert result["pass"] is False
