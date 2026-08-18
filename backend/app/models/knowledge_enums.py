"""知识库相关枚举常量。"""

from enum import StrEnum


class KnowledgeDocStatus(StrEnum):
    """文档生命周期状态。"""

    ACTIVE = "active"
    DELETED = "deleted"


class ChunkSplitterType(StrEnum):
    """分块策略类型。"""

    SENTENCE = "sentence"  # SentenceSplitter（通用，按句子边界切分）
    MARKDOWN = "markdown"  # MarkdownNodeParser（按 Markdown 标题层级切分）


class ChunkMetadataPolicy(StrEnum):
    """分块元数据策略。"""

    BASIC = "basic"  # 只保留 file_name, chunk_id
    DEBUG = "debug"  # 保留所有元数据（调试用，向量库体积更大）
