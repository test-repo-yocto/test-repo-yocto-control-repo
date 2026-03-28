# Task 8 evidence harness

Source of truth:

- `src/verification/task-8-evidence.ts`
- `scripts/generate-task-8-evidence.ts`

## Commands

```bash
npm run test:task8
npm run evidence:task8
```

Scenario-specific reruns:

```bash
npm run evidence:task8:success
npm run evidence:task8:policy-failure
```

## What the harness proves

The Task 8 harness is intentionally labeled as **mocked local sandbox integration**.

It exercises one end-to-end style orchestration path that proves, with machine-readable artifacts:

- provisioning can reach `outcome=success` with `readiness=ready`
- classic branch protection includes the required `requester-review-policy` check
- requester-review policy passes for a success-ready scenario
- requester-review policy fails closed for a requester-approval-missing scenario

Generated artifacts land in `.sisyphus/evidence/`:

- `task-8-sandbox-e2e.json`
- `task-8-sandbox-e2e.txt`
- `task-8-sandbox-policy-failure.json`
- `task-8-sandbox-policy-failure.txt`
- `task-8-evidence-manifest.json`

The `.json` files are the canonical machine-readable evidence. The `.txt` files are compact summaries for quick inspection.

## Honest limitation: live required-check context

This local harness **does not** claim live GitHub proof for the final required-check context. Instead it makes the gap explicit inside each JSON artifact under `liveRequiredCheckContextObservation`:

- observed locally: branch protection expects `requester-review-policy`
- observed locally: workflow file name + job name are both `requester-review-policy`
- **not verified locally**: the exact check context GitHub surfaces after a real workflow run in a real sandbox repository

That remaining gap is intentional and visible so reviewers can distinguish:

- mocked/local proof of repository code paths
- real org/sandbox proof still needed in the final verification wave

## Reproducibility convention

The harness uses fixed fixture inputs and a fixed evidence timestamp (`2026-03-28T12:00:00.000Z`) so repeated local runs overwrite the same artifacts with stable, diff-friendly content.
