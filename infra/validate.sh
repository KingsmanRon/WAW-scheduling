#!/usr/bin/env bash
# Static validation of deployment assets. In CI a missing Bicep compiler is a
# failure, never a silent skip.
set -euo pipefail
node -e "JSON.parse(require('fs').readFileSync('infra/vercel/vercel.json'))"
for f in infra/azure/main.bicep infra/azure/deploy.sh infra/railway/api.railway.toml infra/railway/worker.railway.toml Dockerfile docker-compose.yml; do
  test -s "$f" || { echo "missing $f" >&2; exit 1; }
done
bash -n infra/azure/deploy.sh
# The runtime contract: split credentials, and the migration credential only on the job.
grep -q "API_DATABASE_URL" infra/azure/main.bicep
grep -q "WORKER_DATABASE_URL" infra/azure/main.bicep
if grep -nE "name: '(DATABASE_URL)'" infra/azure/main.bicep; then echo "single DATABASE_URL contract is not supported" >&2; exit 1; fi
if awk '/resource (api|worker) /,/^}/' infra/azure/main.bicep | grep -q "MIGRATION_DATABASE_URL"; then
  echo "migration credential must not reach the API or worker" >&2
  exit 1
fi
if command -v bicep >/dev/null; then
  bicep build infra/azure/main.bicep --stdout >/dev/null
elif command -v az >/dev/null; then
  az bicep build --file infra/azure/main.bicep --stdout >/dev/null
elif [[ -n "${CI:-}" ]]; then
  echo "Bicep compiler unavailable in CI" >&2
  exit 1
else
  echo "Bicep compiler unavailable locally; static checks only" >&2
fi
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  docker compose -f docker-compose.yml config -q
fi
echo "infrastructure validation passed"
