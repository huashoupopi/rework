# Day 7：知识库管理（文档上传 + 分块 + 入库 + 版本管理）

> 目标：实现知识库文档上传、解析分块、向量入库、版本管理、索引重建
> 预计文件数：4 个新建 + 1 个修改
> 验证工具：Apifox

---

## 整体架构

```
用户上传文档（PDF/DOCX/TXT）
  ↓
[1] 文档解析（提取纯文本）
  ↓
[2] 内容去重（SHA256 哈希比对）
  ↓
[3] 文本分块（chunk_size + overlap）
  ↓
[4] Embedding 生成（BGE-M3）
  ↓
[5] 写入 pgvector 向量表
  ↓
[6] 版本管理（旧版本归档，新版本激活）
```

---

## Step 1：`app/services/knowledge_service.py` — 知识库服务

**要求**：

```python
import hashlib
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

KNOWLEDGE_BASE_DIR = Path("knowledge_base")

class KnowledgeService:
    @staticmethod
    def ensure_dirs() -> None:
        """创建知识库目录结构"""
        # knowledge_base/
        # ├── active/           ← 当前生效的文档
        # └── managed_versions/ ← 历史版本归档

    @staticmethod
    def compute_content_hash(content: bytes) -> str:
        """SHA256 内容哈希，用于去重"""
        return hashlib.sha256(content).hexdigest()

    @staticmethod
    def normalize_doc_key(filename: str) -> str:
        """文档键规范化：只保留 a-z, 0-9, -, _"""
        # Path(filename).stem → 去掉扩展名
        # re.sub(r'[^a-z0-9_-]', '_', name.lower())

    @staticmethod
    async def save_version_file(
        doc_key: str, version: int, content: bytes, suffix: str
    ) -> Path:
        """保存到版本目录：managed_versions/{doc_key}/v{version}/"""

    @staticmethod
    async def write_active_document(doc_key: str, content: bytes, suffix: str) -> Path:
        """写入 active 目录（当前生效版本）"""

    @staticmethod
    async def trigger_build_knowledge(
        chunk_size: int = 512,
        chunk_overlap: int = 50,
    ) -> None:
        """异步触发知识库索引重建脚本"""
        # asyncio.create_subprocess_exec("uv", "run", "python", "build_knowledge.py", ...)
```

**你需要回答自己的问题**：

1. **为什么要做内容去重（SHA256）？**
   - 用户可能重复上传同一份文档（文件名不同但内容相同）
   - 不去重 → 同一段文字被检索到多次，占用向量表空间，且 Reranker 浪费计算
   - SHA256 哈希比对：内容相同 → 哈希相同 → 跳过入库
   - **面试话术**："用内容哈希做幂等性保护，避免重复文档污染向量索引。"

2. **`normalize_doc_key` 为什么要规范化文件名？**
   - 用户上传的文件名可能有中文、空格、特殊字符
   - 直接做目录名不安全（目录遍历风险 + 文件系统兼容性）
   - 规范化为 `[a-z0-9_-]` 确保安全且跨平台
   - **追问**：两个不同文件名规范化后相同怎么办？（加版本号或 UUID 后缀区分）

3. **为什么索引重建用子进程（`create_subprocess_exec`）而不是在 API 进程里做？**
   - 知识库构建涉及大量 IO（读文件 + Embedding 计算 + 写数据库），耗时可能几分钟
   - 在 API 进程里做会阻塞所有请求
   - 子进程独立运行，API 进程不受影响
   - **追问**：子进程 vs BackgroundTasks？（子进程有独立内存空间，崩溃不影响主进程；BackgroundTasks 共享进程，一个任务 OOM 全部完蛋）

4. **版本管理的意义是什么？**
   - 知识库更新后可能出现"新版不如旧版"的情况（比如误删了关键文档）
   - 版本管理让你能**回滚**到之前的版本
   - `active/` 目录是当前生效的文档，`managed_versions/` 归档历史版本
   - **面试加分**："知识库版本管理类似数据库 migration——每次变更有记录，可追溯可回滚。"

---

## Step 2：`build_knowledge.py` — 知识库构建脚本

**要求（放在项目根目录）**：

```python
"""知识库索引构建脚本（独立运行，不依赖 FastAPI）"""
import argparse
import asyncio
from pathlib import Path

from llama_index.core import SimpleDirectoryReader, VectorStoreIndex, Settings
from llama_index.core.node_parser import SentenceSplitter
from llama_index.embeddings.huggingface import HuggingFaceEmbedding
from llama_index.vector_stores.postgres import PGVectorStore

from app.core.config import settings

async def build(source_dir: str, chunk_size: int, chunk_overlap: int):
    # 1. 初始化 Embedding
    embed_model = HuggingFaceEmbedding(model_name="BAAI/bge-m3")
    Settings.embed_model = embed_model

    # 2. 初始化 PGVectorStore
    vector_store = PGVectorStore.from_params(
        host=settings.DB_HOST, port=settings.DB_PORT,
        database=settings.DB_NAME, user=settings.DB_USER,
        password=settings.DB_PASSWORD,
        table_name=settings.DB_TABLE,
        embed_dim=1024,
        hybrid_search=True,
        text_search_config="simple",
    )

    # 3. 读取文档
    documents = SimpleDirectoryReader(source_dir).load_data()

    # 4. 分块
    splitter = SentenceSplitter(chunk_size=chunk_size, chunk_overlap=chunk_overlap)
    nodes = splitter.get_nodes_from_documents(documents)

    # 5. 构建索引（自动 Embedding + 写入 pgvector）
    index = VectorStoreIndex(nodes, vector_store=vector_store)
    print(f"构建完成：{len(nodes)} 个文档块已入库")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", default="knowledge_base/active")
    parser.add_argument("--chunk-size", type=int, default=512)
    parser.add_argument("--chunk-overlap", type=int, default=50)
    args = parser.parse_args()
    asyncio.run(build(args.source_dir, args.chunk_size, args.chunk_overlap))
```

