# RAG（检索增强生成）面试知识文档

> 基于风电运维智能问答系统项目实战，涵盖 RAG 全链路核心知识点。
>
> **审校状态（2026-04-03）**
> - 当前仓库真实实现：`FastAPI + PostgreSQL/PGVector + Redis + Arq + React fetch/ReadableStream 流式聊天`
> - 本文大部分 RAG 主链内容仍然有效，但**流式输出、LLM 部署方式、历史回灌策略**已按当前仓库重新校准
> - 遇到与 `10/11/14/15` 冲突的地方，以 `10/11/14/15` 和当前代码为准

---

## 一、RAG 基础概念

### 1.1 什么是 RAG？

RAG（Retrieval-Augmented Generation，检索增强生成）是一种将**信息检索**与**大语言模型生成**相结合的技术架构。核心思想是：在 LLM 生成回答之前，先从外部知识库中检索与用户问题相关的文档片段，将这些片段作为上下文注入到 Prompt 中，让 LLM 基于检索到的真实信息来生成回答。

简单来说，RAG = **检索（Retrieval）** + **增强（Augmented）** + **生成（Generation）**。

- **检索**：从知识库中找到与问题最相关的文档片段
- **增强**：将检索到的内容作为上下文注入 Prompt
- **生成**：LLM 基于增强后的 Prompt 生成最终回答

### 1.2 为什么需要 RAG？

LLM 有几个根本性的限制，RAG 正是为了解决这些限制：

1. **知识截止问题（Knowledge Cutoff）**：LLM 的知识停留在训练数据的截止日期，无法回答训练后发生的事件或更新的信息。RAG 通过检索实时知识库来弥补。

2. **幻觉问题（Hallucination）**：LLM 在缺乏相关知识时会"编造"看起来合理但实际错误的答案。RAG 通过提供真实文档作为依据，大幅减少幻觉。

3. **领域知识缺失**：通用 LLM 缺乏特定领域的专业知识。例如本项目中的风电运维知识——叶片裂纹修复方案、特定故障代码含义等，这些在通用训练数据中覆盖极少。

4. **数据隐私**：企业私有数据不能上传给第三方模型进行微调。RAG 让私有数据留在本地知识库，只在推理时注入。

5. **可追溯性**：RAG 能提供回答的来源文档（source），方便用户验证答案的准确性。在本项目中，每次回答都会返回引用的文档名、相关度得分和内容摘要。

### 1.3 RAG vs Fine-tuning（微调）的区别和选择

| 维度 | RAG | Fine-tuning |
|------|-----|-------------|
| **知识更新** | 实时更新知识库即可，无需重新训练 | 需要重新训练模型，成本高 |
| **成本** | 低：只需维护向量数据库 | 高：GPU 训练、数据标注 |
| **数据量要求** | 少量文档即可开始 | 通常需要数千到数万条标注数据 |
| **可解释性** | 高：能追溯到具体文档来源 | 低：知识融入模型权重，不可追溯 |
| **幻觉控制** | 好：基于检索到的真实文档 | 一般：仍可能生成训练数据外的内容 |
| **适用场景** | 知识频繁更新、需要可追溯性 | 需要改变模型的行为模式或风格 |
| **部署复杂度** | 中：需要向量数据库 + 检索服务 | 低：只需部署微调后的模型 |

**选择建议**：
- 如果需求是"让模型知道特定领域的知识" → **选 RAG**
- 如果需求是"让模型以特定方式说话/推理" → **选 Fine-tuning**
- 实际项目中常常**两者结合**：RAG 提供知识，Fine-tuning 调整风格

本项目选择 RAG 的原因：
- 风电运维文档频繁更新（新型号、新故障案例）
- 需要追溯答案来源（运维人员需要验证）
- 私有文档不能外泄
- 团队没有 GPU 集群做微调

### 1.4 RAG 的整体流程和架构

```
用户提问
   │
   ▼
[1. 安全检测] ──→ 不安全 → 拒答
   │ 安全
   ▼
[2. Query 增强] ──→ 拼接图像检测上下文
   │
   ▼
[3. 混合检索] ──→ 稠密检索 + 稀疏检索 → top_k=10 候选
   │
   ▼
[4. 重排 Rerank] ──→ Cross-Encoder 精排 → top_n=5
   │
   ▼
[5. 安全过滤] ──→ 检测上下文节点是否被投毒
   │
   ▼
[6. 路由决策] ──→ 判断是否使用 RAG（score + node 数量）
   │
   ├─ RAG 路由 → 构建含上下文的 Prompt
   └─ Fallback 路由 → 通用知识回答
   │
   ▼
[7. LLM 生成] ──→ 流式输出（HTTP streaming，非标准 SSE）
   │
   ▼
[8. 后处理] ──→ 去重、Think 标记解析、存储
```

### 1.5 RAG 的优势和局限性

**优势**：
- 知识库可随时更新，无需重训模型
- 答案可追溯到具体文档
- 减少幻觉（有据可依）
- 支持多模态（本项目整合了 YOLO 缺陷检测结果）
- 数据隐私可控

**局限性**：
- 检索质量直接影响回答质量（garbage in, garbage out）
- 对 chunking 策略敏感：切分不好可能丢失上下文
- 增加了系统复杂度（需要维护向量数据库、Embedding 模型、Reranker）
- 上下文窗口有限：不能把所有检索结果都塞进 Prompt
- 跨文档推理能力弱：如果答案需要综合多个文档的信息，RAG 表现可能不如微调

---

## 二、文档处理与知识库构建

### 2.1 文档解析

#### Docling 是什么？

Docling 是一个文档解析库（由 IBM 开发），专门用于将复杂格式的文档（PDF、Word、PPT 等）转换为结构化的文本。它的核心优势是对 PDF 的处理能力远超传统方案。

#### 为什么需要 Docling？

PDF 是非结构化数据中最棘手的格式之一：
- **扫描件 PDF**：内容是图片，需要 OCR
- **复杂表格**：传统解析器会把表格拆得支离破碎
- **多栏排版**：左右两栏容易错乱
- **页眉页脚**：混入正文内容

项目中使用 Docling 作为 PDF 解析的首选方案：

```python
# build_knowledge.py 中的实现
if pdf_files:
    try:
        from llama_index.readers.docling import DoclingReader

        reader = DoclingReader()
        for pdf_file in pdf_files:
            pdf_docs = reader.load_data(pdf_file)
            # DoclingReader 不写入 file_path/file_name，手动补上
            for doc in pdf_docs:
                doc.metadata.setdefault("file_path", pdf_file)
                doc.metadata.setdefault("file_name", Path(pdf_file).name)
            docs.extend(pdf_docs)
    except ImportError:
        # Docling 未安装时降级到 SimpleDirectoryReader
        pdf_docs = SimpleDirectoryReader(input_files=pdf_files).load_data()
        docs.extend(pdf_docs)
```

**设计亮点**：
- 优雅降级：Docling 未安装时自动降级到 `SimpleDirectoryReader`（基于 PyMuPDF/pdfminer）
- 手动补元数据：`DoclingReader` 不自动写入 `file_path`/`file_name`，代码手动补上，确保后续增量重建时能通过 `doc_key` 精准删除旧 chunks

#### SimpleDirectoryReader

LlamaIndex 内置的通用文档读取器，支持 TXT、PDF、DOCX、CSV、HTML 等。对于非 PDF 文件（如 Markdown），项目直接使用它：

```python
if other_files:
    other_docs = SimpleDirectoryReader(input_files=other_files).load_data()
    docs.extend(other_docs)
```

### 2.2 文本切分（Chunking）

#### 为什么要切分？

文档通常有数千甚至数万字，而：
1. **Embedding 模型有输入长度限制**：BGE-M3 最优输入长度约 512 tokens
2. **检索精度**：整篇文档作为一个向量，检索精度太低。切成小块后，每个 chunk 代表一个具体的知识点，检索更精准
3. **LLM 上下文窗口有限**：不可能把整篇文档塞进 Prompt，只能放最相关的几个 chunk
4. **语义聚焦**：小 chunk 的语义更集中，向量表示更准确

#### 切分策略

项目支持两种切分策略：

**1. SentenceSplitter（句子级切分）**——项目默认方案

按句子边界切分文本，确保不会在句子中间断开。这是最常用的切分策略。

```python
# build_knowledge.py 中的实现
splitter = SentenceSplitter(
    chunk_size=chunk_size,      # 默认 800 tokens
    chunk_overlap=chunk_overlap, # 默认 150 tokens
)
nodes = splitter.get_nodes_from_documents(documents)
```

**工作原理**：
1. 先按句子边界（句号、问号、感叹号等）分割文本
2. 将连续的句子合并，直到达到 `chunk_size` 上限
3. 相邻 chunk 之间保留 `chunk_overlap` 个 token 的重叠
4. 如果单个句子超过 `chunk_size`，会进一步按词/字符拆分

**2. MarkdownNodeParser（Markdown 标题级切分）**

