// ============================================================
// main.bicep - Orchestrator for all infrastructure modules
// ============================================================

targetScope = 'resourceGroup'

// ── Core Parameters ──────────────────────────────────────────
@description('Azure region for all resources')
param location string = 'swedencentral'

@description('Environment name prefix (dev, staging, prod)')
param environmentName string

@description('Container image to deploy (e.g. ghcr.io/org/repo:sha)')
param containerImage string

// ── Feature Flags ─────────────────────────────────────────────
@description('Deploy a new SQL database if none is found')
param deploySql bool = false

@description('Assign RBAC roles for managed identity')
param deployRoles bool = true

// ── Database Config (used only when deploying new DB) ────────
@description('SQL Admin username (required if deploySql=true)')
param sqlAdminLogin string = ''

@secure()
@description('SQL Admin password (required if deploySql=true)')
param sqlAdminPassword string = ''

@description('SQL Database name')
param sqlDatabaseName string = 'appdb'

// ── Existing Database Connection ─────────────────────────────
@description('Connection string if you already have a database (overrides SQL deployment)')
param existingDatabaseConnectionString string = ''

// ── Microsoft Foundry / AI ───────────────────────────────────
@description('Azure AI Foundry endpoint URL')
param foundryEndpoint string = ''

@description('Azure AI Foundry project endpoint URL')
param foundryProjectEndpoint string = ''

@secure()
@description('Azure AI Foundry API key')
param foundryApiKey string = ''

@description('Azure AI Foundry model deployment name')
param foundryDeployment string = ''

@description('Azure AI Foundry API version')
param foundryApiVersion string = '2024-10-21'

@description('Azure OpenAI endpoint URL (e.g. https://myresource.openai.azure.com)')
param azureOpenAiEndpoint string = ''

@secure()
@description('Azure OpenAI API key')
param azureOpenAiKey string = ''

@description('Azure OpenAI deployment name')
param azureOpenAiDeployment string = ''

@description('Azure OpenAI API version')
param azureOpenAiApiVersion string = '2024-10-21'

@secure()
@description('Optional direct OpenAI API key')
param openAiApiKey string = ''

@description('Optional direct OpenAI model name')
param openAiModel string = 'gpt-4.1-mini'

// ── Container App Config ─────────────────────────────────────
@description('Minimum replicas for the container app')
param minReplicas int = 0

@description('Maximum replicas for the container app')
@allowed([
  1
  2
  3
  5
])
param maxReplicas int = 5

@description('Container CPU cores')
@allowed([
  '0.25'
  '0.5'
  '0.75'
  '1.0'
  '1.25'
  '1.5'
  '1.75'
  '2.0'
])
param containerCpu string = '0.5'

@description('Container memory in GB')
@allowed([
  '0.5Gi'
  '1Gi'
  '1.5Gi'
  '2Gi'
  '3Gi'
  '4Gi'
])
param containerMemory string = '1Gi'

// ── Computed Names ────────────────────────────────────────────
var prefix = environmentName
var containerAppEnvName = '${prefix}-cae'
var containerAppName = '${prefix}-app'
var logAnalyticsName = '${prefix}-logs'
var appInsightsName = '${prefix}-appi'
var appConfigBase = replace(toLower('${prefix}appcfg'), '-', '')
var appConfigName = take('${appConfigBase}${take(uniqueString(resourceGroup().id), 6)}', 50)
var sqlServerName = '${prefix}-sql'
var userIdentityName = '${prefix}-id'
var acrNameBase = replace(toLower('${prefix}acr'), '-', '')
var acrName = length(acrNameBase) < 5 ? 'acr${take(uniqueString(resourceGroup().id), 8)}' : take(acrNameBase, 50)
var cosmosBase = replace(toLower('${prefix}cosmos'), '-', '')
var cosmosAccountName = take('${cosmosBase}${take(uniqueString(resourceGroup().id), 8)}', 44)
var cosmosDatabaseName = 'suppliercompare'
var cosmosContainerName = 'appstate'
var appStorageBase = replace(toLower('${prefix}st'), '-', '')
var appStorageAccountName = take('${appStorageBase}${take(uniqueString(resourceGroup().id), 8)}', 24)
var appStorageBlobContainerName = 'appstate'
var appStorageBlobName = 'app-storage.json'

// ── Azure Container Registry ────────────────────────────────
resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

// ── Managed Identity ─────────────────────────────────────────
resource userIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: userIdentityName
  location: location
}

// ── App Configuration (tenant-side non-secret config) ───────
resource appConfiguration 'Microsoft.AppConfiguration/configurationStores@2023-03-01' = {
  name: appConfigName
  location: location
  sku: {
    name: 'standard'
  }
}

// ── Cosmos DB (serverless) for app state ─────────────────────
resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2023-11-15' = {
  name: cosmosAccountName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    publicNetworkAccess: 'Enabled'
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    capabilities: [
      {
        name: 'EnableServerless'
      }
    ]
  }
}