**你需要回答自己的问题**：

1. **`chunk_size=512` 和 `chunk_overlap=50` 是什么意思？**
   - `chunk_size`：每个文档块的最大 token 数（约 512 × 4 ≈ 2048 字符）
   - `chunk_overlap`：相邻块之间的重叠 token 数——避免句子被截断时丢失上下文
   - 例子：一段 1000 token 的文本 → 块 1: [0-512], 块 2: [462-974], 块 3: [924-1000]
   - **面试必答**："chunk_size 太大 → 向量语义模糊、检索不精确；太小 → 上下文断裂、碎片化。512 是经验值，需要根据实际文档调优。"

2. **`SentenceSplitter` 和按字符切分有什么区别？**
   - `SentenceSplitter` 尽量在句子边界切分，不会把一句话从中间切断
   - 按字符硬切（`chunk_size` 字符）可能切在单词中间
   - 句子级切分语义更完整，检索质量更高
   - **追问**：中文的句子边界怎么判断？（句号、问号、感叹号、分号等中文标点）

3. **`SimpleDirectoryReader` 支持什么格式？**
   - 默认支持：TXT、PDF、DOCX、CSV、HTML 等
   - PDF 解析底层用 PyMuPDF 或 pdfminer
   - 复杂 PDF（扫描件、表格密集型）可能需要 Docling 等专用解析器
   - **面试话术**："我们的知识库主要是技术文档（PDF/Word），SimpleDirectoryReader 能覆盖 90% 场景。复杂 PDF 后续会接入 Docling。"

---

## Step 3：`app/routers/knowledge.py` — 知识库管理路由

**要求**：

```python
# POST /knowledge/documents/upload — 上传文档
# GET  /knowledge/documents — 列出已上传文档
# DELETE /knowledge/documents/{doc_key} — 删除文档
# POST /knowledge/rebuild — 触发索引重建
```

**上传接口核心逻辑**：

```python
@router.post("/knowledge/documents/upload")
async def upload_document(
    file: UploadFile,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not current_user.is_superuser:
        raise HTTPException(403, "仅管理员可上传知识库文档")

    content = await file.read()
    content_hash = KnowledgeService.compute_content_hash(content)

    # 检查是否重复
    # ...（查数据库或文件系统比对 hash）

    doc_key = KnowledgeService.normalize_doc_key(file.filename)
    suffix = Path(file.filename).suffix

    # 保存到 active 目录
    await KnowledgeService.write_active_document(doc_key, content, suffix)

    # 可选：自动触发重建
    # await KnowledgeService.trigger_build_knowledge()

    return {"doc_key": doc_key, "hash": content_hash, "message": "上传成功"}
```

**你需要回答自己的问题**：

1. **为什么只有管理员能上传知识库？**
   - 知识库内容直接影响 RAG 回答质量——错误文档会导致系统给出错误答案
   - 普通用户上传恶意文档 → **知识库投毒**（Prompt Injection 变种）
   - 权限控制是第一道防线；Day 8 的安全检测是第二道
   - **面试安全点**："知识库上传做了两层防护：权限控制（仅管理员）+ 内容安全检测（检查注入）。"

2. **上传后要不要自动重建索引？**
   - 自动重建：用户体验好，但每上传一个文件就重建一次——批量上传时浪费资源
   - 手动重建：需要用户额外点"重建"按钮——但可以批量上传完再一次性重建
   - 推荐：批量上传时不自动重建，提供独立的 `/knowledge/rebuild` 接口
   - **追问**：如果重建过程中有新的检索请求怎么办？（旧索引仍然可用，重建完成后原子切换——或者用 Blue/Green 策略）

---

## Step 4：Alembic 迁移（如果有新模型）

如果知识库用独立的数据库模型（如 `KnowledgeDocument`）来管理文档元数据，需要新建 model + 迁移。

如果只用文件系统管理（不存数据库），则不需要迁移。

**建议**：Day 7 先用文件系统管理（简单），后续有时间再加数据库模型。

---

## Day 7 验收清单

```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/backend

# 1. ruff 无报错
uv run ruff check app/ build_knowledge.py

# 2. 手动测试知识库构建
#    - 准备几个测试文档放到 knowledge_base/active/
#    - 运行 uv run python build_knowledge.py
#    - 检查 pgvector 表有数据

# 3. Apifox 验证：
#    - 上传文档 → 成功
#    - 触发重建 → 日志显示构建完成
#    - 再去 /api/chat/stream 提问 → RAG 能检索到新文档内容
```

---

## 文件写作顺序

```
1. app/services/knowledge_service.py  ← 新建
2. build_knowledge.py                 ← 新建（项目根目录）
3. app/routers/knowledge.py           ← 新建
4. app/main.py                        ← 改（挂 knowledge 路由）
5. 准备测试文档 + 运行 build_knowledge.py
6. Apifox 验证
```

---

## 面试话术（90 秒）

> 知识库管理模块支持文档上传、版本管理、分块入库。
> 上传时用 SHA256 哈希做内容去重，避免重复文档污染向量索引。
> 文档分块用 SentenceSplitter 在句子边界切分，chunk_size=512、overlap=50，保证语义完整性。
> 分块后经过 BGE-M3 Embedding 写入 pgvector，支持 Hybrid Search。
> 索引重建用独立子进程执行，不阻塞 API 进程。
> 只有管理员能上传知识库文档——这是防止知识库投毒的第一道防线。
> 版本管理让知识库变更可追溯可回滚，类似数据库 migration 的思路。
