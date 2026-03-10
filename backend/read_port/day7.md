# Day 7：知识库管理（文档 + 版本 + 分块配置 + 构建脚本）

> 目标：实现知识库三表模型（文档主表 + 版本表 + 分块配置表）、文档上传 + SHA256 去重 + 版本归档、分块配置管理、索引重建
> 预计文件数：10 个新建 + 3 个修改
> 验证工具：Apifox

---

## 前置准备

Day 7 开始之前确保：
- Day 6 全部通过（RAG 流式聊天正常，ThinkStreamParser 正常）
- PostgreSQL pgvector 扩展已启用
- 准备 1~2 个测试文档（PDF 或 Markdown）

### 安装 Day 7 依赖

```bash
# DoclingReader 用于解析复杂 PDF（表格、标题、布局识别）
# 如果你的文档都是纯文本 PDF 或 Markdown，可以先不装 docling
uv add llama-index-readers-docling docling

# 如果只用 SimpleDirectoryReader（够用），不需要额外依赖
```

---

## 整体流程图（先画在纸上再写代码）

```
管理员上传文档（PDF/MD）
  |
[1] 校验文件格式（.pdf / .md）
  |
[2] SHA256 内容哈希 → 数据库去重（WHERE content_hash = ? AND document_id = ?）
  |
[3] 规范化 doc_key（安全文件名）
  |
[4] 数据库：创建/获取 KnowledgeDocument → 创建 KnowledgeDocumentVersion
  |
[5] 保存到 managed_versions/{doc_key}/v{N}/（版本归档）
  |
[6] 保存到 knowledge_base/{doc_key}.pdf（active 文件）
  |
[7] 管理员手动触发 POST /knowledge/rebuild
  |
[8] 子进程执行 build_knowledge.py:
    → 读取 knowledge_base/ 下所有文档
    → SentenceSplitter / MarkdownNodeParser 分块
    → BGE-M3 Embedding
    → 写入 pgvector
```

### 三表架构（vs 旧单表设计）

```
旧方案（Day 7 初版）：                    新方案（参考生产项目）：
========================                   ========================
KnowledgeDocument（一张表）                KnowledgeDocument（文档主表）
- doc_key, version, status                 - doc_key, title, status, latest_version
- content_hash, suffix                     - 一个 doc_key 只有一条记录
- 每次新版本 = 一行新记录
                                           KnowledgeDocumentVersion（版本表）
                                           - document_id FK → KnowledgeDocument
                                           - version, file_name, content_hash
                                           - storage_path, active_path
                                           - is_current 标记当前版本

                                           KnowledgeChunkConfig（分块配置表）
                                           - splitter, chunk_size, chunk_overlap
                                           - is_default, is_active
                                           - 多个配置可切换
```

**为什么升级到三表？**

| 维度 | 单表方案 | 三表方案 |
|---|---|---|
| 文档和版本 | 混在一行里，查"有哪些文档"要 GROUP BY | 文档和版本分离，一级查询就是文档列表 |
| 分块配置 | 硬编码在 config.py | 数据库管理，支持运行时切换、A/B 测试 |
| 唯一约束 | doc_key+version 联合唯一 | document_id+version、document_id+content_hash 双重唯一 |
| 归档逻辑 | 改 status 列 | is_current 布尔标记，更直观 |
| 面试加分 | 一般 | 明显——关系建模 + 软删除 + 配置即数据 |

- **面试话术**："单表在 MVP 阶段够用，但生产中我升级到三表。文档和版本分离后查询更干净，分块配置做成数据管理后支持运行时调参——不用改代码就能切换 chunk_size。"

### 架构分层

```
router 层（knowledge.py）         service 层（knowledge_service.py）
--------------------------        --------------------------------
参数校验                           文件系统操作（保存/删除/目录管理）
认证鉴权（管理员）                  SHA256 哈希计算 + 文件名规范化
HTTP 响应格式                      子进程触发重建

CRUD 层（crud/knowledge.py）      数据模型
----------------------------      --------------------------------
文档：创建/查询/软删除/恢复        KnowledgeDocument 主表
版本：创建/标记旧版本/按hash查重    KnowledgeDocumentVersion 版本表
配置：增删改查/切换默认            KnowledgeChunkConfig 分块配置表

独立脚本（build_knowledge.py）     枚举（knowledge_enums.py）
--------------------------------  --------------------------------
文档读取（SimpleDirectoryReader / DoclingReader）  KnowledgeDocStatus: ACTIVE / DELETED
文本分块（SentenceSplitter / MarkdownNodeParser）  ChunkSplitterType: SENTENCE / MARKDOWN
Embedding 计算（BGE-M3）                           ChunkMetadataPolicy: BASIC / DEBUG
向量入库（PGVectorStore）
```

### 为什么用数据库管理而不是纯文件系统？

| 维度 | 纯文件系统 | 数据库（当前方案） |
|---|---|---|
| 去重查询 | 遍历所有文件算 SHA256，O(N) | `WHERE content_hash = ?` 走索引，O(1) |
| 版本查询 | 扫描 `v1/`, `v2/` 目录推算 | `SELECT MAX(version) WHERE document_id = ?` |
| 文档列表 | `os.listdir` + `stat` | `SELECT * FROM knowledge_documents` |
| 状态管理 | 无（只有"在不在目录里"） | `status` 字段（active/deleted） |
| 删除一致性 | 删文件后忘记 rebuild → 脏数据 | 数据库软删除 + rebuild 只读 active |
| 事务性 | 无（文件写一半崩了 → 脏状态） | DB 事务保证原子性 |
| 面试加分 | 一般 | 明显（数据建模 + 状态机 + 唯一约束） |

- **面试话术**："知识库元信息用数据库管理，文件内容用文件系统存储。数据库负责状态、版本、去重查询；文件系统负责存二进制文件。两者通过 doc_key 关联。"

**为什么 build_knowledge.py 是独立脚本而不是 service 方法？**
- 知识库构建涉及大量内存（加载 Embedding 模型 + 处理文档），耗时几分钟
- 独立进程 = 独立内存空间，OOM 不影响 API 进程
- 独立进程崩溃 → API 进程不受影响 → 重试即可
- **面试话术**："知识库构建放在子进程，实现了进程级别的故障隔离。"

---

## Step 1：`app/core/config.py` — 新增知识库配置

在 Day 6 配置基础上追加：

```python
# === 知识库配置 ===
KNOWLEDGE_DIR: str = str(Path(__file__).resolve().parent.parent.parent / "knowledge_base")
MANAGED_VERSIONS_DIR: str = ""   # 版本归档目录，_build_derived_paths 自动填充
ALLOWED_DOC_SUFFIXES: str = ".pdf,.md,.markdown"  # 逗号分隔

# 默认分块参数（数据库有 KnowledgeChunkConfig 表可覆盖）
CHUNK_SIZE: int = 800
CHUNK_OVERLAP: int = 150
CHUNK_MIN_LEN: int = 20

# 重建超时
KNOWLEDGE_BUILD_TIMEOUT_S: int = 600
```

在 `_build_derived_paths` 中追加：

```python
# 知识库目录
kb_path = Path(self.KNOWLEDGE_DIR)
kb_path.mkdir(parents=True, exist_ok=True)
if not self.MANAGED_VERSIONS_DIR:
    self.MANAGED_VERSIONS_DIR = str(kb_path.parent / "managed_versions")
Path(self.MANAGED_VERSIONS_DIR).mkdir(parents=True, exist_ok=True)
```

**你需要回答自己的问题**：

1. **为什么 `ALLOWED_DOC_SUFFIXES` 用字符串而不是 list？**
   - Pydantic Settings 从 `.env` 读取时，值都是字符串
   - `.env` 不原生支持 list 类型
   - 用逗号分隔的字符串，代码里 `settings.ALLOWED_DOC_SUFFIXES.split(",")` 解析
   - **追问**：Pydantic v2 其实支持 JSON 格式的 list，但逗号分隔更简单直观

2. **为什么 `managed_versions` 和 `knowledge_base` 分开？**
   - `knowledge_base/` 是 active 目录，`build_knowledge.py` 读取这个目录
   - 如果版本归档也放在 `knowledge_base/` 下，构建脚本会误读历史版本
   - 分开存放 = 职责清晰，构建脚本不需要过滤逻辑

3. **为什么默认 CHUNK_SIZE 改成 800（原来是 512）？**
   - 512 是通用默认值，但风电技术文档段落通常较长
   - 800 token ≈ 1200 中文字符，更适合技术文档的段落长度
   - chunk_overlap=150 保证相邻块有足够上下文重叠
   - **面试点**："分块参数应该根据文档特点调优。通用 512 适合短文档，领域文档通常需要更大 chunk。"

---

## Step 2：`app/models/knowledge_enums.py` — 知识库枚举

**新建文件**：

```python
"""知识库相关枚举常量。"""

from enum import StrEnum


class KnowledgeDocStatus(StrEnum):
    """文档生命周期状态。"""
    ACTIVE = "active"
    DELETED = "deleted"


class ChunkSplitterType(StrEnum):
    """分块策略类型。"""
    SENTENCE = "sentence"     # SentenceSplitter（通用，按句子边界切分）
    MARKDOWN = "markdown"     # MarkdownNodeParser（按 Markdown 标题层级切分）


class ChunkMetadataPolicy(StrEnum):
    """分块元数据策略。"""
    BASIC = "basic"    # 只保留 file_name, chunk_id
    DEBUG = "debug"    # 保留所有元数据（调试用，向量库体积更大）
```

**你需要回答自己的问题**：

1. **为什么用 `StrEnum` 而不是普通字符串？**
   - `StrEnum` 继承 `str`，序列化时自动变成字符串——Pydantic / JSON 无缝兼容
   - 同时提供类型安全——`status = KnowledgeDocStatus.ACTIVE` 比 `status = "active"` 不容易拼错
   - 数据库存的是字符串值 `"active"`，不是 Python 对象——迁移时不会出问题
   - **面试对比**：Day 3 的 Task.status 用字符串，当时只有 4 种状态，够用。知识库模块更复杂，用枚举更安全