按 Markdown 标题层级（`#`、`##`、`###` 等）切分，保持文档的结构语义。

```python
if chunk_splitter == "markdown":
    splitter = MarkdownNodeParser()
```

适用于 Markdown 格式的知识文档，能保持标题和内容的关联性。

#### chunk_size 和 chunk_overlap 参数

**chunk_size（分块大小）**：
- 含义：每个 chunk 的最大 token 数
- 项目默认值：`800`（见 `KnowledgeChunkConfig` 模型和 `config.py` 中的 `CHUNK_SIZE: int = 800`）
- 太小（如 128）：上下文不完整，一个知识点可能被切断
- 太大（如 2048）：语义不够聚焦，检索精度下降；且占用 LLM 上下文窗口
- **调优建议**：一般 512-1024 之间。技术文档可以偏大（800），短问答型数据可以偏小（256）

**chunk_overlap（分块重叠）**：
- 含义：相邻 chunk 之间重叠的 token 数
- 项目默认值：`150`（见 `CHUNK_OVERLAP: int = 150`）
- 为什么需要重叠？防止关键信息恰好在切分边界被截断
- 例如："叶片裂纹的修复方法是..."如果在"方法"和"是"之间切分，前一个 chunk 知道问题但不知道答案，后一个 chunk 有答案但缺少上下文
- overlap 让相邻 chunk 共享一段文本，确保边界信息不丢失
- **调优建议**：通常为 chunk_size 的 10%-25%。太大会导致冗余和向量库膨胀

**min_chunk_len（最小块长度）**：
- 含义：过滤掉过短的 chunk（字符数）
- 项目默认值：`20`（见 `CHUNK_MIN_LEN: int = 20`）
- 作用：过滤掉只有标题、空行、页码等无意义的 chunk

```python
# build_knowledge.py 中的过滤逻辑
filtered_nodes = []
for idx, node in enumerate(nodes, start=1):
    node_text = (getattr(node, "text", "") or "").strip()
    if len(node_text) < chunk_min_len:
        continue  # 过滤短文本
    # ... 附加元数据
    filtered_nodes.append(node)
```

### 2.3 知识库构建全流程

从文档上传到可检索，经历以下完整链路：

```
[用户上传文件]
       │
       ▼
[1. 文件校验]
  - 文件名非空
  - 后缀白名单校验（.pdf, .md, .markdown）
  - 文件内容非空
       │
       ▼
[2. 内容哈希 + 去重]
  - SHA256 计算 content_hash
  - 查询数据库：同一文档是否已有相同 hash 的版本
  - 重复 → 直接返回，不重复入库
       │
       ▼
[3. 文档键（doc_key）规范化]
  - normalize_doc_key(): 去扩展名，只保留 a-z, 0-9, -, _
  - 例："风电叶片手册.pdf" → "doc-1678900000"
       │
       ▼
[4. 数据库记录创建/更新]
  - 主表：KnowledgeDocument（doc_key, title, status, latest_version）
  - 版本表：KnowledgeDocumentVersion（version, content_hash, file_size, ...）
  - 标记旧版本 is_current=False，新版本 is_current=True
       │
       ▼
[5. 文件系统写入]
  - 版本归档：managed_versions/{doc_key}/v{n}/{filename}
  - 活跃目录：knowledge_base/{doc_key}{suffix}
       │
       ▼
[6. 触发索引重建]（异步，通过 Arq 任务队列）
  - 全量重建：清空所有向量 → 重新索引所有文档
  - 增量重建：删除指定文档的旧 chunks → 只索引指定文档
       │
       ▼
[7. 索引构建]（build_knowledge.py 子进程）
  - 获取文件锁（fcntl.flock 排他锁，防并发）
  - 加载 Embedding 模型（BAAI/bge-m3）
  - 连接 PGVectorStore
  - 读取文档（Docling/SimpleDirectoryReader）
  - 文本切分（SentenceSplitter/MarkdownNodeParser）
  - 过滤短文本 + 附加元数据（doc_key, chunk_id）
  - Embedding + 写入 pgvector
  - 更新数据库 index_status="indexed"
       │
       ▼
[8. 可检索] ← RagService 通过 VectorStoreIndex 查询
```

**为什么索引构建用子进程？**

这是一个关键的架构决策。项目使用 `asyncio.create_subprocess_exec`（后来改为 Arq 任务队列）而不是 FastAPI 的 `BackgroundTasks`：

```python
# knowledge_service.py 中的注释解释了原因：
"""
为什么用 create_subprocess_exec 而不是 BackgroundTasks？
- BackgroundTasks 在 API 进程内执行，共享内存空间
- 知识库构建加载 Embedding 模型 + 处理文档，可能占用数 GB 内存
- 如果 BackgroundTask OOM → 整个 API 进程崩溃 → 所有用户断线
- 子进程有独立内存空间，OOM 只影响子进程，API 进程安然无恙
"""
```

**并发控制——文件锁**：

```python
# build_knowledge.py 中的文件锁实现
def acquire_lock():
    """
    fcntl.LOCK_EX: 排他锁（独占）
    LOCK_NB: 非阻塞模式（锁被占用时立即抛异常，不等待）
    """
    lock_fd = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return lock_fd
    except BlockingIOError:
        lock_fd.close()
        raise RuntimeError("另一个重建任务正在运行")
```

---

## 三、Embedding（向量嵌入）

### 3.1 什么是 Embedding？

Embedding（嵌入）是将离散的文本数据映射到连续的高维向量空间的过程。简单来说，就是把文字变成一串数字（向量），使得语义相似的文本在向量空间中距离更近。

例如：
- "风力发电机叶片裂纹" → `[0.12, -0.34, 0.56, ..., 0.78]`（1024 维向量）
- "风电叶片出现裂缝" → `[0.11, -0.33, 0.55, ..., 0.77]`（非常接近）
- "今天天气真好" → `[-0.89, 0.23, -0.45, ..., 0.12]`（距离很远）

### 3.2 为什么需要 Embedding？

1. **计算机不懂文字**：机器只能处理数字，Embedding 是文本进入计算世界的"翻译层"
2. **语义相似度计算**：向量化后，可以用数学方法（余弦相似度等）计算两段文本的语义相似程度
3. **高效检索**：在向量数据库中，可以用 ANN（近似最近邻）算法在毫秒级完成百万级文档的语义检索
4. **跨越字面差异**：传统关键词检索无法匹配同义词/近义词，Embedding 能理解语义

### 3.3 Embedding 模型的工作原理

Embedding 模型本质上是一个深度神经网络（通常基于 Transformer 架构），其核心工作流程：

```
输入文本 → Tokenizer 分词 → Transformer 编码器（多层 Self-Attention）→ Pooling → 输出向量
```

1. **Tokenizer**：将文本切成 token（子词/词组）
2. **Transformer 编码器**：通过多层 Self-Attention 机制，让每个 token "看到"整个句子的上下文信息
3. **Pooling**：将所有 token 的表示聚合成一个固定长度的向量（通常取 `[CLS]` token 或平均池化）
4. **输出**：一个固定维度的向量（BGE-M3 是 1024 维）

### 3.4 BGE-M3 模型

项目使用的 Embedding 模型是 **BAAI/bge-m3**，由北京智源研究院（BAAI）开发。

```python
# rag_service.py 中的初始化代码
LlamaSettings.embed_model = HuggingFaceEmbedding(
    model_name="BAAI/bge-m3",
    model_kwargs={"dtype": "float16"},  # 半精度，节省显存
)
```

**BGE-M3 的三个 "M"**：
- **Multi-Lingual（多语言）**：支持 100+ 种语言，中英文效果都很好。本项目需要处理中文风电运维文档，BGE-M3 的中文能力是关键选型因素
- **Multi-Functionality（多功能）**：同时支持稠密检索、稀疏检索和多向量检索（ColBERT）
- **Multi-Granularity（多粒度）**：支持不同长度的输入（最长 8192 tokens）

**核心参数**：
- **维度**：1024 维（`embed_dim=1024`），这意味着每段文本被编码为一个 1024 维的浮点数向量
- **半精度（float16）**：`model_kwargs={"dtype": "float16"}` — 将模型权重从 32 位浮点降到 16 位，显存占用减半，推理速度更快，精度损失可忽略

### 3.5 距离度量

向量化之后，如何衡量两个向量的"相似程度"？常用三种度量方式：

#### 余弦相似度（Cosine Similarity）

```
cos(A, B) = (A · B) / (||A|| × ||B||)
```

- 取值范围：[-1, 1]（1 表示完全相同，0 表示无关，-1 表示完全相反）
- **只关注方向，不关注长度**：两个向量指向同一方向就相似，无论它们有多长
- 最常用的度量方式，对文本长度不敏感
- **PGVector 默认使用余弦距离**（`<=>` 运算符）

#### 欧氏距离（Euclidean Distance / L2）

```
d(A, B) = √(Σ(Ai - Bi)²)
```

- 取值范围：[0, +∞)（0 表示完全相同，越大越不相似）
- 直觉：两个点在空间中的直线距离
- 对向量的绝对大小敏感

