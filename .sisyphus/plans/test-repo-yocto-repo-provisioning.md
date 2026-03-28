# test-repo-yocto Org Repo Provisioning

## TL;DR
> **Summary**: Build a greenfield GitHub App-driven automation repository in `test-repo-yocto` that provisions new private `proj-*` repositories from a single template and hardens them with branch protection plus a requester-review enforcement workflow.
> **Deliverables**:
> - New control repository for provisioning automation
> - Provisioning workflow with dry-run and sandbox validation modes
> - Baseline hardening for created repositories
> - Requester-review enforcement workflow and verification suite
> **Effort**: Large
> **Parallel**: YES - 3 waves
> **Critical Path**: 1 → 2 → 4 → 5 → 8

## Context
### Original Request
Create a project under `test-repo-yocto` where users can trigger a GitHub Actions workflow to automatically create repositories under the org.

### Interview Summary
- New repositories are always created under `test-repo-yocto`.
- Provisioning is triggered by `workflow_dispatch`.
- Required inputs are `repo slug` and `description`.
- New repositories must always be private.
- New repositories must use the `proj-` prefix.
- Creation is immediate; there is no pre-provision approval gate.
- A single template repository is used.
- Created repositories must include README, LICENSE, and a default CI workflow.
- `main` must block direct merge and require PRs.
- Merge policy must require the repository requester to approve, except when the requester is the PR author; in that case another authorized reviewer must approve.
- Validation must use `dry-run + sandbox repo`.

### Metis Review (gaps addressed)
- Lock auth model to **GitHub App**, not PAT.
- Define success as **created + hardened + enforcement verified**, not merely “repo exists.”
- Make provisioning idempotent and define partial-failure handling.
- Fix requester-identity persistence and reviewer eligibility rules up front.
- Keep scope bounded to create-only automation; no team bootstrap, multi-template support, or dashboard work.

## Work Objectives
### Core Objective
Ship a decision-complete provisioning system that safely creates hardened `proj-*` repositories in `test-repo-yocto` using a GitHub App and enforces a requester-review merge policy through required status checks.

### Deliverables
- Control repository inside `test-repo-yocto` for provisioning automation
- GitHub App auth/configuration layer for org repo creation and repository hardening
- `workflow_dispatch` provisioning workflow supporting `dry-run` and sandbox execution
- Single template repository contract and propagation verification
- Repository hardening step applying private visibility, classic `main` branch protection, required checks, and no-bypass policy
- Requester metadata persistence strategy
- Enforcement workflow that validates requester-review policy on PR activity
- Automated tests and sandbox evidence for happy-path and failure-path behavior

### Definition of Done (verifiable conditions with commands)
- A provisioning dispatch with valid sample inputs creates a private repository named `proj-<slug>` in the sandbox target.
- The created repository contains README, LICENSE, and default CI files from the approved template.
- `main` rejects direct push/merge and requires PR + required checks.
- A PR opened by a non-requester cannot merge until the stored requester approves and the requester-review check passes.
- A PR opened by the requester cannot self-approve and only merges after another authorized reviewer approves and the requester-review check passes.
- An invalid slug or duplicate target repo causes the workflow to fail before provisioning.
- Partial failures are surfaced with explicit operator output and quarantine/remediation instructions.

### Must Have
- GitHub App authentication
- `proj-` naming enforcement
- Private-only provisioning
- Idempotent provisioning flow
- Dry-run mode and sandbox validation path
- Requester-review enforcement as a required status check
- Audit-friendly logs and evidence capture
- Classic branch protection on `main` as the single hardening mechanism

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- No PAT-primary architecture
- No public repositories
- No multiple templates
- No collaborator/team bootstrap automation
- No lifecycle actions beyond create/harden/verify
- No dashboard/UI build
- No merge policy that depends on undocumented GitHub behavior

