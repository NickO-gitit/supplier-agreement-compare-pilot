// ============================================================
// containerapps.bicep - Log Analytics + Container Apps Environment + App
// ============================================================

param location string
param containerAppEnvName string
param containerAppName string
param logAnalyticsName string
param appInsightsName string
param containerImage string
param containerRegistryServer string
param userIdentityId string
param userIdentityClientId string
param databaseConnectionString string = ''
param foundryEndpoint string
param foundryProjectEndpoint string = ''
@secure()
param foundryApiKey string = ''
param foundryDeployment string = ''
param foundryApiVersion string = '2024-10-21'
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

// ── Application Insights (workspace-based) ───────────────────
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
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

var foundryProjectEnvVars = concat(
  !empty(foundryProjectEndpoint) ? [
    {
      name: 'FOUNDRY_PROJECT_ENDPOINT'
      value: foundryProjectEndpoint
    }
  ] : [],
  !empty(foundryDeployment) ? [
    {
      name: 'FOUNDRY_DEPLOYMENT'
      value: foundryDeployment
    }
  ] : [],
  !empty(foundryApiVersion) ? [
    {
      name: 'FOUNDRY_API_VERSION'
      value: foundryApiVersion
    }
  ] : [],
  !empty(foundryApiKey) ? [
    {
      name: 'FOUNDRY_API_KEY'
      secretRef: 'foundry-api-key'
    }
  ] : []
)

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

var appInsightsEnvVars = [
  {
    name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
    value: appInsights.properties.ConnectionString
  }
  {
    name: 'APPINSIGHTS_INSTRUMENTATIONKEY'
    value: appInsights.properties.InstrumentationKey
  }
]

var allEnvVars = concat(
  baseEnvVars,
  appInsightsEnvVars,
  dbEnvVar,
  foundryEnvVars,
  foundryProjectEnvVars,
  azureOpenAiEnvVars,
  openAiEnvVars
)

// ── Registry Config ───────────────────────────────────────────
var managedIdentityRegistry = !empty(containerRegistryServer) ? [
  {
    server: containerRegistryServer
    identity: userIdentityId
  }
] : []

var registries = managedIdentityRegistry
var appSecrets = concat(
  !empty(foundryApiKey) ? [
    {
      name: 'foundry-api-key'
      value: foundryApiKey
    }
  ] : [],
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
output applicationInsightsName string = appInsights.name
