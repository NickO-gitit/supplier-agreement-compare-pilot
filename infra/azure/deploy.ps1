param(
  [Parameter(Mandatory = $true)]
  [string]$TenantId,

  [Parameter(Mandatory = $true)]
  [string]$SubscriptionId,

  [Parameter(Mandatory = $true)]
  [string]$ResourceGroupName,

  [Parameter(Mandatory = $true)]
  [string]$Location,

  [Parameter(Mandatory = $true)]
  [string]$StaticWebAppName,

  [Parameter(Mandatory = $true)]
  [string]$OpenAIAccountName,

  [Parameter(Mandatory = $true)]
  [string]$OpenAIDeploymentName,

  [Parameter(Mandatory = $true)]
  [string]$OpenAIModelName,

  [Parameter(Mandatory = $true)]
  [string]$OpenAIModelVersion,

  [string]$OpenAIApiVersion = "2024-02-15-preview",
  [int]$OpenAIDeploymentCapacity = 10,
  [string]$GitHubRepo = ""
)

$ErrorActionPreference = "Stop"

function Assert-CommandExists {
  param([string]$CommandName)
  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "Required command '$CommandName' was not found. Install it and rerun this script."
  }
}

function Test-AzResourceExists {
  param(
    [string[]]$AzArgs
  )
  $null = & az @AzArgs --only-show-errors 2>$null
  return $LASTEXITCODE -eq 0
}

Assert-CommandExists -CommandName "az"

Write-Host "Authenticating to Azure tenant $TenantId..." -ForegroundColor Cyan
& az login --tenant $TenantId --use-device-code --only-show-errors | Out-Null
& az account set --subscription $SubscriptionId --only-show-errors

Write-Host "Creating/validating resource group '$ResourceGroupName'..." -ForegroundColor Cyan
& az group create `
  --name $ResourceGroupName `
  --location $Location `
  --only-show-errors | Out-Null

if (-not (Test-AzResourceExists -AzArgs @("cognitiveservices", "account", "show", "--name", $OpenAIAccountName, "--resource-group", $ResourceGroupName))) {
  Write-Host "Creating Azure OpenAI account '$OpenAIAccountName'..." -ForegroundColor Cyan
  & az cognitiveservices account create `
    --name $OpenAIAccountName `
    --resource-group $ResourceGroupName `
    --location $Location `
    --kind OpenAI `
    --sku S0 `
    --yes `
    --only-show-errors | Out-Null
} else {
  Write-Host "Azure OpenAI account '$OpenAIAccountName' already exists. Reusing it." -ForegroundColor Yellow
}

if (-not (Test-AzResourceExists -AzArgs @("cognitiveservices", "account", "deployment", "show", "--name", $OpenAIAccountName, "--resource-group", $ResourceGroupName, "--deployment-name", $OpenAIDeploymentName))) {
  Write-Host "Creating Azure OpenAI deployment '$OpenAIDeploymentName'..." -ForegroundColor Cyan
  & az cognitiveservices account deployment create `
    --name $OpenAIAccountName `
    --resource-group $ResourceGroupName `
    --deployment-name $OpenAIDeploymentName `
    --model-name $OpenAIModelName `
    --model-version $OpenAIModelVersion `
    --model-format OpenAI `
    --sku-name Standard `
    --sku-capacity $OpenAIDeploymentCapacity `
    --only-show-errors | Out-Null
} else {
  Write-Host "Azure OpenAI deployment '$OpenAIDeploymentName' already exists. Reusing it." -ForegroundColor Yellow
}

if (-not (Test-AzResourceExists -AzArgs @("staticwebapp", "show", "--name", $StaticWebAppName, "--resource-group", $ResourceGroupName))) {
  Write-Host "Creating Static Web App '$StaticWebAppName'..." -ForegroundColor Cyan
  & az staticwebapp create `
    --name $StaticWebAppName `
    --resource-group $ResourceGroupName `
    --location $Location `
    --sku Free `
    --only-show-errors | Out-Null
} else {
  Write-Host "Static Web App '$StaticWebAppName' already exists. Reusing it." -ForegroundColor Yellow
}

$openAIEndpoint = & az cognitiveservices account show `
  --name $OpenAIAccountName `
  --resource-group $ResourceGroupName `
  --query "properties.endpoint" `
  -o tsv

$openAIKey = & az cognitiveservices account keys list `
  --name $OpenAIAccountName `
  --resource-group $ResourceGroupName `
  --query "key1" `
  -o tsv

Write-Host "Configuring Static Web App application settings..." -ForegroundColor Cyan
& az staticwebapp appsettings set `
  --name $StaticWebAppName `
  --resource-group $ResourceGroupName `
  --setting-names `
    "AZURE_OPENAI_ENDPOINT=$openAIEndpoint" `
    "AZURE_OPENAI_KEY=$openAIKey" `
    "AZURE_OPENAI_DEPLOYMENT=$OpenAIDeploymentName" `
    "AZURE_OPENAI_API_VERSION=$OpenAIApiVersion" `
  --only-show-errors | Out-Null

$swaHostname = & az staticwebapp show `
  --name $StaticWebAppName `
  --resource-group $ResourceGroupName `
  --query "defaultHostname" `
  -o tsv

$swaToken = & az staticwebapp secrets list `
  --name $StaticWebAppName `
  --resource-group $ResourceGroupName `
  --query "properties.apiKey" `
  -o tsv

Write-Host ""
Write-Host "Provisioning complete." -ForegroundColor Green
Write-Host "Static Web App URL: https://$swaHostname"
Write-Host "Add this GitHub secret to your repo: AZURE_STATIC_WEB_APPS_API_TOKEN"
Write-Host "Token value:"
Write-Host $swaToken

if ($GitHubRepo -and (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Host ""
  Write-Host "Setting GitHub secret automatically for $GitHubRepo..." -ForegroundColor Cyan
  & gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN --repo $GitHubRepo --body $swaToken
  Write-Host "GitHub secret configured." -ForegroundColor Green
}