## Verification Strategy
> ZERO HUMAN INTERVENTION — all verification is agent-executed.
- Test decision: tests-after using the control repo’s native test stack chosen by the implementer, plus mocked GitHub API tests and sandbox integration tests
- QA policy: Every task includes agent-executed scenarios
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: foundation and contracts
- Task 1: create control repo skeleton and configuration contract
- Task 2: implement GitHub App auth and API client boundary
- Task 3: define template contract and requester metadata persistence

Wave 2: provisioning and hardening
- Task 4: implement provisioning workflow and validation/idempotency flow
- Task 5: apply repository hardening and required checks/rules
- Task 6: implement partial-failure handling, quarantine reporting, and dry-run behavior

Wave 3: policy enforcement and end-to-end verification
- Task 7: implement requester-review enforcement workflow logic
- Task 8: add mocked tests, sandbox integration tests, and evidence automation

### Dependency Matrix (full, all tasks)
| Task | Depends On | Notes |
|---|---|---|
| 1 | - | Establish control repo structure and config contract |
| 2 | 1 | Auth boundary needed before provisioning/hardening |
| 3 | 1 | Template + requester metadata contract feeds tasks 4, 5, 7 |
| 4 | 2, 3 | Provisioning uses auth and template/metadata contract |
| 5 | 2, 3, 4 | Hardening requires created repo plus auth |
| 6 | 4, 5 | Partial-failure semantics wrap provisioning/hardening |
| 7 | 3, 5 | Enforcement depends on requester metadata and required checks |
| 8 | 4, 5, 6, 7 | E2E verification after all core behavior exists |
| F1-F4 | 1-8 | Final verification after implementation |

### Agent Dispatch Summary (wave → task count → categories)
- Wave 1 → 3 tasks → `balanced`, `high`
- Wave 2 → 3 tasks → `high`, `deep`
- Wave 3 → 2 tasks → `high`, `unspecified-high`
- Final verification → 4 tasks → `oracle`, `unspecified-high`, `deep`

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Create the control repository skeleton and provisioning contract

  **What to do**: Create the new automation repository under `test-repo-yocto`, add the baseline folder structure for workflows, scripts/actions, tests, and docs, and define a single source of truth for provisioning configuration. Fix the dispatch contract to `repo_slug` + `description` plus internal execution mode (`dry-run` vs sandbox) if needed. Document exact slug normalization rules: lowercase, `proj-` prefix enforced, allowed characters `[a-z0-9-]`, no double dashes, max length chosen once and used everywhere.
  **Must NOT do**: Do not introduce multi-template support, public visibility options, or team bootstrap inputs.

  **Recommended Agent Profile**:
  - Category: `balanced` — Reason: greenfield repo scaffolding plus policy contract definition
  - Skills: `[]` — no special skill required
  - Omitted: [`git-master`] — no commit work in this task itself

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [2, 3] | Blocked By: []

  **References**:
  - Plan: `/Users/krnomad/work/ai/gb-test/.sisyphus/plans/test-repo-yocto-repo-provisioning.md` — confirmed requirements and guardrails
  - External: `https://docs.github.com/en/actions/using-workflows/manually-running-a-workflow` — workflow_dispatch operating model
  - External: `https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows` — workflow trigger syntax and inputs

  **Acceptance Criteria**:
  - [ ] Control repo structure exists with dedicated locations for provisioning workflow, enforcement workflow, tests, and docs.
  - [ ] Dispatch input contract is documented and implemented consistently.
  - [ ] Slug validation rules are defined once and reused across workflow and test layers.

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: Valid dispatch contract accepted
    Tool: Bash
    Steps: Run the repo's validation/test command against sample input `repo_slug=my-service`, `description="sandbox repo"`
    Expected: Validation passes and normalized target name resolves to `proj-my-service`
    Evidence: .sisyphus/evidence/task-1-control-repo-contract.txt

  Scenario: Invalid slug rejected
    Tool: Bash
    Steps: Run the same validation with `repo_slug=Bad_Name`
    Expected: Validation fails with explicit slug-policy error before any provisioning step executes
    Evidence: .sisyphus/evidence/task-1-control-repo-contract-error.txt
  ```

  **Commit**: YES | Message: `feat(provisioning): define control repo contract` | Files: [control repo scaffolding, validation contract docs/tests]

- [x] 2. Implement GitHub App authentication and GitHub API boundary

  **What to do**: Implement a single auth/client layer that uses a GitHub App installation token for org repo creation, repository configuration, rules/protection application, and review/status inspection. Define the exact permission matrix required by the App and codify it in docs/tests. Centralize all GitHub REST interactions behind this boundary.
  **Must NOT do**: Do not use PAT as the primary runtime path; PAT may only exist as an explicitly documented local fallback if unavoidable for tests.

  **Recommended Agent Profile**:
  - Category: `high` — Reason: authentication and API boundary correctness is security-critical
  - Skills: `[]`
  - Omitted: [`git-master`] — not a git workflow task

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [4, 5] | Blocked By: [1]

  **References**:
  - Plan: `/Users/krnomad/work/ai/gb-test/.sisyphus/plans/test-repo-yocto-repo-provisioning.md` — auth model locked to GitHub App
  - External: `https://docs.github.com/en/rest/repos/repos#create-an-organization-repository` — org repo creation endpoint
  - External: `https://docs.github.com/en/organizations/managing-organization-settings/restricting-repository-creation-in-your-organization` — org-level repo creation constraints

  **Acceptance Criteria**:
  - [ ] GitHub App auth flow is encapsulated behind a reusable client/module.
  - [ ] The implementation documents required app permissions for repo creation, configuration, and review/status reads.
  - [ ] Mocked API tests cover auth failure, insufficient permission failure, and successful token acquisition/use.

  **QA Scenarios**:
  ```
  Scenario: GitHub App client obtains usable auth for mocked provisioning calls
    Tool: Bash
    Steps: Run the auth/client test suite with fixtures representing successful installation-token flow
    Expected: Client returns authenticated requests for repo creation/configuration operations
    Evidence: .sisyphus/evidence/task-2-github-app-auth.txt

  Scenario: Missing permission fails explicitly
    Tool: Bash
    Steps: Run the same suite with a fixture representing insufficient app permissions
    Expected: Test fails with explicit permission-matrix error and no silent fallback to PAT
    Evidence: .sisyphus/evidence/task-2-github-app-auth-error.txt
  ```

  **Commit**: YES | Message: `feat(auth): add github app client boundary` | Files: [auth layer, API client, permission docs/tests]

