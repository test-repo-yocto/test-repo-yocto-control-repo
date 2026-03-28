# Requester-review policy

Source of truth: `src/policy/requester-review-policy.ts`

Workflow entrypoint: `.github/workflows/requester-review-policy.yml`

Runtime runner: `src/policy/run-requester-review-policy.ts`

## Fixed approval algorithm

- If `requester != pr_author`, requester approval is mandatory.
- If `requester == pr_author`, requester self-approval is ignored and another authorized reviewer must approve.

For this repository, an **authorized reviewer** is modeled as a reviewer whose approval would count toward GitHub's native required-review merge rules based on the repository collaborator permission returned by the GitHub API:

- counts: `admin`, `maintain`, `write`
- does **not** count: `triage`, `read`, `none`

## Review normalization rules

The evaluator normalizes pull-request reviews before policy decisions are made:

- require `id`, `state`, `submitted_at`, `commit_id`, and `user.login`
- collapse multiple reviews from the same reviewer to the latest review by `submitted_at` and `id`
- only `APPROVED` reviews are candidates for satisfying policy
- approvals whose `commit_id` does not match the current PR head are treated as stale and ignored
- later `DISMISSED`, `CHANGES_REQUESTED`, `COMMENTED`, or `PENDING` reviews override earlier approvals from the same reviewer

## Fail-closed behavior

The workflow fails closed when any required policy input is missing or ambiguous, including:

- requester metadata file missing or malformed
- `REQUESTER_LOGIN` repository variable missing or mismatched with the metadata file
- pull-request review payloads missing required fields
- reviewer permission data missing or unsupported
- no qualifying approval satisfying the fixed algorithm

## Readiness integration

Provisioning readiness can report `ready` only after target-repository evidence is observed:

1. `.github/workflows/requester-review-policy.yml` exists in the provisioned target repository
2. `.github/provisioning/requester-metadata.json` exists in the provisioned target repository
3. repository variable `REQUESTER_LOGIN` exists in the provisioned target repository
4. the canonical evaluator export is available in `src/policy/requester-review-policy.ts`

This keeps `enforcement_readiness_verify` fail-closed and avoids reporting `ready` from control-repo file presence alone.
