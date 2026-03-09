# Project.Infra – Super Simple Azure Deployment Guide

This folder is your infrastructure package.
You can copy it into an existing app repo as `Project.Infra`.
Then GitHub Actions can deploy and update Azure automatically.

## What happens automatically

When workflow runs, it does this for you:

1. Uses Azure location `swedencentral` by default.
2. Creates or reuses Azure Container Registry (ACR) automatically.
3. Builds your app image and pushes it to ACR.
4. Creates or updates Container App resources.
5. Scans database resources:
   - If existing Azure SQL is found, it auto-builds a managed-identity connection string.
   - If no database exists, it can create Azure SQL automatically.
6. Updates app code/image when resources already exist.

No registry password and no hardcoded secrets are required in code files.

## This repo integration

This repository now supports Azure Container Apps directly:

- Docker runtime: `Dockerfile`
- App server: `server/index.mjs`
- Active CI/CD workflow: `.github/workflows/deploy-container-apps.yml`
- Infra template: `hexatronic/main.bicep`

Required GitHub settings:

- GitHub Environment (recommended per tenant): `customer-a-prod`, `customer-b-prod`, etc.
- Secrets:
  - `OPENAI_API_KEY` (optional fallback)
- Variables:
  - `AZURE_CLIENT_ID` (OIDC app registration client ID)
  - `AZURE_TENANT_ID` (OIDC app registration tenant ID)
  - `AZURE_SUBSCRIPTION_ID`
  - `AZURE_RESOURCE_GROUP`
  - `AZURE_LOCATION`
  - `ENVIRONMENT_NAME`
  - `ENTRA_LOGIN_CLIENT_ID` (required for enforced Entra auth)
  - `ENTRA_AUTH_TENANT_ID` (optional; defaults to `AZURE_TENANT_ID`)
  - `KEY_VAULT_NAME` (required; Key Vault containing Entra login secret)
  - `ENTRA_LOGIN_CLIENT_SECRET_NAME` (optional; default `entra-login-client-secret`)
  - `FOUNDRY_API_KEY_SECRET_NAME` (optional; default `foundry-api-key`)
  - `OPENAI_API_KEY_SECRET_NAME` (optional; default `openai-api-key`)
  - `DEFAULT_GITHUB_ENVIRONMENT` (optional fallback for push-triggered deployments)

## Important safety rules

- Do not commit `.env` files.
- Do not put passwords in repo files.
- Use managed identity for runtime access whenever possible.
- Workflow generates temporary SQL admin password only when SQL must be created.

## Folder placement

Your app repository should look like this:

```plaintext
YourAppRepo/
├── Project.Infra/
│   ├── main.bicep
│   ├── main.parameters.json
│   ├── containerapps.bicep
│   ├── roles.bicep
│   ├── sql.bicep
│   ├── deploy.sh
│   └── .env.example
└── deploy.yml
```

The workflow supports these infra paths automatically:

- `./Project.Infra`
- `./infra`
- root folder (`./`)

## Multi-tenant pattern (recommended)

Use one GitHub Environment per tenant and federate OIDC to that environment subject:

- Federated credential subject:
  - `repo:<org>/<repo>:environment:<environment-name>`
- Examples:
  - `repo:NickO-gitit/supplier-agreement-compare:environment:customer-a-prod`
  - `repo:NickO-gitit/supplier-agreement-compare:environment:customer-b-prod`

This gives tenant isolation and approval gates per environment.

## One-time GitHub setup (very easy)

Think of this like giving GitHub a "robot key" to your Azure subscription.

### Step 1: Add GitHub Environment Variables (OIDC + deployment settings)

In your GitHub repo:
`Settings -> Environments -> <your-environment> -> Variables`

Add:

