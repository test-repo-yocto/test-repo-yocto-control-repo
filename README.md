# test-repo-yocto control repository

Greenfield control repository scaffold for future automation that provisions hardened private repositories in `test-repo-yocto`.

## Current scope

This repository currently establishes:

- repository skeleton for workflows, source, tests, and docs
- provisioning dispatch contract
- canonical slug validation and normalization rules
- GitHub App installation-token auth boundary and centralized GitHub REST client wrappers
- single-template source contract via one approved `owner/repo` configuration value
- requester metadata contract covering the repository variable mirror and tracked metadata file
- provisioning orchestration that validates requests, resolves the approved template, preflights duplicates, and supports dry-run plus sandbox execution
- post-create target-repository verification that the approved template actually propagated `README.md`, `LICENSE`, and `.github/workflows/ci.yml`
- classic branch protection hardening for `main`, including required PR review, required checks, and explicit no-bypass admin/push settings
- requester-review enforcement workflow and deterministic reviewer-policy evaluator for `requester-review-policy`
- explicit partial-failure modeling (`failed`, `quarantined`, `not_ready`, `success`) with machine-readable remediation output
- quarantine reporting for repositories created before hardening completes/validates
- success-state verification that separates create+hardening scope success from full readiness
- validation tests for valid and invalid slug inputs plus auth/client failure modes

Still not implemented:

- live GitHub-required-check context proof from real sandbox/org runs (local harness remains explicit about this limitation)

## Repository layout

```text
.github/workflows/      GitHub Actions scaffolding
docs/                   Contract and design docs
src/                    Canonical provisioning contract and GitHub boundary code
tests/                  Validation and GitHub auth/client tests
```

## Provisioning dispatch contract

The dispatch contract is centered on these operator-facing inputs:

- `repo_slug` (required): lowercase slug for the requested project repository
- `description` (required): repository description to apply during provisioning
- `execution_mode` (optional, internal-only): `dry-run` or `sandbox`; defaults to `dry-run`

The final repository name is always derived as `proj-${repo_slug}` and never accepted directly as an input.

## Slug policy

Canonical implementation: `src/contracts/provisioning.ts`

- input must already be lowercase
- allowed characters: `a-z`, `0-9`, `-`
- underscores are rejected
- uppercase is rejected
- double dashes are rejected
- leading and trailing dashes are rejected
- one canonical final-name max length: `50`
- since the final name must be `proj-<slug>`, the slug portion can consume at most `45` characters

## Local validation

```bash
npm install
npm test
npm run check
```

See `docs/provisioning-contract.md` for the normalized contract shared by future workflow and API work.

See `docs/github-app-permissions.md` for the GitHub App permission matrix and auth/client boundary.

See `docs/requester-metadata-contract.md` for the single-template source contract, metadata file path, and fail-closed requester metadata schema.

See `docs/provisioning-workflow.md` for the stage model, duplicate-preflight semantics, and dry-run vs sandbox behavior.

Provisioning result semantics are intentionally explicit:

- `scopeSuccess=true` means create + hardening apply + hardening verify passed
- `scopeSuccess=true` now also requires target-repository verification of required template artifacts (`README.md`, `LICENSE`, `.github/workflows/ci.yml`)
- full success (`ok=true`) requires `outcome=success` and `readiness=ready`
- partial/non-ready states (`failed`, `quarantined`, `not_ready`) include machine-readable `failureClass` + `remediation`

See `docs/classic-branch-protection.md` for the canonical classic branch protection payload and verification contract.

See `docs/requester-review-policy.md` for the requester-vs-author approval algorithm, stale/dismissed review handling, and fail-closed fallback behavior.

See `docs/task-8-evidence.md` for the mocked sandbox verification harness, evidence commands, generated artifact names, and the explicit local-vs-live required-check-context limitation.

## Task 8 evidence commands

```bash
npm run test:task8
npm run evidence:task8
```

Scenario-specific evidence reruns:

```bash
npm run evidence:task8:success
npm run evidence:task8:policy-failure
```

Artifacts are written under `.sisyphus/evidence/`. Task 8 evidence is clearly labeled as local mocked sandbox integration, not fake live GitHub proof.
