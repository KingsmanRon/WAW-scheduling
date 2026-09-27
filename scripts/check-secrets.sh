#!/usr/bin/env bash
set -euo pipefail
bad_env=$(git ls-files | awk '$0 ~ /(^|\/)\.env($|\.)/ && $0 !~ /\.env\.example$/ {print "tracked environment file: " $0}')
patterns='(postgres(ql)?://[^:/[:space:]]+:[^@[:space:]<]{8,}@|-----BEGIN ([A-Z0-9 ]+)?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|SUPABASE_SERVICE_ROLE_KEY[[:space:]]*[=:][[:space:]]*["'"'"']?[^$<"'"'"'[:space:]{][^[:space:]]{15,}|AUTH_JWT_SECRET[[:space:]]*=[[:space:]]*[^$<[:space:]][^[:space:]]{15,}|ARTIFACT_ENCRYPTION_KEY[[:space:]]*[=:][[:space:]]*["'"'"']?[1-9a-fA-F][0-9a-fA-F]{63}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]{16,})'
matches=$(git grep -nE "$patterns" -- ':!scripts/check-secrets.sh' ':!.env.example' ':!package-lock.json' 2>/dev/null | grep -Ev '@(localhost|postgres|db\.example\.test)[:/]' | grep -Ev 'postgres://[a-z_.]+:(x|secret|integration-(api|worker)|local-(api|worker|placeholder)|postgres|access_owner)@' | cut -d: -f1 | sort -u || true)
if [[ -n "$bad_env" || -n "$matches" ]]; then
  [[ -n "$bad_env" ]] && printf '%s\n' "$bad_env" >&2
  [[ -n "$matches" ]] && printf 'potential secret pattern in: %s\n' "$matches" >&2
  exit 1
fi
echo "secret check passed"
