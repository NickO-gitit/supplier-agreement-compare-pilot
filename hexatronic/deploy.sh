#!/usr/bin/env bash
# ============================================================
# deploy.sh  –  Local deployment helper
# Reads .env, scans for existing databases, then runs Bicep.
# Usage: ./infra/deploy.sh [--env .env]
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${1:-.env}"

# ── Load .env ─────────────────────────────────────────────────
if [[ -f "$ENV_FILE" ]]; then
  echo "📄 Loading $ENV_FILE"
  set -a; source "$ENV_FILE"; set +a
else
  echo "❌ $ENV_FILE not found. Copy .env.example to .env and fill values." >&2
  exit 1
fi

# ── Validate required vars ────────────────────────────────────
required_vars=(AZURE_SUBSCRIPTION_ID AZURE_RESOURCE_GROUP ENVIRONMENT_NAME CONTAINER_IMAGE)
for v in "${required_vars[@]}"; do
  [[ -z "${!v:-}" ]] && { echo "❌ $v is required in .env" >&2; exit 1; }
done

AZURE_LOCATION="${AZURE_LOCATION:-swedencentral}"
echo "📍 Using Azure location: ${AZURE_LOCATION}"

echo ""
echo "🔍 Scanning resource group '${AZURE_RESOURCE_GROUP}' for existing databases..."

DEPLOY_SQL=false
EXISTING_CONN="${DATABASE_CONNECTION_STRING:-}"

if [[ -z "$EXISTING_CONN" ]]; then
  # Check for Azure SQL
  SQL_COUNT=$(az sql server list \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --subscription "$AZURE_SUBSCRIPTION_ID" \
    --query "length(@)" -o tsv 2>/dev/null || echo "0")

  # Check for CosmosDB
  COSMOS_COUNT=$(az cosmosdb list \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --subscription "$AZURE_SUBSCRIPTION_ID" \
    --query "length(@)" -o tsv 2>/dev/null || echo "0")

  # Check for PostgreSQL Flexible Server
  PG_COUNT=$(az postgres flexible-server list \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --subscription "$AZURE_SUBSCRIPTION_ID" \
    --query "length(@)" -o tsv 2>/dev/null || echo "0")

  echo "  → SQL servers found   : $SQL_COUNT"
  echo "  → CosmosDB accounts   : $COSMOS_COUNT"
  echo "  → PostgreSQL servers  : $PG_COUNT"

  TOTAL_DBS=$((SQL_COUNT + COSMOS_COUNT + PG_COUNT))

  if [[ "$SQL_COUNT" -gt 0 ]]; then
    SQL_SERVER_NAME=$(az sql server list \
      --resource-group "$AZURE_RESOURCE_GROUP" \
      --subscription "$AZURE_SUBSCRIPTION_ID" \
      --query "[0].name" -o tsv 2>/dev/null || echo "")

    if [[ -n "$SQL_SERVER_NAME" ]]; then
      SQL_DB_NAME=$(az sql db list \
        --resource-group "$AZURE_RESOURCE_GROUP" \
        --server "$SQL_SERVER_NAME" \
        --subscription "$AZURE_SUBSCRIPTION_ID" \
        --query "[?name!='master']|[0].name" -o tsv 2>/dev/null || echo "")
      if [[ -n "$SQL_DB_NAME" ]]; then
        EXISTING_CONN="Server=tcp:${SQL_SERVER_NAME}.database.windows.net,1433;Initial Catalog=${SQL_DB_NAME};Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;Authentication=Active Directory Managed Identity;"
      fi
    fi
  fi

  if [[ "$TOTAL_DBS" -gt 0 && -n "$EXISTING_CONN" ]]; then
    echo ""
    echo "✅ Existing SQL database detected. Using managed identity connection string automatically."
    DEPLOY_SQL=false
  elif [[ "$TOTAL_DBS" -gt 0 ]]; then
    echo ""
    echo "✅ Existing database resources detected. Skipping SQL deployment."
    echo "ℹ️  Could not auto-build SQL connection string from discovered resources."
  else
    echo ""
    echo "🆕 No existing databases found. Will deploy new Azure SQL."
    DEPLOY_SQL=true
    SQL_ADMIN_PASSWORD="${SQL_ADMIN_PASSWORD:-$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 16)Aa1!}"
  fi
else
  echo "✅ Using DATABASE_CONNECTION_STRING from .env. Skipping SQL deployment."
fi

# ── Run Bicep deployment ──────────────────────────────────────
echo ""
echo "🚀 Deploying infrastructure to '${AZURE_RESOURCE_GROUP}'..."

az deployment group create \
  --name "app-deployment-$(date +%Y%m%d%H%M%S)" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --subscription "$AZURE_SUBSCRIPTION_ID" \
  --template-file "$SCRIPT_DIR/main.bicep" \
  --parameters "$SCRIPT_DIR/main.parameters.json" \
  --parameters \
    location="$AZURE_LOCATION" \
    environmentName="$ENVIRONMENT_NAME" \
    containerImage="$CONTAINER_IMAGE" \
    deploySql="$DEPLOY_SQL" \
    existingDatabaseConnectionString="$EXISTING_CONN" \
    sqlAdminLogin="${SQL_ADMIN_LOGIN:-sqladmin}" \
    sqlAdminPassword="${SQL_ADMIN_PASSWORD:-}" \
    sqlDatabaseName="${SQL_DATABASE_NAME:-appdb}" \
    foundryEndpoint="${FOUNDRY_ENDPOINT:-}" \
  --output table

echo ""
echo "✅ Deployment complete!"
