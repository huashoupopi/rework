import logging

from app.core.request_context import get_request_id

_REQUEST_ID_FACTORY_INSTALLED = False


def _install_request_id_record_factory() -> None:
    global _REQUEST_ID_FACTORY_INSTALLED
    if _REQUEST_ID_FACTORY_INSTALLED:
        return

    old_factory = logging.getLogRecordFactory()

    def record_factory(*args, **kwargs):
        record = old_factory(*args, **kwargs)
        if not hasattr(record, "request_id"):
            record.request_id = get_request_id()
        return record

    logging.setLogRecordFactory(record_factory)
    _REQUEST_ID_FACTORY_INSTALLED = True


def setup_logging() -> None:
    """
    常用参数：
    - level:
    - format:
    - handlers=[...]:
    - force=True  # 强制覆盖已有配置，适合在库中调用 服务器慎重使用
    五个级别：
    - debug: 详细信息，调试时使用
    - info: 一般信息，正常运行时使用
    - warning: 警告信息，可能会导致问题时使用
    - error: 错误信息，发生错误时使用
    - critical: 严重错误，导致程序无法继续运行时使用
    异常记录：
    - logger.exception("message")  只能在except块中使用，会自动带traceback
    - logger.error("message", exc_info=True)  等价代替
    推荐写法：
    - 用占位符： logger.info("User %s logged in", username)  只有在日志级别允许时才会格式化字符串，性能更好
    - 不要用logger.info(f"User {username} logged in")  这种会无论日志级别如何都格式化字符串，性能较差
    常见时间格式：
    - %(asctime)s: 时间
    - %(name)s: logger名称
    - %(levelname)s: 日志级别
    - %(message)s: 日志消息
    - %(lineno)d: 行号
    生产默认info 排障临时开debug 问题解决后记得关掉debug级别日志
    """
    _install_request_id_record_factory()

    formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - request_id=%(request_id)s - %(message)s"
    )

    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    if not root_logger.handlers:
        root_logger.addHandler(logging.StreamHandler())

    for handler in root_logger.handlers:
        handler.setFormatter(formatter)