2. **为什么不用 PostgreSQL 的 ENUM 类型？**
   - PG ENUM 修改非常麻烦：不能直接删除/重命名枚举值，要先删列再重建
   - 数据库列用 `String(20)`，Python 侧用 `StrEnum`——灵活且类型安全
   - **面试金句**："枚举约束放在应用层而不是数据库层，降低 schema 变更成本。"

3. **`ChunkMetadataPolicy` 有什么实际用途？**
   - `BASIC`：生产环境用，只保留必要元数据，向量库体积小
   - `DEBUG`：调试时用，保留 LlamaIndex 生成的所有元数据，方便排查分块质量
   - **面试话术**："通过配置控制观测粒度，生产用 BASIC 节省存储，排查问题时切 DEBUG 看全量。"

---

## Step 3：`app/models/knowledge_document.py` — 文档主表 + 版本表

**新建文件**：

```python
"""
知识库文档模型：主表 + 版本表。

设计要点：
- KnowledgeDocument 是文档的"身份证"，一个 doc_key 只有一条记录
- KnowledgeDocumentVersion 是"每次上传"的记录，同一文档可以有 v1, v2, ...
- 主表的 latest_version 字段做冗余加速（避免每次查 MAX(version)）
- 版本表的 is_current 标记当前版本（同一文档只有一个 is_current=True）
"""

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, Index, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.knowledge_chunk_config import KnowledgeChunkConfig


class KnowledgeDocument(Base):
    """
    知识库文档主表。

    每个 doc_key 只有一条记录，记录文档的"身份"和当前状态。
    版本详情由 KnowledgeDocumentVersion 管理。

    状态机：
      active  → deleted（管理员手动删除，软删除）
      deleted → active（管理员恢复，重新激活）
    """
    __tablename__ = "knowledge_documents"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    doc_key: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    latest_version: Mapped[int] = mapped_column(default=0)

    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        server_default=func.now(), onupdate=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(nullable=True)

    # relationship
    versions: Mapped[list["KnowledgeDocumentVersion"]] = relationship(
        back_populates="document",
        lazy="selectin",
        cascade="all, delete-orphan",
        order_by="KnowledgeDocumentVersion.version.desc()",
    )


class KnowledgeDocumentVersion(Base):
    """
    知识库文档版本表。

    每次上传同一 doc_key 的新版本，都创建一条新记录（version + 1）。
    is_current 标记当前版本——同一 document_id 下只有一个 is_current=True。

    唯一约束：
    - (document_id, version)：同一文档不会有重复版本号
    - (document_id, content_hash)：同一文档不会有相同内容的版本
    """
    __tablename__ = "knowledge_document_versions"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    document_id: Mapped[int] = mapped_column(
        ForeignKey("knowledge_documents.id", ondelete="CASCADE"),
        index=True,
    )
    version: Mapped[int] = mapped_column()
    file_name: Mapped[str] = mapped_column(String(255))
    storage_path: Mapped[str] = mapped_column(String(500))
    active_path: Mapped[str] = mapped_column(String(500))
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    file_size: Mapped[int] = mapped_column(default=0)
    mime_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    is_current: Mapped[bool] = mapped_column(default=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    indexed_chunk_config_id: Mapped[int | None] = mapped_column(
        ForeignKey("knowledge_chunk_configs.id"), nullable=True
    )
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    # relationships
    document: Mapped["KnowledgeDocument"] = relationship(
        back_populates="versions", lazy="selectin"
    )
    chunk_config: Mapped["KnowledgeChunkConfig | None"] = relationship(
        lazy="selectin"
    )

    __table_args__ = (
        Index("uq_doc_version", "document_id", "version", unique=True),
        Index("uq_doc_hash", "document_id", "content_hash", unique=True),
    )
```

**同步修改 `alembic/env.py`**：

```python
from app.models.knowledge_document import KnowledgeDocument, KnowledgeDocumentVersion  # noqa: F401
from app.models.knowledge_chunk_config import KnowledgeChunkConfig  # noqa: F401
```

**你需要回答自己的问题**：

1. **为什么文档和版本分成两张表，而不是单表加 version 列？**
   - 单表方案：查"有哪些文档"要 `SELECT DISTINCT doc_key` 或 `GROUP BY doc_key` → 效率低
   - 双表方案：`SELECT * FROM knowledge_documents` 直接就是文档列表 → 干净
   - 版本表可以存每次上传的详细信息（文件路径、大小、MIME），不会让主表膨胀
   - **面试金句**："实体和历史分表是关系建模的基本原则——实体表存身份，历史表存变更。"

2. **`latest_version` 为什么是冗余字段？**
   - 严格意义上可以通过 `SELECT MAX(version) FROM versions WHERE document_id = ?` 计算
   - 但每次上传都要这个值 → 加冗余字段避免频繁聚合查询
   - 冗余的代价：新版本创建时要同步更新主表的 `latest_version`（CRUD 层保证）
   - **面试点**："空间换时间的经典策略。冗余字段需要保证一致性——由 CRUD 层的事务保证。"

3. **`is_current` vs `status='archived'` 有什么区别？**
   - 旧方案用 `status` 标记版本状态（active/archived/deleted），混杂了两个维度
   - 新方案分离：`is_current` 只管"这个版本是不是最新的"，`status` 放主表管"文档是不是被删了"
   - 更清晰：上传新版本 → 旧版本的 `is_current = False`，但旧版本不是"被删除了"
   - **面试话术**："单一职责——is_current 管版本选择，status 管生命周期。"

4. **`ondelete="CASCADE"` 和 ORM 的 `cascade="all, delete-orphan"` 有什么区别？**
   - `ondelete="CASCADE"`：数据库层面——删除 document 行时，数据库自动删关联 version 行
   - `cascade="all, delete-orphan"`：ORM 层面——通过 SQLAlchemy 删除 document 对象时，联动删 version 对象
   - 两层都配是双重保护——即使有人绕过 ORM 直接操作 SQL，数据库层面也保证一致性
   - **面试金句**："ORM cascade 是应用层保证，DB cascade 是数据层保证。两层都配是防御性编程。"

5. **为什么 `content_hash` 的唯一约束是 `(document_id, content_hash)` 而不是全局唯一？**
   - 全局唯一 → 两个不同文档恰好内容相同 → 第二个上传失败。不合理
   - 按文档唯一 → 同一文档不会有相同内容的版本（去重），但不同文档可以有相同内容
   - **追问**：如果管理员把同一个 PDF 用不同文件名上传两次呢？（会变成两个不同的 doc_key → 各自独立管理。可以在 CRUD 层做全局 content_hash 警告，但不阻止）

---

## Step 4：`app/models/knowledge_chunk_config.py` — 分块配置表

**新建文件**：

```python
"""
知识库分块配置模型。

支持多个分块策略配置（不同 chunk_size, splitter 等），
管理员可以在运行时切换配置，不需要改代码重启服务。

设计思路：
- 一个默认配置（is_default=True），新版本默认使用
- 可以创建多个配置做 A/B 测试
- 绑定到 KnowledgeDocumentVersion，记录每次构建用了哪个配置
"""

from datetime import datetime

from sqlalchemy import String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class KnowledgeChunkConfig(Base):
    """
    知识库分块配置表。

    字段说明：
    - name: 配置名称（唯一），如 "默认-sentence-800"
    - splitter: 分块策略（sentence / markdown）
    - chunk_size / chunk_overlap / min_chunk_len: 分块参数
    - metadata_policy: 元数据策略（basic / debug）
    - is_active: 是否可用（软删除控制）
    - is_default: 是否是默认配置（全局只有一个）
    """
    __tablename__ = "knowledge_chunk_configs"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(80), unique=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    splitter: Mapped[str] = mapped_column(String(30), default="sentence")
    chunk_size: Mapped[int] = mapped_column(default=800)
    chunk_overlap: Mapped[int] = mapped_column(default=150)
    min_chunk_len: Mapped[int] = mapped_column(default=20)
    metadata_policy: Mapped[str] = mapped_column(String(30), default="basic")

    is_active: Mapped[bool] = mapped_column(default=True)
    is_default: Mapped[bool] = mapped_column(default=False)

    created_by: Mapped[int | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        server_default=func.now(), onupdate=func.now()
    )
```

**导出层 `app/models/knowledge.py`**（兼容导入）：

```python
"""知识库模型导出——统一入口。"""

from app.models.knowledge_chunk_config import KnowledgeChunkConfig
from app.models.knowledge_document import KnowledgeDocument, KnowledgeDocumentVersion
from app.models.knowledge_enums import (
    ChunkMetadataPolicy,
    ChunkSplitterType,
    KnowledgeDocStatus,
)

__all__ = [
    "KnowledgeDocument",
    "KnowledgeDocumentVersion",
    "KnowledgeChunkConfig",
    "KnowledgeDocStatus",
    "ChunkSplitterType",
    "ChunkMetadataPolicy",
]
```

**你需要回答自己的问题**：

1. **为什么分块配置做成数据库表而不是 config.py 的环境变量？**
   - 环境变量改了要重启服务
   - 数据库配置改了立即生效——管理员在前端切换配置 → 下次 rebuild 就用新参数
   - 还能记录"每个版本用的是哪个配置"——出问题时可以追溯
   - **面试话术**："配置即数据（Configuration as Data）。运行时可变的参数放数据库，启动时固定的参数放环境变量。"

2. **`is_default` 全局只有一个——怎么保证？**
   - 不用数据库约束（partial unique index 跨数据库兼容性差）
   - 在 CRUD 层保证：设置新默认时先把旧默认的 `is_default = False`
   - **面试追问**：如果并发操作怎么办？（加分布式锁或用 SELECT FOR UPDATE 行锁。但知识库管理是低频操作，竞态概率极低，应用层保证够用）

3. **`metadata_policy` 有什么实际影响？**
   - `basic`：chunk 只携带 `file_name` + `chunk_id` → 向量库占用小
   - `debug`：携带 LlamaIndex 生成的所有元数据（包括 start_char_idx, end_char_idx 等）→ 便于调试但占用大
   - build_knowledge.py 会读这个字段决定保留哪些元数据

---

## Step 5：`app/crud/knowledge.py` — 知识库 CRUD（350 行核心）

