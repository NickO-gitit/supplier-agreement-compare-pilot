// ============================================================
// roles.bicep - RBAC role assignments for managed identity
// ============================================================

param managedIdentityPrincipalId string
param assignAcrPull bool = false
param acrName string = ''

// ── Built-in Role Definition IDs ─────────────────────────────
var roles = {
  // Container Registry
  acrPull:                       '7f951dda-4ed3-4680-a7ca-43fe172d538d'
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = if (assignAcrPull) {
  name: acrName
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
  assignAcrPull ? 'AcrPull' : ''
]
