# windslice-backend

本地：

```bash
cd backend
uv sync --dev
uv run pytest -m "not needs_model and not needs_db" -q
```

CI：push / PR 到 `main` 时跑同一条纯逻辑测试。需要模型和数据库的用例打了 `needs_model` / `needs_db`，不在 CI 里跑。

pgvector 镜像钉在 `0.8.2-pg16`（CVE-2026-3172）。已有数据卷换镜像后执行：

```bash
./scripts/upgrade_pgvector_082.sh
```