**完整代码**：

```python
"""
知识库 CRUD 操作。

分为三组：
1. 文档操作：创建/查询/软删除/恢复
2. 版本操作：创建/标记旧版本/按 hash 查重
3. 分块配置操作：增删改查/切换默认
"""

from datetime import datetime, timezone

from sqlalchemy import select, func, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.knowledge_document import (
    KnowledgeDocument,
    KnowledgeDocumentVersion,
)
from app.models.knowledge_chunk_config import KnowledgeChunkConfig
from app.models.knowledge_enums import KnowledgeDocStatus


# ==================== 文档操作 ====================


async def get_document_by_id(
    db: AsyncSession, document_id: int
) -> KnowledgeDocument | None:
    """按 ID 获取文档。"""
    return await db.get(KnowledgeDocument, document_id)


async def get_document_by_key(
    db: AsyncSession, doc_key: str
) -> KnowledgeDocument | None:
    """按 doc_key 获取文档（不区分状态）。"""
    stmt = select(KnowledgeDocument).where(
        KnowledgeDocument.doc_key == doc_key
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def list_documents(
    db: AsyncSession,
    status: str | None = None,
    keyword: str | None = None,
    offset: int = 0,
    limit: int = 50,
) -> tuple[list[KnowledgeDocument], int]:
    """
    文档列表 + 分页。

    支持按 status 过滤、按 title/doc_key 模糊搜索。
    返回 (documents, total_count)。
    """
    base = select(KnowledgeDocument)
    count_base = select(func.count(KnowledgeDocument.id))

    if status:
        base = base.where(KnowledgeDocument.status == status)
        count_base = count_base.where(KnowledgeDocument.status == status)

    if keyword:
        like = f"%{keyword}%"
        base = base.where(
            KnowledgeDocument.title.ilike(like)
            | KnowledgeDocument.doc_key.ilike(like)
        )
        count_base = count_base.where(
            KnowledgeDocument.title.ilike(like)
            | KnowledgeDocument.doc_key.ilike(like)
        )

    total = (await db.execute(count_base)).scalar_one()
    stmt = base.order_by(KnowledgeDocument.updated_at.desc()).offset(offset).limit(limit)
    result = await db.execute(stmt)
    return list(result.scalars().all()), total


async def create_document(
    db: AsyncSession,
    doc_key: str,
    title: str,
    created_by: int | None = None,
) -> KnowledgeDocument:
    """
    创建新文档记录。

    只创建主表记录，版本记录由 create_version 创建。
    """
    doc = KnowledgeDocument(
        doc_key=doc_key,
        title=title,
        status=KnowledgeDocStatus.ACTIVE,
        latest_version=0,  # create_version 时更新
        created_by=created_by,
    )
    db.add(doc)
    await db.flush()
    return doc


async def mark_document_deleted(
    db: AsyncSession, document_id: int
) -> KnowledgeDocument | None:
    """软删除文档。"""
    doc = await db.get(KnowledgeDocument, document_id)
    if doc and doc.status == KnowledgeDocStatus.ACTIVE:
        doc.status = KnowledgeDocStatus.DELETED
        doc.deleted_at = datetime.now(timezone.utc)
        await db.flush()
        return doc
    return None


async def mark_document_active(
    db: AsyncSession, document_id: int
) -> KnowledgeDocument | None:
    """恢复已删除的文档。"""
    doc = await db.get(KnowledgeDocument, document_id)
    if doc and doc.status == KnowledgeDocStatus.DELETED:
        doc.status = KnowledgeDocStatus.ACTIVE
        doc.deleted_at = None
        await db.flush()
        return doc
    return None


# ==================== 版本操作 ====================


async def get_current_version(
    db: AsyncSession, document_id: int
) -> KnowledgeDocumentVersion | None:
    """获取文档的当前版本（is_current=True）。"""
    stmt = (
        select(KnowledgeDocumentVersion)
        .where(
            KnowledgeDocumentVersion.document_id == document_id,
            KnowledgeDocumentVersion.is_current == True,  # noqa: E712
        )
        .limit(1)
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def mark_old_versions_not_current(
    db: AsyncSession, document_id: int
) -> int:
    """
    将同一文档下所有 is_current=True 的版本标记为 False。

    新版本上传前调用——确保同一时刻只有一个 is_current=True 的版本。
    返回被标记的记录数。
    """
    stmt = (
        update(KnowledgeDocumentVersion)
        .where(
            KnowledgeDocumentVersion.document_id == document_id,
            KnowledgeDocumentVersion.is_current == True,  # noqa: E712
        )
        .values(is_current=False)
    )
    result = await db.execute(stmt)
    return result.rowcount


async def create_version(
    db: AsyncSession,
    document_id: int,
    version: int,
    file_name: str,
    storage_path: str,
    active_path: str,
    content_hash: str,
    file_size: int,
    mime_type: str | None = None,
    created_by: int | None = None,
    chunk_config_id: int | None = None,
) -> KnowledgeDocumentVersion:
    """
    创建新版本记录。

    调用前应先调用 mark_old_versions_not_current 标记旧版本。
    同时更新主表的 latest_version。
    """
    ver = KnowledgeDocumentVersion(
        document_id=document_id,
        version=version,
        file_name=file_name,
        storage_path=storage_path,
        active_path=active_path,
        content_hash=content_hash,
        file_size=file_size,
        mime_type=mime_type,
        is_current=True,
        created_by=created_by,
        indexed_chunk_config_id=chunk_config_id,
    )
    db.add(ver)
    await db.flush()

    # 更新主表的 latest_version
    doc = await db.get(KnowledgeDocument, document_id)
    if doc:
        doc.latest_version = version

    return ver


async def check_duplicate_hash(
    db: AsyncSession,
    document_id: int,
    content_hash: str,
) -> KnowledgeDocumentVersion | None:
    """
    按 content_hash 查重（同一文档内）。

    (document_id, content_hash) 有唯一约束，这里做业务层检查。
    """
    stmt = (
        select(KnowledgeDocumentVersion)
        .where(
            KnowledgeDocumentVersion.document_id == document_id,
            KnowledgeDocumentVersion.content_hash == content_hash,
        )
        .limit(1)
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


# ==================== 分块配置操作 ====================


async def get_chunk_config_by_id(
    db: AsyncSession, config_id: int
) -> KnowledgeChunkConfig | None:
    return await db.get(KnowledgeChunkConfig, config_id)


async def get_chunk_config_by_name(
    db: AsyncSession, name: str
) -> KnowledgeChunkConfig | None:
    stmt = select(KnowledgeChunkConfig).where(
        KnowledgeChunkConfig.name == name
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def get_default_chunk_config(
    db: AsyncSession,
) -> KnowledgeChunkConfig | None:
    """获取默认分块配置（is_default=True 且 is_active=True）。"""
    stmt = (
        select(KnowledgeChunkConfig)
        .where(
            KnowledgeChunkConfig.is_default == True,  # noqa: E712
            KnowledgeChunkConfig.is_active == True,    # noqa: E712
        )
        .limit(1)
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def list_chunk_configs(
    db: AsyncSession,
    active_only: bool = True,
) -> list[KnowledgeChunkConfig]:
    """列出分块配置。"""
    stmt = select(KnowledgeChunkConfig)
    if active_only:
        stmt = stmt.where(KnowledgeChunkConfig.is_active == True)  # noqa: E712
    stmt = stmt.order_by(KnowledgeChunkConfig.id)
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def create_chunk_config(
    db: AsyncSession,
    name: str,
    splitter: str = "sentence",
    chunk_size: int = 800,
    chunk_overlap: int = 150,
    min_chunk_len: int = 20,
    metadata_policy: str = "basic",
    is_default: bool = False,
    created_by: int | None = None,
    description: str | None = None,
) -> KnowledgeChunkConfig:
    """创建分块配置。如果 is_default=True，先取消旧的默认。"""
    if is_default:
        await _clear_default_config(db)

    config = KnowledgeChunkConfig(
        name=name,
        description=description,
        splitter=splitter,
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        min_chunk_len=min_chunk_len,
        metadata_policy=metadata_policy,
        is_active=True,
        is_default=is_default,
        created_by=created_by,
    )
    db.add(config)
    await db.flush()
    return config


async def update_chunk_config(
    db: AsyncSession,
    config_id: int,
    **fields,
) -> KnowledgeChunkConfig | None:
    """更新分块配置（部分字段更新）。"""
    config = await db.get(KnowledgeChunkConfig, config_id)
    if not config:
        return None

    # 如果要设为默认，先清除旧默认
    if fields.get("is_default"):
        await _clear_default_config(db)

    for key, value in fields.items():
        if hasattr(config, key) and value is not None:
            setattr(config, key, value)

    await db.flush()
    return config


async def delete_chunk_config(
    db: AsyncSession, config_id: int
) -> bool:
    """软删除分块配置（is_active=False）。"""
    config = await db.get(KnowledgeChunkConfig, config_id)
    if not config:
        return False
    config.is_active = False
    if config.is_default:
        config.is_default = False
    await db.flush()
    return True


async def count_versions_by_chunk_config(
    db: AsyncSession, config_id: int
) -> int:
    """统计使用某个配置的版本数量。"""
    stmt = select(func.count(KnowledgeDocumentVersion.id)).where(
        KnowledgeDocumentVersion.indexed_chunk_config_id == config_id
    )
    result = await db.execute(stmt)
    return result.scalar_one()


async def _clear_default_config(db: AsyncSession) -> None:
    """清除所有默认标记。"""
    stmt = (
        update(KnowledgeChunkConfig)
        .where(KnowledgeChunkConfig.is_default == True)  # noqa: E712
        .values(is_default=False)
    )
    await db.execute(stmt)
```

**你需要回答自己的问题**：

1. **为什么 `list_documents` 返回 `(list, total_count)` 元组？**
   - 前端分页需要两个信息：当前页数据 + 总数（计算总页数用）
   - 用两条 SQL 分别查（一条 COUNT，一条 SELECT ... LIMIT OFFSET）
   - **追问**：能不能用 `window function` 一条 SQL 搞定？（可以，`SELECT *, COUNT(*) OVER() AS total FROM ...`，但 ORM 写起来更复杂）