- [x] 3. Define template propagation and requester metadata strategy

  **What to do**: Fix the single template mechanism and requester identity persistence method. The plan default is: persist `requester_login` as a repository variable and mirror it in a tracked metadata file created during provisioning for audit/debuggability. Define the schema for `requester_login`, `provisioned_at`, and `provisioned_by_workflow`, and ensure the enforcement workflow can read it deterministically.
  **Must NOT do**: Do not spread requester identity across multiple unrelated stores with no clear precedence.

  **Recommended Agent Profile**:
  - Category: `balanced` — Reason: contract design with moderate implementation complexity
  - Skills: `[]`
  - Omitted: [`git-master`] — not needed

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [4, 5, 7] | Blocked By: [1]

  **References**:
  - Plan: `/Users/krnomad/work/ai/gb-test/.sisyphus/plans/test-repo-yocto-repo-provisioning.md` — template + requester-review requirements
  - External: `https://docs.github.com/en/rest/repos/repos#create-an-organization-repository` — target repo creation behavior

  **Acceptance Criteria**:
  - [ ] A single approved template source is referenced by provisioning logic.
  - [ ] Requester metadata schema is fixed and readable by both provisioning and enforcement flows.
  - [ ] Tests cover metadata creation and missing/corrupt metadata failure handling.

  **QA Scenarios**:
  ```
  Scenario: Requester metadata stored after provisioning
    Tool: Bash
    Steps: Run metadata unit/integration tests for a sample requester `alice`
    Expected: Stored metadata resolves requester login, timestamp, and provisioning source deterministically
    Evidence: .sisyphus/evidence/task-3-requester-metadata.txt

  Scenario: Missing requester metadata blocks policy evaluation
    Tool: Bash
    Steps: Run enforcement-related tests with metadata removed or malformed
    Expected: Policy evaluation fails closed with explicit remediation guidance
    Evidence: .sisyphus/evidence/task-3-requester-metadata-error.txt
  ```

  **Commit**: YES | Message: `feat(metadata): define requester and template contract` | Files: [template config, requester metadata logic, tests/docs]

