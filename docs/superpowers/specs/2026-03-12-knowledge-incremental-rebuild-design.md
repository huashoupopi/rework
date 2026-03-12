# 知识库增量重建与删除功能设计

**日期**: 2026-03-12
**状态**: 已批准
**目标**: 将 Day 7 的全量重建改造为支持增量重建和部分删除

---

## 背景

当前 Day 7 实现的是全量重建方案：
- 每次调用 `POST /knowledge/rebuild` 都会重新处理所有文档
- 对于 2 个 PDF（~4MB），全量重建耗时约 5 分钟
- 随着文档数量增加，全量重建时间会线性增长

**问题**：
- 上传单个新文档后，需要等待 5 分钟才能查询到
- 无法删除单个文档的索引
- 修改分块参数后，必须全量重建

---

## 设计目标

1. **增量重建**：只处理新增或变更的文档，耗时从 5 分钟降至 3 秒
2. **部分删除**：支持删除指定文档的索引
3. **保留全量重建**：作为兜底方案，应对分块参数调整等场景
4. **接口清晰**：管理员可以明确选择全量或增量

---

## 架构设计

### 1. 数据库模型扩展

#### KnowledgeDocument 表新增字段

```python
class KnowledgeDocument(Base):
    __tablename__ = "knowledge_documents"

    id: int
    doc_key: str              # 文档唯一标识（规范化文件名）
    title: str
    status: str               # "active" | "deleted"
    latest_version: int
    created_at: datetime
    updated_at: datetime

    # === 新增字段 ===
    indexed_at: datetime | None         # 最后一次成功索引的时间
    index_status: str                   # "pending" | "indexed" | "failed"
    error_message: str | None           # 索引失败时的错误信息（最多 500 字符）
    last_build_attempt_at: datetime | None  # 最后一次尝试构建的时间（用于检测超时任务）
```

**字段说明**：
- `indexed_at`: 记录文档最后一次被索引的时间，用于判断是否需要重新索引
- `index_status`:
  - `"pending"`: 文档已上传但未索引，或索引已过期
  - `"indexed"`: 文档已成功索引
  - `"failed"`: 索引失败（embedding 错误、文件损坏等）
- `error_message`: 索引失败时记录错误原因，方便调试（最多 500 字符）
- `last_build_attempt_at`: 记录最后一次尝试构建的时间，用于检测超时任务（如超过 30 分钟仍为 pending 则视为失败）

#### KnowledgeDocumentVersion 表（无变化）

```python
class KnowledgeDocumentVersion(Base):
    __tablename__ = "knowledge_document_versions"

    id: int
    document_id: int          # FK → KnowledgeDocument.id
    version: int
    content_hash: str         # SHA256
    suffix: str               # ".pdf" | ".md"
    file_size: int
    file_path: str            # managed_versions/{doc_key}/v{N}/xxx.pdf
    created_at: datetime
```

#### KnowledgeChunkConfig 表（无变化）

```python
class KnowledgeChunkConfig(Base):
    __tablename__ = "knowledge_chunk_configs"

    id: int
    name: str                 # "default" | "technical" | "qa"
    chunk_size: int
    chunk_overlap: int
    chunk_min_len: int
    is_active: bool
    created_at: datetime
```

---

### 2. API 接口设计

#### 2.1 全量重建

```
POST /knowledge/rebuild/full
```

**功能**：
- 清空 pgvector 表中的所有数据
- 将所有文档的 `index_status` 设置为 `"pending"`, `indexed_at` 设置为 `NULL`
- 启动子进程执行 `build_knowledge.py --mode=full`
- 重新处理 `knowledge_base/` 目录下的所有文档

**响应**：
```json
{
  "status": "started",
  "mode": "full",
  "message": "全量重建已启动，预计耗时 5-10 分钟"
}
```