#### 内积（Inner Product / Dot Product）

```
A · B = Σ(Ai × Bi)
```

- 取值范围：(-∞, +∞)（越大越相似）
- 当向量已归一化时，内积 = 余弦相似度
- 计算最快（不需要除法和开根号）

**项目中的选择**：PGVector 配合 LlamaIndex 默认使用余弦距离，适合文本语义检索场景。

### 3.6 项目中 Embedding 的实现细节

Embedding 在两个地方使用：

**1. 索引阶段（build_knowledge.py）**：将文档 chunk 转成向量并存储

```python
# build_knowledge.py
LlamaSettings.embed_model = HuggingFaceEmbedding(
    model_name="BAAI/bge-m3",
    model_kwargs={"dtype": "float16"},
)

# VectorStoreIndex 自动调用 embed_model 对每个 node 做 Embedding
VectorStoreIndex(
    nodes=filtered_nodes,
    storage_context=storage_context,
    show_progress=True,
)
```

**2. 查询阶段（rag_service.py）**：将用户问题转成向量用于检索

```python
# rag_service.py 中的检索
retriever = cls._index.as_retriever(
    similarity_top_k=cls.RETRIEVAL_TOP_K,  # 10
    vector_store_query_mode="hybrid"
)
nodes = await retriever.aretrieve(augmented_question)
# LlamaIndex 内部会自动调用 embed_model 将 question 向量化
```

---

## 四、向量数据库

### 4.1 什么是向量数据库？

向量数据库是专门用于存储和检索高维向量数据的数据库。传统数据库擅长精确匹配（`WHERE name = 'xxx'`），向量数据库擅长**语义近似搜索**（"找到与这个向量最相似的 K 个向量"）。

### 4.2 为什么需要向量数据库？

1. **高维向量不能用传统索引**：B-Tree、Hash 索引在高维空间失效（维度灾难）
2. **暴力搜索太慢**：100 万个 1024 维向量，逐一计算余弦相似度需要数秒
3. **需要专用索引结构**：IVFFlat、HNSW 等向量索引能在毫秒级完成近似最近邻搜索
4. **与元数据结合**：需要在向量检索时同时过滤元数据（如 `doc_key`、`file_name`）

### 4.3 PGVector 扩展

项目使用 **PGVector**——PostgreSQL 的向量扩展。

**为什么选 PGVector 而不是专用向量数据库（Milvus、Pinecone）？**

- **技术栈统一**：项目已经用 PostgreSQL 存储业务数据，PGVector 让向量和业务数据在同一个数据库中
- **运维简单**：不需要额外维护一个独立的向量数据库服务
- **事务一致性**：向量数据和业务数据在同一事务中，不会出现不一致
- **性能足够**：对于万级文档的知识库，PGVector 的性能绰绰有余
- **成熟稳定**：PostgreSQL 是世界上最成熟的数据库之一

**项目中的 PGVector 连接配置**：

```python
# rag_service.py
vector_store = PGVectorStore.from_params(
    database=settings.DB_NAME,
    host=settings.DB_HOST,
    port=str(settings.DB_PORT),
    password=settings.DB_PASSWORD,
    user=settings.DB_USER,
    table_name=settings.DB_TABLE,
    embed_dim=1024,          # 向量维度，与 BGE-M3 输出一致
    hybrid_search=True,       # 启用混合检索（稠密 + 稀疏）
    text_search_config="simple",  # 全文检索配置
)
```

**注意**：LlamaIndex 的 PGVectorStore 会自动在表名前加 `data_` 前缀。例如配置 `table_name="knowledge"`，实际表名是 `data_knowledge`。这在增量删除时需要注意：

```python
# knowledge_service.py 中的删除逻辑
actual_table = f"data_{settings.DB_TABLE}"
result = await conn.execute(
    sa_text(f"DELETE FROM {actual_table} WHERE metadata_->>'doc_key' = :doc_key"),
    {"doc_key": doc_key},
)
```

### 4.4 PGVector 索引类型

PGVector 支持两种主要索引类型：

#### IVFFlat（倒排文件 + 扁平量化）

- **原理**：将向量空间划分为 N 个聚类（Voronoi 单元），查询时只搜索最近的几个聚类
- **优点**：构建速度快
- **缺点**：精度不如 HNSW；需要预先知道数据分布
- **适用场景**：数据量适中、对构建速度有要求

#### HNSW（分层可导航小世界图）

- **全称**：Hierarchical Navigable Small World
- **原理**：构建一个多层图结构，越高层连接越稀疏（"高速公路"），越底层连接越密集（"乡间小路"）
- **查询过程**：
  1. 从最高层的入口点开始
  2. 在当前层找到距离查询点最近的节点
  3. 以该节点为入口进入下一层
  4. 重复直到最底层，最底层做最精确的搜索
- **优点**：查询速度快（O(log N)）；精度高；不需要训练
- **缺点**：构建时间长；内存占用大（需要存储图结构）
- **适用场景**：对查询速度和精度要求高的场景

**PGVector 默认使用 HNSW 索引**，这也是目前工业界最主流的向量索引方案。

### 4.5 ANN vs KNN

#### KNN（K-Nearest Neighbors，精确最近邻）

- 暴力搜索所有向量，找到精确的 K 个最近邻
- 时间复杂度 O(N × D)，N 是向量数量，D 是维度
- 100% 准确，但慢

#### ANN（Approximate Nearest Neighbors，近似最近邻）

- 使用索引结构（HNSW、IVFFlat 等）快速找到**近似的** K 个最近邻
- 时间复杂度 O(log N) ~ O(N^(1/2))
- 可能会"漏掉"一些真正的最近邻，但速度快几个数量级
- Recall@K（召回率）通常 > 95%

**项目选择 ANN**：知识库检索场景对精度的容忍度较高（漏掉一两个相关文档是可以接受的），但对延迟敏感（用户不能等 10 秒）。

### 4.6 项目中 PGVector 表结构

PGVector 自动创建的表结构（实际表名加 `data_` 前缀）包含以下关键列：
- `id`：主键
- `text`：原始文本内容
- `metadata_`：JSONB 类型，存储元数据（`file_name`、`doc_key`、`chunk_id` 等）
- `embedding`：vector(1024) 类型，存储 1024 维向量

增量删除通过 `metadata_->>'doc_key'` 精准定位：

```python
# build_knowledge.py
# PostgreSQL JSONB 操作符 ->> 提取键值为文本
del_result = await db.execute(
    text(
        f"DELETE FROM {actual_table} "
        "WHERE metadata_->>'doc_key' = :doc_key"
    ),
    {"doc_key": doc_key},  # 参数化查询，防 SQL 注入
)
```

---

## 五、检索（Retrieval）

### 5.1 什么是检索？

检索是从知识库中找到与用户问题最相关的文档片段（chunk）的过程。检索的目标是在海量文档中快速、准确地找到回答用户问题所需的信息。

检索质量直接决定了 RAG 系统的回答质量——如果检索到的文档不相关，LLM 再强也无法给出正确答案。

### 5.2 稠密检索（Dense Retrieval）

**原理**：将查询和文档都编码为稠密向量（dense vector），通过计算向量相似度来匹配。

- 使用 Embedding 模型将文本映射到连续的向量空间
- 语义匹配：能理解同义词、近义词、上下位关系
- 例如：查询"叶片裂缝"可以匹配到"blade crack"

**优势**：
- 语义理解能力强
- 能匹配意思相同但表述不同的文本

**劣势**：
- 对具体实体名（型号、编号）匹配可能不精确
- 依赖 Embedding 模型的质量

### 5.3 稀疏检索（Sparse Retrieval）

**原理**：基于关键词匹配，将文本表示为高维稀疏向量（大部分维度为 0，只有出现的词对应的维度有值）。

常见算法：

**BM25（Best Matching 25）**：
- TF-IDF 的改进版
- TF（词频）：一个词在文档中出现越多，越相关
- IDF（逆文档频率）：一个词在所有文档中出现越少，越有区分度
- BM25 对 TF 做了饱和处理（不会因为一个词出现 100 次就比出现 10 次高 10 倍）
- 还考虑了文档长度归一化

**优势**：
- 对精确关键词匹配非常有效
- 不需要训练模型
- 计算速度快

**劣势**：
- 无法理解语义（"叶片裂缝"和"blade crack"无法匹配）
- 对同义词、近义词无能为力

### 5.4 混合检索（Hybrid Search）

#### 为什么需要混合检索？

稠密检索和稀疏检索各有优劣，混合检索将两者结合，取长补短：

| 场景 | 稠密检索 | 稀疏检索 | 混合检索 |
|------|---------|---------|---------|
| "风机叶片裂纹如何修复" | 能匹配语义相关文档 | 关键词匹配 | 两者最优结果 |
| "故障代码 E-301" | 可能匹配不到精确编号 | 精确匹配 "E-301" | 稀疏检索补位 |
| "blade crack repair" | 能跨语言匹配中文文档 | 中文文档中没有这些英文词 | 稠密检索救场 |

