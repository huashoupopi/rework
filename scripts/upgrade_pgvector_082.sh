#!/usr/bin/env bash
# 把运行中的 Postgres 升到带 pgvector 0.8.2 的镜像，并升级扩展。
# 修 CVE-2026-3172。已有数据卷不会因换镜像自动 ALTER EXTENSION。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "缺少 .env，拒绝继续（需要 DB_USER / DB_PASSWORD / DB_NAME）" >&2
  exit 1
fi

# 不把 .env 打进日志
set -a
# shellcheck disable=SC1091
source .env
set +a

DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-wind_db}"

echo "pull pgvector/pgvector:0.8.2-pg16"
docker compose pull postgres
docker compose up -d postgres

echo "wait until ready"
for _ in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U "$DB_USER" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "extension versions (before → after)"
docker compose exec -T postgres \
  psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector','pgvector');"

docker compose exec -T postgres \
  psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 \
  -c "ALTER EXTENSION vector UPDATE;"

docker compose exec -T postgres \
  psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector','pgvector');"

echo "done. 验收：extversion >= 0.8.2。全量 eval 仍要你本地有服务时再跑。"