**使用场景**：
- 修改了全局分块参数（`CHUNK_SIZE`, `CHUNK_OVERLAP`）
- pgvector 索引损坏或数据不一致
- 首次初始化知识库

---

#### 2.2 增量重建

```
POST /knowledge/rebuild/incremental
```

**功能**：
- 查询 `index_status = "pending"` 或 `indexed_at IS NULL` 的文档
- 启动子进程执行 `build_knowledge.py --mode=incremental --doc-keys=doc1,doc2,...`
- 只处理指定的文档：
  1. 从 pgvector 删除这些文档的旧 chunks（如果存在）
  2. 重新分块、embedding、写入 pgvector
  3. 更新 `indexed_at = now()`, `index_status = "indexed"`

**响应**：
```json
{
  "status": "started",
  "mode": "incremental",
  "doc_keys": ["manual_wind", "manual"],
  "message": "增量重建已启动，预计耗时 3-10 秒"
}
```

**使用场景**：
- 上传了新文档
- 修改了某个文档的内容（新版本）
- 上次索引失败，需要重试

---

#### 2.3 删除文档索引

```
DELETE /knowledge/documents/{doc_key}
```

**功能**：
- 从 pgvector 删除 `metadata->>'doc_key' = ?` 的所有 chunks
- 更新数据库：
  - `index_status = "pending"`
  - `indexed_at = NULL`
  - 如果 `physical_delete=true`，则标记 `status = "deleted"` 并删除物理文件

**请求参数**：
```json
{
  "physical_delete": false  // 是否物理删除文件（默认 false，只删除索引）
}
```

**响应**：
```json
{
  "status": "success",
  "doc_key": "manual_wind",
  "chunks_deleted": 42,
  "physical_delete": false
}
```

**使用场景**：
- 文档内容过时，需要从知识库移除
- 误上传了错误的文档
- 测试时清理数据

---

#### 2.4 查询索引状态

```
GET /knowledge/status
```

**功能**：
- 返回所有文档的索引状态统计

**响应**：
```json
{
  "total_documents": 10,
  "indexed": 8,
  "pending": 1,
  "failed": 1,
  "documents": [
    {
      "doc_key": "manual_wind",
      "title": "风电运维手册",
      "index_status": "indexed",
      "indexed_at": "2026-03-12T10:30:00Z",
      "latest_version": 2
    },
    {
      "doc_key": "manual",
      "title": "通用手册",
      "index_status": "pending",
      "indexed_at": null,
      "latest_version": 1
    }
  ]
}
```

---

### 3. build_knowledge.py 实现逻辑

#### 命令行参数

```bash
python build_knowledge.py --mode=full
python build_knowledge.py --mode=incremental --doc-keys=doc1,doc2
```

#### 核心流程

