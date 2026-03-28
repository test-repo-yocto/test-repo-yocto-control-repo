export const CLASSIC_BRANCH_PROTECTION_BRANCH = 'main';
export const REQUESTER_REVIEW_POLICY_CHECK = 'requester-review-policy';

export interface BranchProtectionRestrictions {
  users: string[];
  teams: string[];
  apps: string[];
}

export interface BranchProtectionVerificationResult {
  ok: boolean;
  issues: string[];
}

export interface ApplyClassicBranchProtectionDependencies {
  updateBranchProtection<T = unknown>(input: {
    owner: string;
    repo: string;
    branch: string;
    protection: Record<string, unknown>;
  }): Promise<T>;
  getBranchProtection<T = unknown>(input: { owner: string; repo: string; branch: string }): Promise<T>;
}

export function createClassicMainBranchProtection(): Record<string, unknown> {
  return {
    required_status_checks: {
      strict: true,
      contexts: [REQUESTER_REVIEW_POLICY_CHECK],
    },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      require_last_push_approval: false,
      required_approving_review_count: 1,
    },
    restrictions: createNoBypassRestrictions(),
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: true,
    required_conversation_resolution: true,
    lock_branch: false,
    allow_fork_syncing: false,
  };
}

export function verifyClassicMainBranchProtection(protection: unknown): BranchProtectionVerificationResult {
  const issues: string[] = [];
  const root = asRecord(protection);
  const requiredStatusChecks = asRecord(root.required_status_checks);
  const requiredPullRequestReviews = asRecord(root.required_pull_request_reviews);
  const restrictions = normalizeRestrictions(root.restrictions);
  const requiredContexts = normalizeRequiredStatusCheckContexts(requiredStatusChecks);
  const approvals = requiredPullRequestReviews.required_approving_review_count;

  if (!readEnabledFlag(requiredStatusChecks, 'strict')) {
    issues.push('Strict required status checks must be enabled so PRs stay up to date with main.');
  }

  if (!requiredContexts.includes(REQUESTER_REVIEW_POLICY_CHECK)) {
    issues.push(`Required status checks must include ${REQUESTER_REVIEW_POLICY_CHECK}.`);
  }

  if (typeof approvals !== 'number' || approvals < 1) {
    issues.push('At least one approving review must be required before merging to main.');
  }

  if (!readEnabledFlag(root, 'enforce_admins')) {
    issues.push('Admin enforcement must be enabled so administrators cannot bypass main protection.');
  }

  if (!readEnabledFlag(root, 'required_linear_history')) {
    issues.push('Linear history should be required to keep merge behavior constrained to reviewed PR flow.');
  }

  if (!readEnabledFlag(root, 'required_conversation_resolution')) {
    issues.push('Conversation resolution must be required before merge.');
  }

  if (readEnabledFlag(root, 'allow_force_pushes')) {
    issues.push('Force pushes must remain disabled on main.');
  }

  if (readEnabledFlag(root, 'allow_deletions')) {
    issues.push('Branch deletions must remain disabled on main.');
  }

  if (!readEnabledFlag(root, 'block_creations')) {
    issues.push('Branch creation from matching refs must remain blocked on main.');
  }

  if (!restrictions) {
    issues.push('Push restrictions must be explicitly configured to block direct pushes to main.');
  } else if (
    restrictions.users.length > 0 ||
    restrictions.teams.length > 0 ||
    restrictions.apps.length > 0
  ) {
    issues.push('Push restrictions must use empty allowlists so no actor can push directly to main.');
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

export async function applyClassicMainBranchProtection(
  dependencies: ApplyClassicBranchProtectionDependencies,
  input: { owner: string; repo: string; branch?: string },
): Promise<BranchProtectionVerificationResult> {
  const branch = input.branch ?? CLASSIC_BRANCH_PROTECTION_BRANCH;
  await dependencies.updateBranchProtection({
    owner: input.owner,
    repo: input.repo,
    branch,
    protection: createClassicMainBranchProtection(),
  });

  const appliedProtection = await dependencies.getBranchProtection({
    owner: input.owner,
    repo: input.repo,
    branch,
  });

  return verifyClassicMainBranchProtection(appliedProtection);
}

export function createNoBypassRestrictions(): BranchProtectionRestrictions {
  return {
    users: [],
    teams: [],
    apps: [],
  };
}

function normalizeRequiredStatusCheckContexts(requiredStatusChecks: Record<string, unknown>): string[] {
  const legacyContexts = Array.isArray(requiredStatusChecks.contexts)
    ? requiredStatusChecks.contexts.filter((value): value is string => typeof value === 'string')
    : [];
  const checks = Array.isArray(requiredStatusChecks.checks)
    ? requiredStatusChecks.checks.flatMap((value) => {
        const record = asRecord(value);
        return typeof record.context === 'string' ? [record.context] : [];
      })
    : [];

  return [...new Set([...legacyContexts, ...checks])];
}

function normalizeRestrictions(value: unknown): BranchProtectionRestrictions | undefined {
  const restrictions = asRecord(value);
  if (!('users' in restrictions) && !('teams' in restrictions) && !('apps' in restrictions)) {
    return undefined;
  }

  return {
    users: normalizeStringArray(restrictions.users),
    teams: normalizeStringArray(restrictions.teams),
    apps: normalizeStringArray(restrictions.apps),
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry === 'string') {
      return [entry];
    }

    const record = asRecord(entry);
    return typeof record.slug === 'string'
      ? [record.slug]
      : typeof record.login === 'string'
        ? [record.login]
        : typeof record.name === 'string'
          ? [record.name]
          : [];
  });
}

function readEnabledFlag(source: Record<string, unknown>, key: string): boolean {
  const value = source[key];

  if (typeof value === 'boolean') {
    return value;
  }

  const record = asRecord(value);
  return record.enabled === true;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
