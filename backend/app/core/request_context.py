import logging
import time
import uuid
from contextvars import ContextVar, Token

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

_REQUEST_ID_CTX: ContextVar[str] = ContextVar("request_id", default="-")

"""
你这个项目里 request_id 是怎么从 FastAPI 深层的 service 代码里被日志拿到的？
"请求进来时，RequestContextMiddleware 从请求头读或者 uuid4() 生成一个 request_id，通过 ContextVar
  塞进当前协程的上下文。asyncio 会让这个 ContextVar 的值自动跟着协程链路传递——任何深层代码都能通过 get_request_id()
   拿到同一个值。
setup_logging 在启动时通过 setLogRecordFactory 装了一个钩子，每造一条 LogRecord 时，自动调 get_request_id()
  把当前值贴到 record 上。然后 Formatter 里的 %(request_id)s 就能把它打出来。
"""


def get_request_id() -> str:
    return _REQUEST_ID_CTX.get()


def set_request_id(request_id: str) -> Token[str]:
    return _REQUEST_ID_CTX.set(request_id)


def reset_request_id(token: Token[str]) -> None:
    _REQUEST_ID_CTX.reset(token)


def new_request_id() -> str:
    return uuid.uuid4().hex


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.logger = logging.getLogger("app.request")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        request_id = headers.get("X-Request-ID") or new_request_id()
        scope.setdefault("state", {})
        scope["state"]["request_id"] = request_id

        token = set_request_id(request_id)
        start = time.perf_counter()
        response_started_at: float | None = None
        status_code: int | None = None
        saw_streaming_body = False

        method = scope.get("method", "UNKNOWN")
        path = scope.get("path", "")
        client = scope.get("client")
        client_ip = client[0] if client else "unknown"

        self.logger.info(
            "http event=start method=%s path=%s client_ip=%s",
            method,
            path,
            client_ip,
        )

        async def send_wrapper(message: Message) -> None:
            nonlocal response_started_at, saw_streaming_body, status_code

            if message["type"] == "http.response.start":
                status_code = message["status"]
                response_started_at = time.perf_counter()
                mutable_headers = MutableHeaders(scope=message)
                mutable_headers["X-Request-ID"] = request_id
            elif message["type"] == "http.response.body" and message.get("more_body", False):
                saw_streaming_body = True

            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            total_ms = (time.perf_counter() - start) * 1000
            self.logger.exception(
                "http event=error method=%s path=%s total_ms=%.1f",
                method,
                path,
                total_ms,
            )
            raise
        finally:
            total_ms = (time.perf_counter() - start) * 1000
            response_start_ms = (
                (response_started_at - start) * 1000
                if response_started_at is not None
                else total_ms
            )
            self.logger.info(
                "http event=done method=%s path=%s status_code=%s streaming=%s "
                "response_start_ms=%.1f total_ms=%.1f",
                method,
                path,
                status_code if status_code is not None else "n/a",
                saw_streaming_body,
                response_start_ms,
                total_ms,
            )
            reset_request_id(token)
