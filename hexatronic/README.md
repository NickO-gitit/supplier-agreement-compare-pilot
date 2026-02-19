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

No registry password, no Foundry API key, and no hardcoded secrets are required in code files.

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

## One-time GitHub setup (very easy)

Think of this like giving GitHub a "robot key" to your Azure subscription.

### Step 1: Add GitHub Secrets

In your GitHub repo:
`Settings -> Secrets and variables -> Actions -> Secrets`

Add:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`

### Step 2: Add GitHub Variables

In your GitHub repo:
`Settings -> Secrets and variables -> Actions -> Variables`

Add:

- `AZURE_RESOURCE_GROUP` (example: `rg-myapp-prod`)
- `ENVIRONMENT_NAME` (example: `myapp-prod`)
- `FOUNDRY_ENDPOINT` (optional, only if your app needs it)

You do NOT need to add ACR variable.
ACR name is generated automatically from `ENVIRONMENT_NAME`.

## Deploy like a 5-year-old guide

Imagine 4 buttons:

1. **Put code in GitHub**
   - Push to `main` or `master`.

2. **Robot wakes up**
   - GitHub Action starts by itself.

3. **Robot checks toys**
   - "Do we have Azure resources already?"
   - If yes: update app image.
   - If no: create needed resources.

4. **Robot says done**
   - It prints your app URL.

That’s it.

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