2. **`mark_old_versions_not_current` 用 `update()` 而不是逐条修改？**
   - 批量 UPDATE 一条 SQL 搞定，比循环逐条 `version.is_current = False` 高效
   - 特别是版本多的时候（一个文档上传了 20 次），批量操作明显更快
   - **面试点**："ORM 批量操作用 `update()` 语句，避免 N+1 问题。"

3. **`create_version` 为什么要同步更新主表的 `latest_version`？**
   - 冗余字段需要保证一致性
   - 在同一个事务中更新，要么都成功要么都回滚
   - **面试话术**："冗余字段的一致性由事务保证——版本记录和主表更新在同一个事务中。"

4. **`check_duplicate_hash` 和数据库唯一约束什么关系？**
   - 唯一约束是数据库层面的最终防线——即使应用层漏查，数据库也会拒绝
   - `check_duplicate_hash` 是应用层友好检查——给用户明确的"内容重复"提示
   - 如果不做应用层检查，数据库会抛 `IntegrityError` → 需要 try/except → 错误信息不友好
   - **面试话术**："双重保证：应用层友好提示，数据库层兜底。"

5. **`_clear_default_config` 为什么用下划线前缀？**
   - Python 命名约定：下划线前缀表示"模块内部使用"
   - 外部模块应该调用 `create_chunk_config(is_default=True)` 或 `update_chunk_config(is_default=True)`
   - 清除旧默认是内部实现细节，不应该暴露给调用方
   - **面试点**："封装——暴露意图接口，隐藏实现细节。"

---

## Step 6：`app/schemas/knowledge_document.py` — 文档 Schema

**新建文件**：

```python
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class KnowledgeVersionSchema(BaseModel):
    """版本响应 Schema。"""
    id: int
    version: int
    file_name: str
    content_hash: str
    file_size: int
    mime_type: str | None = None
    is_current: bool
    indexed_chunk_config_id: int | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class KnowledgeDocumentSchema(BaseModel):
    """文档响应 Schema（含嵌套的当前版本）。"""
    id: int
    doc_key: str
    title: str
    status: str
    latest_version: int
    created_at: datetime
    updated_at: datetime
    current_version: KnowledgeVersionSchema | None = None

    model_config = ConfigDict(from_attributes=True)


class KnowledgeDocumentListSchema(BaseModel):
    """文档分页列表。"""
    total: int
    documents: list[KnowledgeDocumentSchema]


class KnowledgeUploadResponse(BaseModel):
    """上传响应。"""
    created: bool
    message: str
    document: KnowledgeDocumentSchema
    version: KnowledgeVersionSchema
    rebuild_triggered: bool = False
    rebuild_success: bool | None = None
    rebuild_exit_code: int | None = None


class KnowledgeDeleteResponse(BaseModel):
    """删除响应。"""
    success: bool
    doc_key: str
    message: str
```

**`app/schemas/knowledge_chunk_config.py`**：

```python
from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator


class ChunkConfigBaseSchema(BaseModel):
    """分块配置基础字段。"""
    name: str
    description: str | None = None
    splitter: str = "sentence"
    chunk_size: int = 800
    chunk_overlap: int = 150
    min_chunk_len: int = 20
    metadata_policy: str = "basic"
    is_active: bool = True
    is_default: bool = False


class ChunkConfigCreateSchema(ChunkConfigBaseSchema):
    """创建请求。"""

    @field_validator("chunk_overlap")
    @classmethod
    def overlap_must_be_less_than_size(cls, v, info):
        chunk_size = info.data.get("chunk_size", 800)
        if v >= chunk_size:
            raise ValueError(f"chunk_overlap ({v}) 必须小于 chunk_size ({chunk_size})")
        return v


class ChunkConfigUpdateSchema(BaseModel):
    """更新请求（所有字段可选）。"""
    name: str | None = None
    description: str | None = None
    splitter: str | None = None
    chunk_size: int | None = None
    chunk_overlap: int | None = None
    min_chunk_len: int | None = None
    metadata_policy: str | None = None
    is_active: bool | None = None
    is_default: bool | None = None


class ChunkConfigSchema(ChunkConfigBaseSchema):
    """响应 Schema。"""
    id: int
    created_by: int | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ChunkConfigDeleteResponse(BaseModel):
    """删除响应。"""
    success: bool
    message: str
```

**`app/schemas/knowledge_rebuild.py`**：

```python
from pydantic import BaseModel


class KnowledgeRebuildResponse(BaseModel):
    """重建响应。"""
    success: bool
    scope: str  # "full" 或 "single"
    document_id: int | None = None
    exit_code: int
    duration_ms: float
    chunk_config_id: int | None = None
    stdout: str
    stderr: str
```

**导出层 `app/schemas/knowledge.py`**：

```python
"""知识库 Schema 导出——统一入口。"""

from app.schemas.knowledge_chunk_config import (
    ChunkConfigCreateSchema,
    ChunkConfigDeleteResponse,
    ChunkConfigSchema,
    ChunkConfigUpdateSchema,
)
from app.schemas.knowledge_document import (
    KnowledgeDeleteResponse,
    KnowledgeDocumentListSchema,
    KnowledgeDocumentSchema,
    KnowledgeUploadResponse,
    KnowledgeVersionSchema,
)
from app.schemas.knowledge_rebuild import KnowledgeRebuildResponse

__all__ = [
    "KnowledgeVersionSchema",
    "KnowledgeDocumentSchema",
    "KnowledgeDocumentListSchema",
    "KnowledgeUploadResponse",
    "KnowledgeDeleteResponse",
    "ChunkConfigCreateSchema",
    "ChunkConfigUpdateSchema",
    "ChunkConfigSchema",
    "ChunkConfigDeleteResponse",
    "KnowledgeRebuildResponse",
]
```

**你需要回答自己的问题**：

1. **为什么 Schema 要拆成多个文件？**
   - 单文件 → 混杂文档、配置、重建三种 Schema → 100 行以上不好维护
   - 拆文件 → 每个文件职责清晰，找代码更快
   - 导出层 `knowledge.py` 统一入口 → 外部 import 依然简洁
   - **面试话术**："模块拆分按领域（document/chunk_config/rebuild），导出层聚合。"

2. **`ChunkConfigCreateSchema` 为什么有 validator 而 `ChunkConfigUpdateSchema` 没有？**
   - 创建时所有字段都有值 → 可以校验 overlap < size
   - 更新时字段可选 → 可能只更新 name → 拿不到 chunk_size 做比较
   - 更新的校验放在 router 层——合并旧值 + 新值后校验
   - **面试点**："校验层级不同——创建在 Schema 层（数据完整），更新在 Service 层（需要旧数据对比）。"

3. **`KnowledgeUploadResponse` 为什么返回完整的 document 和 version 对象？**
   - 前端上传后需要立即显示文档信息——不用再发一次 GET 请求
   - 返回完整对象遵循 REST 最佳实践：POST 返回创建的资源
   - `rebuild_triggered` 和 `rebuild_success` 是可选的——如果上传时自动触发 rebuild

---

## Step 7：`app/services/knowledge_service.py` — 知识库服务

**完整代码**：