```python
import argparse
import fcntl
import logging
from datetime import datetime
from pathlib import Path
from llama_index.core import VectorStoreIndex, SimpleDirectoryReader
from llama_index.vector_stores.postgres import PGVectorStore
from sqlalchemy import text
from app.core.config import settings
from app.core.database import SessionLocal, engine
from app.models.knowledge import KnowledgeDocument

logger = logging.getLogger(__name__)

# 文件锁路径
LOCK_FILE = Path(settings.BASE_DIR).parent / ".rebuild.lock"

def acquire_lock():
    """获取文件锁，如果已被占用则抛出异常"""
    lock_fd = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return lock_fd
    except BlockingIOError:
        raise RuntimeError("另一个重建任务正在运行")

def release_lock(lock_fd):
    """释放文件锁"""
    fcntl.flock(lock_fd, fcntl.LOCK_UN)
    lock_fd.close()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["full", "incremental"], required=True)
    parser.add_argument("--doc-keys", type=str, help="逗号分隔的 doc_key 列表（仅 incremental 模式）")
    args = parser.parse_args()

    # 获取文件锁
    try:
        lock_fd = acquire_lock()
    except RuntimeError as e:
        logger.error(str(e))
        return 1

    try:
        # 初始化 vector store
        vector_store = PGVectorStore.from_params(
            database=settings.DB_NAME,
            host=settings.DB_HOST,
            port=str(settings.DB_PORT),
            password=settings.DB_PASSWORD,
            user=settings.DB_USER,
            table_name=settings.DB_TABLE,
            embed_dim=1024,
            hybrid_search=True,
        )

        if args.mode == "full":
            # 全量重建：清空 pgvector
            vector_store.clear()
            # 加载所有文档
            documents = load_all_documents()
        else:
            # 增量重建：只加载指定文档
            doc_keys = args.doc_keys.split(",") if args.doc_keys else []
            if not doc_keys:
                logger.error("增量模式需要指定 --doc-keys")
                return 1

            # 删除旧 chunks（使用原始 SQL）
            with engine.connect() as conn:
                for doc_key in doc_keys:
                    result = conn.execute(
                        text(f"DELETE FROM {settings.DB_TABLE} WHERE metadata->>'doc_key' = :doc_key"),
                        {"doc_key": doc_key}
                    )
                    logger.info(f"删除文档 {doc_key} 的旧 chunks: {result.rowcount} 条")
                conn.commit()

            # 加载指定文档
            documents = load_documents_by_keys(doc_keys)

        # 分块 + Embedding + 写入
        try:
            index = VectorStoreIndex.from_documents(documents, vector_store=vector_store)
            logger.info(f"索引构建成功：{len(documents)} 个文档")
        except Exception as e:
            logger.exception(f"索引构建失败: {e}")
            # 标记失败的文档
            db = SessionLocal()
            try:
                for doc in documents:
                    doc_key = doc.metadata.get("doc_key")
                    db_doc = db.query(KnowledgeDocument).filter_by(doc_key=doc_key).first()
                    if db_doc:
                        db_doc.index_status = "failed"
                        db_doc.error_message = str(e)[:500]  # 截断错误信息
                        db_doc.last_build_attempt_at = datetime.utcnow()
                db.commit()
            finally:
                db.close()
            return 1

        # 更新数据库状态
        db = SessionLocal()
        try:
            for doc in documents:
                doc_key = doc.metadata.get("doc_key")
                db_doc = db.query(KnowledgeDocument).filter_by(doc_key=doc_key).first()
                if db_doc:
                    db_doc.indexed_at = datetime.utcnow()
                    db_doc.index_status = "indexed"
                    db_doc.error_message = None  # 清除旧的错误信息
                    db_doc.last_build_attempt_at = datetime.utcnow()
            db.commit()
        finally:
            db.close()

        logger.info(f"索引构建完成：{len(documents)} 个文档")
        return 0
    finally:
        release_lock(lock_fd)

def load_all_documents():
    """加载 knowledge_base/ 下所有文档"""
    reader = SimpleDirectoryReader(settings.KNOWLEDGE_DIR)
    docs = reader.load_data()
    # 为每个 doc 添加 doc_key metadata
    for doc in docs:
        file_path = Path(doc.metadata.get("file_path", ""))
        doc.metadata["doc_key"] = file_path.stem
    return docs

def load_documents_by_keys(doc_keys: list[str]):
    """只加载指定的文档"""
    docs = []
    for doc_key in doc_keys:
        # 从 knowledge_base/{doc_key}.* 加载
        file_path = find_file_by_doc_key(doc_key)
        if file_path:
            reader = SimpleDirectoryReader(input_files=[str(file_path)])
            doc = reader.load_data()[0]
            doc.metadata["doc_key"] = doc_key
            docs.append(doc)
    return docs

def find_file_by_doc_key(doc_key: str) -> Path | None:
    """根据 doc_key 查找文件"""
    knowledge_dir = Path(settings.KNOWLEDGE_DIR)
    for suffix in [".pdf", ".md", ".markdown"]:
        file_path = knowledge_dir / f"{doc_key}{suffix}"
        if file_path.exists():
            return file_path
    return None
```

