# Template source and requester metadata contract

## Single template source

Source of truth: `src/contracts/template-metadata.ts`

- Configuration key: `PROVISIONING_TEMPLATE_REPOSITORY`
- Shape: exactly one `owner/repo` string
- Default ref contract: `main`
- Multiple template options are out of scope and unsupported

This control repository only defines the contract and validation surface. Later provisioning code should read one approved template repository value, normalize it once, and use that single normalized value for all template propagation.

Provisioning success verification now treats these template-delivered target-repository paths as mandatory evidence after create:

- `README.md`
- `LICENSE`
- `.github/workflows/ci.yml`

## Requester metadata storage strategy

Requester metadata is persisted as a single canonical tracked artifact during provisioning:

- **Tracked metadata file**
  - Path inside created repositories: `.github/provisioning/requester-metadata.json`
  - Purpose: canonical requester identity + provenance for requester-review enforcement

This file is now the only source of truth for requester metadata in live-critical paths.

## Metadata file schema

```json
{
  "kind": "test-repo-yocto/requester-metadata",
  "schema_version": 1,
  "requester_login": "alice",
  "provisioned_at": "2026-03-28T12:00:00.000Z",
  "provisioned_by_workflow": ".github/workflows/provision-repository.yml@refs/heads/main"
}
```

### Field rules

- `kind`: fixed discriminator for deterministic parsing
- `schema_version`: fixed to `1`
- `requester_login`: canonical lowercase GitHub login using letters, digits, and single dashes
- `provisioned_at`: canonical UTC ISO-8601 timestamp from `Date#toISOString()`
- `provisioned_by_workflow`: stable workflow identity/path string with no spaces

## Runtime parse contract

Normalized runtime shape:

```ts
{
  requesterLogin: string;
  provisionedAt: string;
  provisionedByWorkflow: string;
  metadataFilePath: '.github/provisioning/requester-metadata.json';
  metadataFile: {
    kind: 'test-repo-yocto/requester-metadata';
    schema_version: 1;
    requester_login: string;
    provisioned_at: string;
    provisioned_by_workflow: string;
  };
}
```

## Failure semantics

Consumers must fail closed when any of the following occurs:

- metadata file missing
- metadata file empty or invalid JSON
- `kind` or `schema_version` mismatch
- any required field missing or empty
- `provisioned_at` not in canonical ISO form
- `provisioned_by_workflow` not in stable identifier form

## Intended later usage

- **Provisioning code** should create `.github/provisioning/requester-metadata.json` during sandbox create.
- **Requester-review enforcement** should read `.github/provisioning/requester-metadata.json` from the provisioned repository as canonical input.