resource cosmosSqlDatabase 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2023-11-15' = {
  name: cosmosDatabaseName
  parent: cosmosAccount
  properties: {
    resource: {
      id: cosmosDatabaseName
    }
  }
}

resource cosmosSqlContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2023-11-15' = {
  name: cosmosContainerName
  parent: cosmosSqlDatabase
  properties: {
    resource: {
      id: cosmosContainerName
      partitionKey: {
        paths: [
          '/tenant'
        ]
        kind: 'Hash'
      }
    }
  }
}

// ── Blob Storage for snapshot backup ─────────────────────────
resource appStorageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: appStorageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource appStorageContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  name: '${appStorageAccount.name}/default/${appStorageBlobContainerName}'
  properties: {
    publicAccess: 'None'
  }
}

resource appConfigDataReaderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(appConfiguration.id, userIdentity.id, 'app-configuration-data-reader')
  scope: appConfiguration
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '516239f1-63e1-4d78-a4de-a74fb236a071')
    principalId: userIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── SQL Module ───────────────────────────────────────────────
module sqlModule 'sql.bicep' = if (deploySql && empty(existingDatabaseConnectionString)) {
  name: 'sql-deployment'
  params: {
    location: location
    sqlServerName: sqlServerName
    sqlDatabaseName: sqlDatabaseName
    sqlAdminLogin: sqlAdminLogin
    sqlAdminPassword: sqlAdminPassword
    managedIdentityPrincipalId: userIdentity.properties.principalId
  }
}

// ── Roles Module ─────────────────────────────────────────────
module rolesModule 'roles.bicep' = if (deployRoles) {
  name: 'roles-deployment'
  params: {
    managedIdentityPrincipalId: userIdentity.properties.principalId
    assignFoundryRole: !empty(foundryEndpoint) || !empty(foundryProjectEndpoint) || !empty(azureOpenAiEndpoint)
    assignAcrPull: true
    acrName: containerRegistry.name
  }
}

// ── Resolve Connection String ─────────────────────────────────
// Priority: existingDatabaseConnectionString > newly deployed SQL
var resolvedConnectionString = !empty(existingDatabaseConnectionString)
  ? existingDatabaseConnectionString
  : (deploySql ? sqlModule!.outputs.connectionString : '')
var cosmosKey = cosmosAccount.listKeys().primaryMasterKey
var appStorageConnectionString = 'DefaultEndpointsProtocol=https;AccountName=${appStorageAccount.name};AccountKey=${appStorageAccount.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'

// ── Container Apps Module ─────────────────────────────────────
module containerAppModule 'containerapps.bicep' = {
  name: 'containerapp-deployment'
  params: {
    location: location
    containerAppEnvName: containerAppEnvName
    containerAppName: containerAppName
    logAnalyticsName: logAnalyticsName
    appInsightsName: appInsightsName
    appConfigEndpoint: appConfiguration.properties.endpoint
    containerImage: containerImage
    containerRegistryServer: containerRegistry.properties.loginServer
    userIdentityId: userIdentity.id
    userIdentityClientId: userIdentity.properties.clientId
    databaseConnectionString: resolvedConnectionString
    foundryEndpoint: foundryEndpoint
    foundryProjectEndpoint: foundryProjectEndpoint
    foundryApiKey: foundryApiKey
    foundryDeployment: foundryDeployment
    foundryApiVersion: foundryApiVersion
    azureOpenAiEndpoint: azureOpenAiEndpoint
    azureOpenAiKey: azureOpenAiKey
    azureOpenAiDeployment: azureOpenAiDeployment
    azureOpenAiApiVersion: azureOpenAiApiVersion
    openAiApiKey: openAiApiKey
    openAiModel: openAiModel
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    containerCpu: containerCpu
    containerMemory: containerMemory
    environmentName: environmentName
    cosmosEndpoint: cosmosAccount.properties.documentEndpoint
    cosmosDatabaseName: cosmosDatabaseName
    cosmosContainerName: cosmosContainerName
    cosmosKey: cosmosKey
    appStorageBlobConnectionString: appStorageConnectionString
    appStorageBlobContainerName: appStorageBlobContainerName
    appStorageBlobName: appStorageBlobName
  }
}

// ── Outputs ───────────────────────────────────────────────────
output containerAppUrl string = containerAppModule.outputs.containerAppUrl
output containerAppName string = containerAppName
output applicationInsightsName string = containerAppModule.outputs.applicationInsightsName
output appConfigurationName string = appConfiguration.name
output appConfigurationEndpoint string = appConfiguration.properties.endpoint
output managedIdentityClientId string = userIdentity.properties.clientId
output managedIdentityPrincipalId string = userIdentity.properties.principalId
