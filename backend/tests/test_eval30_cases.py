"""eval30 题库的 CI 冒烟（裁决：CI 只跑离线部分——schema 校验 + 门卫层纯函数判分）。

不起服务、不连库、不调模型：
- schema 校验守「题库文件没被改坏」（此前 16 道 bench 题被改坏没人发现的教训同款）
- 门卫层用真实的 check_user_input() 离线判——「该拦的 5 条今天真的拦得住、
  不该拦的 5 条今天真的放得过」，规则库哪天改动导致答案漂移，这里当场红
"""

import pytest

from app.security import check_user_input
from evals.case_loader import VALID_LAYERS, load_eval_cases, materialize_query
from evals.scoring import score_guardrail

CASES = load_eval_cases()

# ── schema 校验 ──────────────────────────────────────────────


def test_case_count_and_layer_distribution():
    layers: dict[str, int] = {}
    for case in CASES:
        layers[case["layer"]] = layers.get(case["layer"], 0) + 1
    assert layers == {
        "retrieval": 10,
        "generation": 8,
        "guardrail": 10,
        "multi_turn": 4,
        "routing": 4,
    }


def test_ids_unique():
    ids = [c["id"] for c in CASES]
    assert len(ids) == len(set(ids))


def test_every_case_well_formed():
    for case in CASES:
        assert case["layer"] in VALID_LAYERS, case
        assert isinstance(case["expect"], dict) and case["expect"], case
        # query 与 query_special 二选一，且物化后非空
        assert materialize_query(case).strip(), case


def test_layer_specific_expect_keys():
    for case in CASES:
        expect = case["expect"]
        layer = case["layer"]
        if layer == "retrieval":
            assert expect["terms"], case
        elif layer == "generation":
            assert expect["must_mention"], case
        elif layer == "guardrail":
            assert isinstance(expect["should_block"], bool), case
        elif layer == "multi_turn":
            assert expect["prior"] and expect["rewritten_must_contain"], case
        elif layer == "routing":
            assert expect["route"] in {"rag", "fallback"}, case


# ── 门卫层离线判分（真实闸函数）─────────────────────────────

GUARDRAIL_CASES = [c for c in CASES if c["layer"] == "guardrail"]


@pytest.mark.parametrize("case", GUARDRAIL_CASES, ids=lambda c: c["id"])
def test_guardrail_case_verdict_offline(case):
    """每条门卫题拿真实的 check_user_input 判一遍，结论必须与卷面一致。"""
    is_safe, score, rules = check_user_input(materialize_query(case))
    result = score_guardrail(case, blocked=not is_safe)
    assert result["pass"], (
        f"{case['id']}: 期望 block={case['expect']['should_block']}，"
        f"实际 blocked={not is_safe}（score={score}, rules={rules}）"
    )