- [x] 4. Implement provisioning workflow with validation, idempotency, and sandbox execution

  **What to do**: Build the provisioning workflow that validates inputs, supports dry-run evaluation, provisions sandbox repos for validation, and treats duplicate repos as an idempotent pre-flight failure rather than a partial success. The workflow must create only private `proj-*` repos and must record operator-facing structured output for each stage.
  **Must NOT do**: Do not permit creation to proceed after validation failure, and do not silently reuse an existing repo.

  **Recommended Agent Profile**:
  - Category: `high` — Reason: core orchestration and failure semantics
  - Skills: `[]`
  - Omitted: [`git-master`] — not relevant

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: [5, 6, 8] | Blocked By: [2, 3]

  **References**:
  - External: `https://docs.github.com/en/actions/using-workflows/manually-running-a-workflow` — manual workflow dispatch behavior
  - External: `https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows` — workflow event and input model
  - External: `https://docs.github.com/en/rest/repos/repos#create-an-organization-repository` — org repo creation API

  **Acceptance Criteria**:
  - [ ] Valid dispatch provisions a new private `proj-*` repo in sandbox mode.
  - [ ] Dry-run mode performs validation and planned-action output without creating a repo.
  - [ ] Duplicate repo names fail before provisioning with explicit duplicate-target output.
  - [ ] Workflow logs expose stage-level outcomes without leaking secrets.

  **QA Scenarios**:
  ```
  Scenario: Sandbox provisioning succeeds for valid input
    Tool: Bash
    Steps: Dispatch the workflow in sandbox mode with `repo_slug=my-service` and capture logs/API assertions
    Expected: A private sandbox repository `proj-my-service` is created with structured success output
    Evidence: .sisyphus/evidence/task-4-provisioning-success.txt

  Scenario: Duplicate repo is blocked pre-create
    Tool: Bash
    Steps: Dispatch the workflow with a slug that already exists in the sandbox target
    Expected: Workflow fails during pre-flight and does not create or mutate the existing repo
    Evidence: .sisyphus/evidence/task-4-provisioning-duplicate.txt
  ```

  **Commit**: YES | Message: `feat(provisioning): add dispatch workflow and idempotency` | Files: [workflow, orchestration logic, tests]

- [x] 5. Apply repository hardening: branch protection/rulesets, required checks, and no-bypass policy

  **What to do**: After creation, apply the baseline protection model to the new repo’s `main` branch using classic branch protection, not rulesets. Require PRs, at least one approving review, required status checks, restrictions that prevent direct merge to `main`, and no bypass for admins if the platform/features in use allow it. Register the requester-review check as required.
  **Must NOT do**: Do not mark provisioning successful before these protections are confirmed on the created repo.

  **Recommended Agent Profile**:
  - Category: `high` — Reason: repository security policy application is high-risk
  - Skills: `[]`
  - Omitted: [`git-master`] — not needed

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [6, 7, 8] | Blocked By: [2, 3, 4]

  **References**:
  - External: `https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches` — branch protection capabilities and limits
  - External: `https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets` — explicitly not selected; use only as contrast when documenting why classic branch protection was chosen

  **Acceptance Criteria**:
  - [ ] `main` requires PR-based merge and blocks direct push/direct merge.
  - [ ] At least one approving review is required.
  - [ ] `requester-review-policy` is registered as a required status check.
  - [ ] Admin/bypass behavior is explicitly configured and verified.
  - [ ] Branch protection verification is automated after application.

  **QA Scenarios**:
  ```
  Scenario: Hardened repository rejects direct main updates
    Tool: Bash
    Steps: Attempt a scripted direct update/push path against sandbox `main` after hardening
    Expected: Operation is blocked by branch protection/ruleset
    Evidence: .sisyphus/evidence/task-5-main-protection.txt

  Scenario: Missing required requester-review check blocks merge readiness
    Tool: Bash
    Steps: Create a test PR without the requester-review status check configured or passing
    Expected: Merge is blocked and protection verification reports configuration failure
    Evidence: .sisyphus/evidence/task-5-required-check-error.txt
  ```

  **Commit**: YES | Message: `feat(policy): apply repository hardening defaults` | Files: [hardening logic, verification tests/docs]

