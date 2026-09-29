#!/usr/bin/env bash
# Static validation of the deployment assets: Railway (API, worker, migration
# job), Vercel (console) and local Compose. Run in CI.
set -euo pipefail
fail() {
  echo "infra: $*" >&2
  exit 1
}

for f in infra/railway/api.railway.toml infra/railway/worker.railway.toml \
  infra/railway/migrate.railway.toml apps/console/vercel.json \
  apps/console/vite.config.ts Dockerfile docker-compose.yml; do
  test -s "$f" || fail "missing $f"
done

# Railway config-as-code: well-formed lines only (comments, [tables],
# key = value), and each service starts the right compiled entry point.
for f in infra/railway/*.railway.toml; do
  awk '!/^[[:space:]]*(#.*)?$/ && !/^\[[a-z]+\]$/ && !/^[A-Za-z]+ = .+$/ { print FILENAME ": " $0; bad = 1 } END { exit bad }' "$f" ||
    fail "$f has lines that are not TOML key = value pairs"
done
start() { sed -n 's/^startCommand = "\(.*\)"$/\1/p' "$1"; }
[[ "$(start infra/railway/api.railway.toml)" == "node apps/core-api/dist/server.js" ]] || fail "API start command"
[[ "$(start infra/railway/worker.railway.toml)" == "node apps/worker/dist/main.js" ]] || fail "worker start command"
[[ "$(start infra/railway/migrate.railway.toml)" == "node packages/db/dist/migrate.js" ]] || fail "migration start command"
for src in apps/core-api/src/server.ts apps/worker/src/main.ts packages/db/src/migrate.ts; do
  test -s "$src" || fail "missing entry point $src"
done
grep -q '^healthcheckPath = "/ready"$' infra/railway/api.railway.toml || fail "API readiness check"
grep -q '^healthcheckPath = "/ready"$' infra/railway/worker.railway.toml || fail "worker readiness check"
grep -q '^restartPolicyType = "NEVER"$' infra/railway/migrate.railway.toml || fail "the migration job must not restart"

# The owner credential is set only on the migration job. (Comments may name
# it; no setting may.)
for f in infra/railway/api.railway.toml infra/railway/worker.railway.toml; do
  if grep -v '^[[:space:]]*#' "$f" | grep -q MIGRATION_DATABASE_URL; then
    fail "$f must not configure MIGRATION_DATABASE_URL"
  fi
done

# The console: security headers from the host, CSP from the build.
node -e '
const v = JSON.parse(require("fs").readFileSync("apps/console/vercel.json", "utf8"));
const all = v.headers.find((h) => h.source === "/(.*)").headers;
const get = (k) => all.find((h) => h.key.toLowerCase() === k)?.value ?? "";
const want = {
  "x-frame-options": /^DENY$/,
  "content-security-policy": /frame-ancestors .none./,
  "x-content-type-options": /^nosniff$/,
  "referrer-policy": /^no-referrer$/,
  "strict-transport-security": /max-age=\d{7,}/,
};
for (const [k, re] of Object.entries(want))
  if (!re.test(get(k))) { console.error(`vercel.json: ${k} missing or weak`); process.exit(1); }
if (v.outputDirectory !== "dist") { console.error("vercel.json: outputDirectory"); process.exit(1); }
'
grep -q "Content-Security-Policy" apps/console/vite.config.ts || fail "console build must write a Content-Security-Policy"

if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  docker compose -f docker-compose.yml config -q
fi
echo "infrastructure validation passed"