- `AZURE_CLIENT_ID` (OIDC deployment app/client ID)
- `AZURE_TENANT_ID` (OIDC deployment tenant ID)
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_RESOURCE_GROUP` (example: `rg-myapp-prod`)
- `AZURE_LOCATION` (example: `swedencentral`)
- `ENVIRONMENT_NAME` (example: `myapp-prod`)
- `ENTRA_LOGIN_CLIENT_ID` (app registration client ID used for end-user login)
- `ENTRA_AUTH_TENANT_ID` (optional, defaults to `AZURE_TENANT_ID`)
- `KEY_VAULT_NAME` (Key Vault that stores Entra login client secret)
- `ENTRA_LOGIN_CLIENT_SECRET_NAME` (optional, defaults to `entra-login-client-secret`)
- `FOUNDRY_API_KEY_SECRET_NAME` (optional, defaults to `foundry-api-key`)
- `OPENAI_API_KEY_SECRET_NAME` (optional, defaults to `openai-api-key`)
- `DEFAULT_GITHUB_ENVIRONMENT` (optional, useful for `push` trigger fallback)

Optional migration-only variables (used to seed App Configuration automatically on deploy):
- `FOUNDRY_ENDPOINT`
- `FOUNDRY_PROJECT_ENDPOINT`
- `FOUNDRY_DEPLOYMENT`
- `FOUNDRY_API_VERSION`
- `OPENAI_MODEL`

### Step 2: Add GitHub Environment Secrets (runtime provider keys only)

In your GitHub repo:
`Settings -> Environments -> <your-environment> -> Secrets`

Add:

- `OPENAI_API_KEY` (optional)

Store your Foundry API key in Key Vault instead (same vault as login secret):

```bash
az keyvault secret set --vault-name <KEY_VAULT_NAME> --name foundry-api-key --value <FOUNDRY_API_KEY>
```

Optional (if you want OpenAI fallback from Key Vault too):

```bash
az keyvault secret set --vault-name <KEY_VAULT_NAME> --name openai-api-key --value <OPENAI_API_KEY>
```

You do NOT need to add ACR variable.
ACR name is generated automatically from `ENVIRONMENT_NAME`.

## Bootstrap a tenant automatically

Use the bootstrap script to set up a new tenant end-to-end:

```powershell
pwsh ./hexatronic/bootstrap-tenant.ps1 `
  -TenantId "<tenant-id>" `
  -SubscriptionId "<subscription-id>" `
  -ResourceGroupName "<resource-group>" `
  -Location "swedencentral" `
  -RepoOwner "NickO-gitit" `
  -RepoName "supplier-agreement-compare" `
  -GitHubEnvironment "customer-a-prod" `
  -EnvironmentName "suppliercomparea-prod" `
  -CreateResourceGroup
```

The script:

1. Registers required Azure providers
2. Creates/reuses OIDC deploy app + service principal
3. Creates environment-based federated credential
4. Assigns RG roles (`Contributor`, `User Access Administrator`)
5. Creates/reuses web-login app + client secret
6. Creates/reuses Key Vault and stores login client secret
7. Grants deploy identity `Key Vault Secrets User`
8. Outputs all GitHub Environment variables to apply

## Deploy like a 5-year-old guide

Imagine 4 buttons:

1. **Put code in GitHub**
   - Push to `main` or `master`.

2. **Robot wakes up**
   - GitHub Action starts (push) or you run `workflow_dispatch`.

   For multi-tenant deployments, use `workflow_dispatch` and choose `target_environment`.

3. **Robot checks toys**
   - "Do we have Azure resources already?"
   - If yes: update app image.
   - If no: create needed resources.

4. **Robot says done**
   - It prints your app URL.

That’s it.

## Entra auth on every deployment

The workflow `.github/workflows/deploy-container-apps.yml` now enforces Entra login on every deploy:

- Enables Container App auth
- Configures Microsoft identity provider
- Sets unauthenticated action to `RedirectToLoginPage`
- Keeps `/health` excluded for probes

Prerequisite:

- Your login app registration must include this redirect URI:
  - `https://<container-app-fqdn>/.auth/login/aad/callback`
- Your login app client secret must be stored in Azure Key Vault
  (name defaults to `entra-login-client-secret`).
- The GitHub OIDC deploy app/service principal must have
  `Key Vault Secrets User` on that vault.

## Local deployment (optional)

If you want local terminal deployment:

1. Copy `.env.example` to `.env`
1. Fill your values
1. Run Azure login:

```bash
az login
```

1. Run:

```bash
./deploy.sh .env
```

## Database behavior details

- Existing Azure SQL found:
  - Workflow builds managed-identity SQL connection string automatically.
  - No database password is required for app runtime.
- No database found:
  - Workflow can deploy SQL.
  - SQL admin password is generated during workflow run (not stored in repo files).

## Notes

- `main.parameters.json` is valid JSON (no comments).
- Default location is `swedencentral` in infrastructure and workflow.
- Infrastructure deployments are idempotent: running again updates existing resources.
