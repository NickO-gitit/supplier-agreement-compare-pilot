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
  [string]$RepoOwner,

  [Parameter(Mandatory = $true)]
  [string]$RepoName,

  [Parameter(Mandatory = $true)]
  [string]$GitHubEnvironment,

  [Parameter(Mandatory = $true)]
  [string]$EnvironmentName,

  [string]$DeployAppDisplayName = '',
  [string]$LoginAppDisplayName = '',
  [string]$KeyVaultName = '',
  [string]$LoginSecretName = 'entra-login-client-secret',
  [string]$FoundryApiKeySecretName = 'foundry-api-key',
  [string]$OpenAiApiKeySecretName = 'openai-api-key',
  [int]$LoginSecretYears = 1,
  [switch]$CreateResourceGroup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Wait-ProviderRegistered {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Namespace
  )

  az provider register --namespace $Namespace --output none
  for ($i = 0; $i -lt 60; $i++) {
    $state = az provider show --namespace $Namespace --query registrationState -o tsv
    if ($state -eq 'Registered') {
      return
    }
    Start-Sleep -Seconds 3
  }
  throw "Provider '$Namespace' did not reach Registered state in time."
}

function Ensure-RoleAssignment {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Scope,
    [Parameter(Mandatory = $true)]
    [string]$PrincipalObjectId,
    [Parameter(Mandatory = $true)]
    [string]$PrincipalType,
    [Parameter(Mandatory = $true)]
    [string]$RoleName
  )

  $existing = az role assignment list `
    --scope $Scope `
    --assignee-object-id $PrincipalObjectId `
    --role $RoleName `
    --query '[0]' `
    -o json | ConvertFrom-Json

  if (-not $existing) {
    az role assignment create `
      --scope $Scope `
      --assignee-object-id $PrincipalObjectId `
      --assignee-principal-type $PrincipalType `
      --role $RoleName `
      --output none
  }
}

function Ensure-AppRegistration {
  param(
    [Parameter(Mandatory = $true)]
    [string]$DisplayName,
    [string]$SignInAudience = ''
  )

  $app = az ad app list --display-name $DisplayName --query '[0]' -o json | ConvertFrom-Json
  if (-not $app) {
    if ([string]::IsNullOrWhiteSpace($SignInAudience)) {
      $app = az ad app create --display-name $DisplayName -o json | ConvertFrom-Json
    } else {
      $app = az ad app create --display-name $DisplayName --sign-in-audience $SignInAudience -o json | ConvertFrom-Json
    }
  }
  return $app
}

function Ensure-ServicePrincipal {
  param(
    [Parameter(Mandatory = $true)]
    [string]$AppId
  )

  $sp = $null
  try {
    $sp = az ad sp show --id $AppId -o json | ConvertFrom-Json
  } catch {
    $sp = $null
  }

  if (-not $sp) {
    $sp = az ad sp create --id $AppId -o json | ConvertFrom-Json
  }
  return $sp
}

function Ensure-FederatedCredential {
  param(
    [Parameter(Mandatory = $true)]
    [string]$AppObjectId,
    [Parameter(Mandatory = $true)]
    [string]$CredentialName,
    [Parameter(Mandatory = $true)]
    [string]$Subject
  )

  $existing = az ad app federated-credential list --id $AppObjectId -o json | ConvertFrom-Json
  $hasSubject = $false
  foreach ($item in $existing) {
    if ($item.subject -eq $Subject) {
      $hasSubject = $true
      break
    }
  }

  if ($hasSubject) {
    return
  }

  $tmp = New-TemporaryFile
  @{
    name = $CredentialName
    issuer = 'https://token.actions.githubusercontent.com'
    subject = $Subject
    audiences = @('api://AzureADTokenExchange')
    description = "OIDC for GitHub environment '$GitHubEnvironment'"
  } | ConvertTo-Json -Depth 5 | Set-Content -Path $tmp -Encoding UTF8

  az ad app federated-credential create --id $AppObjectId --parameters @$tmp --output none
}

