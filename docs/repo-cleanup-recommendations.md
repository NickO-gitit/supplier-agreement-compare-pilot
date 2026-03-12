# Repository Cleanup and Restructuring Recommendations

Date: 2026-03-12

## Objective
1. Replace the non-descriptive `hexatronic` infra folder with a reusable, portable structure.
2. Make deployment/infra files easy to copy into other webapps without rewriting CI logic.
3. Keep behavior unchanged for this app.

## Decision Implemented
The infra package has been renamed and normalized to:

- `infra/azure/` (new canonical location)

This replaces the old `hexatronic/` naming and provides a clear, reusable path.

## New Target Structure
```text
/
  .github/workflows/
    deploy-container-apps.yml
  infra/
    azure/
      main.bicep
      containerapps.bicep
      roles.bicep
      sql.bicep
      main.parameters.json
      bootstrap-tenant.ps1
      deploy.sh
      deploy.yml
      README.md
  api/
  server/
  src/
  docs/
```

## Reusability Contract (for other webapps)
To reuse deployment in another app, copy:

1. `infra/azure/*`
2. `.github/workflows/deploy-container-apps.yml`
3. `Dockerfile` (or equivalent image build config)

Required behavior now:

- Active workflow resolves infra directory dynamically in this order:
  1. `./infra/azure`
  2. `./infra`
  3. `./Project.Infra`
  4. `./`

This means the same workflow can be transplanted with minimal edits.

## What Was Changed for Portability
1. Moved infra IaC + scripts from `hexatronic/` to `infra/azure/`.
2. Updated active workflow to resolve infra location dynamically instead of hardcoding `./hexatronic/main.bicep`.
3. Updated infra docs and helper template workflow references to the new path.
4. Updated CAF analysis references to `infra/azure/*`.

## Remaining Cleanup Recommendations

### Confirmed Safe Deletions
- `tmp_test_delete.txt`
- `{console.error(e.message)`
- `tmp_mockup_docx/`
- `tmp_mockup_docx2/`
- `infra/azure/main.json` (generated artifact, local/untracked)
- `dist/` (build output, regenerate as needed)

### Probable Deletions (Needs Confirmation)
- `CODEX_INSTRUCTIONS.md`
- `MANUAL_DEPLOYMENT_NO_CODEX.txt`
- `SECURITY_AUDIT_RECOMMENDATIONS.md`
- `tenant-bootstrap-pilot-prod.json`
- `mockup2_table.docx`
- `mockup2_table_copy.docx`
- `infra/azure/deploy.yml` (template workflow, not active in `.github/workflows`)
- `api/host.json`
- `api/*/function.json`
- `api/package.json`
- `.claude/settings.local.json`

### Code-Level Cleanup Candidates
- Unreferenced UI files in `src/components/`:
  - `APIConfigModal.tsx`
  - `DiffViewer.tsx`
  - `FileUpload.tsx`
  - `Header.tsx`
  - `NotesPanel.tsx`
  - `RiskAnalysisPanel.tsx`
- `src/services/groupingAutomation.ts` appears unreferenced.

## Risks
1. Removing Azure Functions metadata files may break Azure Functions deployment if used externally.
2. Removing local docs/mockups may remove operational context.
3. Removing legacy exports in `src/services/storage.ts` may break external scripts.

## Validation Checklist
1. Parse workflow YAML successfully.
2. Verify no hardcoded `hexatronic/main.bicep` references in active workflows.
3. Run app build.
4. Run one deployment dry run in a non-prod RG.
5. Confirm outputs (Container App URL, App Config seed, Key Vault access).

## Invasiveness
Medium.
