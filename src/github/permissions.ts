export type GitHubPermissionAccess = 'read' | 'write';

export type GitHubRepositoryPermissionName =
  | 'actions'
  | 'administration'
  | 'contents'
  | 'metadata'
  | 'pull_requests'
  | 'statuses';

export type GitHubRepositoryPermissionSet = Partial<
  Record<GitHubRepositoryPermissionName, GitHubPermissionAccess>
>;

export type GitHubAppOperation =
  | 'organization_repository_create'
  | 'repository_variable_write'
  | 'branch_protection_write'
  | 'pull_request_reviews_read'
  | 'commit_statuses_read';

export interface GitHubAppPermissionRequirement {
  operation: GitHubAppOperation;
  repository: GitHubRepositoryPermissionSet;
  purpose: string;
}

export const GITHUB_APP_PERMISSION_REQUIREMENTS: readonly GitHubAppPermissionRequirement[] = [
  {
    operation: 'organization_repository_create',
    repository: {
      administration: 'write',
      metadata: 'read',
    },
    purpose: 'Create private repositories in the target organization.',
  },
  {
    operation: 'repository_variable_write',
    repository: {
      actions: 'write',
      metadata: 'read',
    },
    purpose: 'Persist repository-scoped Actions variables and inspect repository metadata.',
  },
  {
    operation: 'branch_protection_write',
    repository: {
      administration: 'write',
      contents: 'read',
      metadata: 'read',
    },
    purpose: 'Apply classic branch protection after verifying target branches exist.',
  },
  {
    operation: 'pull_request_reviews_read',
    repository: {
      metadata: 'read',
      pull_requests: 'read',
    },
    purpose: 'Read pull request review history for requester-review enforcement.',
  },
  {
    operation: 'commit_statuses_read',
    repository: {
      metadata: 'read',
      statuses: 'read',
    },
    purpose: 'Inspect commit status checks during later merge-readiness verification.',
  },
] as const;

const ACCESS_LEVEL: Record<GitHubPermissionAccess, number> = {
  read: 1,
  write: 2,
};

export function permissionSatisfies(
  actual: GitHubPermissionAccess | undefined,
  required: GitHubPermissionAccess,
): boolean {
  if (actual === undefined) {
    return false;
  }

  return ACCESS_LEVEL[actual] >= ACCESS_LEVEL[required];
}

export function describeMissingRepositoryPermissions(
  actualPermissions: GitHubRepositoryPermissionSet,
  requirements: readonly GitHubAppPermissionRequirement[] = GITHUB_APP_PERMISSION_REQUIREMENTS,
): string[] {
  const missing = new Set<string>();

  for (const requirement of requirements) {
    for (const [permissionName, requiredAccess] of Object.entries(requirement.repository) as Array<
      [GitHubRepositoryPermissionName, GitHubPermissionAccess]
    >) {
      const actualAccess = actualPermissions[permissionName];

      if (!permissionSatisfies(actualAccess, requiredAccess)) {
        missing.add(`${permissionName}:${requiredAccess}`);
      }
    }
  }

  return [...missing].sort();
}