---

### 4. 服务层实现

#### knowledge_service.py

```python
import subprocess
from pathlib import Path
from datetime import datetime
from sqlalchemy.orm import Session
from app.models.knowledge import KnowledgeDocument
from app.core.config import settings

class KnowledgeService:
    @staticmethod
    def trigger_full_rebuild(db: Session) -> dict:
        """触发全量重建"""
        # 检查是否有任务正在运行
        if is_rebuild_running():
            return {
                "status": "conflict",
                "message": "另一个重建任务正在运行，请稍后再试"
            }

        # 重置所有文档状态
        db.query(KnowledgeDocument).update({
            "index_status": "pending",
            "indexed_at": None
        })
        db.commit()

        # 启动子进程
        script_path = Path(settings.BASE_DIR).parent / "build_knowledge.py"
        subprocess.Popen([
            "python", str(script_path),
            "--mode=full"
        ])

        return {
            "status": "started",
            "mode": "full",
            "message": "全量重建已启动"
        }

    @staticmethod
    def trigger_incremental_rebuild(db: Session) -> dict:
        """触发增量重建"""
        # 检查是否有任务正在运行
        if is_rebuild_running():
            return {
                "status": "conflict",
                "message": "另一个重建任务正在运行，请稍后再试"
            }

        # 查询待索引的文档
        pending_docs = db.query(KnowledgeDocument).filter(
            (KnowledgeDocument.index_status == "pending") |
            (KnowledgeDocument.indexed_at == None)
        ).all()

        if not pending_docs:
            return {
                "status": "skipped",
                "message": "没有待索引的文档"
            }

        doc_keys = [doc.doc_key for doc in pending_docs]

        # 启动子进程
        script_path = Path(settings.BASE_DIR).parent / "build_knowledge.py"
        subprocess.Popen([
            "python", str(script_path),
            "--mode=incremental",
            f"--doc-keys={','.join(doc_keys)}"
        ])

        return {
            "status": "started",
            "mode": "incremental",
            "doc_keys": doc_keys,
            "message": f"增量重建已启动，共 {len(doc_keys)} 个文档"
        }

def is_rebuild_running() -> bool:
    """检查是否有重建任务正在运行（通过检查锁文件）"""
    lock_file = Path(settings.BASE_DIR).parent / ".rebuild.lock"
    if not lock_file.exists():
        return False

    try:
        with open(lock_file, "r") as f:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(f, fcntl.LOCK_UN)
            return False
    except BlockingIOError:
        return True

    @staticmethod
    def delete_document_index(db: Session, doc_key: str, physical_delete: bool = False) -> dict:
        """删除文档索引"""
        doc = db.query(KnowledgeDocument).filter_by(doc_key=doc_key).first()
        if not doc:
            raise ValueError(f"文档不存在: {doc_key}")

        # 从 pgvector 删除 chunks（使用原始 SQL）
        from app.core.database import engine
        from sqlalchemy import text
        with engine.connect() as conn:
            result = conn.execute(
                text(f"DELETE FROM {settings.DB_TABLE} WHERE metadata->>'doc_key' = :doc_key"),
                {"doc_key": doc_key}
            )
            chunks_deleted = result.rowcount
            conn.commit()

        # 更新数据库状态
        doc.index_status = "pending"
        doc.indexed_at = None

        if physical_delete:
            # 标记为已删除
            doc.status = "deleted"
            # 物理删除文件
            knowledge_file = Path(settings.KNOWLEDGE_DIR) / f"{doc_key}.pdf"
            if knowledge_file.exists():
                knowledge_file.unlink()
            # 也可以删除 .md 文件
            for suffix in [".md", ".markdown"]:
                md_file = Path(settings.KNOWLEDGE_DIR) / f"{doc_key}{suffix}"
                if md_file.exists():
                    md_file.unlink()

        db.commit()

        return {
            "status": "success",
            "doc_key": doc_key,
            "chunks_deleted": chunks_deleted,
            "physical_delete": physical_delete
        }
```