- [x] 6. Implement partial-failure handling, quarantine reporting, and success-state verification

  **What to do**: Add explicit failure semantics for “repo created but not hardened,” “hardening applied but enforcement not ready,” and any other intermediate failure. Define a quarantine/reporting path that leaves the repo visibly non-ready and emits remediation instructions. Provisioning success must only be reported after create + harden + enforcement verification all pass.
  **Must NOT do**: Do not silently leave a partially secured repo in a success state.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: failure semantics and remediation flow span multiple system stages
  - Skills: `[]`
  - Omitted: [`git-master`] — not a git-history task

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [8] | Blocked By: [4, 5]

  **References**:
  - Plan: `/Users/krnomad/work/ai/gb-test/.sisyphus/plans/test-repo-yocto-repo-provisioning.md` — success definition and guardrails
  - External: `https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/audit-log-events-for-your-organization` — auditability expectations

  **Acceptance Criteria**:
  - [ ] Each provisioning stage emits a machine-readable success/failure result.
  - [ ] Partial-failure paths are classified and surfaced with remediation instructions.
  - [ ] Final workflow conclusion is success only when the repository is fully hardened and verified.

  **QA Scenarios**:
  ```
  Scenario: Hardening failure produces quarantine outcome
    Tool: Bash
    Steps: Run an integration test that simulates repo creation success followed by protection-application failure
    Expected: Result is marked non-ready/quarantined with explicit remediation output
    Evidence: .sisyphus/evidence/task-6-partial-failure.txt

  Scenario: Enforcement-not-ready prevents success state
    Tool: Bash
    Steps: Simulate a created repo where requester-review workflow is absent or unverifiable
    Expected: Provisioning exits non-success and emits enforcement-readiness failure details
    Evidence: .sisyphus/evidence/task-6-enforcement-not-ready.txt
  ```

  **Commit**: YES | Message: `feat(provisioning): add partial-failure quarantine handling` | Files: [failure-state logic, tests, audit/reporting docs]

- [x] 7. Implement requester-review enforcement workflow and reviewer-policy algorithm

  **What to do**: Build the enforcement workflow that runs on PR/review activity, reads stored requester metadata, lists PR reviews via API, and computes pass/fail according to this exact algorithm: if `requester != pr_author`, requester approval is mandatory; if `requester == pr_author`, self-approval is ignored and another authorized reviewer must approve. For this plan, “authorized reviewer” means a reviewer whose approval counts toward GitHub’s native required-review merge rules for the repository. Handle dismissed/stale reviews and fail closed when metadata is missing or ambiguous.
  **Must NOT do**: Do not rely on native branch protection alone for requester-specific approval, and do not count requester self-approval.

  **Recommended Agent Profile**:
  - Category: `high` — Reason: policy enforcement logic is core business/security behavior
  - Skills: `[]`
  - Omitted: [`git-master`] — not relevant

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [8] | Blocked By: [3, 5]

  **References**:
  - External: `https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews` — required-review behavior and self-approval limitation
  - External: `https://docs.github.com/en/rest/pulls/reviews` — PR review listing and review state API
  - External: `https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches` — required status checks integration with protected branches

  **Acceptance Criteria**:
  - [ ] Non-requester-authored PRs fail until requester approval exists.
  - [ ] Requester-authored PRs fail until another authorized reviewer approval exists.
  - [ ] Dismissed/stale approvals are not counted.
  - [ ] Missing requester metadata or unreadable review data fails closed with explicit status output.

  **QA Scenarios**:
  ```
  Scenario: Requester approval required when requester is not PR author
    Tool: Bash
    Steps: Run policy tests or sandbox PR flow where PR author is `bob`, requester is `alice`, and approvals are evaluated before and after `alice` approves
    Expected: Check fails before `alice` approval and passes after valid requester approval
    Evidence: .sisyphus/evidence/task-7-requester-review.txt

  Scenario: Requester-authored PR requires different reviewer
    Tool: Bash
    Steps: Run policy tests or sandbox PR flow where requester and PR author are both `alice`; submit only self-related activity, then approval from another authorized reviewer
    Expected: Self-approval never satisfies policy; check passes only after another authorized reviewer approves
    Evidence: .sisyphus/evidence/task-7-requester-self-author.txt
  ```

  **Commit**: YES | Message: `feat(policy): enforce requester review workflow` | Files: [enforcement workflow, policy evaluator, tests]