#### 混合检索的原理

同时执行两路检索：
1. **稠密检索**：用 Embedding 向量做近似最近邻搜索
2. **稀疏检索**：用关键词做全文检索（PostgreSQL 的 `tsvector`/`tsquery`）

然后将两路结果融合。

#### RRF（Reciprocal Rank Fusion）融合算法

RRF 是最常用的多路检索结果融合算法。

**公式**：
```
RRF_score(d) = Σ (1 / (k + rank_i(d)))
```

- `d`：一个文档
- `rank_i(d)`：文档 d 在第 i 路检索结果中的排名（从 1 开始）
- `k`：常数（通常取 60），防止排名靠前的文档得分过高

**例子**：
假设文档 A 在稠密检索中排名第 1，在稀疏检索中排名第 5：
```
RRF(A) = 1/(60+1) + 1/(60+5) = 0.0164 + 0.0154 = 0.0318
```
假设文档 B 在稠密检索中排名第 3，在稀疏检索中排名第 2：
```
RRF(B) = 1/(60+3) + 1/(60+2) = 0.0159 + 0.0161 = 0.0320
```
B > A，所以融合后 B 排在 A 前面。

**RRF 的优势**：
- 不需要对不同检索的分数做归一化（不同检索的分数量纲可能完全不同）
- 只看排名，不看绝对分数
- 简单、鲁棒、效果好

#### 项目中的混合检索实现

```python
# rag_service.py — 初始化时启用混合检索
vector_store = PGVectorStore.from_params(
    # ...
    hybrid_search=True,             # 关键：启用混合检索
    text_search_config="simple",    # PostgreSQL 全文检索配置
)

# 检索时指定混合模式
retriever = cls._index.as_retriever(
    similarity_top_k=cls.RETRIEVAL_TOP_K,  # 10
    vector_store_query_mode="hybrid"        # 混合检索模式
)
nodes = await retriever.aretrieve(augmented_question)
```

**降级策略**：当混合检索返回 0 结果时（可能是全文检索组件异常），降级为纯向量检索：

```python
if not nodes:
    logger.warning("Hybrid search返回0结果，降级为纯向量检索")
    fallback_retriever = cls._index.as_retriever(
        similarity_top_k=cls.RETRIEVAL_TOP_K,
        vector_store_query_mode="default"  # 纯向量检索
    )
    nodes = await fallback_retriever.aretrieve(augmented_question)
```

### 5.5 top_k 参数

- **含义**：检索阶段返回的候选文档数量
- **项目值**：`RETRIEVAL_TOP_K = 10`
- **太小**（如 3）：可能漏掉相关文档
- **太大**（如 50）：引入太多噪声，且 Reranker 处理更慢
- **调优建议**：通常 10-20。考虑后续 Reranker 会进一步筛选，检索阶段宁可多召回

### 5.6 检索质量的评估指标

#### Recall@K（召回率）
- 在 top-K 结果中，真正相关的文档占所有相关文档的比例
- 例如：总共有 5 个相关文档，top-10 中召回了 4 个 → Recall@10 = 4/5 = 80%
- 越高越好，但 K 越大通常越高

#### MRR（Mean Reciprocal Rank，平均倒数排名）
- 第一个相关文档出现的位置的倒数的平均值
- 例如：第一个相关文档排在第 3 位 → RR = 1/3
- 关注"第一个正确结果出现得多早"

#### NDCG（Normalized Discounted Cumulative Gain）
- 考虑了文档的相关程度（不仅仅是相关/不相关）和位置
- 排名靠前的文档权重更高
- 最全面的排序质量指标

---

## 六、重排（Reranking）

### 6.1 什么是重排？

重排（Reranking）是在初步检索之后，对候选文档进行**更精细的相关度排序**的过程。检索阶段为了速度，使用的是较粗糙的匹配方法（如 ANN），重排阶段则使用更强大但更慢的模型来精确评估每个候选文档与查询的相关度。

### 6.2 为什么检索之后还需要重排？

核心原因：**检索和重排解决的是两个不同层次的问题**。

| 维度 | 检索（Retrieval） | 重排（Reranking） |
|------|-------------------|-------------------|
| 目标 | 从百万文档中快速筛出 top-K 候选 | 对 top-K 候选做精细排序 |
| 速度 | 必须快（毫秒级） | 可以慢一些（百毫秒级） |
| 模型 | 双塔模型（Bi-Encoder） | 交叉编码器（Cross-Encoder） |
| 精度 | 较粗 | 很精细 |
| 处理量 | 全部文档 | 只处理 top-K（通常 10-20）|

### 6.3 双塔模型 vs 交叉编码器

#### 双塔模型（Bi-Encoder）——用于检索阶段

```
Query:    "叶片裂纹修复" → Encoder_Q → [0.12, -0.34, ...] ─┐
                                                              ├→ 余弦相似度
Document: "裂纹修补方案" → Encoder_D → [0.11, -0.33, ...] ─┘
```

- Query 和 Document 分别独立编码
- 文档向量可以**离线预计算**并存入向量数据库
- 查询时只需编码 Query 一次，然后做向量检索
- 速度快，但精度有限（Q 和 D 之间没有交互）

#### 交叉编码器（Cross-Encoder）——用于重排阶段

```
[CLS] 叶片裂纹修复 [SEP] 裂纹修补方案 [SEP] → Transformer → 相关度分数: 0.92
```

- Query 和 Document **拼接在一起**输入 Transformer
- Q 和 D 的每个 token 之间都有注意力交互
- 精度更高，但**不能预计算**——每对 (Q, D) 都要实时计算
- 速度慢，只能处理少量候选（top-K 之后的几十个）

### 6.4 BGE-Reranker-V2-M3 模型

项目使用的重排模型是 **BAAI/bge-reranker-v2-m3**。

```python
# rag_service.py 中的初始化
cls._reranker = FlagEmbeddingReranker(
    model="BAAI/bge-reranker-v2-m3",
    top_n=cls.RERANK_TOP_N,  # 5
    use_fp16=use_fp16,        # Apple Silicon 或 CUDA 时用半精度
)
```

**特点**：
- 与 BGE-M3 Embedding 模型配套，效果最优
- 多语言支持（Multi-Lingual），适合中文场景
- 轻量级 Cross-Encoder，推理速度合理

**半精度检测**：
```python
use_fp16 = torch.cuda.is_available() or (
    torch.backends.mps.is_available()  # Apple Silicon (M1/M2/M3)
    if hasattr(torch.backends, "mps") else False
)
```

### 6.5 top_n 参数

- **含义**：重排后保留的文档数量
- **项目值**：`RERANK_TOP_N = 5`
- 从检索的 top_k=10 个候选中，Reranker 重新打分后只保留 top_n=5 个
- **为什么不全保留？** 减少 Prompt 中的上下文量，聚焦最相关的内容

### 6.6 score_threshold 参数

- **含义**：重排后的最低分数阈值，低于此分数的文档会被丢弃
- **项目值**：`SOURCE_THRESHOLD = -6.0`
- BGE-Reranker 的分数范围通常在 [-10, +10] 之间
- `-6.0` 是一个比较宽松的阈值，只过滤掉明显不相关的文档

```python
# rag_service.py 中的阈值过滤
context_nodes = [
    n for n in nodes if n.score is None or n.score > cls.SOURCE_THRESHOLD
]
```

### 6.7 项目中重排的完整流程

```python
# 1. 检索阶段：top_k=10 个候选
retriever = cls._index.as_retriever(
    similarity_top_k=cls.RETRIEVAL_TOP_K,  # 10
    vector_store_query_mode="hybrid"
)
nodes = await retriever.aretrieve(augmented_question)

# 2. 重排阶段：Cross-Encoder 精排，保留 top_n=5
if cls._reranker and nodes:
    query_bundle = QueryBundle(query_str=augmented_question)
    nodes = await asyncio.to_thread(
        cls._reranker.postprocess_nodes,
        nodes,
        query_bundle,
    )

# 3. 分数阈值过滤
context_nodes = [
    n for n in nodes if n.score is None or n.score > cls.SOURCE_THRESHOLD
]

# 4. 安全过滤（Prompt Injection 检测）
safe_nodes = []
for node in context_nodes:
    node_text = getattr(node, "text", "") or ""
    node_safe, node_score = check_context_node(node_text)
    if node_safe:
        safe_nodes.append(node)
context_nodes = safe_nodes
```

**注意**：`asyncio.to_thread` 将 Reranker 推理放到线程池执行，避免阻塞事件循环。因为 Reranker 是 CPU/GPU 密集型计算，不是异步 IO 操作。

---

## 七、Query Rewriting（查询重写）

### 7.1 什么是查询重写？

查询重写是在检索之前，对用户的原始查询进行改写或增强的过程，目的是提高检索的召回率和准确率。

### 7.2 为什么需要查询重写？

