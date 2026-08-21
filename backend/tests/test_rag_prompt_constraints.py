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


def test_build_messages_skips_history_for_long_question():
    """长问不带历史。

    2026-08-21 修正：这条测试原名 ..._for_self_contained_question，
    用「隐裂通常怎么检测？」当自包含样本，断言它跳过历史。
    但 c7dc1a3（08-19）已经把判据从「指代词 + 30 字」改成「有历史且
    长度 ≤ 40」——理由是「轻度的怎么划分?」这类无指代词的追问会被漏判，
    改写链路整条不执行。那次改了实现没同步这条测试，它从此一直红着。

    按现行判据，9 个字的短问【应该】带历史。真正跳过历史的是长问，
    所以样本换成一条超过 40 字的自包含提问。
    """
    long_question = "风机叶片出现隐裂之后，运维班组应该按照什么顺序安排复检、评估和更换，需要哪些记录？"
    assert len(long_question) > 40

    messages = RagService._build_messages(
        question=long_question,
        context_nodes=[DummyNode("检测方法：敲击法、超声波扫描、热像仪。")],
        route="rag",
        chat_window=[
            {"role": "user", "content": "上一个问题"},
            {"role": "assistant", "content": "上一个回答"},
        ],
    )

    assert [message.role.value for message in messages] == ["system", "user"]
    assert messages[-1].content == long_question


def test_build_messages_keeps_history_for_short_followup():
    """短问带历史 —— 这正是 c7dc1a3 要修的场景。

    「轻度的怎么划分?」没有任何指代词，旧判据会把它当自包含直接跳过，
    改写链路不执行；新判据只看长度，所以它会带上历史。
    """
    messages = RagService._build_messages(
        question="轻度的怎么划分?",
        context_nodes=[DummyNode("裂纹按长度分级。")],
        route="rag",
        chat_window=[
            {"role": "user", "content": "隐裂怎么分级？"},
            {"role": "assistant", "content": "分轻度、中度、重度。"},
        ],
    )

    assert [message.role.value for message in messages] == ["system", "user", "assistant", "user"]


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
