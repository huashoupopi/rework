import asyncio
import io
import logging
import uuid
import zipfile
from pathlib import Path

from fastapi import HTTPException, UploadFile

from app.models.task import Task
from app.services.image_guard import prepare_image_bytes

logger = logging.getLogger(__name__)
UPLOAD_DIR = Path("static/uploads")
RESULT_DIR = Path("static/results")


class FileService:
    @staticmethod
    async def save_file(file: UploadFile) -> tuple[str, str | None, str]:
        task_uuid = str(uuid.uuid4())
        file_name = file.filename
        if not file_name:
            raise HTTPException(status_code=400, detail="文件名不能为空")
        content = await file.read()
        prepared = await asyncio.to_thread(prepare_image_bytes, content, file_name)
        save_name = f"{task_uuid}{prepared.suffix}"
        save_path = UPLOAD_DIR / save_name

        def _write() -> None:
            UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
            save_path.write_bytes(prepared.content)

        await asyncio.to_thread(_write)
        return task_uuid, file_name, str(save_path)

    @staticmethod
    def get_result_path(task_uuid: str, original_filename: str) -> str:
        file_extension = Path(str(original_filename)).suffix
        result_name = f"{task_uuid}_result{file_extension}"
        result_path = RESULT_DIR / result_name
        RESULT_DIR.mkdir(parents=True, exist_ok=True)
        return str(result_path)

    @staticmethod
    def delete_file(uuid_str: str, filename: str) -> None:
        try:
            file_extension = Path(str(filename)).suffix
            save_name = f"{uuid_str}{file_extension}"
            save_path = UPLOAD_DIR / save_name
            if save_path.exists():
                save_path.unlink()
            result_name = f"{uuid_str}_result{file_extension}"
            result_path = RESULT_DIR / result_name
            if result_path.exists():
                result_path.unlink()
        except Exception as e:
            logger.exception("Error deleting files for task %s: %s", uuid_str, e)

    @staticmethod
    def create_zip_for_tasks(tasks: list[Task]) -> io.BytesIO:
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
            for task in tasks:
                if task.result_path and Path(task.result_path).exists():
                    arcname = f"{task.id}_{task.file_name}"
                    zip_file.write(task.result_path, arcname=arcname)
        zip_buffer.seek(0)
        return zip_buffer
