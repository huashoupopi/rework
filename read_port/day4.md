# Day 4：YOLO 服务接入 + 下载接口

> 目标：将后台推理占位替换为真实 YOLO 推理，补充结果图下载、PDF 报告、批量 ZIP 下载接口
> 预计文件数：3 个新建 + 2 个修改
> 验证工具：Apifox

---

## Step 1：`app/services/yolo_service.py` — YOLO 推理服务

**要求**：
- 类级别单例：`model = None`，首次调用时加载
- `load_model()` 类方法：加载模型 + 空图预热
- `predict(image_path, save_path)` 类方法：推理 + 绘图 + 返回结构化结果

**代码骨架**：

```python
import logging
import numpy as np
import cv2
from ultralytics import YOLO
from app.core.config import settings

logger = logging.getLogger(__name__)

class YOLOService:
    model = None

    @classmethod
    def load_model(cls) -> None:
        if cls.model is not None:
            return
        model_path = settings.YOLO_MODEL_PATH
        logger.info("正在加载 YOLO 模型: %s", model_path)
        cls.model = YOLO(model_path)
        # 空图预热 GPU/CPU
        cls.model(np.zeros((640, 640, 3), dtype=np.uint8), verbose=False)
        logger.info("YOLO 模型加载完毕")

    @classmethod
    def predict(cls, image_path: str, save_path: str) -> dict:
        if cls.model is None:
            cls.load_model()
        results = cls.model.predict(source=image_path, conf=0.25, iou=0.45, save=False, verbose=False)
        result = results[0]
        # 绘制结果图
        plotted = result.plot(line_width=2, font_size=1.0)
        cv2.imwrite(save_path, plotted)
        # 结构化数据
        detect_data = {"total": len(result.boxes), "objects": []}
        for box in result.boxes:
            cls_id = int(box.cls[0])
            detect_data["objects"].append({
                "class": result.names[cls_id],
                "confidence": round(float(box.conf[0]), 4),
                "box": [round(x, 1) for x in box.xywh[0].tolist()],
            })
        return detect_data
```

**你需要回答自己的问题**：

1. **为什么用 `classmethod` 而不是 `staticmethod`？**
   - `classmethod` 的第一个参数是 `cls`（类本身），可以访问类属性 `cls.model`
   - `staticmethod` 没有 `cls`，无法访问类属性——那就无法实现单例
   - **面试话术**："YOLO 模型加载一次后复用，用 classmethod 实现类级别单例，避免每次请求重复加载 300MB+ 的模型权重。"

2. **为什么要空图预热？**
   - 第一次推理时，框架会做 JIT 编译、CUDA 初始化等耗时操作
   - 空图预热把这个开销提前到启动阶段，避免第一个用户请求特别慢
   - `np.zeros((640, 640, 3))` 是 640×640 的黑图，推理结果无意义但能触发初始化
   - **面试点**：这叫 Warmup / Cold Start 问题。生产系统常用预热来降低首次请求延迟

3. **`conf=0.25` 和 `iou=0.45` 是什么？**
   - `conf`：置信度阈值——低于 0.25 的检测框丢弃（减少误检）
   - `iou`：NMS（非极大值抑制）的 IoU 阈值——重叠超过 0.45 的框只保留置信度最高的（减少重复框）
   - **追问**：这两个参数调高/调低分别有什么影响？（conf 调高 → 漏检增多、误检减少；iou 调高 → 重复框增多、但小目标不容易被抑制）

4. **`result.plot()` 做了什么？为什么不自己画框？**
   - Ultralytics 内置的绘图方法，自动在原图上画 bbox + 类别名 + 置信度
   - 自己画也行（用 cv2.rectangle），但没必要——Ultralytics 的实现已经很好了
   - `line_width=2` 控制框粗细，`font_size=1.0` 控制标注文字大小

5. **结构化数据里的 `box` 为什么用 `xywh` 格式？**
   - `xywh` = 中心点 x, 中心点 y, 宽度, 高度——YOLO 原生输出格式
   - 另一种常见格式是 `xyxy` = 左上角 x, 左上角 y, 右下角 x, 右下角 y
   - 前端绘制 Canvas 时两种都能用，`xywh` 更紧凑
   - **追问**：这些坐标是像素值还是归一化值？（Ultralytics 的 `box.xywh` 默认是像素值）

---

## Step 2：更新后台推理函数

**改 `app/routers/tasks.py` 中的 `background_detect_task`**：