---

### 5. 路由层实现

#### routers/knowledge.py

```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.core.database import get_db
from app.services.knowledge_service import KnowledgeService

router = APIRouter(prefix="/knowledge", tags=["knowledge"])

@router.post("/rebuild/full")
def rebuild_full(db: Session = Depends(get_db)):
    """全量重建索引"""
    result = KnowledgeService.trigger_full_rebuild(db)
    return result

@router.post("/rebuild/incremental")
def rebuild_incremental(db: Session = Depends(get_db)):
    """增量重建索引"""
    result = KnowledgeService.trigger_incremental_rebuild(db)
    return result

@router.delete("/documents/{doc_key}")
def delete_document(
    doc_key: str,
    physical_delete: bool = False,
    db: Session = Depends(get_db)
):
    """删除文档索引"""
    try:
        result = KnowledgeService.delete_document_index(db, doc_key, physical_delete)
        return result
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

@router.get("/status")
def get_status(db: Session = Depends(get_db)):
    """查询索引状态"""
    from app.models.knowledge import KnowledgeDocument
    from app.services.knowledge_service import is_rebuild_running

    docs = db.query(KnowledgeDocument).all()

    stats = {
        "total_documents": len(docs),
        "indexed": sum(1 for d in docs if d.index_status == "indexed"),
        "pending": sum(1 for d in docs if d.index_status == "pending"),
        "failed": sum(1 for d in docs if d.index_status == "failed"),
        "rebuild_running": is_rebuild_running(),  # 是否有重建任务正在运行
        "documents": [
            {
                "doc_key": d.doc_key,
                "title": d.title,
                "index_status": d.index_status,
                "indexed_at": d.indexed_at.isoformat() if d.indexed_at else None,
                "latest_version": d.latest_version,
                "error_message": d.error_message if d.index_status == "failed" else None,
                "last_build_attempt_at": d.last_build_attempt_at.isoformat() if d.last_build_attempt_at else None
            }
            for d in docs
        ]
    }

    return stats
```

---

## 数据流

### 上传新文档流程

```
1. POST /knowledge/upload
   ↓
2. 计算 SHA256，检查去重
   ↓
3. 保存到 knowledge_base/{doc_key}.pdf
   ↓
4. 创建 KnowledgeDocument（index_status="pending", indexed_at=NULL）
   ↓
5. 创建 KnowledgeDocumentVersion
   ↓
6. 返回上传成功
   ↓
7. 管理员调用 POST /knowledge/rebuild/incremental
   ↓
8. 子进程处理该文档 → index_status="indexed"
```

**注意**：`POST /knowledge/upload` 接口需要修改，确保新上传的文档初始状态为：
- `index_status="pending"`
- `indexed_at=NULL`
- `last_build_attempt_at=NULL`

**上传接口修改示例**：
```python
# 在 knowledge_service.py 的上传逻辑中
new_doc = KnowledgeDocument(
    doc_key=doc_key,
    title=title,
    status="active",
    latest_version=1,
    index_status="pending",  # 新增
    indexed_at=None,         # 新增
    last_build_attempt_at=None  # 新增
)
db.add(new_doc)
```

### 删除文档流程

```
1. DELETE /knowledge/documents/{doc_key}
   ↓
2. 从 pgvector 删除所有 chunks
   ↓
3. 更新 index_status="pending", indexed_at=NULL
   ↓
4. 可选：标记 status="deleted" 或物理删除文件
```

---

## 错误处理

### 索引失败

- 如果 `build_knowledge.py` 执行失败（文件损坏、embedding 超时等）
- 将文档标记为 `index_status="failed"`, `error_message` 记录错误原因
- 管理员可以通过 `GET /knowledge/status` 查看失败的文档和错误信息
- 修复问题后，再次调用增量重建

