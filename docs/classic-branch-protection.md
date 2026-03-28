# Classic branch protection contract

Task 5 hardening is intentionally implemented with **classic branch protection only** on `main`.

Rulesets are explicitly out of scope for this repository's baseline hardening path.

## Canonical `main` protection

Source of truth: `src/github/branch-protection.ts`

The control repo applies this baseline contract after repository creation:

- branch: `main`
- pull requests required before merge via `required_pull_request_reviews`
- at least `1` approving review required
- required status checks enabled in strict mode
- required status checks include `requester-review-policy`
- admin enforcement enabled (`enforce_admins: true`)
- direct pushes blocked by explicit empty push allowlists:
  - `restrictions.users = []`
  - `restrictions.teams = []`
  - `restrictions.apps = []`
- force pushes disabled
- branch deletions disabled
- conversation resolution required
- linear history required

## No-bypass policy

Classic branch protection does not provide a separate ruleset-style bypass list. This repository therefore encodes no-bypass intent through the classic controls it can verify directly:

- `enforce_admins: true` means administrators are subject to the same protection rules
- push restrictions are present and empty, so no user/team/app is allowlisted for direct pushes to `main`
- required checks include `requester-review-policy`, making the later requester-review workflow part of merge readiness

The required check is now backed by `.github/workflows/requester-review-policy.yml`, which executes the canonical evaluator in `src/policy/requester-review-policy.ts`.

## Verification contract

`verifyClassicMainBranchProtection(...)` treats the following as configuration drift:

- `requester-review-policy` missing from required checks
- approving review count below `1`
- admin enforcement disabled
- push restrictions omitted or containing any allowlisted actor
- strict status checks disabled
- force pushes or deletions enabled

`applyClassicMainBranchProtection(...)` applies the canonical payload and then re-reads branch protection from GitHub to verify the live state.
