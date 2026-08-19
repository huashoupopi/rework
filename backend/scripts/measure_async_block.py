"""F4/F5 事件循环阻塞实测。

尺子（前后必须同一把）：
- loop-lag：async 协程每 50ms sleep 一次，记录实际间隔。若同步代码卡住循环，
  会出现远大于 50ms 的空洞。这是「async 里藏同步」的直接证据。
- health：子进程起 uvicorn，从 t=0 起轮询 GET /health。量的是对外可响应时间。

用法（在 backend/ 下）：
  UV_FROZEN=1 uv run python scripts/measure_async_block.py --phase before
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import socket
import subprocess
import sys
import http.client
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

INTERVAL_S = 0.05
PING_TIMEOUT_S = 0.2


def _now() -> str:
    return datetime.now(UTC).strftime("%Y%m%d_%H%M%S")


def _summarize_lags(samples: list[float], wall_s: float) -> dict:
    if not samples:
        return {"n": 0, "wall_s": round(wall_s, 3)}
    ordered = sorted(samples)
    p50 = ordered[len(ordered) // 2]
    p95 = ordered[int(len(ordered) * 0.95)]
    stall = max(0.0, max(samples) - INTERVAL_S)
    expected = max(1, int(wall_s / INTERVAL_S))
    return {
        "n": len(samples),
        "expected_ticks": expected,
        "tick_ratio": round(len(samples) / expected, 3),
        "max_interval_s": round(max(samples), 4),
        "p50_interval_s": round(p50, 4),
        "p95_interval_s": round(p95, 4),
        "max_stall_s": round(stall, 4),
        "wall_s": round(wall_s, 3),
    }


async def _lag_sampler(stop: asyncio.Event, samples: list[float]) -> None:
    while not stop.is_set():
        t0 = time.perf_counter()
        try:
            await asyncio.wait_for(asyncio.sleep(INTERVAL_S), timeout=PING_TIMEOUT_S + 120)
        except asyncio.CancelledError:
            return
        samples.append(time.perf_counter() - t0)


async def measure_f4_loop() -> dict:
    """当前进程里跑 RagService.initialize，同时打 loop-lag。"""
    from app.services.rag_service import RagService

    RagService._initialized = False
    RagService._index = None
    RagService._reranker = None

    samples: list[float] = []
    stop = asyncio.Event()
    ping = asyncio.create_task(_lag_sampler(stop, samples))
    await asyncio.sleep(0.25)
    baseline = _summarize_lags(list(samples), 0.25)
    samples.clear()

    t0 = time.perf_counter()
    await RagService.initialize()
    wall = time.perf_counter() - t0

    await asyncio.sleep(0.15)
    stop.set()
    ping.cancel()
    with contextlib_suppress():
        await ping

    return {
        "target": "f4_initialize",
        "baseline": baseline,
        "during": _summarize_lags(samples, wall),
        "initialized": RagService._initialized,
    }


def contextlib_suppress():
    class _C:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return True

    return _C()


async def measure_f5_loop() -> dict:
    """Pillow 重编码 + save_file 写盘，同时打 loop-lag。"""
    from fastapi import UploadFile
    from PIL import Image
    from starlette.datastructures import Headers

    from app.services.file_service import FileService, UPLOAD_DIR
    from app.services.image_guard import prepare_image_bytes

    # 纯色 PNG 会被压到几十 KB，重编码 ~50ms，和 50ms ping 分不清。
    # 用接近上限的噪点 JPEG：体积真实、Pillow 重编码够重。
    width, height = 2400, 2400
    img = Image.frombytes("RGB", (width, height), os.urandom(width * height * 3))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    raw = buf.getvalue()
    if len(raw) > 10 * 1024 * 1024:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        raw = buf.getvalue()

    async def _run(label: str, work):
        samples: list[float] = []
        stop = asyncio.Event()
        ping = asyncio.create_task(_lag_sampler(stop, samples))
        await asyncio.sleep(0.2)
        samples.clear()
        t0 = time.perf_counter()
        result = work() if not asyncio.iscoroutinefunction(work) else await work()
        wall = time.perf_counter() - t0
        await asyncio.sleep(0.1)
        stop.set()
        ping.cancel()
        with contextlib_suppress():
            await ping
        return label, _summarize_lags(samples, wall), result

    _, pillow_stats, prepared = await _run(
        "pillow", lambda: prepare_image_bytes(raw, "measure.jpg")
    )

    upload = UploadFile(
        file=io.BytesIO(raw),
        filename="measure.jpg",
        headers=Headers({"content-type": "image/jpeg"}),
    )

    async def _save():
        return await FileService.save_file(upload)

    _, save_stats, saved = await _run("save_file", _save)
    _task_uuid, _name, save_path = saved
    try:
        Path(save_path).unlink(missing_ok=True)
    except OSError:
        pass

    async def _burst():
        paths = []
        for i in range(3):
            item = UploadFile(
                file=io.BytesIO(raw),
                filename=f"measure-{i}.jpg",
                headers=Headers({"content-type": "image/jpeg"}),
            )
            saved_item = await FileService.save_file(item)
            paths.append(saved_item[2])
        return paths

    _, burst_stats, burst_paths = await _run("burst3", _burst)
    for path in burst_paths:
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            pass

    return {
        "target": "f5_upload",
        "image_bytes": len(raw),
        "encoded_bytes": len(prepared.content),
        "pillow": pillow_stats,
        "save_file": save_stats,
        "burst3_save_file": burst_stats,
        "upload_dir": str(UPLOAD_DIR),
    }


def _pick_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def measure_f4_health(timeout_s: float = 180.0) -> dict:
    """子进程 uvicorn + 从 t=0 轮询 /health。

    stdout 必须落文件：PIPE 会把 uvicorn 日志写满缓冲区，反过来卡死事件循环，尺子失效。
    """
    port = _pick_port()
    url = f"http://127.0.0.1:{port}/health"
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["NO_PROXY"] = "127.0.0.1,localhost"
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        env.pop(key, None)
    # 父进程轮询也必须绕开代理，否则会打到代理而不是本机 uvicorn。
    os.environ["NO_PROXY"] = "127.0.0.1,localhost"
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        os.environ.pop(key, None)
    log_file = tempfile.NamedTemporaryFile(
        prefix=f"uvicorn_health_{port}_",
        suffix=".log",
        delete=False,
        mode="w",
        encoding="utf-8",
    )
    log_path = Path(log_file.name)
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "info",
        ],
        cwd=str(Path(__file__).resolve().parents[1]),
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        text=True,
    )
    t0 = time.perf_counter()
    refused = 0
    timed_out = 0
    errors = 0
    first_200_s: float | None = None
    first_200_body: str | None = None
    latencies: list[float] = []
    deadline = t0 + timeout_s
    try:
        while time.perf_counter() < deadline:
            req_t0 = time.perf_counter()
            conn: http.client.HTTPConnection | None = None
            try:
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=1.5)
                conn.request("GET", "/health")
                resp = conn.getresponse()
                body = resp.read().decode("utf-8")
                dt = time.perf_counter() - req_t0
                if resp.status == 200:
                    if first_200_s is None:
                        first_200_s = time.perf_counter() - t0
                        first_200_body = body
                    latencies.append(dt)
                    if len(latencies) >= 8:
                        break
            except TimeoutError:
                timed_out += 1
            except ConnectionRefusedError:
                refused += 1
            except OSError as exc:
                if "timed out" in str(exc).lower():
                    timed_out += 1
                elif getattr(exc, "errno", None) in {61, 111}:  # ECONNREFUSED
                    refused += 1
                else:
                    errors += 1
            except Exception:
                errors += 1
            finally:
                if conn is not None:
                    conn.close()
            time.sleep(0.05)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        log_file.close()

    log_tail = ""
    try:
        log_tail = log_path.read_text(encoding="utf-8")[-4000:]
    except OSError:
        log_tail = ""

    return {
        "target": "f4_health",
        "url": url,
        "port": port,
        "timeout_s": timeout_s,
        "first_200_s": None if first_200_s is None else round(first_200_s, 3),
        "first_200_body": first_200_body,
        "refused_or_unconnected": refused,
        "timed_out": timed_out,
        "other_errors": errors,
        "post_up_n": len(latencies),
        "post_up_max_s": round(max(latencies), 4) if latencies else None,
        "post_up_p50_s": round(sorted(latencies)[len(latencies) // 2], 4) if latencies else None,
        "log_path": str(log_path),
        "startup_complete": "Application startup complete." in log_tail,
    }


def _write_result(phase: str, payload: dict) -> Path:
    out_dir = Path(__file__).resolve().parents[1] / "evals" / "results"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"async_block_{phase}_{_now()}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


async def _async_main(args: argparse.Namespace) -> dict:
    payload: dict = {
        "phase": args.phase,
        "measured_at": datetime.now(UTC).isoformat(),
        "interval_s": INTERVAL_S,
    }
    if args.only in ("all", "f5"):
        print("measuring f5-loop...", flush=True)
        payload["f5"] = await measure_f5_loop()
        print(json.dumps(payload["f5"], ensure_ascii=False, indent=2), flush=True)
    if args.only in ("all", "f4-loop"):
        print("measuring f4-loop...", flush=True)
        payload["f4_loop"] = await measure_f4_loop()
        print(json.dumps(payload["f4_loop"], ensure_ascii=False, indent=2), flush=True)
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", required=True, choices=["before", "after"])
    parser.add_argument(
        "--only",
        default="all",
        choices=["all", "f4-loop", "f4-health", "f5"],
    )
    args = parser.parse_args()

    payload: dict
    if args.only == "f4-health":
        print("measuring f4-health...", flush=True)
        payload = {
            "phase": args.phase,
            "measured_at": datetime.now(UTC).isoformat(),
            "f4_health": measure_f4_health(),
        }
        print(json.dumps({k: v for k, v in payload["f4_health"].items() if k != "log_tail"}, indent=2), flush=True)
    else:
        payload = asyncio.run(_async_main(args))
        if args.only == "all":
            print("measuring f4-health...", flush=True)
            payload["f4_health"] = measure_f4_health()
            slim = {k: v for k, v in payload["f4_health"].items() if k != "log_tail"}
            print(json.dumps(slim, indent=2), flush=True)

    path = _write_result(args.phase, payload)
    print(f"wrote {path}", flush=True)


if __name__ == "__main__":
    main()
