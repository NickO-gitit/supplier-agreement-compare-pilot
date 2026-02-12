# Azure Deployment Guide

This project is configured for:
- `Azure Static Web Apps` hosting
- `Azure OpenAI` for:
  - risk analysis via server-side API (`/api/analyze-risk`)
  - grouping quality review via server-side API (`/api/review-grouping`)

## 1) Prerequisites

- Azure CLI installed and working (`az --version`)
- Azure access to your target subscription and tenant
- GitHub repo already created (this repo)
- Optional: GitHub CLI (`gh`) if you want the script to set secrets automatically

## 2) Run provisioning script

From repo root:

```powershell
pwsh ./infra/azure/deploy.ps1 `
  -TenantId "<your-tenant-id>" `
  -SubscriptionId "<your-subscription-id>" `
  -ResourceGroupName "rg-supplier-agreement-compare" `
  -Location "swedencentral" `
  -StaticWebAppName "swa-supplier-agreement-compare" `
  -OpenAIAccountName "oai-supplier-agreement-compare" `
  -OpenAIDeploymentName "gpt-4-1-mini" `
  -OpenAIModelName "gpt-4.1-mini" `
  -OpenAIModelVersion "<model-version-from-your-region>" `
  -GitHubRepo "NickO-gitit/supplier-agreement-compare"
```

Notes:
- `-OpenAIModelVersion` depends on regional availability.
- To list available models/versions for your Azure OpenAI account:

```powershell
az cognitiveservices account list-models `
  --name <openai-account-name> `
  --resource-group <resource-group> `
  -o table
```

## 3) GitHub Actions

Workflow file is already added at:
- `.github/workflows/azure-static-web-apps.yml`

If the script did not set the secret automatically, add this manually in GitHub repo settings:
- Secret name: `AZURE_STATIC_WEB_APPS_API_TOKEN`
- Secret value: token printed by `deploy.ps1`

## 4) Runtime settings

The script sets these Static Web App app settings:
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_KEY`
- `AZURE_OPENAI_DEPLOYMENT`
- `AZURE_OPENAI_API_VERSION`

The frontend calls:
- `/api/analyze-risk` when `VITE_RISK_API_URL` is set
- `/api/review-grouping` when `VITE_GROUPING_REVIEW_API_URL` is set

Defaults are already in `.env.example`, so keys stay server-side in Azure.
