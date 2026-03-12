# CAF Alignment Analysis

Date: 2026-03-12

## Scope Reviewed
- `CAF/Shared with customer/1. CAF Pre-questions for customers v3.5.xlsx`
- `CAF/Shared with customer/2. CAF Abstract v3.5.docx`
- `CAF/Shared with customer/3. CAF Foundation v3.5.docx`
- `CAF/Shared with customer/4. CAF Networking v3.5.docx`
- `CAF/Shared with customer/5. CAF Naming Convention v3.5.docx`
- `CAF/Shared with customer/6. CAF Policy Baseline v3.5.xlsx`
- `CAF/Shared with customer/7. CAF Region Subnetting v3.5.xlsx`
- `CAF/Shared with customer/8. CAF High Level Design v3.51.vsdx`
- `CAF/Shared with customer/9. CAF Security v3.5.docx`

Compared against:
- `.github/workflows/deploy-container-apps.yml`
- `infra/azure/main.bicep`
- `infra/azure/containerapps.bicep`
- `infra/azure/roles.bicep`
- `infra/azure/sql.bicep`
- `server/dataStore.mjs`
- `server/loadTenantConfig.mjs`

## Overall Match
- The repository aligns well as a workload-level deployment stack (Container App + app runtime + CI/CD).
- CAF package is enterprise platform-oriented (management groups, subscription architecture, policy baseline, network governance).
- Result: partial alignment. App-level controls exist, but most tenant/platform CAF controls are not codified.

## Current Strengths
- OIDC-based Azure login and provider checks in CI/CD.
- Entra auth enforcement in deployment pipeline.
- Managed Identity used for App Configuration runtime loading.
- Monitoring foundation (Log Analytics + App Insights).
- Environment-prefixed naming pattern in IaC.

## Key Gaps and Recommended Fixes

### 1) Foundation and Governance
Gap:
- No management group hierarchy, landing zone segmentation, or subscription model from CAF.

Fix:
- Split IaC into two layers:
  - Platform CAF baseline (management groups, subscriptions, scopes, controls)
  - Workload module (current app stack per landing zone)

### 2) Policy Baseline
Gap:
- No policy/initiative assignment module for CAF baseline controls.

Fix:
- Add a Bicep policy assignment module with parameterized scopes and rollout toggles.

### 3) Networking and Isolation
Gap:
- Public-by-default posture:
  - Container app ingress is external.
  - ACR public network access enabled.
  - Cosmos public network access enabled.
  - SQL public network access enabled.
  - SQL firewall allows Azure services.

Fix:
- Move to private-by-default:
  - VNet-integrated Container Apps environment
  - Private endpoints + Private DNS for Cosmos/SQL/ACR/AppConfig/Key Vault
  - Optional controlled ingress via Front Door/App Gateway WAF

### 4) Identity and Access
Gap:
- Cosmos account key is used at runtime; no MI/RBAC path for Cosmos data access.
- Several RBAC assignments are broad at resource-group scope.

Fix:
- Move Cosmos access to Managed Identity + RBAC.
- Reduce role scopes to minimum required resource scope.

### 5) Naming Convention
Gap:
- Naming is consistent but does not fully enforce CAF naming blocks for all resources.

Fix:
- Introduce centralized naming function/module and enforce prefix-name-region-type-env pattern where feasible.

### 6) Tagging, Cost, and Locks
Gap:
- No required tag baseline or policy-backed enforcement.
- No budget/anomaly automation in IaC.
- No lock strategy for critical shared resources.

Fix:
- Enforce required tags at deploy and policy levels.
- Add budgets and action groups.
- Add CanNotDelete locks for critical platform resources.

### 7) CAF Operational Artifacts
Gap:
- CAF docs recommend governance artifacts (document placement, standard resources, etc.); not codified as repeatable resources.

Fix:
- Add optional governance module for CAF storage artifacts and diagnostics standards.

## Document-by-Document Alignment
- `2. CAF Abstract`: partial alignment.
- `3. CAF Foundation`: low alignment.
- `4. CAF Networking`: low alignment.
- `5. CAF Naming Convention`: partial alignment.
- `6. CAF Policy Baseline`: low alignment.
- `7. CAF Region Subnetting`: low alignment.
- `8. CAF High Level Design`: conceptual mismatch (CAF is broader enterprise target).
- `9. CAF Security`: partial alignment.

## Recommended Phasing
1. Phase 1: Workload hardening (private endpoints, RBAC tightening, keyless runtime access where possible).
2. Phase 2: Platform baseline (management groups, landing zone structure, policy scaffolding).
3. Phase 3: Policy rollout and governance automation (tags, budgets, locks, security initiatives).