把 Day 3 的占位代码替换为真实推理：

```python
async def background_detect_task(task_id: int, file_path: str, result_path: str) -> None:
    async with AsyncSessionLocal() as db:
        try:
            task = await db.get(Task, task_id)
            if not task:
                return
            # 真实推理（同步阻塞，考虑 to_thread）
            detect_result = await asyncio.to_thread(
                YOLOService.predict, file_path, result_path
            )
            task.status = "completed"
            task.detect_result = detect_result
            await db.commit()
            logger.info("任务完成 task_id=%s total=%s", task_id, detect_result["total"])
        except Exception:
            logger.exception("后台检测任务失败 task_id=%s", task_id)
            async with AsyncSessionLocal() as err_db:
                t = await err_db.get(Task, task_id)
                if t:
                    t.status = "failed"
                    await err_db.commit()
```

**你需要回答自己的问题**：

1. **为什么用 `asyncio.to_thread`？**
   - YOLO 推理是 **CPU/GPU 密集型**同步操作
   - 直接在 async 函数里调用会**阻塞整个事件循环**，导致所有其他请求 hang 住
   - `asyncio.to_thread` 把同步函数丢到线程池执行，事件循环不被阻塞
   - **面试必答**："CPU 密集型任务不能在事件循环中同步执行，否则会阻塞所有并发请求。用 `to_thread` 或独立 Worker 进程解决。"

2. **`to_thread` 和 `run_in_executor` 的区别？**
   - `to_thread` 是 Python 3.9+ 的语法糖，底层用的就是 `run_in_executor(None, func, *args)`
   - `run_in_executor` 可以传自定义 executor（如 ProcessPoolExecutor），`to_thread` 只能用默认线程池
   - 你的场景用 `to_thread` 够了

3. **YOLO 推理用线程池还是进程池？**
   - 线程池：简单、共享内存、但受 GIL 限制（Python 级别只有一个线程在执行 Python 代码）
   - 进程池：突破 GIL、完全并行、但进程间通信开销大
   - YOLO 推理大部分计算在 C++ 层（OpenCV/PyTorch），**GIL 会被释放**，所以线程池就够用
   - **面试加分**：如果纯 Python 计算（如大规模数据处理），就该用 ProcessPoolExecutor

---

## Step 3：`app/routers/tasks.py` — 补充下载接口

在 Day 3 已有的 tasks 路由基础上新增 3 个下载接口：

```python
# GET  /tasks/{task_id}/download/image — 下载结果图
# GET  /tasks/{task_id}/report — 下载 PDF 报告
# GET  /tasks/batch/download?task_ids=1&task_ids=2 — 批量 ZIP 下载
```

**结果图下载**：
```python
from fastapi.responses import FileResponse

@router.get("/tasks/{task_id}/download/image")
async def download_result_image(
    task_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    task = await db.get(Task, task_id)
    if not task:
        raise HTTPException(404, "任务不存在")
    if not current_user.is_superuser and task.user_id != current_user.id:
        raise HTTPException(403, "无权访问")
    if not task.result_path or not Path(task.result_path).exists():
        raise HTTPException(404, "结果图不存在")
    return FileResponse(task.result_path, filename=f"result_{task.file_name}")
```

**你需要回答自己的问题**：

1. **`FileResponse` 和 `StreamingResponse` 的区别？什么时候用哪个？**
   - `FileResponse`：直接返回磁盘文件，FastAPI 自动处理 Content-Type、Content-Length
   - `StreamingResponse`：返回一个可迭代对象（generator），适合大文件或动态生成的内容
   - 小文件（图片、PDF）用 `FileResponse`；大文件或流式数据用 `StreamingResponse`
   - **追问**：FileResponse 是一次性把文件读入内存吗？（不是，底层用分块读取 + sendfile 系统调用）

2. **为什么要检查 `task.user_id != current_user.id`？**
   - 这是**数据级权限控制**：普通用户只能下载自己的任务结果
   - 管理员可以下载所有人的（`is_superuser` 跳过检查）
   - 如果不做这个检查，用户 A 知道任务 ID 就能下载用户 B 的结果——**IDOR 漏洞**（Insecure Direct Object Reference）
   - **面试安全点**：IDOR 是 OWASP Top 10 之一