```python
"""
知识库文件管理服务。

职责：文件系统操作（保存、删除、目录管理）+ 子进程触发构建。
元信息管理（去重、版本号）由 CRUD 层负责，本模块不依赖数据库 Session。
"""

import asyncio
import hashlib
import logging
import os
import re
import sys
import time
from pathlib import Path

from app.core.config import settings

logger = logging.getLogger(__name__)

# 允许的文件后缀集合
ALLOWED_SUFFIXES: set[str] = {
    s.strip().lower() for s in settings.ALLOWED_DOC_SUFFIXES.split(",") if s.strip()
}

# 目录路径
KNOWLEDGE_DIR = Path(settings.KNOWLEDGE_DIR)
VERSIONS_DIR = Path(settings.MANAGED_VERSIONS_DIR)
BACKEND_DIR = Path(__file__).resolve().parents[2]


def ensure_knowledge_dirs() -> None:
    """创建知识库目录结构。启动时和上传前调用。"""
    KNOWLEDGE_DIR.mkdir(parents=True, exist_ok=True)
    VERSIONS_DIR.mkdir(parents=True, exist_ok=True)


def normalize_doc_key(filename: str) -> str:
    """
    文档键规范化：去掉扩展名，只保留 a-z, 0-9, -, _。

    为什么要规范化？
    - 用户上传 "风电叶片检修手册 (第三版).pdf" → 中文+空格+括号
    - 直接做目录名 → 文件系统兼容性问题 + 目录遍历攻击风险
    - 规范化后安全且可预测

    示例：
      "blade_manual_v3.pdf" → "blade_manual_v3"
      "风电叶片手册.pdf"    → "doc-1678900000"（中文全替换后太短，用时间戳兜底）
    """
    stem = Path(filename).stem
    normalized = re.sub(r"[^a-zA-Z0-9_-]+", "-", stem.strip().lower())
    normalized = re.sub(r"-{2,}", "-", normalized).strip("-")
    return normalized[:100] or f"doc-{int(time.time())}"


def sanitize_filename(filename: str) -> str:
    """清理文件名，保留扩展名。"""
    name = Path(filename).stem
    suffix = Path(filename).suffix.lower()
    clean = re.sub(r"[^a-zA-Z0-9_.-]+", "_", name.strip())
    return f"{clean[:200]}{suffix}" if clean else f"file_{int(time.time())}{suffix}"


def compute_content_hash(content: bytes) -> str:
    """
    SHA256 内容哈希，用于去重。

    为什么用 SHA256 而不是 MD5？
    - MD5 已知存在碰撞攻击（两个不同文件产生相同哈希）
    - SHA256 抗碰撞性远强于 MD5，是当前工业标准
    - 性能差异在文件级别可忽略（MB 级别毫秒差异）
    """
    return hashlib.sha256(content).hexdigest()


def is_allowed_suffix(filename: str) -> bool:
    """检查文件后缀是否在白名单中。"""
    return Path(filename).suffix.lower() in ALLOWED_SUFFIXES


def relative_to_backend(path: Path) -> str:
    """将绝对路径转为相对于 backend 目录的路径。"""
    try:
        return str(path.relative_to(BACKEND_DIR))
    except ValueError:
        return str(path)


async def read_upload_file(file) -> bytes:
    """异步读取上传文件内容。"""
    return await file.read()


def save_version_file(
    doc_key: str,
    version: int,
    content: bytes,
    file_name: str,
) -> Path:
    """
    保存文件到版本归档目录。

    目录结构：
      managed_versions/
      └── blade_manual/
          ├── v1/
          │   └── blade_manual.pdf
          └── v2/
              └── blade_manual.pdf
    """
    version_dir = VERSIONS_DIR / doc_key / f"v{version}"
    version_dir.mkdir(parents=True, exist_ok=True)
    file_path = version_dir / file_name
    file_path.write_bytes(content)
    logger.info(
        "版本归档完成 doc_key=%s version=%d path=%s",
        doc_key, version, file_path,
    )
    return file_path


def write_active_document(doc_key: str, content: bytes, suffix: str) -> Path:
    """
    写入 active 目录（knowledge_base/）。
    build_knowledge.py 读取这个目录来构建索引。

    写入前先清理同 doc_key 的旧文件，防止一个文档有多个后缀的残留。
    """
    ensure_knowledge_dirs()
    normalized_suffix = suffix.lower()
    if normalized_suffix not in ALLOWED_SUFFIXES:
        normalized_suffix = ".pdf"

    # 清理旧文件（不同后缀的残留）
    for s in ALLOWED_SUFFIXES:
        old_path = KNOWLEDGE_DIR / f"{doc_key}{s}"
        if old_path.exists() and old_path.is_file():
            old_path.unlink()
            logger.info("清理旧 active 文件 path=%s", old_path)

    active_path = KNOWLEDGE_DIR / f"{doc_key}{normalized_suffix}"
    active_path.write_bytes(content)
    logger.info("写入 active 文档 path=%s size=%d", active_path, len(content))
    return active_path


def remove_active_file(doc_key: str) -> bool:
    """
    从 active 目录删除文件。
    数据库的软删除由 CRUD 层负责，这里只管文件系统。
    """
    removed = False
    for suffix in ALLOWED_SUFFIXES:
        path = KNOWLEDGE_DIR / f"{doc_key}{suffix}"
        if path.exists() and path.is_file():
            path.unlink()
            removed = True
            logger.info("删除 active 文件 path=%s", path)
    return removed


async def trigger_build_knowledge(
    chunk_config: dict | None = None,
    source_dir: str | None = None,
    timeout_seconds: int | None = None,
) -> tuple[int, float, str, str]:
    """
    异步触发知识库索引重建脚本。

    为什么用 create_subprocess_exec 而不是 BackgroundTasks？
    - BackgroundTasks 在 API 进程内执行，共享内存空间
    - 知识库构建加载 Embedding 模型 + 处理文档，可能占用数 GB 内存
    - 如果 BackgroundTask OOM → 整个 API 进程崩溃 → 所有用户断线
    - 子进程有独立内存空间，OOM 只影响子进程，API 进程安然无恙

    为什么用环境变量传参而不是 CLI 参数？
    - 参数越来越多（DB连接、chunk配置、模型路径），CLI 参数会很长
    - 环境变量天然支持分组（DB_HOST, DB_PORT vs CHUNK_SIZE, CHUNK_OVERLAP）
    - 和 Pydantic Settings 的 .env 方案一致，脚本可以直接读 .env
    """
    final_timeout = timeout_seconds or settings.KNOWLEDGE_BUILD_TIMEOUT_S
    final_source_dir = source_dir or str(KNOWLEDGE_DIR)

    # 构建环境变量
    env = dict(os.environ)
    env["KNOWLEDGE_DIR"] = final_source_dir

    # 传入分块配置
    if chunk_config:
        for key, value in chunk_config.items():
            env[f"CHUNK_{key.upper()}"] = str(value)

    cmd = [sys.executable, "build_knowledge.py"]

    logger.info(
        "启动知识库重建 cmd=%s cwd=%s timeout=%ds",
        cmd, BACKEND_DIR, final_timeout,
    )

    start = time.perf_counter()
    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(BACKEND_DIR),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        logger.info("build_knowledge.py 已启动 PID=%s", process.pid)

        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            process.communicate(),
            timeout=final_timeout,
        )
        stdout = stdout_bytes.decode("utf-8", errors="replace")
        stderr = stderr_bytes.decode("utf-8", errors="replace")
        duration_ms = (time.perf_counter() - start) * 1000

        if process.returncode == 0:
            logger.info(
                "知识库重建成功 duration_ms=%.1f PID=%s",
                duration_ms, process.pid,
            )
        else:
            logger.error(
                "知识库重建失败 exit_code=%s duration_ms=%.1f",
                process.returncode, duration_ms,
            )

        if stdout.strip():
            logger.info("[build_knowledge stdout]\n%s", stdout[-2000:])
        if stderr.strip():
            logger.warning("[build_knowledge stderr]\n%s", stderr[-2000:])

        return (process.returncode or 0, duration_ms, stdout[-4000:], stderr[-4000:])

    except asyncio.TimeoutError:
        duration_ms = (time.perf_counter() - start) * 1000
        logger.error(
            "知识库重建超时 timeout=%ds duration_ms=%.1f",
            final_timeout, duration_ms,
        )
        # 超时后必须终止子进程，防止进程泄漏
        process.kill()
        await process.wait()
        raise
    except Exception:
        duration_ms = (time.perf_counter() - start) * 1000
        logger.exception("知识库重建异常 duration_ms=%.1f", duration_ms)
        raise
```

**你需要回答自己的问题**：

1. **service 层为什么不依赖数据库 Session？**
   - service 层只管文件系统操作和子进程
   - 数据库操作由 CRUD 层负责，router 层编排两者
   - 好处：service 的函数都是纯函数或文件操作，不需要 `async def`（除了 `trigger_build_knowledge`）
   - **面试话术**："三层分离——CRUD 管数据库，Service 管文件系统和外部进程，Router 编排两者。"

2. **`normalize_doc_key` 的安全考量？**
   - **目录遍历攻击**：文件名含 `../../etc/passwd` → 写到系统目录
   - 正则 `[^a-zA-Z0-9_-]+` 把 `/`、`.`、空格全部替换 → 无法构造路径穿越
   - 截断到 100 字符 → 防止超长文件名导致文件系统报错
   - **面试安全点**："文件名做了白名单过滤 + 长度截断，防止路径穿越和文件系统兼容性问题。"

3. **`relative_to_backend` 的用途是什么？**
   - 数据库存相对路径而不是绝对路径
   - 绝对路径耦合了部署环境——换台服务器路径就变了
   - 相对路径 + 运行时拼接 BACKEND_DIR → 部署无关
   - **面试话术**："存储层使用相对路径，解耦部署环境。"

4. **为什么用环境变量传参给 build_knowledge.py？**
   - 参数多（DB 连接 5 个 + chunk 配置 5 个 + 模型路径 3 个 = 13 个参数）
   - CLI 参数 → `python build_knowledge.py --db-host x --db-port y --db-user z ...` → 太长
   - 环境变量 → 天然支持分组，和 `.env` 方案一致
   - **追问**：安全吗？（进程的环境变量只有同用户/root 可见，比命令行参数安全——命令行参数 `ps aux` 全可见）

---

## Step 8：`app/routers/knowledge.py` — 知识库管理路由

**完整代码**（按功能分段）：

