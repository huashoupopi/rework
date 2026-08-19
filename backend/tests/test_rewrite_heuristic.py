"""B2：改写门卫。不 import rag_service（会拉 llama-index）。"""

from app.services.query_rewrite import REWRITE_MAX_LEN, needs_rewrite


def test_short_followup_without_pronoun_rewrites_when_history_exists():
    assert needs_rewrite("轻度的怎么划分?", has_history=True) is True


def test_no_history_never_rewrites():
    assert needs_rewrite("那腐蚀呢？", has_history=False) is False
    assert needs_rewrite("轻度的怎么划分?", has_history=False) is False


def test_long_self_contained_skips_rewrite():
    question = (
        "风机叶片前缘冲蚀面积超过零点五平方米并且深度已经到达结构层，"
        "同时导雷系统电阻也超标时应该如何修复？"
    )
    assert len(question) > REWRITE_MAX_LEN
    assert needs_rewrite(question, has_history=True) is False


def test_eval_rw_queries_still_trigger():
    for query in ("那腐蚀呢？", "那这个的检测方法呢？", "那验收标准呢？", "那轻度的怎么划分呢？"):
        assert needs_rewrite(query, has_history=True) is True