3. **批量下载用 ZIP 怎么实现？**
   - 核心：`zipfile.ZipFile` 写入 `io.BytesIO` 内存缓冲区
   - 或用 `StreamingResponse` + `zipfile` 流式写入（避免大量文件时内存爆掉）
   - `task_ids` 参数用 `Query` 接收列表：`task_ids: list[int] = Query(...)`
   - **追问**：`Query(...)` 的 `...` 是什么？（`Ellipsis`，表示必填参数；不传则 FastAPI 返回 422 校验错误）

---

## Step 4：`app/services/report_service.py` — PDF 报告生成（可选）

> 如果时间紧张可以跳过此 Step，后面再补。报告功能是加分项不是必需。

**要求**：
- 用 `reportlab` 生成 PDF
- 包含：基本信息表格 + 原图/结果图 + 缺陷详情表
- 返回 `io.BytesIO` 内存对象（不写磁盘）

**安装**：
```bash
uv add reportlab
```

**你需要回答自己的问题**：

1. **为什么返回 `BytesIO` 而不是写入磁盘？**
   - PDF 是临时产物，不需要持久化存储
   - 内存生成 → 直接返回给客户端 → GC 自动回收
   - 如果写磁盘还要处理清理逻辑，增加复杂度

2. **reportlab 的替代方案有哪些？**
   - `weasyprint`：HTML → PDF，样式灵活但依赖重
   - `fpdf2`：轻量级，API 简单
   - `reportlab`：功能最全，中文支持需要额外字体文件
   - **追问**：中文 PDF 乱码怎么解决？（注册中文字体文件，如 `SimSun.ttf`，或用 Google Noto Sans CJK）

---

## Step 5：更新 `app/main.py` — lifespan 中加载 YOLO

```python
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    setup_logging()
    logger.info("Starting up...")
    await init_models()
    # 新增：加载 YOLO 模型
    YOLOService.load_model()
    yield
    logger.info("Shutting down...")
    await engine.dispose()
```

**你需要回答自己的问题**：

1. **为什么在 lifespan 里加载模型而不是在第一次请求时？**
   - lifespan 在应用启动时执行一次，所有请求共享同一个模型实例
   - 如果在第一次请求时加载：第一个用户要等 10-30 秒（模型加载时间），体验极差
   - 而且多个并发请求可能同时触发加载，造成竞态条件
   - **面试话术**："重资源在 lifespan 预加载，避免首次请求冷启动延迟。"

2. **模型加载失败怎么办？应该让应用启动失败吗？**
   - 取决于业务需求：如果 YOLO 是核心功能，加载失败就应该 crash（fail fast）
   - 如果 YOLO 是可选功能（比如还有 RAG 问答），可以 catch 异常、记录日志、继续启动
   - 你的项目两种功能都重要，建议 try/except + 日志告警，不阻止启动

---

## 安装依赖

```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/backend
uv add ultralytics opencv-python-headless
# 如果要做 PDF 报告
uv add reportlab
```

> 注意：用 `opencv-python-headless` 而不是 `opencv-python`，后者会拉 GUI 依赖（Qt），服务器不需要。

---

## Day 4 验收清单

```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/backend

# 1. ruff 无报错
uv run ruff check app/

# 2. 格式化无差异
uv run ruff format --check app/

# 3. Apifox 验证：
#    - 上传图片 → 后台推理 → status 变为 completed → detect_result 有数据
#    - 下载结果图 → 能看到标注框
#    - （可选）下载 PDF 报告
#    - （可选）批量 ZIP 下载

# 4. 检查 YOLO 模型文件存在
ls -la best.pt
```

---

## 文件写作顺序

```
1. app/services/yolo_service.py       ← 新建
2. app/routers/tasks.py               ← 改（替换占位 + 加下载接口）
3. app/services/report_service.py     ← 新建（可选，时间紧可跳过）
4. app/main.py                        ← 改（lifespan 加 YOLO 加载）
5. Apifox 验证
```

---

## 面试话术（90 秒）

> YOLO 推理服务用类级别单例模式实现，模型在 lifespan 预加载避免冷启动。
> 推理是 CPU/GPU 密集型操作，用 `asyncio.to_thread` 放入线程池执行，不阻塞事件循环。
> 为什么线程池就够了？因为 YOLO 底层计算在 C++ 层，GIL 会被释放，线程间能真正并行。
> 上传后立即返回 processing 状态，后台独立 Session 执行推理并更新状态。
> 下载接口做了 IDOR 防护——普通用户只能下载自己的任务结果，防止越权访问。