```python
"""
知识库管理路由。

所有接口仅管理员（is_superuser）可访问。
元信息存数据库（三表），文件存文件系统。

端点清单：
- POST   /knowledge/documents/upload       上传文档
- GET    /knowledge/documents               列出文档
- DELETE /knowledge/documents/{doc_key}      删除文档
- POST   /knowledge/rebuild                 触发全量重建
- GET    /knowledge/chunk-configs            列出分块配置
- POST   /knowledge/chunk-configs            创建分块配置
- PUT    /knowledge/chunk-configs/{id}       更新分块配置
- DELETE /knowledge/chunk-configs/{id}       删除分块配置
"""

import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.crud import knowledge as knowledge_crud
from app.models.knowledge_enums import KnowledgeDocStatus
from app.models.user import User
from app.routers.auth import get_current_user
from app.schemas.knowledge import (
    ChunkConfigCreateSchema,
    ChunkConfigDeleteResponse,
    ChunkConfigSchema,
    ChunkConfigUpdateSchema,
    KnowledgeDeleteResponse,
    KnowledgeDocumentListSchema,
    KnowledgeDocumentSchema,
    KnowledgeRebuildResponse,
    KnowledgeUploadResponse,
    KnowledgeVersionSchema,
)
from app.services import knowledge_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["知识库管理(Knowledge)"])


def _require_superuser(user: User) -> None:
    """
    权限守卫：只有管理员能操作知识库。

    为什么知识库操作限制管理员？
    - 知识库内容直接影响 RAG 回答质量
    - 普通用户上传恶意文档 → 知识库投毒（Prompt Injection 变种）
    - 权限控制是安全的第一道防线
    """
    if not user.is_superuser:
        raise HTTPException(status_code=403, detail="仅管理员可操作知识库")


# ==================== 文档上传 ====================


@router.post(
    "/knowledge/documents/upload",
    response_model=KnowledgeUploadResponse,
    summary="上传知识库文档",
)
async def upload_document(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeUploadResponse:
    """
    上传文档到知识库。

    流程：
    1. 校验文件格式
    2. SHA256 → 按文档内去重
    3. 创建/获取文档主记录 → 标记旧版本 → 创建新版本
    4. 保存文件（版本归档 + active 目录）
    5. 统一 commit
    """
    _require_superuser(current_user)
    knowledge_service.ensure_knowledge_dirs()

    # [1] 校验文件名和格式
    if not file.filename:
        raise HTTPException(status_code=400, detail="文件名不能为空")

    if not knowledge_service.is_allowed_suffix(file.filename):
        raise HTTPException(
            status_code=400,
            detail=f"仅支持 {sorted(knowledge_service.ALLOWED_SUFFIXES)} 格式",
        )

    # [2] 读取文件内容 + 哈希
    content = await knowledge_service.read_upload_file(file)
    if not content:
        raise HTTPException(status_code=400, detail="上传文件为空")

    content_hash = knowledge_service.compute_content_hash(content)
    suffix = Path(file.filename).suffix.lower()
    doc_key = knowledge_service.normalize_doc_key(file.filename)
    safe_filename = knowledge_service.sanitize_filename(file.filename)

    # [3] 获取或创建文档主记录
    doc = await knowledge_crud.get_document_by_key(db, doc_key)
    created = False

    if doc is None:
        doc = await knowledge_crud.create_document(
            db, doc_key=doc_key, title=safe_filename, created_by=current_user.id,
        )
        created = True
    elif doc.status == KnowledgeDocStatus.DELETED:
        # 文档已被删除 → 恢复为 active，继续上传新版本
        await knowledge_crud.mark_document_active(db, doc.id)
        created = False

    # [4] 按文档内去重
    dup_version = await knowledge_crud.check_duplicate_hash(
        db, document_id=doc.id, content_hash=content_hash,
    )
    if dup_version:
        return KnowledgeUploadResponse(
            created=False,
            message=f"内容重复，与 v{dup_version.version} 相同",
            document=KnowledgeDocumentSchema.model_validate(doc),
            version=KnowledgeVersionSchema.model_validate(dup_version),
        )

    # [5] 标记旧版本 + 计算新版本号
    await knowledge_crud.mark_old_versions_not_current(db, doc.id)
    new_version_num = doc.latest_version + 1

    # [6] 文件系统操作
    try:
        storage_path = knowledge_service.save_version_file(
            doc_key, new_version_num, content, safe_filename,
        )
        active_path = knowledge_service.write_active_document(
            doc_key, content, suffix,
        )
    except Exception:
        logger.exception("文件保存失败，回滚数据库 doc_key=%s", doc_key)
        await db.rollback()
        raise HTTPException(status_code=500, detail="文件保存失败")

    # [7] 创建版本记录
    version = await knowledge_crud.create_version(
        db,
        document_id=doc.id,
        version=new_version_num,
        file_name=safe_filename,
        storage_path=knowledge_service.relative_to_backend(storage_path),
        active_path=knowledge_service.relative_to_backend(active_path),
        content_hash=content_hash,
        file_size=len(content),
        mime_type=file.content_type,
        created_by=current_user.id,
    )

    # [8] 统一 commit
    await db.commit()
    await db.refresh(doc)

    logger.info(
        "文档上传成功 doc_key=%s version=%d hash=%s user=%d",
        doc_key, new_version_num, content_hash[:16], current_user.id,
    )

    # 填充 current_version 到文档 Schema
    doc_schema = KnowledgeDocumentSchema.model_validate(doc)
    doc_schema.current_version = KnowledgeVersionSchema.model_validate(version)

    return KnowledgeUploadResponse(
        created=created,
        message="上传成功",
        document=doc_schema,
        version=KnowledgeVersionSchema.model_validate(version),
    )


# ==================== 文档列表 ====================


@router.get(
    "/knowledge/documents",
    response_model=KnowledgeDocumentListSchema,
    summary="列出知识库文档",
)
async def list_documents(
    status: str | None = None,
    keyword: str | None = None,
    offset: int = 0,
    limit: int = 50,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeDocumentListSchema:
    """列出文档，支持按状态过滤和关键词搜索。"""
    _require_superuser(current_user)
    docs, total = await knowledge_crud.list_documents(
        db, status=status, keyword=keyword, offset=offset, limit=limit,
    )

    # 填充 current_version
    items = []
    for d in docs:
        schema = KnowledgeDocumentSchema.model_validate(d)
        current_ver = await knowledge_crud.get_current_version(db, d.id)
        if current_ver:
            schema.current_version = KnowledgeVersionSchema.model_validate(current_ver)
        items.append(schema)

    return KnowledgeDocumentListSchema(total=total, documents=items)


# ==================== 文档删除 ====================


@router.delete(
    "/knowledge/documents/{doc_key}",
    response_model=KnowledgeDeleteResponse,
    summary="删除知识库文档",
)
async def delete_document(
    doc_key: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeDeleteResponse:
    """
    软删除文档（数据库 status → deleted）+ 删除 active 目录文件。
    版本归档不受影响（可手动恢复）。
    """
    _require_superuser(current_user)

    doc = await knowledge_crud.get_document_by_key(db, doc_key)
    if not doc:
        raise HTTPException(status_code=404, detail=f"文档 {doc_key} 不存在")

    result = await knowledge_crud.mark_document_deleted(db, doc.id)
    if not result:
        raise HTTPException(status_code=400, detail=f"文档 {doc_key} 已删除或状态不允许")

    knowledge_service.remove_active_file(doc_key)
    await db.commit()

    logger.info("文档已删除 doc_key=%s user=%d", doc_key, current_user.id)

    return KnowledgeDeleteResponse(
        success=True,
        doc_key=doc_key,
        message="文档已删除（软删除），版本归档仍保留。请触发 rebuild 更新向量索引。",
    )


# ==================== 知识库重建 ====================


@router.post(
    "/knowledge/rebuild",
    response_model=KnowledgeRebuildResponse,
    summary="触发知识库索引重建",
)
async def trigger_rebuild(
    chunk_config_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeRebuildResponse:
    """
    触发 build_knowledge.py 重建向量索引。

    可以指定 chunk_config_id 使用特定分块配置。
    不指定则使用默认配置。
    """
    _require_superuser(current_user)

    # 获取分块配置
    config = None
    config_dict = None
    if chunk_config_id:
        config = await knowledge_crud.get_chunk_config_by_id(db, chunk_config_id)
        if not config:
            raise HTTPException(status_code=404, detail=f"配置 {chunk_config_id} 不存在")
    else:
        config = await knowledge_crud.get_default_chunk_config(db)

    if config:
        config_dict = {
            "splitter": config.splitter,
            "size": config.chunk_size,
            "overlap": config.chunk_overlap,
            "min_len": config.min_chunk_len,
            "metadata_policy": config.metadata_policy,
            "config_id": config.id,
        }

    try:
        exit_code, duration_ms, stdout, stderr = (
            await knowledge_service.trigger_build_knowledge(
                chunk_config=config_dict,
            )
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail="知识库重建超时，请检查文档数量或增加超时时间",
        )
    except Exception as exc:
        logger.exception("触发重建失败")
        raise HTTPException(
            status_code=500,
            detail=f"重建失败: {exc}",
        ) from exc

    return KnowledgeRebuildResponse(
        success=exit_code == 0,
        scope="full",
        exit_code=exit_code,
        duration_ms=round(duration_ms, 2),
        chunk_config_id=config.id if config else None,
        stdout=stdout,
        stderr=stderr,
    )


# ==================== 分块配置管理 ====================


@router.get(
    "/knowledge/chunk-configs",
    response_model=list[ChunkConfigSchema],
    summary="列出分块配置",
)
async def list_chunk_configs(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ChunkConfigSchema]:
    _require_superuser(current_user)
    configs = await knowledge_crud.list_chunk_configs(db)
    return [ChunkConfigSchema.model_validate(c) for c in configs]


@router.post(
    "/knowledge/chunk-configs",
    response_model=ChunkConfigSchema,
    summary="创建分块配置",
)
async def create_chunk_config(
    payload: ChunkConfigCreateSchema,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ChunkConfigSchema:
    _require_superuser(current_user)

    # 校验 overlap < size
    if payload.chunk_overlap >= payload.chunk_size:
        raise HTTPException(
            status_code=400,
            detail=f"chunk_overlap ({payload.chunk_overlap}) 必须小于 chunk_size ({payload.chunk_size})",
        )

    # 检查名称唯一
    existing = await knowledge_crud.get_chunk_config_by_name(db, payload.name)
    if existing:
        raise HTTPException(status_code=409, detail=f"配置名 '{payload.name}' 已存在")

    config = await knowledge_crud.create_chunk_config(
        db,
        name=payload.name,
        description=payload.description,
        splitter=payload.splitter,
        chunk_size=payload.chunk_size,
        chunk_overlap=payload.chunk_overlap,
        min_chunk_len=payload.min_chunk_len,
        metadata_policy=payload.metadata_policy,
        is_default=payload.is_default,
        created_by=current_user.id,
    )
    await db.commit()

    return ChunkConfigSchema.model_validate(config)


@router.put(
    "/knowledge/chunk-configs/{chunk_config_id}",
    response_model=ChunkConfigSchema,
    summary="更新分块配置",
)
async def update_chunk_config(
    chunk_config_id: int,
    payload: ChunkConfigUpdateSchema,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ChunkConfigSchema:
    _require_superuser(current_user)

    config = await knowledge_crud.get_chunk_config_by_id(db, chunk_config_id)
    if not config:
        raise HTTPException(status_code=404, detail="配置不存在")

    # 如果要切换默认，更新旧默认
    fields = payload.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="没有要更新的字段")

    config = await knowledge_crud.update_chunk_config(
        db, chunk_config_id, **fields,
    )
    await db.commit()

    return ChunkConfigSchema.model_validate(config)


@router.delete(
    "/knowledge/chunk-configs/{chunk_config_id}",
    response_model=ChunkConfigDeleteResponse,
    summary="删除分块配置",
)
async def delete_chunk_config(
    chunk_config_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ChunkConfigDeleteResponse:
    _require_superuser(current_user)

    # 检查是否有版本在使用此配置
    usage_count = await knowledge_crud.count_versions_by_chunk_config(
        db, chunk_config_id,
    )
    if usage_count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"该配置被 {usage_count} 个版本使用中，无法删除",
        )

    success = await knowledge_crud.delete_chunk_config(db, chunk_config_id)
    if not success:
        raise HTTPException(status_code=404, detail="配置不存在")

    await db.commit()

    return ChunkConfigDeleteResponse(
        success=True,
        message="分块配置已删除",
    )
```

**你需要回答自己的问题**：

