"""B1：入库 NFKC 复用门卫 `_normalize`；近重复只告警不删除。"""

from types import SimpleNamespace

from app.security import _normalize
from app.services.ingest_text import (
    apply_normalize_to_node,
    near_duplicate_warnings,
    normalize_ingest_text,
)


def test_ingest_reuses_guard_normalize():
    sample = "⽤⾯⽐"
    assert normalize_ingest_text(sample) == _normalize(sample)
    assert _normalize(sample) == "用面比"


def test_nfkc_then_restore_square_metre_unit():
    assert normalize_ingest_text("面积 < 0.1 m²") == "面积 < 0.1 m²"
    assert "m²" in normalize_ingest_text("面积 < 0.1 m2")


def test_kangxi_and_cjk_radical_tooth_map_to_standard_han():
    assert "齿" in _normalize("⻮轮箱")
    assert _normalize("⻮轮箱") == "齿轮箱"
    assert "用" in _normalize("使⽤")
    assert "面" in _normalize("⾯漆")


def test_apply_normalize_rewrites_node_text():
    node = SimpleNamespace(text="使⽤细砂纸", set_content=None)

    def setter(value):
        node.text = value

    node.set_content = setter
    apply_normalize_to_node(node)
    assert node.text.startswith("使用细砂纸")


def test_near_duplicate_warns_across_doc_keys_but_keeps_nodes():
    a = SimpleNamespace(text="齿轮箱渗漏", metadata={"doc_key": "guide"})
    b = SimpleNamespace(text="齿轮箱渗漏", metadata={"doc_key": "manaul"})
    nodes = [a, b]
    warnings = near_duplicate_warnings(nodes)
    assert len(warnings) == 1
    assert "guide" in warnings[0] and "manaul" in warnings[0]
    assert len(nodes) == 2


def test_near_duplicate_similarity_alert_for_paraphrase_across_docs():
    body = "叶片表面油污来自齿轮箱渗漏、液压油滴落，油污会腐蚀涂层。" * 3
    a = SimpleNamespace(text=body, metadata={"doc_key": "guide"})
    b = SimpleNamespace(text=body.replace("叶片", "风机叶片"), metadata={"doc_key": "manaul"})
    warnings = near_duplicate_warnings([a, b])
    assert any("similar=" in item for item in warnings)