用户的查询往往存在以下问题：
1. **过于简短**："叶片裂纹" → 缺乏上下文
2. **口语化**："风机叶片上那个裂开的怎么修" → 检索效果差
3. **多轮对话中的指代**："这个怎么处理？" → "这个"指什么？
4. **多意图**："叶片裂纹的原因和修复方法" → 可能需要拆分成两个查询

### 7.3 项目中的查询增强实现

项目实现了基于图像上下文的查询增强（`build_augmented_query`）：

```python
# rag_service.py
def build_augmented_query(question: str, image_context: dict | None) -> str:
    """将图像检测结果拼接到查询中，增强检索语义。"""
    if not image_context or not isinstance(image_context, dict):
        return question

    objects = image_context.get("objects") or []
    if not objects:
        return question

    seen: set[str] = set()
    parts: list[str] = []
    for obj in objects:
        cls_name = obj.get("class", "")
        if not cls_name or cls_name in seen:
            continue
        seen.add(cls_name)
        zh = DEFECT_LABEL_ZH.get(cls_name, "")
        parts.append(f"{cls_name}({zh})" if zh else cls_name)
    if not parts:
        return question
    return f"{question} 缺陷类型:{', '.join(parts)}"
```

**实际效果**：
- 原始查询："这个缺陷怎么修？"
- YOLO 检测结果：`[{"class": "craze", "confidence": 0.95}]`
- 增强后查询："这个缺陷怎么修？ 缺陷类型:craze(裂纹)"

增强后的查询包含了具体的缺陷类型名称（中英文），检索时能匹配到更精确的文档。

**缺陷标签中英文映射表**：
```python
DEFECT_LABEL_ZH: dict[str, str] = {
    "corrosion": "腐蚀",
    "craze": "裂纹",
    "hide_craze": "隐裂",
    "surface_attach": "表面附着物",
    "surface_corrosion": "表面腐蚀",
    "surface_eye": "表面气孔",
    "surface_injure": "表面损伤",
    "surface_oil": "表面油污",
    "thunderstrike": "雷击",
}
```

---

## 八、Route Decision（路由决策）

### 8.1 什么是路由决策？

路由决策是 RAG 系统中的一个关键环节：**判断当前查询是否应该使用检索到的知识库内容来回答**。不是所有问题都适合用 RAG 回答——比如用户说"你好"，知识库里肯定没有相关文档，强行用 RAG 反而会降低回答质量。

### 8.2 项目中的路由决策逻辑

```python
# rag_service.py
use_rag = (
    len(context_nodes) >= settings.RAG_ROUTE_MIN_CONTEXT_NODES  # >= 1 个有效节点
    and top_score is not None
    and top_score >= settings.RAG_ROUTE_MIN_TOP_SCORE            # 最高分 >= -2.0
)
route = "rag" if (use_rag or has_image) else "fallback"
```

**两个判断条件**：

1. **最少节点数**（`RAG_ROUTE_MIN_CONTEXT_NODES = 1`）：至少要有 1 个通过阈值过滤的上下文节点。如果检索 + 重排 + 过滤后一个节点都没有，说明知识库中没有相关内容。

2. **最高分数阈值**（`RAG_ROUTE_MIN_TOP_SCORE = -2.0`）：重排后的最高分要 >= -2.0。如果最相关的文档分数都很低，说明知识库中的内容与问题关联度不够。

3. **图片例外**：如果有图片上下文（YOLO 检测结果），强制走 RAG 路由——因为图像检测结果需要结合知识库来解释。

### 8.3 降级策略

当路由决策为 `fallback` 时，系统采用不同的 System Prompt：

**RAG 路由的 System Prompt**：
```
你是一个专业的风电运维专家助手。
请严格基于检索到的【上下文】来回答用户的问题，不要编造。
如果上下文中没有相关信息，请直接说不知道。
```

**Fallback 路由的 System Prompt**：
```
你是一个专业的风电运维技术助手。
当前知识库中未找到与用户问题直接相关的文档。
请根据你的通用知识尽可能回答，
但要诚实说明这不是来自专业文档的答案。
```

**设计思想**：
- RAG 路由：要求 LLM **严格基于上下文**回答，不编造
- Fallback 路由：允许 LLM 用通用知识回答，但**诚实告知**不是来自专业文档
- 这样既保证了有文档时的准确性，又不会在无文档时完全无法回答

---

## 九、Prompt 工程

### 9.1 系统提示词的设计

项目的 Prompt 工程采用**结构化消息**（ChatMessage）而非自由文本拼接：

```python
# rag_service.py — _build_messages 方法
def _build_messages(cls, question, context_nodes, route, chat_window, image_context):
    messages: list[ChatMessage] = []

    # 1. System prompt（根据路由不同）
    messages.append(ChatMessage(role=MessageRole.SYSTEM, content=system_text))

    # 2. 图片检测上下文（作为额外 system 消息）
    if image_context:
        messages.append(ChatMessage(role=MessageRole.SYSTEM, content=image_msg))

    # 3. RAG 检索上下文（作为额外 system 消息）
    if route == "rag" and context_nodes:
        messages.append(ChatMessage(role=MessageRole.SYSTEM, content=rag_msg))

    # 4. 历史对话（结构化 user/assistant turns）
    if chat_window:
        for msg in chat_window:
            role = MessageRole.USER if msg.get("role") == "user" else MessageRole.ASSISTANT
            content = msg.get("content", "")
            if role == MessageRole.ASSISTANT:
                content = sanitize_assistant_history(content)
            messages.append(ChatMessage(role=role, content=content))

    # 5. 当前用户问题
    messages.append(ChatMessage(role=MessageRole.USER, content=question))

    return messages
```

**System Prompt 的关键设计**：

```python
# RAG 路由的完整 System Prompt
system_text = (
    "你是一个专业的风电运维专家助手。\n"
    "请严格基于检索到的【上下文】来回答用户的问题，不要编造。\n"
    "如果上下文中没有相关信息，请直接说不知道。\n"
    "回答请使用中文。不要用英文回答。\n\n"
    "【硬约束】\n"
    "- 直接回答用户当前问题，不要改写成新的提问。\n"
    "- 不要虚构用户身份、岗位、背景或案例。\n"
    '- 不要输出"我的问题是...""用户的问题是..."。\n'
    '- 不要输出"助手回答:""您的回答非常准确"等评审或转述语句。'
)
```

**【硬约束】的作用**：防止 LLM 的常见不良行为——
- 自问自答（生成假的用户问题）
- 虚构用户身份（"作为一名资深风电工程师..."）
- 评审式回答（"您的问题提得很好！"）
- 角色转换（生成"助手回答:"这样的标签）

### 9.2 上下文注入方式

检索到的文档以额外的 System 消息注入，而不是拼在 User 消息中：

```python
# 检索上下文注入
if route == "rag" and context_nodes:
    context_text = "\n\n".join(n.text[:800] for n in context_nodes[:5])
    rag_msg = (
        "以下是仅供回答当前问题使用的检索上下文。"
        "必须优先依据这些内容作答；如果上下文不足，明确说明不足，不要编造。\n\n"
        f"{context_text}"
    )
    messages.append(ChatMessage(role=MessageRole.SYSTEM, content=rag_msg))
```

**设计考量**：
- 每个 chunk 最多取 800 字符（`n.text[:800]`），防止单个 chunk 过长
- 最多取 5 个 chunk（`context_nodes[:5]`），控制总上下文长度
- 作为 System 消息注入，让 LLM 将其视为"知识来源"而非"对话内容"

### 9.3 对话历史的管理（Session Memory）

项目实现了基于数据库的会话记忆：

```python
# chat.py — 获取会话窗口
if settings.RAG_SESSION_MEMORY_ENABLED:  # 默认开启
    history = await chat_crud.get_recent_chat_windows(
        db=db,
        user_id=current_user.id,
        task_id=task_id,
        turns=settings.RAG_SESSION_WINDOW_TURNS,  # 4 轮
        before_message_id=user_message.id,
    )
```

**关键配置**：
- `RAG_SESSION_MEMORY_ENABLED = True`：默认开启会话记忆
- `RAG_SESSION_WINDOW_TURNS = 4`：保留最近 4 轮对话

**历史消息清洗**——`sanitize_assistant_history`：

```python
def sanitize_assistant_history(content: str) -> str:
    """清洗 assistant 历史内容中的污染模式。"""
    text = content
    # 第一步：在最早的截断标记处截断（移除模型自问自答部分）
    for marker in _TRUNCATION_MARKERS:
        pos = text.lower().find(marker.lower())
        if pos != -1 and pos < earliest_cut:
            earliest_cut = pos
    # 第二步：正则清洗行首噪音
    for pat in _ASSISTANT_NOISE_PATTERNS:
        text = pat.sub("", text)
    return text.strip()
```

**截断标记**包括：
- `\nuser:` / `\n用户:` — 模型自问自答生成的伪造用户消息
- `\nassistant:` — 伪造的助手标签
- `\nThinking Process:` — 泄漏的思考过程

**为什么要清洗？** 如果把污染的历史消息原样回灌给模型，会"放大"污染效应——模型看到之前生成的伪造对话，会更倾向于继续生成类似的污染内容。

