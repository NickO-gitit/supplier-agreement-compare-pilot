// ============================================================
// sql.bicep - Azure SQL Server + Database
// Only deployed when deploySql=true and no existing DB found
// ============================================================

param location string
param sqlServerName string
param sqlDatabaseName string
param sqlAdminLogin string
@secure()
param sqlAdminPassword string
param managedIdentityPrincipalId string

// ── SQL Server ────────────────────────────────────────────────
resource sqlServer 'Microsoft.Sql/servers@2022-05-01-preview' = {
  name: sqlServerName
  location: location
  properties: {
    administratorLogin: sqlAdminLogin
    administratorLoginPassword: sqlAdminPassword
    version: '12.0'
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'   // Adjust to 'Disabled' if using private endpoints
  }
  identity: {
    type: 'SystemAssigned'
  }
}

// ── Allow Azure services to connect ──────────────────────────
resource allowAzureServices 'Microsoft.Sql/servers/firewallRules@2022-05-01-preview' = {
  parent: sqlServer
  name: 'AllowAllWindowsAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// ── SQL Database ──────────────────────────────────────────────
resource sqlDatabase 'Microsoft.Sql/servers/databases@2022-05-01-preview' = {
  parent: sqlServer
  name: sqlDatabaseName
  location: location
  sku: {
    name: 'S0'     // Standard S0 – cheapest paid tier. Change to 'Basic' for dev
    tier: 'Standard'
    capacity: 10
  }
  properties: {
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    maxSizeBytes: 2147483648   // 2 GB
    zoneRedundant: false
    readScale: 'Disabled'
  }
}

// ── Entra ID / Managed Identity SQL Admin ─────────────────────
resource sqlServerAdmin 'Microsoft.Sql/servers/administrators@2022-05-01-preview' = {
  parent: sqlServer
  name: 'ActiveDirectory'
  properties: {
    administratorType: 'ActiveDirectory'
    login: 'managed-identity-admin'
    sid: managedIdentityPrincipalId
    tenantId: subscription().tenantId
  }
}

// ── Outputs ───────────────────────────────────────────────────
output sqlServerFqdn string = sqlServer.properties.fullyQualifiedDomainName
output sqlServerName string = sqlServer.name
output sqlDatabaseName string = sqlDatabase.name
// Standard ADO.NET connection string – swap auth method as needed
output connectionString string = 'Server=tcp:${sqlServer.properties.fullyQualifiedDomainName},1433;Initial Catalog=${sqlDatabaseName};Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;Authentication=Active Directory Managed Identity;'
