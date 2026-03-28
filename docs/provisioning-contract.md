# Provisioning contract

## Dispatch inputs

| Input | Required | Type | Notes |
| --- | --- | --- | --- |
| `repo_slug` | yes | string | Operator-facing project slug. Must satisfy the canonical slug policy. |
| `description` | yes | string | Human-readable repository description. Trimmed during normalization and must not be empty. |
| `execution_mode` | no | `dry-run \| sandbox` | Internal operator/testing mode only. Defaults to `dry-run`. |

## Canonical naming

- Organization target: `test-repo-yocto`
- Final repository name: `proj-${repo_slug}`
- Prefix is enforced by code, not accepted from operators

## Canonical validation rules

Source of truth: `src/contracts/provisioning.ts`

1. Trim surrounding whitespace from `repo_slug` and `description`
2. Reject empty values
3. Reject any slug containing characters outside `[a-z0-9-]`
4. Reject uppercase input rather than silently case-folding it
5. Reject underscores
6. Reject double dashes
7. Reject leading or trailing dashes
8. Enforce one final repository-name limit: `50` characters including the `proj-` prefix

## Normalized output shape

```ts
{
  repoSlug: string;
  description: string;
  executionMode: 'dry-run' | 'sandbox';
  targetRepositoryName: string;
}
```

## Rationale

- Node.js + TypeScript keeps the control repo close to future GitHub App and Actions integration work.
- The slug validator is intentionally standalone so later workflow, API, and test layers can all import exactly the same implementation.

## Related contracts

- Single approved template source: `docs/requester-metadata-contract.md`
- Requester metadata file schema: `docs/requester-metadata-contract.md`