### 9.4 项目中的 Prompt 模板总结

| 消息角色 | 内容 | 说明 |
|----------|------|------|
| SYSTEM | 角色定义 + 硬约束 | 根据 RAG/Fallback 路由不同 |
| SYSTEM | 图像检测上下文 | 可选：有缺陷检测结果时注入 |
| SYSTEM | RAG 检索上下文 | 可选：RAG 路由时注入 top-5 chunk |
| USER | 历史用户消息 1 | 仅在问题存在明显指代/省略时回灌 |
| ASSISTANT | 历史助手回复 1 | 经过 sanitize 清洗，仅在需要多轮改写时回灌 |
| ... | ... | ... |
| USER | 当前用户问题 | 最后一条消息 |

---

## 十、流式输出（Streaming）

### 10.1 HTTP 流式输出与 SSE 对比

当前项目**不是标准 SSE**。  
真实实现是：

- 后端：`StreamingResponse(..., media_type="text/plain")`
- 前端：`fetch + ReadableStream + TextDecoder`

之所以还要理解 SSE，是因为它和当前实现属于同一类“单向流式返回”问题域，面试时经常会被拿来比较。

**与 WebSocket 的区别**：
- 当前实现和 SSE 都是**单向**流式返回，WebSocket 是双向
- 当前实现和 SSE 都基于 HTTP，WebSocket 需要协议升级
- SSE 有标准事件格式（`text/event-stream`），当前实现没有，返回的是 `text/plain` chunk
- 对于本项目这种“POST 问题 + 可选图片 + 单向返回”的场景，`fetch + ReadableStream` 更贴当前需求

**HTTP 响应头**：
```python
# chat.py
return StreamingResponse(
    event_generator(),
    media_type="text/plain",
    headers={
        "Cache-Control": "no-cache",       # 禁止缓存
        "X-Accel-Buffering": "no",         # 禁止 Nginx 缓冲
        "Connection": "keep-alive",         # 保持连接
    },
)
```

### 10.2 为什么 RAG 场景需要流式输出？

1. **减少首字延迟（TTFB）**：LLM 生成一个完整回答可能需要 5-15 秒，流式输出让用户在 1-2 秒内就能看到第一个字
2. **用户体验**：逐字显示比等待全部生成后一次性显示体验好得多
3. **早期中断**：如果用户看到开头就知道答案不对，可以提前取消
4. **资源利用**：不需要在服务端缓存完整回答再发送

### 10.3 项目中的流式实现

#### 后端流式生成

```python
# rag_service.py — _stream_chat 方法
@classmethod
async def _stream_chat(
    cls, messages: list[ChatMessage], t0: float
) -> AsyncGenerator[str, None]:
    """使用 astream_chat 进行结构化对话生成。"""
    first_token = True
    last_content_len = 0
    thinking_started = False
    thinking_ended = False

    response_gen = await LlamaSettings.llm.astream_chat(messages)
    async for chunk in response_gen:
        # 处理 reasoning_content（思考内容）
        thinking_delta = chunk.additional_kwargs.get("thinking_delta", "")
        if thinking_delta and not thinking_ended:
            if not thinking_started:
                thinking_started = True
                yield "<think>"
            yield thinking_delta
            continue
        elif thinking_started and not thinking_ended:
            thinking_ended = True
            yield "</think>"

        # 正常内容输出
        token = getattr(chunk, "delta", None) or ""
        if not token:
            msg = getattr(chunk, "message", None)
            if msg:
                current = getattr(msg, "content", "") or ""
                if len(current) > last_content_len:
                    token = current[last_content_len:]
                    last_content_len = len(current)

        if not token:
            continue
        if first_token:
            ttfb_ms = (time.perf_counter() - t0) * 1000
            logger.info("rag stage=ttfb ms=%.1f mode=chat", ttfb_ms)
            first_token = False
        yield token
```

**设计亮点**：
- **TTFB 监控**：记录首个 token 的延迟（`ttfb_ms`），用于性能监控
- **Think 标记处理**：支持推理模型的思考过程（`<think>...</think>`），用特殊标记包裹
- **增量内容提取**：当 `delta` 不可用时，通过 `last_content_len` 差值提取增量

#### 前端流式消费

```python
# chat.py — event_generator
async def event_generator():
    full_response = ""
    parser = ThinkStreamParser()
    result_meta: dict = {}
    _stream_stopped = False

    async for raw_token in RagService.generate_chat_stream(...):
        if await request.is_disconnected():
            logger.info("客户端已断开连接，停止生成")
            break

        parsed = parser.feed(raw_token)
        if parsed:
            full_response += parsed
            yield parsed
        await asyncio.sleep(0)  # 让出事件循环
```

**ThinkStreamParser** 的作用：
- 将 `<think>` 标签转换为 `<<<THINK_START>>>` 前端标记
- 将 `</think>` 标签转换为 `<<<THINK_END>>>` 前端标记
- 前端可以据此折叠显示思考过程

**流式去重**：
```python
# 检测流式重复：某些模型会重复生成相同内容
clean = _strip_markers(full_response)
if len(clean) > _REPEAT_DETECT_PREFIX * 3:
    prefix = clean[:_REPEAT_DETECT_PREFIX]  # 前 30 字符作为特征串
    second_pos = clean.find(prefix, _REPEAT_DETECT_PREFIX)
    if second_pos != -1:
        # 确认是否真的重复
        tail = clean[second_pos:].strip()
        head = clean[:len(tail)].strip()
        if tail == head or head.startswith(tail):
            _stream_stopped = True  # 停止向前端发送
```

#### 引用来源的流式传输

检索到的文档来源信息通过特殊标记附加在流式输出末尾：

```python
# rag_service.py
if sources:
    yield (
        "\n<<<SOURCES>>>"
        + json.dumps(sources, ensure_ascii=False)
        + "<<<SOURCES_END>>>"
    )
```

来源信息格式：
```python
def build_source(context_nodes, source_threshold=-5.0):
    sources = []
    for idx, node in enumerate(context_nodes, start=1):
        source = {
            "id": idx,
            "doc": doc,          # 文档名
            "score": score,      # 相关度分数
            "snippet": snippet,  # 内容摘要（前 100 字符）
        }
        if "page" in metadata:
            source["page"] = metadata["page"]
        sources.append(source)
    return sources
```

---

## 十一、RAG 工程化、评测与治理

### 11.1 离线链路 vs 在线链路

如果你只会说“用户提问 → 检索 → 大模型回答”，说明你还停留在 demo 层，不是工程层。

真正的 RAG 至少分两条链路：

#### 离线链路（Indexing Pipeline）
负责把知识准备好：
- 文档解析
- 清洗
- 切分
- 元数据补全
- embedding
- 建索引
- 状态回写

#### 在线链路（Serving Pipeline）
负责把答案答对、答快、答稳：
- query 预处理
- 安全检查
- 检索
- rerank
- route decision
- prompt 组装
- LLM 生成
- 来源回传

**为什么必须分开？**
- 离线链路偏吞吐与可重建
- 在线链路偏延迟与稳定性
- 两者优化目标完全不同

### 11.2 知识库治理：不是“有向量就够了”

生产级 RAG 真正难的不是 embedding，而是治理。

必须至少考虑这些维度：
- **元数据**：文档名、页码、版本、时间、来源、权限标签
- **版本控制**：文档更新后，旧 chunk 怎么失效
- **去重**：同一文件重复上传怎么办
- **增量更新**：不能每次都全量重建
- **权限过滤**：不能让 A 用户检索到 B 用户文档
- **脏数据控制**：错误 OCR、模板噪音、目录页污染

本项目已经有版本、状态、增量重建、chunk 配置这些很好的工程锚点。下一步在面试里要能讲清：
**向量库不是知识库，知识库 = 向量索引 + 关系型元数据 + 状态管理 + 权限边界。**

### 11.3 检索调优：top_k、top_n、threshold 是联动的

很多人调 RAG 只会改 `top_k`，这是不够的。

常见 3 个旋钮：
- `top_k`：初召回候选数
- `top_n`：rerank 后保留数
- `score_threshold`：低于阈值的结果直接丢弃

调优逻辑：
- **召回不足**：适当提高 `top_k`
- **噪声太多**：提高 threshold 或减少 `top_n`
- **rerank 成本高**：降低 `top_k`，但要观察 recall 是否明显下降
- **上下文过长挤爆 prompt**：减少 `top_n` 或压缩 snippet

这不是独立参数，而是一组联动权衡：
- 召回质量
- 延迟
- token 成本
- 上下文污染风险

### 11.4 RAG 评测：不评估就等于没做工程

很多团队以为“用户觉得还行”就算完成了 RAG，这是很危险的。

至少要从 3 层评估：

#### 检索层
- **Recall@K**：相关文档是否进入候选集
- **MRR**：第一个相关结果出现得够不够靠前
- **nDCG**：相关结果排序是否合理