- [x] 8. Add mocked test suite, sandbox integration verification, and evidence automation

  **What to do**: Build the final verification harness: mocked GitHub API tests for provisioning/auth/review logic, sandbox integration scripts, and automatic artifact capture into `.sisyphus/evidence/` during execution. Ensure all major happy/failure paths produce reproducible evidence files and that the repository is ready for agent-driven QA.
  **Must NOT do**: Do not rely on manual browser checks or human interpretation for core acceptance.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: broad test/evidence integration across the project
  - Skills: `[]`
  - Omitted: [`git-master`] — not needed

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [F1-F4] | Blocked By: [4, 5, 6, 7]

  **References**:
  - Plan: `/Users/krnomad/work/ai/gb-test/.sisyphus/plans/test-repo-yocto-repo-provisioning.md` — dry-run + sandbox verification requirement
  - External: `https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/audit-log-events-for-your-organization` — audit evidence expectations
  - External: `https://docs.github.com/en/rest/pulls/reviews` — review data cases to mock

  **Acceptance Criteria**:
  - [ ] Mocked tests cover auth, validation, idempotency, hardening, and requester-review decision logic.
  - [ ] Sandbox integration tests verify create/harden/enforce end to end.
  - [ ] Evidence files are written for each key scenario and are suitable for final review.

  **QA Scenarios**:
  ```
  Scenario: Full sandbox flow passes end to end
    Tool: Bash
    Steps: Run the end-to-end sandbox verification command for a fresh valid slug and PR policy scenario
    Expected: Provisioning, hardening, and requester-review checks all pass with evidence artifacts generated
    Evidence: .sisyphus/evidence/task-8-sandbox-e2e.txt

  Scenario: Full flow surfaces policy failure evidence
    Tool: Bash
    Steps: Run the same flow with a PR scenario lacking the required requester/alternate approval
    Expected: End-to-end verification fails with a policy-specific evidence artifact and no false success
    Evidence: .sisyphus/evidence/task-8-sandbox-policy-failure.txt
  ```

  **Commit**: YES | Message: `test(provisioning): add sandbox verification and evidence capture` | Files: [mocked tests, integration harness, evidence automation]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high (+ playwright if UI)
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Commit 1: control repo scaffolding + dispatch/slug contract
- Commit 2: GitHub App auth boundary + permission tests/docs
- Commit 3: template + requester metadata contract
- Commit 4: provisioning workflow + idempotency handling
- Commit 5: hardening rules/protection + verification
- Commit 6: partial-failure quarantine/reporting
- Commit 7: requester-review enforcement workflow + policy tests
- Commit 8: sandbox integration/evidence harness

## Success Criteria
- The automation provisions only private `proj-*` repos.
- The implementation uses a GitHub App, not PAT, as the primary auth mechanism.
- Provisioned repos are not considered ready until hardening and requester-review enforcement are active and verified.
- Merge to `main` is impossible without PR + required checks.
- Requester-review policy works for both requester≠author and requester=author cases.
- Duplicate, invalid, missing-permission, and partial-failure paths all fail safely with operator-visible output.
