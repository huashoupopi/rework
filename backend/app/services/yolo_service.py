import logging
from pathlib import Path

import cv2
import numpy as np
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
        model_file = Path(model_path)
        if not model_file.exists():
            logger.error("YOLO 模型文件不存在: %s", model_path)
            raise FileNotFoundError(f"YOLO 模型文件不存在: {model_path}")
        logger.info("加载 YOLO 模型，路径: %s", model_path)
        try:
            cls.model = YOLO(model_path)
            cls.model(np.zeros((640, 640, 3), dtype=np.uint8), verbose=False)  # 预热模型
            logger.info("YOLO 模型加载完成")
        except Exception as e:
            logger.exception("加载 YOLO 模型失败: %s", str(e))
            raise RuntimeError(f"加载 YOLO 模型失败: {str(e)}") from e

    @classmethod
    def predict(cls, image_path: str, save_path: str) -> dict:
        if cls.model is None:
            cls.load_model()
        try:
            results = cls.model(source=image_path, conf=0.25, iou=0.45, save=False, verbose=False)  # type: ignore
            result = results[0]
            plotted = result.plot(line_width=2, font_size=1.0)
            cv2.imwrite(save_path, plotted)
            detect_data = {"total": len(result.boxes), "objects": []}
            for box in result.boxes:
                cls_id = int(box.cls[0])
                detect_data["objects"].append(
                    {
                        "class": result.names[cls_id],
                        "confidence": round(float(box.conf[0]), 4),
                        "box": [round(x, 1) for x in box.xyxy[0].tolist()],
                    }
                )
        except Exception as e:
            logger.exception("YOLO 预测失败: %s", str(e))
            raise RuntimeError(f"YOLO 预测失败: {str(e)}") from e
        return detect_data
