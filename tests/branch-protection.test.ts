import { describe, expect, it } from 'vitest';

import {
  REQUESTER_REVIEW_POLICY_CHECK,
  applyClassicMainBranchProtection,
  createClassicMainBranchProtection,
  verifyClassicMainBranchProtection,
} from '../src/github/branch-protection.js';

describe('classic branch protection hardening', () => {
  it('builds the canonical classic branch protection payload for main', () => {
    expect(createClassicMainBranchProtection()).toEqual({
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
      restrictions: {
        users: [],
        teams: [],
        apps: [],
      },
      required_linear_history: true,
      allow_force_pushes: false,
      allow_deletions: false,
      block_creations: true,
      required_conversation_resolution: true,
      lock_branch: false,
      allow_fork_syncing: false,
    });
  });

  it('verifies canonical protections including requester-review-policy and no-bypass intent', () => {
    const result = verifyClassicMainBranchProtection({
      required_status_checks: {
        strict: true,
        contexts: [REQUESTER_REVIEW_POLICY_CHECK, 'ci'],
      },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: {
        required_approving_review_count: 2,
      },
      restrictions: {
        users: [],
        teams: [],
        apps: [],
      },
      required_linear_history: true,
      allow_force_pushes: { enabled: false },
      allow_deletions: false,
      block_creations: { enabled: true },
      required_conversation_resolution: { enabled: true },
    });

    expect(result).toEqual({
      ok: true,
      issues: [],
    });
  });

  it('fails verification when direct-push blocking, required check, or admin enforcement drift', () => {
    const result = verifyClassicMainBranchProtection({
      required_status_checks: {
        strict: false,
        contexts: ['ci'],
      },
      enforce_admins: false,
      required_pull_request_reviews: {
        required_approving_review_count: 0,
      },
      restrictions: {
        users: ['octocat'],
        teams: [],
        apps: [],
      },
      required_linear_history: false,
      allow_force_pushes: true,
      allow_deletions: true,
      block_creations: false,
      required_conversation_resolution: false,
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        'Strict required status checks must be enabled so PRs stay up to date with main.',
        `Required status checks must include ${REQUESTER_REVIEW_POLICY_CHECK}.`,
        'At least one approving review must be required before merging to main.',
        'Admin enforcement must be enabled so administrators cannot bypass main protection.',
        'Push restrictions must use empty allowlists so no actor can push directly to main.',
      ]),
    );
  });

  it('applies branch protection then verifies the fetched protection state', async () => {
    const updateBranchProtection: <T = unknown>(input: {
      owner: string;
      repo: string;
      branch: string;
      protection: Record<string, unknown>;
    }) => Promise<T> = async <T = unknown>() => ({ ok: true }) as T;
    const getBranchProtection: <T = unknown>(input: {
      owner: string;
      repo: string;
      branch: string;
    }) => Promise<T> = async <T = unknown>() =>
      ({
      required_status_checks: {
        strict: true,
        checks: [{ context: REQUESTER_REVIEW_POLICY_CHECK }],
      },
      enforce_admins: true,
      required_pull_request_reviews: {
        required_approving_review_count: 1,
      },
      restrictions: {
        users: [],
        teams: [],
        apps: [],
      },
      required_linear_history: true,
      allow_force_pushes: false,
      allow_deletions: false,
      block_creations: true,
      required_conversation_resolution: true,
      }) as T;

    await expect(
      applyClassicMainBranchProtection(
        {
          updateBranchProtection,
          getBranchProtection,
        },
        {
          owner: 'test-repo-yocto',
          repo: 'proj-my-service',
        },
      ),
    ).resolves.toEqual({ ok: true, issues: [] });
  });
});