1. **上传接口为什么不自动触发 rebuild？**
   - 批量上传 5 个文档 → 触发 5 次 rebuild → 每次重建全量索引 → 浪费资源
   - 分离上传和重建 → 上传完所有文档后一次性 rebuild
   - **面试话术**："上传和重建解耦，支持批量上传后一次性重建，避免重复计算。"

2. **为什么 commit 放在 router 层而不是 CRUD 层？**
   - 上传流程涉及多个步骤：创建文档 → 标记旧版本 → 创建新版本 → 保存文件
   - 如果 CRUD 内部 commit → 文件保存失败 → 数据库已提交 → 不一致
   - commit 放 router → 所有步骤成功后统一提交 → 任何步骤失败都可回滚
   - **面试金句**："事务边界应该在编排层（router/service），不在数据访问层（CRUD）。"

3. **分块配置删除为什么检查使用数量？**
   - 某个配置被 10 个版本引用 → 删除配置后 `indexed_chunk_config_id` 变成悬空引用
   - 虽然数据库有 FK 约束保护，但给用户友好提示比 `IntegrityError` 好
   - **面试话术**："引用完整性在应用层做友好检查，数据库层做最终防线。"

4. **`db.refresh(doc)` 在 commit 后为什么需要？**
   - commit 后 ORM 对象的属性变成"过期"（expired）
   - refresh 重新从数据库加载最新数据（包括 `latest_version` 等刚更新的字段）
   - 不 refresh → 访问属性时也会自动查（lazy load），但显式 refresh 更可控
   - **面试点**："SQLAlchemy 的 identity map 和对象状态管理——commit 后 expire，需要 refresh 获取最新值。"

5. **`504 Gateway Timeout` 为什么不用 `408 Request Timeout`？**
   - 408 是"客户端请求超时"（客户端太慢发完请求）
   - 504 是"网关/代理超时"（后端服务处理太慢）
   - 这里是后端子进程超时 → 504 更准确
   - **面试点**：HTTP 状态码的语义要精确，不能随便用

---

## Step 9：`build_knowledge.py` — 知识库构建脚本

**完整代码（放在项目根目录 `backend/build_knowledge.py`）**：

```python
"""
知识库索引构建脚本（独立运行，不依赖 FastAPI）。

由 knowledge_service.trigger_build_knowledge() 通过子进程调用。
也可以手动运行：uv run python build_knowledge.py

流程：
1. 从环境变量读取配置
2. 读取文档（SimpleDirectoryReader / DoclingReader）
3. SentenceSplitter / MarkdownNodeParser 分块
4. 过滤短文本
5. 清空旧向量 → 写入 pgvector
"""

import os
import sys
import time
from pathlib import Path

# === 环境变量必须在 import llama_index 之前设置 ===
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]:
    os.environ.pop(key, None)

# 把项目根目录加入 sys.path，这样可以 import app.core.config
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.core.config import settings  # noqa: E402

# HF_HOME 和 HUGGINGFACE_HUB_CACHE 在 Day 6 Step 1 的 config.py 中定义。
# 如果你跳过了 Day 6 或这两个字段为空，这里用 models/hf_cache 作为默认值。
_hf_home = settings.HF_HOME if hasattr(settings, "HF_HOME") and settings.HF_HOME else str(Path(__file__).resolve().parent / "models" / "hf_cache")
os.environ.setdefault("HF_HOME", _hf_home)
os.environ.setdefault("HUGGINGFACE_HUB_CACHE", _hf_home)

from llama_index.core import Settings as LlamaSettings  # noqa: E402
from llama_index.core import SimpleDirectoryReader  # noqa: E402
from llama_index.core import StorageContext, VectorStoreIndex  # noqa: E402
from llama_index.core.node_parser import SentenceSplitter, MarkdownNodeParser  # noqa: E402
from llama_index.embeddings.huggingface import HuggingFaceEmbedding  # noqa: E402
from llama_index.vector_stores.postgres import PGVectorStore  # noqa: E402

# === 从环境变量读取配置（子进程通过 env 传入） ===
KNOWLEDGE_DIR = os.environ.get("KNOWLEDGE_DIR", str(Path(__file__).resolve().parent / "knowledge_base"))
CHUNK_SPLITTER = os.environ.get("CHUNK_SPLITTER", "sentence")
CHUNK_SIZE = int(os.environ.get("CHUNK_SIZE", "800"))
CHUNK_OVERLAP = int(os.environ.get("CHUNK_OVERLAP", "150"))
CHUNK_MIN_LEN = int(os.environ.get("CHUNK_MIN_LEN", "20"))
CHUNK_METADATA_POLICY = os.environ.get("CHUNK_METADATA_POLICY", "basic")
CHUNK_CONFIG_ID = os.environ.get("CHUNK_CONFIG_ID")


def load_documents(source_dir: str) -> list:
    """
    读取目录下的所有文档。

    SimpleDirectoryReader 支持：TXT、PDF、DOCX、CSV、HTML 等。
    PDF 解析底层用 PyMuPDF / pdfminer。
    复杂 PDF（扫描件、复杂表格）可以换成 DoclingReader。
    """
    dir_path = Path(source_dir)
    if not dir_path.exists():
        print(f"错误: 目录 {source_dir} 不存在")
        return []

    # 只读取允许的文件类型
    allowed = {s.strip() for s in settings.ALLOWED_DOC_SUFFIXES.split(",") if s.strip()}
    input_files = [
        str(f) for f in sorted(dir_path.iterdir())
        if f.is_file() and f.suffix.lower() in allowed
    ]

    if not input_files:
        print(f"警告: {source_dir} 下没有可处理的文档")
        return []

    print(f"发现 {len(input_files)} 个文档，开始读取...")

    # 按文件类型分别处理
    pdf_files = [f for f in input_files if f.lower().endswith(".pdf")]
    other_files = [f for f in input_files if not f.lower().endswith(".pdf")]

    docs = []

    # PDF 文件尝试用 DoclingReader（更好的 PDF 解析）
    if pdf_files:
        try:
            from llama_index.readers.docling import DoclingReader
            reader = DoclingReader()
            for pdf_file in pdf_files:
                pdf_docs = reader.load_data(pdf_file)
                docs.extend(pdf_docs)
                print(f"  DoclingReader: {Path(pdf_file).name} → {len(pdf_docs)} 片段")
        except ImportError:
            print("  DoclingReader 未安装，降级到 SimpleDirectoryReader")
            pdf_docs = SimpleDirectoryReader(input_files=pdf_files).load_data()
            docs.extend(pdf_docs)

    # 其他文件用 SimpleDirectoryReader
    if other_files:
        other_docs = SimpleDirectoryReader(input_files=other_files).load_data()
        docs.extend(other_docs)

    # 确保每个文档都有 file_name 元数据
    for doc in docs:
        file_path = doc.metadata.get("file_path")
        if file_path and not doc.metadata.get("file_name"):
            doc.metadata["file_name"] = Path(file_path).name

    print(f"文档读取完成，共 {len(docs)} 个文档片段")
    return docs


def build_index(source_dir: str) -> None:
    """
    构建知识库索引的主流程。

    步骤说明：
    1. 初始化 Embedding 模型（BGE-M3, 1024 维）
    2. 连接 PGVectorStore（pgvector）
    3. 读取文档
    4. 根据配置选择分块器
    5. 过滤短文本块（< min_len）
    6. 清空旧向量（全量重建）
    7. 构建索引（自动 Embedding + 写入 pgvector）
    """
    start = time.perf_counter()

    # --- [1] 初始化 Embedding 模型 ---
    print("加载 Embedding 模型 (BAAI/bge-m3)...")
    LlamaSettings.embed_model = HuggingFaceEmbedding(model_name="BAAI/bge-m3")
    LlamaSettings.llm = None  # 构建阶段不需要 LLM

    # --- [2] 连接 PGVectorStore ---
    print("连接 PostgreSQL 向量数据库...")
    vector_store = PGVectorStore.from_params(
        database=settings.DB_NAME,
        host=settings.DB_HOST,
        password=settings.DB_PASSWORD,
        port=str(settings.DB_PORT),
        user=settings.DB_USER,
        table_name=settings.DB_TABLE,
        embed_dim=1024,
        hybrid_search=True,
        text_search_config="simple",
    )
    storage_context = StorageContext.from_defaults(vector_store=vector_store)

    # --- [3] 读取文档 ---
    documents = load_documents(source_dir)
    if not documents:
        print("没有文档可构建，退出")
        return

    # --- [4] 根据配置选择分块器 ---
    print(f"分块策略: {CHUNK_SPLITTER}, chunk_size={CHUNK_SIZE}, overlap={CHUNK_OVERLAP}")
    if CHUNK_SPLITTER == "markdown":
        splitter = MarkdownNodeParser()
        print("使用 MarkdownNodeParser（按 Markdown 标题层级切分）")
    else:
        splitter = SentenceSplitter(
            chunk_size=CHUNK_SIZE,
            chunk_overlap=CHUNK_OVERLAP,
        )
        print("使用 SentenceSplitter（按句子边界切分）")

    nodes = splitter.get_nodes_from_documents(documents)
    print(f"分块完成，原始节点数: {len(nodes)}")

    # --- [5] 过滤短文本 + 附加元数据 ---
    filtered_nodes = []
    for idx, node in enumerate(nodes, start=1):
        text = (getattr(node, "text", "") or "").strip()
        if len(text) < CHUNK_MIN_LEN:
            continue
        metadata = dict(getattr(node, "metadata", {}) or {})
        metadata.setdefault("chunk_id", idx)
        metadata["chunk_splitter"] = CHUNK_SPLITTER
        if CHUNK_CONFIG_ID:
            metadata["chunk_config_id"] = int(CHUNK_CONFIG_ID)

        # 根据 metadata_policy 控制元数据量
        if CHUNK_METADATA_POLICY == "basic":
            # 只保留必要字段
            keep_keys = {"file_name", "chunk_id", "chunk_splitter", "chunk_config_id"}
            metadata = {k: v for k, v in metadata.items() if k in keep_keys}

        node.metadata = metadata
        filtered_nodes.append(node)

    print(f"过滤后节点数: {len(filtered_nodes)} (min_len={CHUNK_MIN_LEN})")

    if not filtered_nodes:
        print("过滤后没有可入库节点，退出")
        return

    # --- [6] 清空旧向量（全量重建，先删后建）---
    print("清空旧向量数据...")
    vector_store.clear()

    # --- [7] 构建索引（Embedding + 写入 pgvector）---
    print("开始 Embedding + 写入 pgvector（这一步最慢）...")
    VectorStoreIndex(
        nodes=filtered_nodes,
        storage_context=storage_context,
        show_progress=True,
    )

    duration = time.perf_counter() - start
    print(f"构建完成！{len(filtered_nodes)} 个节点已入库，耗时 {duration:.1f}s")


if __name__ == "__main__":
    build_index(source_dir=KNOWLEDGE_DIR)
```