### 并发控制

**实现方式**：使用文件锁防止多个重建任务同时执行

**文件锁实现**（在 `build_knowledge.py` 中）：

```python
import fcntl
from pathlib import Path

LOCK_FILE = Path(settings.BASE_DIR).parent / ".rebuild.lock"

def acquire_lock():
    """获取文件锁，如果已被占用则抛出异常"""
    lock_fd = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return lock_fd
    except BlockingIOError:
        raise RuntimeError("另一个重建任务正在运行")

def release_lock(lock_fd):
    """释放文件锁"""
    fcntl.flock(lock_fd, fcntl.LOCK_UN)
    lock_fd.close()

# main() 中使用
lock_fd = acquire_lock()
try:
    # ... 执行重建逻辑
finally:
    release_lock(lock_fd)
```

**API 层检测**（在 `knowledge_service.py` 中）：

```python
def is_rebuild_running() -> bool:
    """检查是否有重建任务正在运行"""
    lock_file = Path(settings.BASE_DIR).parent / ".rebuild.lock"
    if not lock_file.exists():
        return False

    try:
        with open(lock_file, "r") as f:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(f, fcntl.LOCK_UN)
            return False
    except BlockingIOError:
        return True
```

**API 响应**：
- 如果检测到锁文件被占用，返回 `409 Conflict`
- 响应示例：
  ```json
  {
    "status": "conflict",
    "message": "另一个重建任务正在运行，请稍后再试"
  }
  ```

**超时处理**：
- 如果 `build_knowledge.py` 进程崩溃，锁文件会自动释放（进程退出时 OS 自动释放 flock）
- 如果进程被 kill -9 强制杀死，锁文件也会自动释放
- 无需手动清理僵尸锁

**超时任务检测**：
- 通过 `last_build_attempt_at` 字段检测超时任务
- 如果文档的 `index_status="pending"` 且 `last_build_attempt_at` 超过 30 分钟，视为构建失败
- 可以通过定时任务或管理接口将这些文档标记为 `"failed"`

### 数据一致性

- 如果 pgvector 和数据库状态不一致（如手动删除了 chunks）
- 使用全量重建恢复一致性

---

## 性能预估

| 场景 | 文档数量 | 耗时 |
|------|---------|------|
| 全量重建 | 2 个 PDF（4MB） | ~5 分钟 |
| 全量重建 | 10 个 PDF（20MB） | ~25 分钟 |
| 增量重建 | 1 个新 PDF（2MB） | ~3 秒 |
| 增量重建 | 5 个新 PDF（10MB） | ~15 秒 |
| 删除索引 | 1 个文档（42 chunks） | <1 秒 |

**说明**：
- 全量重建时间与文档数量和大小成正比
- 增量重建只处理变化的文档，性能提升 100 倍
- 删除索引只需执行一条 SQL，几乎瞬时完成

---

## 未来优化

1. **后台任务队列**：使用 Celery 或 arq 管理重建任务，支持进度查询
2. **Webhook 通知**：重建完成后通知前端
3. **分块配置版本化**：记录每个 chunk 使用的分块参数，支持局部重建
4. **增量更新优化**：使用 chunk hash 实现更精细的增量控制

---

## 总结

本设计通过以下方式实现增量重建和部分删除：

1. **数据库扩展**：新增 `indexed_at` 和 `index_status` 字段追踪索引状态
2. **接口分离**：提供 `/rebuild/full` 和 `/rebuild/incremental` 两个独立接口
3. **文档级增量**：只处理变化的文档，性能提升 100 倍（5 分钟 → 3 秒）
4. **保留全量重建**：应对分块参数调整等特殊场景
5. **清晰的错误处理**：失败文档可单独重试，不影响其他文档

该方案在实现成本和性能收益之间取得了良好平衡，适合中小规模知识库（< 1000 文档）。
