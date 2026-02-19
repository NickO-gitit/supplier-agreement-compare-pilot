// ============================================================
// roles.bicep - RBAC role assignments for managed identity
// ============================================================

param managedIdentityPrincipalId string
param assignFoundryRole bool = false
param assignAcrPull bool = false
param acrName string = ''

// ── Built-in Role Definition IDs ─────────────────────────────
var roles = {
  // Storage
  storageBlobDataContributor:    'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  storageQueueDataContributor:   '974c5e8b-45b9-4653-ba55-5f855dd0fb88'

  // Cognitive / AI
  cognitiveServicesUser:         'a97b65f3-24c7-4388-baec-2e87135dc908'
  cognitiveServicesOpenAIUser:   '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

  // Key Vault
  keyVaultSecretsUser:           '4633458b-17de-408a-b874-0445c86b69e6'

  // SQL
  sqlDbContributor:              '9b7fa17d-e63e-47b0-bb0a-15c516ac86ec'

  // Container Registry
  acrPull:                       '7f951dda-4ed3-4680-a7ca-43fe172d538d'
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = if (assignAcrPull) {
  name: acrName
}

// ── Cognitive Services / AI Foundry role ─────────────────────
resource cognitiveServicesUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignFoundryRole) {
  name: guid(resourceGroup().id, managedIdentityPrincipalId, roles.cognitiveServicesUser)
  scope: resourceGroup()
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.cognitiveServicesUser)
    principalId: managedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource cognitiveServicesOpenAIRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignFoundryRole) {
  name: guid(resourceGroup().id, managedIdentityPrincipalId, roles.cognitiveServicesOpenAIUser)
  scope: resourceGroup()
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.cognitiveServicesOpenAIUser)
    principalId: managedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// ── Key Vault Secrets User ────────────────────────────────────
resource keyVaultSecretsUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, managedIdentityPrincipalId, roles.keyVaultSecretsUser)
  scope: resourceGroup()
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsUser)
    principalId: managedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// ── Storage Blob ──────────────────────────────────────────────
resource storageBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, managedIdentityPrincipalId, roles.storageBlobDataContributor)
  scope: resourceGroup()
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageBlobDataContributor)
    principalId: managedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// ── ACR Pull ─────────────────────────────────────────────────
resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignAcrPull) {
  name: guid(acr.id, managedIdentityPrincipalId, roles.acrPull)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
    principalId: managedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output rolesAssigned array = [
  'Key Vault Secrets User'
  'Storage Blob Data Contributor'
  assignFoundryRole ? 'Cognitive Services User' : ''
  assignFoundryRole ? 'Cognitive Services OpenAI User' : ''
  assignAcrPull ? 'AcrPull' : ''
]
