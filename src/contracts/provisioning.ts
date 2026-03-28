export const ORGANIZATION_SLUG = 'test-repo-yocto';
export const REPOSITORY_PREFIX = 'proj-';
export const MAX_FINAL_REPOSITORY_NAME_LENGTH = 50;
export const EXECUTION_MODES = ['dry-run', 'sandbox'] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export interface ProvisioningDispatchInput {
  repo_slug: string;
  description: string;
  execution_mode?: string;
}

export interface NormalizedProvisioningRequest {
  repoSlug: string;
  description: string;
  executionMode: ExecutionMode;
  targetRepositoryName: string;
}

const slugPattern = /^[a-z0-9-]+$/;

export function buildTargetRepositoryName(repoSlug: string): string {
  return `${REPOSITORY_PREFIX}${repoSlug}`;
}

export function maxRepoSlugLength(): number {
  return MAX_FINAL_REPOSITORY_NAME_LENGTH - REPOSITORY_PREFIX.length;
}

export function normalizeProvisioningRequest(
  input: ProvisioningDispatchInput,
): NormalizedProvisioningRequest {
  const repoSlug = input.repo_slug.trim();
  const description = input.description.trim();
  const requestedExecutionMode = input.execution_mode ?? 'dry-run';

  if (repoSlug.length === 0) {
    throw new Error('repo_slug is required.');
  }

  if (description.length === 0) {
    throw new Error('description is required.');
  }

  if (!isExecutionMode(requestedExecutionMode)) {
    throw new Error(`execution_mode must be one of: ${EXECUTION_MODES.join(', ')}.`);
  }

  if (repoSlug !== repoSlug.toLowerCase()) {
    throw new Error('repo_slug must be lowercase; uppercase characters are rejected.');
  }

  if (repoSlug.includes('_')) {
    throw new Error('repo_slug must not contain underscores.');
  }

  if (!slugPattern.test(repoSlug)) {
    throw new Error('repo_slug may only contain lowercase letters, digits, and dashes.');
  }

  if (repoSlug.includes('--')) {
    throw new Error('repo_slug must not contain double dashes.');
  }

  if (repoSlug.startsWith('-') || repoSlug.endsWith('-')) {
    throw new Error('repo_slug must not start or end with a dash.');
  }

  if (repoSlug.length > maxRepoSlugLength()) {
    throw new Error(
      `repo_slug is too long; ${REPOSITORY_PREFIX}<slug> must be <= ${MAX_FINAL_REPOSITORY_NAME_LENGTH} characters.`,
    );
  }

  return {
    repoSlug,
    description,
    executionMode: requestedExecutionMode,
    targetRepositoryName: buildTargetRepositoryName(repoSlug),
  };
}

function isExecutionMode(value: string): value is ExecutionMode {
  return EXECUTION_MODES.includes(value as ExecutionMode);
}
