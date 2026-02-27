import logging
import shutil
import uuid
from pathlib import Path

from fastapi import File, UploadFile

logger = logging.getLogger(__name__)
UPLOAD_DIR = Path("static/uploads")
RESULT_DIR = Path("static/results")


class FileService:
    @staticmethod
    async def save_file(file: UploadFile = File()) -> tuple[str, str | None, str]:
        task_uuid = str(uuid.uuid4())
        file_name = file.filename
        file_extension = Path(str(file_name)).suffix
        save_name = f"{task_uuid}{file_extension}"
        save_path = UPLOAD_DIR / save_name
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        with open(save_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
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
            logger.exception(f"Error deleting files for task {uuid_str}: {e}")