function Ensure-KeyVault {
  param(
    [Parameter(Mandatory = $true)]
    [string]$VaultName,
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroup,
    [Parameter(Mandatory = $true)]
    [string]$AzureLocation
  )

  $exists = $false
  try {
    $existingName = az keyvault show --name $VaultName --query name -o tsv 2>$null
    if ($existingName -eq $VaultName) {
      $exists = $true
    }
  } catch {
    $exists = $false
  }

  if (-not $exists) {
    az keyvault create `
      --name $VaultName `
      --resource-group $ResourceGroup `
      --location $AzureLocation `
      --enable-rbac-authorization true `
      --output none
  }
}

function Ensure-KeyVaultAdminForCurrentUser {
  param(
    [Parameter(Mandatory = $true)]
    [string]$KeyVaultId
  )

  $userObjectId = az ad signed-in-user show --query id -o tsv
  Ensure-RoleAssignment `
    -Scope $KeyVaultId `
    -PrincipalObjectId $userObjectId `
    -PrincipalType 'User' `
    -RoleName 'Key Vault Administrator'
}

function Set-KeyVaultSecretWithRetry {
  param(
    [Parameter(Mandatory = $true)]
    [string]$VaultName,
    [Parameter(Mandatory = $true)]
    [string]$SecretName,
    [Parameter(Mandatory = $true)]
    [string]$SecretValue
  )

  for ($attempt = 1; $attempt -le 12; $attempt++) {
    az keyvault secret set `
      --vault-name $VaultName `
      --name $SecretName `
      --value $SecretValue `
      --output none 2>$null

    if ($LASTEXITCODE -eq 0) {
      return
    }
    Start-Sleep -Seconds 5
  }

  throw "Failed to set secret '$SecretName' in Key Vault '$VaultName'."
}

function Resolve-KeyVaultName {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RequestedName,
    [Parameter(Mandatory = $true)]
    [string]$Repo,
    [Parameter(Mandatory = $true)]
    [string]$GitHubEnv
  )

  if (-not [string]::IsNullOrWhiteSpace($RequestedName)) {
    return $RequestedName.ToLower()
  }

  $base = ("kv" + $Repo + $GitHubEnv).ToLower()
  $base = ($base -replace '[^a-z0-9]', '')
  if ($base.Length -gt 20) {
    $base = $base.Substring(0, 20)
  }
  if ($base.Length -lt 3) {
    $base = 'kvsupcompare'
  }

  for ($i = 0; $i -lt 15; $i++) {
    $suffix = if ($i -eq 0) { '' } else { Get-Random -Minimum 100 -Maximum 9999 }
    $candidate = "$base$suffix"
    if ($candidate.Length -gt 24) {
      $candidate = $candidate.Substring(0, 24)
    }

    try {
      $name = az keyvault show --name $candidate --query name -o tsv 2>$null
      if ($name -eq $candidate) {
        return $candidate
      }
    } catch {
      return $candidate
    }
  }

  throw 'Unable to generate a Key Vault name candidate.'
}

$providers = @(
  'Microsoft.App',
  'Microsoft.ContainerRegistry',
  'Microsoft.OperationalInsights',
  'Microsoft.AppConfiguration',
  'Microsoft.ManagedIdentity',
  'Microsoft.Authorization',
  'Microsoft.Sql',
  'Microsoft.DocumentDB',
  'Microsoft.KeyVault'
)

az account set --subscription $SubscriptionId
$account = az account show -o json | ConvertFrom-Json
if ($account.tenantId -ne $TenantId) {
  throw "Active tenant '$($account.tenantId)' does not match requested tenant '$TenantId'. Run 'az login --tenant $TenantId' first."
}

foreach ($provider in $providers) {
  Wait-ProviderRegistered -Namespace $provider
}

$rgId = az group show --name $ResourceGroupName --query id -o tsv 2>$null
if (-not $rgId) {
  if (-not $CreateResourceGroup) {
    throw "Resource group '$ResourceGroupName' does not exist. Re-run with -CreateResourceGroup to create it."
  }
  az group create --name $ResourceGroupName --location $Location --output none
  $rgId = az group show --name $ResourceGroupName --query id -o tsv
}

$safeEnv = ($GitHubEnvironment -replace '[^a-zA-Z0-9-]', '-').Trim('-')
if ([string]::IsNullOrWhiteSpace($DeployAppDisplayName)) {
  $DeployAppDisplayName = "github-oidc-$RepoName-$safeEnv"
}
if ([string]::IsNullOrWhiteSpace($LoginAppDisplayName)) {
  $LoginAppDisplayName = "supplier-compare-web-login-$safeEnv"
}

$deployApp = Ensure-AppRegistration -DisplayName $DeployAppDisplayName
$deploySp = Ensure-ServicePrincipal -AppId $deployApp.appId

$federatedSubject = "repo:${RepoOwner}/${RepoName}:environment:${GitHubEnvironment}"
$federatedName = "github-env-$safeEnv"
if ($federatedName.Length -gt 120) {
  $federatedName = $federatedName.Substring(0, 120)
}
Ensure-FederatedCredential `
  -AppObjectId $deployApp.id `
  -CredentialName $federatedName `
  -Subject $federatedSubject

Ensure-RoleAssignment `
  -Scope $rgId `
  -PrincipalObjectId $deploySp.id `
  -PrincipalType 'ServicePrincipal' `
  -RoleName 'Contributor'
Ensure-RoleAssignment `
  -Scope $rgId `
  -PrincipalObjectId $deploySp.id `
  -PrincipalType 'ServicePrincipal' `
  -RoleName 'User Access Administrator'

$loginApp = Ensure-AppRegistration `
  -DisplayName $LoginAppDisplayName `
  -SignInAudience 'AzureADMyOrg'
$loginSp = Ensure-ServicePrincipal -AppId $loginApp.appId

# Container Apps auth uses response_type=code id_token, so this must be enabled.
az ad app update `
  --id $loginApp.appId `
  --enable-id-token-issuance true `
  --output none

$loginSecret = az ad app credential reset `
  --id $loginApp.appId `
  --append `
  --display-name "container-app-auth-$safeEnv" `
  --years $LoginSecretYears `
  -o json | ConvertFrom-Json

$loginSecretExpiry = $null
if ($loginSecret.PSObject.Properties.Name -contains 'endDateTime') {
  $loginSecretExpiry = $loginSecret.endDateTime
} elseif ($loginSecret.PSObject.Properties.Name -contains 'endDate') {
  $loginSecretExpiry = $loginSecret.endDate
}

$resolvedKeyVaultName = Resolve-KeyVaultName `
  -RequestedName $KeyVaultName `
  -Repo $RepoName `
  -GitHubEnv $GitHubEnvironment

Ensure-KeyVault `
  -VaultName $resolvedKeyVaultName `
  -ResourceGroup $ResourceGroupName `
  -AzureLocation $Location

$keyVaultId = az keyvault show --name $resolvedKeyVaultName --query id -o tsv
Ensure-KeyVaultAdminForCurrentUser -KeyVaultId $keyVaultId
Ensure-RoleAssignment `
  -Scope $keyVaultId `
  -PrincipalObjectId $deploySp.id `
  -PrincipalType 'ServicePrincipal' `
  -RoleName 'Key Vault Secrets User'

Set-KeyVaultSecretWithRetry `
  -VaultName $resolvedKeyVaultName `
  -SecretName $LoginSecretName `
  -SecretValue $loginSecret.password

$summary = [ordered]@{
  tenant = @{
    tenantId = $TenantId
    subscriptionId = $SubscriptionId
    resourceGroup = $ResourceGroupName
    location = $Location
  }
  github = @{
    repository = "$RepoOwner/$RepoName"
    environment = $GitHubEnvironment
    federatedSubject = $federatedSubject
  }
  deployIdentity = @{
    displayName = $deployApp.displayName
    clientId = $deployApp.appId
    appObjectId = $deployApp.id
    servicePrincipalObjectId = $deploySp.id
  }
  loginIdentity = @{
    displayName = $loginApp.displayName
    clientId = $loginApp.appId
    appObjectId = $loginApp.id
    servicePrincipalObjectId = $loginSp.id
    clientSecretExpiresOn = $loginSecretExpiry
  }
  keyVault = @{
    name = $resolvedKeyVaultName
    secretName = $LoginSecretName
    foundryApiKeySecretName = $FoundryApiKeySecretName
    openAiApiKeySecretName = $OpenAiApiKeySecretName
  }
  githubEnvironmentVariables = @{
    AZURE_CLIENT_ID = $deployApp.appId
    AZURE_TENANT_ID = $TenantId
    AZURE_SUBSCRIPTION_ID = $SubscriptionId
    AZURE_RESOURCE_GROUP = $ResourceGroupName
    AZURE_LOCATION = $Location
    ENVIRONMENT_NAME = $EnvironmentName
    ENTRA_LOGIN_CLIENT_ID = $loginApp.appId
    KEY_VAULT_NAME = $resolvedKeyVaultName
    ENTRA_LOGIN_CLIENT_SECRET_NAME = $LoginSecretName
    FOUNDRY_API_KEY_SECRET_NAME = $FoundryApiKeySecretName
    OPENAI_API_KEY_SECRET_NAME = $OpenAiApiKeySecretName
    DEFAULT_GITHUB_ENVIRONMENT = $GitHubEnvironment
  }
  githubEnvironmentSecrets = @(
    'OPENAI_API_KEY (optional)'
  )
}

$outputFile = "tenant-bootstrap-$safeEnv.json"
$summary | ConvertTo-Json -Depth 8 | Set-Content -Path $outputFile -Encoding UTF8
$summary | ConvertTo-Json -Depth 8
Write-Host ""
Write-Host "Wrote bootstrap output to $outputFile"
