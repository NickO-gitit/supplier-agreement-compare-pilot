// ============================================================
// containerapps.bicep - Log Analytics + Container Apps Environment + App
// ============================================================

param location string
param containerAppEnvName string
param containerAppName string
param logAnalyticsName string
param containerImage string
param containerRegistryServer string
param userIdentityId string
param userIdentityClientId string
param databaseConnectionString string = ''
param foundryEndpoint string
param azureOpenAiEndpoint string = ''
@secure()
param azureOpenAiKey string = ''
param azureOpenAiDeployment string = ''
param azureOpenAiApiVersion string = '2024-10-21'
@secure()
param openAiApiKey string = ''
param openAiModel string = 'gpt-4.1-mini'
param minReplicas int
param maxReplicas int
param containerCpu string
param containerMemory string
param environmentName string

// ── Log Analytics Workspace ───────────────────────────────────
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logAnalyticsName
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ── Container Apps Environment ────────────────────────────────
resource containerAppEnv 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: containerAppEnvName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// ── Build env vars array dynamically ─────────────────────────
// Always included vars
var baseEnvVars = [
  {
    name: 'ENVIRONMENT'
    value: environmentName
  }
  {
    name: 'AZURE_CLIENT_ID'
    value: userIdentityClientId
  }
]

var dbEnvVar = !empty(databaseConnectionString) ? [
  {
    name: 'DATABASE_CONNECTION_STRING'
    value: databaseConnectionString
  }
] : []

var foundryEnvVars = !empty(foundryEndpoint) ? [
  {
    name: 'AZURE_FOUNDRY_ENDPOINT'
    value: foundryEndpoint
  }
] : []

var azureOpenAiEnvVars = concat(
  !empty(azureOpenAiEndpoint) ? [
    {
      name: 'AZURE_OPENAI_ENDPOINT'
      value: azureOpenAiEndpoint
    }
  ] : [],
  !empty(azureOpenAiDeployment) ? [
    {
      name: 'AZURE_OPENAI_DEPLOYMENT'
      value: azureOpenAiDeployment
    }
  ] : [],
  !empty(azureOpenAiApiVersion) ? [
    {
      name: 'AZURE_OPENAI_API_VERSION'
      value: azureOpenAiApiVersion
    }
  ] : [],
  !empty(azureOpenAiKey) ? [
    {
      name: 'AZURE_OPENAI_KEY'
      secretRef: 'azure-openai-key'
    }
  ] : []
)

var openAiEnvVars = concat(
  !empty(openAiModel) ? [
    {
      name: 'OPENAI_MODEL'
      value: openAiModel
    }
  ] : [],
  !empty(openAiApiKey) ? [
    {
      name: 'OPENAI_API_KEY'
      secretRef: 'openai-api-key'
    }
  ] : []
)

var allEnvVars = concat(baseEnvVars, dbEnvVar, foundryEnvVars, azureOpenAiEnvVars, openAiEnvVars)

// ── Registry Config ───────────────────────────────────────────
var managedIdentityRegistry = !empty(containerRegistryServer) ? [
  {
    server: containerRegistryServer
    identity: userIdentityId
  }
] : []

var registries = managedIdentityRegistry
var appSecrets = concat(
  !empty(azureOpenAiKey) ? [
    {
      name: 'azure-openai-key'
      value: azureOpenAiKey
    }
  ] : [],
  !empty(openAiApiKey) ? [
    {
      name: 'openai-api-key'
      value: openAiApiKey
    }
  ] : []
)

// ── Container App ─────────────────────────────────────────────
resource containerApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: containerAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${userIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: registries
      secrets: appSecrets
    }
    template: {
      containers: [
        {
          name: containerAppName
          image: containerImage
          resources: {
            cpu: json(containerCpu)
            memory: containerMemory
          }
          env: allEnvVars
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 3000
              }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-scaling'
            http: {
              metadata: {
                concurrentRequests: '10'
              }
            }
          }
        ]
      }
    }
  }
}

// ── Outputs ───────────────────────────────────────────────────
output containerAppUrl string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output containerAppId string = containerApp.id
