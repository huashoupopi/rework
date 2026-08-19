"""把既有 detect_result 序列化成固定字段的 JSON/CSV，不重跑检测。"""

from __future__ import annotations

import csv
import io
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.models.task import Task

EXPORT_FIELDS = (
    "task_id",
    "image_name",
    "defect_class",
    "confidence",
    "bbox_x1",
    "bbox_y1",
    "bbox_x2",
    "bbox_y2",
    "detected_at",
)


def detections_from_task(task: Task) -> list[dict[str, Any]]:
    payload = task.detect_result or {}
    objects = payload.get("objects") or []
    detected_at = task.created_at.isoformat() if task.created_at else ""
    rows: list[dict[str, Any]] = []
    for obj in objects:
        box = list(obj.get("box") or [])
        box = box + [None] * (4 - len(box))
        try:
            confidence = round(float(obj.get("confidence") or 0), 4)
        except (TypeError, ValueError):
            confidence = 0.0
        rows.append(
            {
                "task_id": task.id,
                "image_name": task.file_name,
                "defect_class": obj.get("class"),
                "confidence": confidence,
                "bbox_x1": box[0],
                "bbox_y1": box[1],
                "bbox_x2": box[2],
                "bbox_y2": box[3],
                "detected_at": detected_at,
            }
        )
    return rows


def export_json_body(task: Task) -> dict[str, Any]:
    return {"task_id": task.id, "detections": detections_from_task(task)}


def export_csv_text(task: Task) -> str:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=list(EXPORT_FIELDS))
    writer.writeheader()
    writer.writerows(detections_from_task(task))
    return buf.getvalue()
