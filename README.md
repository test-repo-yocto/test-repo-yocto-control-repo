# test-repo-yocto control repository

Greenfield control repository scaffold for future automation that provisions hardened private repositories in `test-repo-yocto`.

## Get Started

이 저장소는 `test-repo-yocto` 조직 안에서 강화된 private `proj-*` 저장소를 프로비저닝하기 위한 TypeScript 기반 control repository입니다. 실제 애플리케이션 코드를 배포하는 저장소가 아니라, 프로비저닝 계약, GitHub 경계 코드, 검증 로직, 증적 생성 흐름을 관리하는 운영용 저장소로 보면 됩니다.

### 준비 사항

- Node.js 20 이상
- npm
- 로컬에서 테스트와 타입 검사를 실행할 수 있는 개발 환경

### 설치 및 기본 확인

처음 시작할 때는 아래 순서로 확인하면 됩니다.

```bash
npm install
npm test
npm run check
```

- `npm install`: 의존성을 설치합니다.
- `npm test`: 전체 테스트를 실행해서 현재 구현이 깨지지 않았는지 확인합니다.
- `npm run check`: TypeScript 타입 검사만 수행합니다.

### 실무에서 어떻게 보나

운영자는 이 저장소에서 아래 내용을 확인합니다.

- 프로비저닝 입력 계약, 예를 들어 `repo_slug`, `description`, `execution_mode`
- `proj-${repo_slug}` 이름 규칙과 slug 검증 정책
- GitHub App 권한 경계와 중앙화된 클라이언트 래퍼
- 브랜치 보호, requester review 정책, 부분 실패 모델링 결과

즉, 새 저장소 생성 자동화를 바꾸거나 검증할 때 먼저 이 저장소의 계약과 테스트, 증적을 봐야 합니다.

### 자주 쓰는 명령어

```bash
npm install
npm test
npm run check
npm run evidence:task8
```

- `npm install`: 로컬 작업을 위한 패키지를 설치합니다.
- `npm test`: 전체 테스트 스위트를 실행합니다.
- `npm run check`: 타입 오류가 없는지 확인합니다.
- `npm run evidence:task8`: Task 8 관련 로컬 증적 파일을 다시 생성합니다.

Task 8 관련 테스트만 빠르게 보고 싶으면 `npm run test:task8`도 사용할 수 있습니다.

### 어디를 보면 되는가

- `docs/provisioning-contract.md`: 프로비저닝 입력 계약과 정규화 규칙
- `docs/github-app-permissions.md`: GitHub App 권한과 인증 경계
- `docs/requester-metadata-contract.md`: 요청자 메타데이터 계약
- `docs/provisioning-workflow.md`: 단계별 워크플로와 dry-run, sandbox 의미
- `docs/classic-branch-protection.md`: `main` 브랜치 보호 기준
- `docs/requester-review-policy.md`: requester-review 정책 판정 규칙
- `docs/task-8-evidence.md`: Task 8 증적 생성 방식과 해석 방법
- `.sisyphus/evidence/`: 기계 판독용 증적 산출물 위치

### 현재 한계

`npm run evidence:task8`로 만드는 Task 8 증적은 로컬 mocked sandbox 시뮬레이션입니다. 저장소 코드 경로와 산출물은 검증하지만, 실제 GitHub sandbox 또는 조직에서 실행된 required-check context의 최종 표시값까지 증명하지는 않습니다. 그 live GitHub required-check context proof는 별도의 실제 실행으로 확인해야 합니다.

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