**你需要回答自己的问题**：

1. **`chunk_size=800` 和 `chunk_overlap=150` 是什么意思？**
   - `chunk_size`：每个文档块的最大 token 数（约 800 x 1.5 ≈ 1200 中文字符）
   - `chunk_overlap`：相邻块之间的重叠 token 数——避免句子被截断时丢失上下文
   - 例子：一段 1600 token → 块 1: [0-800], 块 2: [650-1450], 块 3: [1300-1600]
   - **面试必答**："chunk_size 太大 → 向量语义模糊；太小 → 上下文断裂。800 是领域文档的经验值。"

2. **`SentenceSplitter` vs `MarkdownNodeParser` 怎么选？**
   - `SentenceSplitter`：通用，按句子边界切分，适合 PDF 等非结构化文档
   - `MarkdownNodeParser`：按 Markdown 标题层级切分，保留文档结构，适合 `.md` 文件
   - 在分块配置表中管理 → 管理员可以为不同类型文档选择不同分块器
   - **面试话术**："分块策略做成可配置的——通用文档用 sentence，结构化文档用 markdown，运行时切换不用改代码。"

3. **`DoclingReader` vs `SimpleDirectoryReader` 的区别？**
   - `SimpleDirectoryReader`：用 PyMuPDF/pdfminer 解析 PDF，对纯文本 PDF 够用
   - `DoclingReader`：IBM 开源的文档解析器，支持表格识别、标题检测、布局分析
   - 优先尝试 `DoclingReader`，ImportError 时降级到 `SimpleDirectoryReader`
   - **面试话术**："PDF 解析做了优雅降级——有 Docling 用高级解析，没有就用基础解析。渐进增强策略。"

4. **为什么改用环境变量而不是 CLI 参数？**
   - 之前版本用 `argparse` 传参：`python build_knowledge.py --chunk-size 800 --chunk-overlap 150`
   - 参数越来越多（DB 连接 + chunk 配置 + 模型路径 = 13+ 参数），CLI 太长
   - 环境变量 → 和 `.env` 方案一致，子进程自然继承父进程环境变量
   - **面试点**："配置传递方式的演进——少量参数用 CLI，大量参数用环境变量或配置文件。"

5. **`metadata_policy == "basic"` 时为什么要过滤元数据？**
   - LlamaIndex 默认给每个 chunk 附加大量元数据（file_path, start_char_idx, end_char_idx 等）
   - 这些元数据也会写入 pgvector 的 JSONB 列 → 占用存储空间
   - `basic` 模式只保留检索和展示必要的字段 → 节省 30~50% 存储
   - `debug` 模式保留全部 → 调试分块质量时需要

6. **`vector_store.clear()` 为什么在构建索引之前调用？**
   - 全量重建策略：先删除所有旧向量 → 再写入新向量
   - 不清空会导致：已删除文档的向量残留 + 更新文档的重复向量
   - **追问**：为什么不增量更新？（需要记录每个文档对应哪些向量 ID，复杂度高。文档量小时全量重建更简单可靠）
   - **面试话术**："知识库文档量可控（几十到几百），全量重建简单可靠。如果文档量上万，需要改成增量更新——用 doc_key 标记向量，更新时按 doc_key 删旧加新。"

7. **`hybrid_search=True` + `text_search_config="simple"` 做了什么？**
   - `hybrid_search=True`：PGVectorStore 自动创建全文检索索引（GIN Index）
   - 检索时同时做向量语义搜索 + 关键词匹配 → 分数融合
   - `"simple"`：PostgreSQL 分词配置，按空格/标点切分，不做词形还原
   - 为什么不用 `"english"`？中文不需要词干化（running→run），`simple` 对中文无害
   - **面试金句**："Hybrid Search = 语义理解 + 精确匹配。用户问'Err_105'时关键词匹配命中，问'叶片裂纹怎么修'时语义匹配命中。"

---

## Step 10：改 `app/main.py` — 挂载 knowledge 路由

```python
from app.routers import knowledge

# 在 lifespan 或 router 注册区域
app.include_router(knowledge.router, prefix="/api")
```

知识库路由不需要 lifespan 初始化（没有要预加载的模型）。

---

## Step 11：Alembic 迁移

```bash
# 确保 alembic/env.py 已 import 三个 model
uv run alembic revision --autogenerate -m "add_knowledge_management_tables"
# 检查迁移文件，确认有：
# - create_table('knowledge_documents', ...)
# - create_table('knowledge_document_versions', ...)
# - create_table('knowledge_chunk_configs', ...)
# - 唯一索引 uq_doc_version, uq_doc_hash
# - content_hash 索引
# - status 索引
uv run alembic upgrade head
```

---

## Day 7 验收清单

```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/backend

# 1. ruff 无报错
uv run ruff check app/ build_knowledge.py

# 2. 格式化
uv run ruff format --check app/ build_knowledge.py

# 3. Apifox 验证：

# a) 创建分块配置
#    POST /api/knowledge/chunk-configs
#    Body: {"name": "默认-sentence-800", "splitter": "sentence", "chunk_size": 800, "chunk_overlap": 150, "is_default": true}
#    期望: 200, id=1

# b) 上传文档
#    POST /api/knowledge/documents/upload
#    Body: form-data, file=<选择文件>
#    期望: 200, created=true, version.version=1

# c) 重复上传同一文件
#    期望: 200, created=false, message 含"内容重复"

# d) 上传同一 doc_key 的新版本（修改后的文件）
#    期望: 200, version.version=2, v1 的 is_current=false

# e) 列出文档
#    GET /api/knowledge/documents
#    期望: 看到文档列表 + current_version 信息

# f) 触发重建
#    POST /api/knowledge/rebuild
#    期望: success=true, 能看到构建输出

# g) 验证 RAG 能检索到新文档
#    POST /api/chat/stream {"question": "文档中提到的内容"}
#    检查日志: route=rag

# h) 删除文档
#    DELETE /api/knowledge/documents/{doc_key}
#    期望: success=true
#    再查 GET /api/knowledge/documents → 该文档消失
#    触发 rebuild → RAG 检索不到该文档内容

# i) 分块配置 CRUD
#    POST 创建第二个配置 → GET 列出看到两个
#    PUT 更新配置参数 → GET 验证
#    DELETE 删除未使用的配置 → 成功
#    DELETE 删除被使用的配置 → 409 拒绝

# 4. 数据库验证
#    psql -d your_db -c "SELECT doc_key, status, latest_version FROM knowledge_documents;"
#    psql -d your_db -c "SELECT document_id, version, is_current FROM knowledge_document_versions;"
#    psql -d your_db -c "SELECT name, is_default FROM knowledge_chunk_configs;"
#    psql -d your_db -c "SELECT count(*) FROM data_wind_knowledge;"
```

---

## 文件写作顺序

```
1.  app/core/config.py                          <- 改（加知识库配置）
2.  app/models/knowledge_enums.py               <- 新建（枚举常量）
3.  app/models/knowledge_document.py            <- 新建（文档主表 + 版本表）
4.  app/models/knowledge_chunk_config.py        <- 新建（分块配置表）
5.  app/models/knowledge.py                     <- 新建（导出层）
6.  app/crud/knowledge.py                       <- 新建（三表 CRUD）
7.  app/schemas/knowledge_document.py           <- 新建（文档 Schema）
8.  app/schemas/knowledge_chunk_config.py       <- 新建（配置 Schema）
9.  app/schemas/knowledge_rebuild.py            <- 新建（重建 Schema）
10. app/schemas/knowledge.py                    <- 新建（Schema 导出层）
11. app/services/knowledge_service.py           <- 新建（文件系统 + 子进程）
12. app/routers/knowledge.py                    <- 新建（管理路由）
13. build_knowledge.py                          <- 新建（项目根目录，构建脚本）
14. app/main.py                                 <- 改（挂 knowledge 路由）
15. alembic/env.py                              <- 改（import 三个 model）
16. alembic 迁移 + upgrade
17. Apifox 验证
```

---

## 面试话术（90 秒）

> 知识库管理模块用三表模型——文档主表记录身份和状态，版本表记录每次上传的详细信息，分块配置表管理分块参数。
>
> 文档主表的 doc_key 唯一约束保证一个文档只有一条记录。版本表有两个联合唯一约束：(document_id, version) 防重复版本号，(document_id, content_hash) 防重复内容。is_current 标记当前版本，新版本上传时批量把旧版本设为 not current。
>
> 分块配置做成数据库表而不是硬编码——管理员在前端就能切换 chunk_size 和 splitter 类型，不用改代码重部署。支持 SentenceSplitter 和 MarkdownNodeParser 两种分块策略。每个版本记录了它被构建时用的配置 ID，出问题能追溯。
>
> 上传时 SHA256 哈希做内容去重，文件名白名单正则防路径穿越。只有管理员能操作——防止知识库投毒。上传和重建解耦，批量上传后一次性 rebuild。
>
> 重建脚本在独立子进程执行，进程级故障隔离。用环境变量传参，和 .env 配置方案一致。先 vector_store.clear() 清空旧向量再全量写入，保证和 active 目录一致。PDF 解析优先用 DoclingReader（结构化输出），没装就降级到 SimpleDirectoryReader。
>
> 分块后经过 BGE-M3 Embedding（1024 维）写入 pgvector，开启 Hybrid Search 同时支持语义检索和关键词精确匹配。架构分三层：CRUD 管数据库，Service 管文件系统和子进程，Router 编排两者并控制事务边界。
