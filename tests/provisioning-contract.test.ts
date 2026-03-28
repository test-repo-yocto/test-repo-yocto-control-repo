import { describe, expect, it } from 'vitest';
import {
  MAX_FINAL_REPOSITORY_NAME_LENGTH,
  REPOSITORY_PREFIX,
  maxRepoSlugLength,
  normalizeProvisioningRequest,
} from '../src/contracts/provisioning.js';

describe('normalizeProvisioningRequest', () => {
  it('accepts a valid dispatch contract and derives the final repo name', () => {
    const result = normalizeProvisioningRequest({
      repo_slug: 'my-service',
      description: 'sandbox repo',
      execution_mode: 'sandbox',
    });

    expect(result).toEqual({
      repoSlug: 'my-service',
      description: 'sandbox repo',
      executionMode: 'sandbox',
      targetRepositoryName: 'proj-my-service',
    });
  });

  it('defaults execution mode to dry-run and trims whitespace', () => {
    const result = normalizeProvisioningRequest({
      repo_slug: '  my-service  ',
      description: '  sandbox repo  ',
    });

    expect(result.executionMode).toBe('dry-run');
    expect(result.repoSlug).toBe('my-service');
    expect(result.description).toBe('sandbox repo');
  });

  it('enforces the shared final-name max length', () => {
    const repoSlug = 'a'.repeat(maxRepoSlugLength());
    const result = normalizeProvisioningRequest({
      repo_slug: repoSlug,
      description: 'length boundary',
    });

    expect(result.targetRepositoryName).toHaveLength(MAX_FINAL_REPOSITORY_NAME_LENGTH);
    expect(result.targetRepositoryName.startsWith(REPOSITORY_PREFIX)).toBe(true);
  });

  it.each([
    ['Bad_Name', 'repo_slug must be lowercase; uppercase characters are rejected.'],
    ['bad_name', 'repo_slug must not contain underscores.'],
    ['bad--name', 'repo_slug must not contain double dashes.'],
    ['-bad-name', 'repo_slug must not start or end with a dash.'],
    ['bad-name-', 'repo_slug must not start or end with a dash.'],
    ['bad.name', 'repo_slug may only contain lowercase letters, digits, and dashes.'],
  ])('rejects invalid slug %s', (repo_slug, message) => {
    expect(() =>
      normalizeProvisioningRequest({
        repo_slug,
        description: 'sandbox repo',
      }),
    ).toThrow(message);
  });

  it('rejects overlong slugs', () => {
    expect(() =>
      normalizeProvisioningRequest({
        repo_slug: 'a'.repeat(maxRepoSlugLength() + 1),
        description: 'sandbox repo',
      }),
    ).toThrow(`repo_slug is too long; ${REPOSITORY_PREFIX}<slug> must be <= ${MAX_FINAL_REPOSITORY_NAME_LENGTH} characters.`);
  });

  it('rejects empty description', () => {
    expect(() =>
      normalizeProvisioningRequest({
        repo_slug: 'my-service',
        description: '   ',
      }),
    ).toThrow('description is required.');
  });

  it('rejects invalid execution modes instead of defaulting them', () => {
    expect(() =>
      normalizeProvisioningRequest({
        repo_slug: 'my-service',
        description: 'sandbox repo',
        execution_mode: 'production',
      }),
    ).toThrow('execution_mode must be one of: dry-run, sandbox.');
  });
});
