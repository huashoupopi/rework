import pytest

from app.services.rag_service import RagService

pytestmark = pytest.mark.needs_model


class DummyNode:
    def __init__(self, text: str):
        self.text = text


def test_build_messages_rag_prompt_preserves_exact_domain_terms():
    messages = RagService._build_messages(
        question="隐裂通常怎么检测？",
        context_nodes=[
            DummyNode("检测方法：敲击法、超声波扫描、热像仪。"),
            DummyNode("雷击损伤修复步骤：修复导雷系统。"),
        ],
        route="rag",
    )

    system_text = messages[0].content

    assert "优先保留上下文中的专业术语、设备名称、材料名称和部件名称" in system_text
    assert "如果上下文列出了检测方法、工艺步骤、关键部件或工具名称" in system_text
    assert "不要为了概括而把原始术语改写成更泛的说法" in system_text


def test_build_prompt_rag_prompt_preserves_exact_domain_terms():
    prompt = RagService._build_prompt(
        question="叶片雷击损伤后第一步应该做什么？",
        context_nodes=[
            DummyNode("雷击损伤修复步骤：停机检查，修复导雷系统。"),
        ],
        route="rag",
    )

    assert "优先保留上下文中的专业术语、设备名称、材料名称和部件名称" in prompt
    assert "不要为了概括而把原始术语改写成更泛的说法" in prompt
    assert "当用户询问“第一步”“首先”这类步骤问题时" in prompt


def test_build_messages_skips_history_for_self_contained_question():
    messages = RagService._build_messages(
        question="隐裂通常怎么检测？",
        context_nodes=[DummyNode("检测方法：敲击法、超声波扫描、热像仪。")],
        route="rag",
        chat_window=[
            {"role": "user", "content": "上一个问题"},
            {"role": "assistant", "content": "上一个回答"},
        ],
    )

    assert [message.role.value for message in messages] == ["system", "user"]
    assert messages[-1].content == "隐裂通常怎么检测？"


def test_build_messages_keeps_history_for_context_dependent_question():
    messages = RagService._build_messages(
        question="那这个呢？",
        context_nodes=[DummyNode("检测方法：敲击法、超声波扫描、热像仪。")],
        route="rag",
        chat_window=[
            {"role": "user", "content": "隐裂通常怎么检测？"},
            {"role": "assistant", "content": "可以用超声波。"},
        ],
    )

    assert [message.role.value for message in messages] == ["system", "user", "assistant", "user"]
    assert messages[-1].content == "那这个呢？"
