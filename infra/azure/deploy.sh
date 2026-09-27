#!/usr/bin/env bash
# Deploy the ACCESS execution plane to Azure Container Apps.
#
# Secrets are NOT passed here. Store them in the Key Vault first (names in
# docs/deployment.md): api-database-url, worker-database-url,
# migration-database-url, database-ca-cert, artifact-encryption-key,
# supabase-service-role-key.
set -euo pipefail
: "${RESOURCE_GROUP:?}" "${PREFIX:?}" "${IMAGE:?}" "${KEY_VAULT_NAME:?}" \
  "${SUPABASE_URL:?}" "${AUTH_JWT_ISSUER:?}" "${AUTH_JWKS_URL:?}" "${CONSOLE_ORIGIN:?}"
PROFILE="${ACCESS_DEPLOYMENT_PROFILE:-client-pilot}"
DATA_MODE="${ACCESS_DATA_MODE:-SYNTHETIC}"
CONNECTOR="${CONNECTOR_KIND:-none}"
if [[ "$DATA_MODE" == "REAL" && "$CONNECTOR" != "none" ]]; then
  echo "REAL data requires CONNECTOR_KIND=none until a real connector is qualified" >&2
  exit 1
fi
if [[ "$IMAGE" != *@sha256:* ]]; then
  echo "IMAGE must be pinned by digest (registry/access@sha256:...)" >&2
  exit 1
fi
here="$(dirname "$0")"
az deployment group create -g "$RESOURCE_GROUP" -f "$here/main.bicep" \
  -p prefix="$PREFIX" image="$IMAGE" registryServer="${REGISTRY_SERVER:-}" \
     deploymentProfile="$PROFILE" dataMode="$DATA_MODE" keyVaultName="$KEY_VAULT_NAME" \
     supabaseUrl="$SUPABASE_URL" storageBucket="${SUPABASE_STORAGE_BUCKET:-access-artifacts}" \
     authIssuer="$AUTH_JWT_ISSUER" authJwksUrl="$AUTH_JWKS_URL" consoleOrigin="$CONSOLE_ORIGIN" \
     connectorKind="$CONNECTOR" --output none
# Apply migrations (ledger-based, idempotent) before the new revisions serve.
execution=$(az containerapp job start -g "$RESOURCE_GROUP" -n "$PREFIX-migrate" --query name -o tsv)
for _ in $(seq 1 90); do
  status=$(az containerapp job execution show -g "$RESOURCE_GROUP" -n "$PREFIX-migrate" \
    --job-execution-name "$execution" --query properties.status -o tsv)
  [[ "$status" == "Succeeded" ]] && break
  if [[ "$status" == "Failed" ]]; then echo "migration job failed: $execution" >&2; exit 1; fi
  sleep 10
done
[[ "$status" == "Succeeded" ]] || { echo "migration job timed out" >&2; exit 1; }
for app in api worker; do
  revision=$(az containerapp show -g "$RESOURCE_GROUP" -n "$PREFIX-$app" --query properties.latestRevisionName -o tsv)
  az containerapp revision restart -g "$RESOURCE_GROUP" -n "$PREFIX-$app" --revision "$revision" --output none
done
echo "deployed $IMAGE ($PROFILE, $DATA_MODE); verify /ready and run the checklist in docs/client-pilot-checklist.md"
