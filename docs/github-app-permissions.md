# GitHub App auth and permission boundary

This repository uses a **GitHub App installation token** as the only runtime authentication boundary for GitHub REST calls. A personal access token is **not** a primary path and is intentionally ignored by the auth/client modules.

## Boundary modules

- `src/github/auth.ts`: creates the app JWT, exchanges it for an installation token, validates the returned permission set, and exposes cached installation-token auth.
- `src/github/client.ts`: centralizes GitHub REST requests and exposes the narrow operations needed by later provisioning, hardening, and PR-review tasks.
- `src/github/permissions.ts`: documents the exact repository permission matrix and is reused by auth validation/tests.

## Required GitHub App repository permissions

| Future operation | Required permission(s) | Why this boundary requires it now |
| --- | --- | --- |
| Organization repository creation | `administration:write`, `metadata:read` | Needed to create new private repositories and inspect target repository metadata consistently. |
| Repository variable writes / metadata | `actions:write`, `metadata:read` | Needed for later requester metadata persistence through repository Actions variables. |
| Classic branch protection updates | `administration:write`, `contents:read`, `metadata:read` | Needed to apply and verify classic protection against `main` after repo creation. |
| Pull request review inspection | `pull_requests:read`, `metadata:read` | Needed for later requester-review policy evaluation. |
| Commit status inspection | `statuses:read`, `metadata:read` | Needed for later required-check and merge-readiness reads. |

## Auth flow

1. Load `appId`, `installationId`, and PEM `privateKey`.
2. Sign a short-lived GitHub App JWT locally with RS256.
3. Exchange that JWT for an installation access token via `POST /app/installations/{installation_id}/access_tokens`.
4. Validate the returned permission map against the matrix above.
5. Reuse the cached installation token until it is within one minute of expiry.

## Client surface prepared for later tasks

- `createOrganizationRepository(...)`
- `upsertRepositoryVariable(...)`
- `updateBranchProtection(...)`
- `getBranchProtection(...)`
- `listPullRequestReviews(...)`
- `listCommitStatuses(...)`
- `request(...)` for any additional GitHub REST operation that still needs the same auth boundary

## Failure semantics

- Installation-token exchange returning `401` => `GitHubAppAuthError`
- Missing required GitHub App permissions => `GitHubAppPermissionError` with explicit missing permission names
- GitHub API `403` after successful auth => `GitHubAppPermissionError`
- No PAT-primary fallback exists in this boundary
