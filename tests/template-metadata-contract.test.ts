import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TEMPLATE_SOURCE_REF,
  PROVISIONING_TEMPLATE_REPOSITORY_CONFIG_KEY,
  REQUESTER_LOGIN_REPOSITORY_VARIABLE_NAME,
  REQUESTER_METADATA_FILE_PATH,
  createRequesterMetadataArtifacts,
  normalizeApprovedTemplateSource,
  parseRequesterMetadata,
} from '../src/contracts/template-metadata.js';

describe('normalizeApprovedTemplateSource', () => {
  it('accepts one canonical template repository reference', () => {
    expect(normalizeApprovedTemplateSource('test-repo-yocto/repo-template')).toEqual({
      configKey: PROVISIONING_TEMPLATE_REPOSITORY_CONFIG_KEY,
      owner: 'test-repo-yocto',
      repository: 'repo-template',
      fullName: 'test-repo-yocto/repo-template',
      ref: DEFAULT_TEMPLATE_SOURCE_REF,
    });
  });

  it.each([
    ['', `${PROVISIONING_TEMPLATE_REPOSITORY_CONFIG_KEY} is required and must point to exactly one template repository.`],
    ['repo-template', `${PROVISIONING_TEMPLATE_REPOSITORY_CONFIG_KEY} must use the form <owner>/<repo>.`],
    ['owner/repo/extra', `${PROVISIONING_TEMPLATE_REPOSITORY_CONFIG_KEY} must use the form <owner>/<repo>.`],
  ])('rejects invalid template source %s', (value, message) => {
    expect(() => normalizeApprovedTemplateSource(value)).toThrow(message);
  });
});

describe('requester metadata contract', () => {
  it('creates mirrored repository-variable and tracked metadata artifacts', () => {
    const result = createRequesterMetadataArtifacts({
      requesterLogin: 'Alice',
      provisionedAt: '2026-03-28T12:00:00.000Z',
      provisionedByWorkflow: '.github/workflows/provision.yml@refs/heads/main',
    });

    expect(result.repositoryVariable).toEqual({
      name: REQUESTER_LOGIN_REPOSITORY_VARIABLE_NAME,
      value: 'alice',
    });
    expect(result.metadataFilePath).toBe(REQUESTER_METADATA_FILE_PATH);
    expect(result.metadataFile).toEqual({
      kind: 'test-repo-yocto/requester-metadata',
      schema_version: 1,
      requester_login: 'alice',
      provisioned_at: '2026-03-28T12:00:00.000Z',
      provisioned_by_workflow: '.github/workflows/provision.yml@refs/heads/main',
    });
    expect(result.metadataFileContents).toContain('"requester_login": "alice"');
    expect(result.parsed.requesterLogin).toBe('alice');
  });

  it('parses metadata deterministically when the mirrored variable matches', () => {
    const artifacts = createRequesterMetadataArtifacts({
      requesterLogin: 'alice',
      provisionedAt: new Date('2026-03-28T12:00:00.000Z'),
      provisionedByWorkflow: '.github/workflows/provision.yml@refs/heads/main',
    });

    expect(
      parseRequesterMetadata({
        metadataFileContent: artifacts.metadataFileContents,
        repositoryVariableValue: artifacts.repositoryVariable.value,
      }),
    ).toEqual(artifacts.parsed);
  });

  it.each([
    [undefined, 'Requester metadata is missing or malformed; expected JSON object at .github/provisioning/requester-metadata.json.'],
    ['', 'Requester metadata is missing or malformed; expected JSON object at .github/provisioning/requester-metadata.json.'],
    ['{', 'Requester metadata is missing or malformed; expected JSON object at .github/provisioning/requester-metadata.json.'],
    [JSON.stringify({ kind: 'wrong', schema_version: 1, requester_login: 'alice', provisioned_at: '2026-03-28T12:00:00.000Z', provisioned_by_workflow: '.github/workflows/provision.yml@refs/heads/main' }), 'Requester metadata kind must be test-repo-yocto/requester-metadata.'],
    [JSON.stringify({ kind: 'test-repo-yocto/requester-metadata', schema_version: 2, requester_login: 'alice', provisioned_at: '2026-03-28T12:00:00.000Z', provisioned_by_workflow: '.github/workflows/provision.yml@refs/heads/main' }), 'Requester metadata schema_version must be 1.'],
    [JSON.stringify({ kind: 'test-repo-yocto/requester-metadata', schema_version: 1, requester_login: '', provisioned_at: '2026-03-28T12:00:00.000Z', provisioned_by_workflow: '.github/workflows/provision.yml@refs/heads/main' }), 'requester_login must not be empty.'],
    [JSON.stringify({ kind: 'test-repo-yocto/requester-metadata', schema_version: 1, requester_login: 'alice', provisioned_at: '2026-03-28T12:00:00Z', provisioned_by_workflow: '.github/workflows/provision.yml@refs/heads/main' }), 'provisioned_at must use canonical UTC ISO-8601 format (Date#toISOString).'],
    [JSON.stringify({ kind: 'test-repo-yocto/requester-metadata', schema_version: 1, requester_login: 'alice', provisioned_at: '2026-03-28T12:00:00.000Z', provisioned_by_workflow: 'workflow path with spaces' }), 'provisioned_by_workflow must use a stable workflow identifier/path string with no spaces.'],
  ])('fails closed for missing or corrupt metadata %#', (metadataFileContent, message) => {
    expect(() =>
      parseRequesterMetadata({
        metadataFileContent,
      }),
    ).toThrow(message);
  });

  it('fails closed when repository-variable and metadata-file requester logins diverge', () => {
    const artifacts = createRequesterMetadataArtifacts({
      requesterLogin: 'alice',
      provisionedAt: '2026-03-28T12:00:00.000Z',
      provisionedByWorkflow: '.github/workflows/provision.yml@refs/heads/main',
    });

    expect(() =>
      parseRequesterMetadata({
        metadataFileContent: artifacts.metadataFile,
        repositoryVariableValue: 'bob',
      }),
    ).toThrow(
      `Requester metadata mismatch: repository variable ${REQUESTER_LOGIN_REPOSITORY_VARIABLE_NAME} must exactly match ${REQUESTER_METADATA_FILE_PATH}.`,
    );
  });
});