#### 生成层
- **Faithfulness / 忠实度**：回答是否真的基于上下文
- **Answer Relevancy**：是否真正回答了问题
- **Citation Accuracy**：来源引用是否对得上

#### 端到端层
- 用户满意度
- 首 token 延迟（TTFB）
- 总响应耗时
- 单次问答成本
- fallback 占比

**没有评测集的 RAG，本质上只是“感觉型开发”。**

### 11.5 成本、延迟与降级路径

工程上，RAG 不只是“尽量答对”，还要“别把系统拖死”。

成本主要来自：
- embedding 构建
- rerank 模型
- LLM 上下文 token
- 多路检索与外部 API

延迟主要来自：
- 检索 I/O
- rerank 推理
- prompt 太长
- LLM 首 token 太慢

**典型降级策略：**
- 关闭 rerank，直接用检索 top_k
- 降低 top_k / top_n
- 超时后直接 fallback
- 对低价值问题给短答复而不是长回答
- 对明显域外问题直接拒答，而不是硬答到跑飞

### 11.6 RAG vs 纯向量检索 vs Elasticsearch vs Fine-tuning

这类题是大厂高频，不会对比就很吃亏。

#### RAG vs 纯向量检索

纯向量检索只负责“找”，RAG 是“找 + 组装上下文 + 生成 + 引用”。

如果需求只是文档召回、相似文本检索，可能不需要 LLM；如果需求是面向用户的可读答案，RAG 才完整。

#### RAG vs Elasticsearch / OpenSearch

ES 强在：
- 关键词检索
- 过滤
- 聚合
- 稳定的全文搜索工程能力

RAG/向量检索强在：
- 语义匹配
- 近义表达
- 长文本知识问答

现实里常见的不是二选一，而是：
**ES 做稀疏召回 + 向量检索做稠密召回 + rerank 融合。**

#### RAG vs Fine-tuning

- **RAG**：改知识，不改模型权重
- **Fine-tuning**：改行为模式/风格/能力边界

默认优先级通常是：
1. 先做 prompt 和 RAG
2. 再做评测与治理
3. 证明瓶颈真的在模型行为，再考虑微调

别一上来就谈微调。那通常是错误优化方向。

---

## 十二、面试高频问题

### Q1: 请描述一下 RAG 的完整工作流程

**参考答案**：

RAG 的完整流程分为两个阶段：

**离线阶段（知识库构建）**：
1. 文档解析：使用 Docling/SimpleDirectoryReader 将 PDF、Markdown 等文档转为纯文本
2. 文本切分：使用 SentenceSplitter 按句子边界切分为 chunks（chunk_size=800, overlap=150）
3. 过滤：移除过短的 chunk（< 20 字符）
4. Embedding：用 BGE-M3 将每个 chunk 编码为 1024 维向量
5. 存储：将向量和原文存入 PGVector（PostgreSQL 向量扩展）

**在线阶段（查询回答）**：
1. 安全检测：Prompt Injection 评分检测，不安全直接拒答
2. 查询增强：拼接图像检测上下文等额外信息
3. 混合检索：同时执行稠密向量检索和稀疏关键词检索，RRF 融合，返回 top_k=10 候选
4. 重排：BGE-Reranker-V2-M3 Cross-Encoder 精排，保留 top_n=5
5. 路由决策：根据节点数量和最高分数判断走 RAG 路由还是 Fallback
6. Prompt 构建：将检索上下文、历史对话、用户问题组装为结构化消息
7. LLM 生成：流式输出回答
8. 后处理：去重、Think 标记解析、存储到数据库

### Q2: RAG 和 Fine-tuning 有什么区别？什么时候选哪个？

**参考答案**：

核心区别：RAG 是给模型"开卷考试"（检索外部知识），Fine-tuning 是让模型"闭卷考试"（把知识训练进模型权重）。

选 RAG 的场景：
- 知识频繁更新（如产品文档、FAQ）
- 需要追溯答案来源
- 数据隐私要求高（私有文档不能上传训练）
- 预算有限（不需要 GPU 训练）

选 Fine-tuning 的场景：
- 需要改变模型的行为模式（如输出格式、推理风格）
- 领域有大量标注数据
- 对延迟要求极高（不能多一个检索步骤）

实际项目中我选择了 RAG，因为风电运维文档频繁更新，且需要追溯答案来源让运维人员验证。

### Q3: 什么是混合检索？为什么不只用向量检索？

**参考答案**：

混合检索同时执行稠密向量检索和稀疏关键词检索，然后用 RRF（Reciprocal Rank Fusion）融合结果。

只用向量检索的问题：
- 对精确实体匹配弱：查询"故障代码 E-301"，向量检索可能匹配到其他故障代码
- 稀疏检索（BM25）能精确匹配关键词

只用关键词检索的问题：
- 无法理解语义：查询"叶片裂缝"匹配不到"blade crack"
- 同义词、近义词无法匹配

混合检索取两者之长，在项目中通过 PGVector 的 `hybrid_search=True` 和 `text_search_config="simple"` 实现，用 RRF 算法融合排名。

### Q4: 解释一下 RRF（Reciprocal Rank Fusion）的原理

**参考答案**：

RRF 是一种多路检索结果融合算法。公式：`RRF_score(d) = Σ 1/(k + rank_i(d))`

例如文档 A 在向量检索排第 1，关键词检索排第 5：
```
RRF(A) = 1/(60+1) + 1/(60+5) = 0.0318
```

RRF 的优势：
- 只看排名不看分数，不需要对不同检索方式的分数做归一化
- 常数 k=60 防止排名靠前的文档权重过大
- 简单、鲁棒、效果经过大量验证

### Q5: 为什么检索之后还需要 Reranking？

**参考答案**：

检索阶段用的是 Bi-Encoder（双塔模型），Query 和 Document 分别独立编码然后计算相似度，速度快但精度有限。

Reranking 用的是 Cross-Encoder（交叉编码器），将 Query 和 Document 拼接在一起输入 Transformer，两者的每个 token 之间都有 Attention 交互，精度更高但速度慢。

所以采用"先粗筛后精排"的策略：检索阶段从百万文档中快速筛出 top-10 候选（毫秒级），Reranking 对 10 个候选精细排序保留 top-5（百毫秒级）。

项目中用 BGE-Reranker-V2-M3 做 Reranking，使用 `asyncio.to_thread` 放到线程池执行避免阻塞。

### Q6: chunk_size 和 chunk_overlap 怎么调优？

**参考答案**：

**chunk_size**：
- 太小（如 128）：上下文不完整，知识点被截断
- 太大（如 2048）：语义不聚焦，检索精度下降
- 一般 512-1024。项目用 800，适合技术文档

**chunk_overlap**：
- 防止关键信息在切分边界丢失
- 通常为 chunk_size 的 10%-25%。项目用 150（约 19%）
- 太大导致冗余和向量库膨胀

项目中这些参数可通过 `KnowledgeChunkConfig` 表动态配置，不需要改代码就能调整和对比效果。

### Q7: 什么是 HNSW 索引？为什么用它？

**参考答案**：

HNSW（Hierarchical Navigable Small World）是一种多层图索引结构：
- 构建一个多层图，高层连接稀疏（"高速公路"），底层连接密集（"乡间小路"）
- 查询时从最高层开始，逐层下降，每层找到最近的节点作为下一层的入口
- 时间复杂度 O(log N)，比暴力搜索 O(N) 快几个数量级

为什么用 HNSW 而不是 IVFFlat：
- 查询速度更快
- 精度更高（Recall > 95%）
- 不需要预先训练聚类中心
- PGVector 默认支持 HNSW

### Q8: BGE-M3 Embedding 模型有什么特点？为什么选它？

**参考答案**：

BGE-M3 是北京智源研究院开发的 Embedding 模型，三个 M 代表：
- Multi-Lingual：支持 100+ 语言，中文效果好
- Multi-Functionality：同时支持稠密/稀疏/多向量检索
- Multi-Granularity：支持最长 8192 tokens 输入

选择原因：
- 项目需要处理中文风电运维文档，BGE-M3 的中文能力是关键
- 1024 维向量，精度和效率平衡好
- 支持混合检索（稠密+稀疏），与 PGVector 的 hybrid_search 配合
- 与 BGE-Reranker 配套使用效果最优

### Q9: 项目中如何处理 Prompt Injection 攻击？

**参考答案**：

项目实现了三重防御：

**第一重：用户输入检测**（check_user_input）
- Unicode NFKC 归一化 + 零宽字符剥离（防 Unicode 绕过）
- 评分机制（非布尔值），规则分高中低三级
- score >= 6 阻断，3-5 净化但放行，< 3 放行
- 输入长度校验（> 4096 字符阻断，防稀释攻击）
- 放在 RAG 流程最前面，不安全直接拒答

**第二重：上下文节点检测**（check_context_node）
- 放在 Reranker 之后，Prompt 构建之前
- 使用独立规则集（不含低危格式规则，因为技术文档必然包含 `---`、代码块等）
- score >= 3 剔除节点（阈值比用户输入低，因为知识库不应包含注入指令）

