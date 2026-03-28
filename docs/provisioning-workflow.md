# Provisioning workflow orchestration

## Stage model

The orchestration path is intentionally linear and emits one structured operator-facing record per stage:

1. `contract_validation`
2. `mode_resolution`
3. `template_source_resolution`
4. `duplicate_target_preflight`
5. `create_or_plan`
6. `branch_protection_apply`
7. `branch_protection_verify`
8. `template_artifact_verify`
9. `enforcement_readiness_verify`

Each stage is logged as a JSON line with:

```json
{
  "stage": "duplicate_target_preflight",
  "status": "success",
  "summary": "Target repository name is available; create path may proceed.",
  "details": {
    "owner": "test-repo-yocto-sandbox",
    "repository": "proj-my-service"
  }
}
```

Supported stage statuses are `success`, `failure`, `planned`, and `skipped`.

## Result and readiness model

`runProvisioningWorkflow(...)` now returns a top-level outcome model separate from individual stage status:

- `outcome`: `success | failed | quarantined | not_ready`
- `readiness`: `ready | not_ready`
- `scopeSuccess`: `true` only when create + hardening apply + hardening verify + required template artifact verification all pass
- `scope`: machine-readable booleans for `repositoryCreated`, `hardeningApplied`, `hardeningVerified`, `templateArtifactsVerified`, `enforcementReady`
- `failureClass`: machine-readable failure taxonomy (for example `hardening_apply_failed`, `enforcement_not_ready`)
- `remediation`: machine-readable remediation actions
- `quarantine`: present when a partially-created repository must be treated as non-ready

The workflow only returns `ok=true` when `outcome=success` and `readiness=ready`.

## Execution behavior

### Dry-run

- validates the canonical dispatch contract
- resolves the approved template source and requester-metadata artifacts
- checks for duplicate target repositories in the sandbox target owner
- emits a `planned` `create_or_plan` stage
- does **not** call GitHub create-from-template
- emits `enforcement_readiness_verify=planned`
- returns `outcome=not_ready` with remediation because no repository was provisioned/verified

### Sandbox

- performs the same validation and duplicate preflight as dry-run
- creates the target repo via GitHub's template-generation path
- always requests `private: true`
- applies classic branch protection to `main`
- verifies the live branch protection state after application
- verifies that the target repository actually contains the required template-delivered artifacts: `README.md`, `LICENSE`, and `.github/workflows/ci.yml`
- fails immediately if the target repo already exists
- verifies requester-review enforcement readiness (future-readiness gate)

## Partial-failure and quarantine semantics

- If repository creation succeeds but hardening application fails, the result is `outcome=quarantined` with repository details included.
- If hardening verification detects drift after apply, the result is `outcome=quarantined` and includes drift issues plus remediation actions.
- Quarantined results include a `quarantine` object so operators can treat the repo as visibly non-ready until remediated.

## Enforcement-not-ready semantics

- Until requester-review enforcement verification is implemented/available, orchestration can return `outcome=not_ready` even when `scopeSuccess=true`.
- This prevents false “fully ready” success reporting while preserving machine-readable proof that current create+hardening scope succeeded.

## Duplicate handling

- Duplicate targets are a **preflight failure**.
- A repo that already exists is never treated as success, partial success, or reusable state.
- The create path is skipped after a duplicate is detected.

## Target owner configuration

- `PROVISIONING_SANDBOX_OWNER` selects the sandbox owner/org for dry-run preflight and sandbox create calls.
- If unset, the orchestration falls back to `test-repo-yocto`.

## Workflow entrypoint

`.github/workflows/provision-repository.yml` installs dependencies and runs:

```bash
npx tsx src/provisioning/run-workflow.ts
```

Required runtime inputs/config:

- `repo_slug`
- `description`
- `execution_mode`
- `PROVISIONING_GITHUB_APP_ID`
- `PROVISIONING_GITHUB_APP_INSTALLATION_ID`
- `PROVISIONING_GITHUB_APP_PRIVATE_KEY`
- `PROVISIONING_TEMPLATE_REPOSITORY`
- optional `PROVISIONING_TEMPLATE_REPOSITORY_REF`
- optional `PROVISIONING_SANDBOX_OWNER`

GitHub Actions repository/org secrets cannot start with `GITHUB_`, so the supported Actions contract uses the `PROVISIONING_GITHUB_APP_*` secret family. Legacy `GITHUB_APP_*` env names are retained only as local/manual fallback inputs outside the primary Actions setup path.

## Current boundary

Requester metadata artifacts are persisted during sandbox repository creation by writing:

- repository variable `REQUESTER_LOGIN`
- tracked file `.github/provisioning/requester-metadata.json`

Readiness now depends on target-repository evidence: the target repo must expose the required template artifacts (`README.md`, `LICENSE`, `.github/workflows/ci.yml`) plus requester-review workflow + requester metadata artifacts (file + variable) before `outcome=success/readiness=ready` is returned.

Task 5 intentionally extended the stage model so sandbox success now requires classic `main` branch protection application plus verification.
