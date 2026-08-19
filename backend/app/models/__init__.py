# 统一导入所有模型，确保 SQLAlchemy mapper 初始化时能解析所有 relationship 引用。
# 任何脚本只需 `import app.models` 即可完成全部模型注册。
from app.models.chat import ChatImage, ChatMessage
from app.models.conversation import Conversation
from app.models.knowledge_chunk_config import KnowledgeChunkConfig
from app.models.knowledge_document import KnowledgeDocument, KnowledgeDocumentVersion
from app.models.task import Task, TaskStatus
from app.models.user import User

__all__ = [
    "User",
    "Task",
    "TaskStatus",
    "ChatMessage",
    "ChatImage",
    "Conversation",
    "KnowledgeDocument",
    "KnowledgeDocumentVersion",
    "KnowledgeChunkConfig",
]