**第三重：输出泄露检测**（check_output_leak）
- 检测 LLM 输出是否泄露 system prompt 或身份被篡改
- 只告警不阻断（误阻断正常回答的代价 > 偶尔泄露的代价）

### Q10: 项目中知识库重建为什么用子进程而不是 BackgroundTasks？

**参考答案**：

BackgroundTasks 在 API 进程内执行，共享内存空间。知识库构建需要加载 Embedding 模型和处理大量文档，可能占用数 GB 内存。如果 BackgroundTask OOM（Out of Memory），整个 API 进程崩溃，所有用户断线。

子进程（后来改为 Arq Worker）有独立内存空间，OOM 只影响子进程/Worker，API 进程安然无恙。

并发控制用 `fcntl.flock` 文件锁——排他锁（LOCK_EX）+ 非阻塞模式（LOCK_NB），如果锁被占用立即报错，防止多个重建任务同时运行。

### Q11: 项目中如何实现增量重建？

**参考答案**：

增量重建只处理 `index_status="pending"` 的文档，而不是重建全部索引。

流程：
1. 查询待索引文档（`index_status="pending"`）
2. 在 PGVector 中删除这些文档的旧 chunks：
   ```sql
   DELETE FROM data_knowledge WHERE metadata_->>'doc_key' = :doc_key
   ```
3. 只加载指定文档，重新切分 + Embedding + 写入
4. 更新 `index_status="indexed"`

关键设计：每个 chunk 的 metadata 中包含 `doc_key` 字段，用于精准定位和删除旧数据。这是在切分阶段通过文件路径的 stem 提取的：
```python
metadata["doc_key"] = Path(file_path).stem
```

### Q12: 向量检索中余弦相似度和欧氏距离有什么区别？

**参考答案**：

- 余弦相似度只关注方向不关注长度，取值 [-1, 1]。两个向量指向同一方向就相似，适合文本语义检索（文本长度不影响结果）
- 欧氏距离关注两点在空间中的直线距离，取值 [0, +inf)。对向量的绝对大小敏感
- 当向量已归一化（长度为 1）时，余弦相似度和欧氏距离等价

项目使用余弦距离（PGVector 默认），因为文本语义检索场景下不关注向量的绝对大小。

### Q13: 如何评估 RAG 系统的质量？

**参考答案**：

可以从三个维度评估：

**检索质量**：
- Recall@K：top-K 中真正相关文档的比例
- MRR：第一个相关文档的排名倒数
- NDCG：考虑文档相关度和位置的综合指标

**生成质量**：
- 忠实度（Faithfulness）：回答是否基于检索到的上下文，有没有编造
- 答案相关性（Answer Relevancy）：回答是否真正回答了用户的问题
- 上下文精准度（Context Precision）：检索到的上下文是否都与问题相关

**端到端质量**：
- 人工评估：领域专家评分
- 用户满意度：用户反馈
- A/B 测试：不同参数配置的效果对比

项目中通过日志记录每次查询的关键指标（路由决策、节点数量、top_score、TTFB 等）来监控系统质量。

### Q14: 什么是向量数据库的"维度灾难"？

**参考答案**：

维度灾难（Curse of Dimensionality）是指在高维空间中，传统的距离度量和索引方法会失效的现象：

1. 在高维空间中，所有数据点之间的距离趋于相等（差异不明显）
2. 传统的树形索引（B-Tree、KD-Tree）在高维空间中退化为暴力搜索
3. 数据在高维空间中变得极度稀疏

这就是为什么需要专用的向量索引（HNSW、IVFFlat）——它们通过图结构或聚类来绕过维度灾难，实现高效的近似搜索。

### Q15: 流式输出中如何处理来源引用？

**参考答案**：

项目使用特殊标记将来源信息附加在流式输出的末尾：

```
[正常回答内容...]
<<<SOURCES>>>[{"id":1,"doc":"blade_manual.pdf","score":0.92,"snippet":"..."}]<<<SOURCES_END>>>
```

前端解析到 `<<<SOURCES>>>` 标记时，提取 JSON 数据并渲染为引用列表。这样来源信息不会干扰正常的流式输出。

### Q16: 项目中的路由决策是如何工作的？

**参考答案**：

路由决策判断是否使用检索到的知识库内容来回答，基于两个条件：
1. 至少有 1 个通过阈值过滤的上下文节点（`RAG_ROUTE_MIN_CONTEXT_NODES = 1`）
2. 重排后的最高分数 >= -2.0（`RAG_ROUTE_MIN_TOP_SCORE = -2.0`）

两个条件都满足 → RAG 路由（基于知识库回答）
任一不满足 → Fallback 路由（用通用知识回答，并诚实告知）

特例：如果有图片上下文（YOLO 检测结果），强制走 RAG 路由。

这种设计避免了两个极端：
- 没有路由决策 → 用户说"你好"时也强行引用不相关文档
- 路由过于严格 → 稍微不确定就不用知识库

### Q17: 为什么 Embedding 用 float16 而不是 float32？

**参考答案**：

float16（半精度浮点）相比 float32（单精度浮点）：
- **显存/内存减半**：模型权重从 32 位降到 16 位
- **推理速度更快**：现代 GPU/Apple Silicon 对 float16 有硬件加速
- **精度损失极小**：对于 Embedding 任务，float16 的精度完全够用

项目代码：`model_kwargs={"dtype": "float16"}`

这是工程实践中的常见优化——在不影响效果的前提下减少资源消耗。

### Q18: 项目如何处理文档版本管理？

**参考答案**：

项目实现了完整的文档版本管理系统：

1. **主表**（`knowledge_documents`）：存储文档基本信息、当前状态（active/deleted）、最新版本号
2. **版本表**（`knowledge_document_versions`）：每次上传创建新版本记录
3. **内容去重**：SHA256 哈希 + 唯一约束（`document_id, content_hash`），同一文档相同内容不会重复入库
4. **版本切换**：上传新版本时先 `mark_old_versions_not_current`，再 `create_version(is_current=True)`
5. **文件存储**：
   - 版本归档：`managed_versions/{doc_key}/v{n}/{filename}`
   - 活跃目录：`knowledge_base/{doc_key}{suffix}`（构建索引时读取）
6. **软删除**：`status="deleted"` 标记，可恢复

### Q19: 什么是 Docling？它解决了什么问题？

**参考答案**：

Docling 是 IBM 开发的文档解析库，专门用于将复杂格式文档（特别是 PDF）转换为结构化文本。

它解决的核心问题：
- 传统 PDF 解析器（PyMuPDF/pdfminer）对复杂 PDF（扫描件、复杂表格、多栏排版）效果差
- Docling 使用深度学习模型进行版面分析和 OCR，能更准确地提取文本结构

项目中的使用策略是**优雅降级**：优先用 DoclingReader 解析 PDF，如果 Docling 未安装则降级到 SimpleDirectoryReader。

### Q20: 如何优化 RAG 系统的效果？

**参考答案**：

可以从以下几个维度优化：

**检索优化**：
- 调整 chunk_size/overlap：项目支持通过 `KnowledgeChunkConfig` 表动态调整
- 使用混合检索而不是单纯向量检索
- 增加 top_k 提高召回率，配合 Reranker 保证精度

**重排优化**：
- 使用 Cross-Encoder Reranker（项目已实现）
- 调整 top_n 和 score_threshold

**Prompt 优化**：
- 结构化消息替代自由文本拼接（项目已实现）
- 硬约束防止 LLM 不良行为
- 限制上下文长度（每个 chunk 最多 800 字符，最多 5 个 chunk）

**查询优化**：
- Query Rewriting：改写用户查询提高检索质量
- 项目实现了基于图像上下文的查询增强

**数据质量**：
- 过滤短文本 chunk（min_chunk_len）
- 元数据管理（metadata_policy: basic vs full）
- 定期清理低质量文档

---

## 附录：项目技术栈一览

| 组件 | 技术选型 | 说明 |
|------|---------|------|
| 后端框架 | FastAPI | 异步 Python Web 框架 |
| LLM 推理 | OpenAI 兼容 API / Ollama（可切换） | 当前默认走 OpenAI 兼容协议 |
| LLM 模型 | qwen/qwen3.5-122b-a10b（当前配置，可切换） | 当前 `.env` 为视觉模型 |
| Embedding | BAAI/bge-m3 (1024 维) | 多语言 Embedding |
| Reranker | BAAI/bge-reranker-v2-m3 | Cross-Encoder 重排 |
| 向量数据库 | PostgreSQL + PGVector | 混合检索（向量 + 全文） |
| 文档解析 | Docling + SimpleDirectoryReader | 优雅降级 |
| 文本切分 | SentenceSplitter | chunk_size=800, overlap=150 |
| RAG 框架 | LlamaIndex | 编排检索 + 生成 |
| 任务队列 | Arq (Redis) | 异步知识库重建 |
| 缓存/锁 | Redis | 分布式锁 + 限流 |
| 安全 | 三重 Prompt Injection 检测 | 评分机制 |
