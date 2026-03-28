import { describe, expect, it } from 'vitest';

import {
  buildRequesterReviewPolicyReviews,
  evaluateRequesterReviewPolicy,
  getRequesterReviewEnforcementReadiness,
  getRequesterReviewEnforcementReadinessForRepository,
  normalizeGitHubPullRequestReviews,
} from '../src/policy/requester-review-policy.js';
import { GitHubApiError } from '../src/github/client.js';

describe('requester-review policy evaluator', () => {
  it('requires requester approval when requester and author differ', () => {
    const reviews = buildRequesterReviewPolicyReviews({
      reviews: normalizeGitHubPullRequestReviews([
        reviewFixture({ id: 1, reviewer: 'reviewer', state: 'APPROVED' }),
      ]),
      reviewerPermissions: {
        reviewer: 'write',
      },
    });

    const result = evaluateRequesterReviewPolicy({
      requesterLogin: 'alice',
      prAuthorLogin: 'bob',
      headCommitSha: 'head-sha',
      reviews,
    });

    expect(result.ok).toBe(false);
    expect(result.failureCode).toBe('missing_qualifying_approval');
    expect(result.summary).toContain('Requester alice must provide');
  });

  it('passes when requester provides a current authorized approval for another author', () => {
    const reviews = buildRequesterReviewPolicyReviews({
      reviews: normalizeGitHubPullRequestReviews([
        reviewFixture({ id: 1, reviewer: 'alice', state: 'APPROVED' }),
        reviewFixture({ id: 2, reviewer: 'carol', state: 'COMMENTED' }),
      ]),
      reviewerPermissions: {
        alice: 'write',
      },
    });

    const result = evaluateRequesterReviewPolicy({
      requesterLogin: 'alice',
      prAuthorLogin: 'bob',
      headCommitSha: 'head-sha',
      reviews,
    });

    expect(result.ok).toBe(true);
    expect(result.qualifyingApprovals).toEqual([
      expect.objectContaining({
        reviewerLogin: 'alice',
      }),
    ]);
  });

  it('ignores requester self-approval and requires another authorized reviewer when requester authored the PR', () => {
    const reviews = buildRequesterReviewPolicyReviews({
      reviews: normalizeGitHubPullRequestReviews([
        reviewFixture({ id: 1, reviewer: 'alice', state: 'APPROVED' }),
      ]),
      reviewerPermissions: {
        alice: 'write',
      },
    });

    const result = evaluateRequesterReviewPolicy({
      requesterLogin: 'alice',
      prAuthorLogin: 'alice',
      headCommitSha: 'head-sha',
      reviews,
    });

    expect(result.ok).toBe(false);
    expect(result.failureCode).toBe('missing_qualifying_approval');
    expect(result.ignoredApprovals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reviewerLogin: 'alice',
          reason: expect.stringContaining('Self-approval'),
        }),
      ]),
    );
  });

  it('passes requester-authored PRs only after another authorized reviewer approves', () => {
    const reviews = buildRequesterReviewPolicyReviews({
      reviews: normalizeGitHubPullRequestReviews([
        reviewFixture({ id: 1, reviewer: 'alice', state: 'APPROVED' }),
        reviewFixture({ id: 2, reviewer: 'carol', state: 'APPROVED' }),
      ]),
      reviewerPermissions: {
        alice: 'write',
        carol: 'maintain',
      },
    });

    const result = evaluateRequesterReviewPolicy({
      requesterLogin: 'alice',
      prAuthorLogin: 'alice',
      headCommitSha: 'head-sha',
      reviews,
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('alternate authorized reviewer carol');
  });

  it('ignores stale, dismissed, and non-counting approvals', () => {
    const reviews = buildRequesterReviewPolicyReviews({
      reviews: normalizeGitHubPullRequestReviews([
        reviewFixture({ id: 1, reviewer: 'alice', state: 'APPROVED', commitId: 'old-head' }),
        reviewFixture({ id: 2, reviewer: 'alice', state: 'DISMISSED', submittedAt: '2026-03-28T12:05:00.000Z' }),
        reviewFixture({ id: 3, reviewer: 'carol', state: 'APPROVED' }),
      ]),
      reviewerPermissions: {
        carol: 'read',
      },
    });

    const result = evaluateRequesterReviewPolicy({
      requesterLogin: 'alice',
      prAuthorLogin: 'bob',
      headCommitSha: 'head-sha',
      reviews,
    });

    expect(result.ok).toBe(false);
    expect(result.qualifyingApprovals).toHaveLength(0);
    expect(result.ignoredApprovals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reviewerLogin: 'carol',
          reason: expect.stringContaining('does not count toward native required reviews'),
        }),
      ]),
    );
  });

  it('fails closed when review payload is missing required fields', () => {
    expect(() =>
      normalizeGitHubPullRequestReviews([
        {
          id: 1,
          state: 'APPROVED',
          submitted_at: '2026-03-28T12:00:00.000Z',
          user: { login: 'alice' },
        },
      ]),
    ).toThrow('Review payload 1 is missing commit_id needed to reject stale approvals.');
  });

  it('fails closed when approval permission data is missing', () => {
    expect(() =>
      buildRequesterReviewPolicyReviews({
        reviews: normalizeGitHubPullRequestReviews([
          reviewFixture({ id: 1, reviewer: 'alice', state: 'APPROVED' }),
        ]),
        reviewerPermissions: {},
      }),
    ).toThrow('Missing reviewer permission data for alice');
  });
});

describe('requester-review enforcement readiness', () => {
  it('reports ready when the workflow file and evaluator are available', () => {
    expect(
      getRequesterReviewEnforcementReadiness({
        workflowFilePresent: true,
        evaluatorAvailable: true,
      }),
    ).toEqual({
      ready: true,
      summary: 'Requester-review enforcement workflow and evaluator are present.',
      details: {
        workflowPath: '.github/workflows/requester-review-policy.yml',
        workflowFilePresent: true,
        evaluatorAvailable: true,
      },
    });
  });

  it('reports not ready when the workflow file is absent', () => {
    const result = getRequesterReviewEnforcementReadiness({
      workflowFilePresent: false,
      evaluatorAvailable: true,
    });

    expect(result.ready).toBe(false);
    expect(result.details.workflowFilePresent).toBe(false);
  });

  it('verifies target-repository artifacts before reporting enforcement ready', async () => {
    const result = await getRequesterReviewEnforcementReadinessForRepository({
      client: {
        getRepositoryContent: async <T = unknown>() => ({ type: 'file' } as T),
        getRepositoryVariable: async <T = unknown>() => ({
          name: 'REQUESTER_LOGIN',
          value: 'alice',
        } as T),
      },
      owner: 'test-repo-yocto-sandbox',
      repo: 'proj-my-service',
    });

    expect(result.ready).toBe(true);
    expect(result.details.workflowFilePresentInTargetRepository).toBe(true);
    expect(result.details.metadataFilePresentInTargetRepository).toBe(true);
    expect(result.details.requesterVariablePresentInTargetRepository).toBe(true);
  });

  it('reports not ready when target repository is missing metadata artifacts', async () => {
    const result = await getRequesterReviewEnforcementReadinessForRepository({
      client: {
        getRepositoryContent: async <T = unknown>(_owner: string, _repo: string, path: string) => {
          if (path === '.github/workflows/requester-review-policy.yml') {
            return { type: 'file' } as T;
          }

          throw new GitHubApiError('Not Found', {
            method: 'GET',
            path: `/repos/test-repo-yocto-sandbox/proj-my-service/contents/${path}`,
            status: 404,
          });
        },
        getRepositoryVariable: async () => {
          throw new GitHubApiError('Not Found', {
            method: 'GET',
            path: '/repos/test-repo-yocto-sandbox/proj-my-service/actions/variables/REQUESTER_LOGIN',
            status: 404,
          });
        },
      },
      owner: 'test-repo-yocto-sandbox',
      repo: 'proj-my-service',
    });

    expect(result.ready).toBe(false);
    expect(result.summary).toContain('metadata file .github/provisioning/requester-metadata.json missing');
    expect(result.summary).toContain('repository variable REQUESTER_LOGIN missing');
  });
});

function reviewFixture(options: {
  id: number;
  reviewer: string;
  state: 'APPROVED' | 'COMMENTED' | 'DISMISSED';
  submittedAt?: string;
  commitId?: string;
}) {
  return {
    id: options.id,
    state: options.state,
    submitted_at: options.submittedAt ?? '2026-03-28T12:00:00.000Z',
    commit_id: options.commitId ?? 'head-sha',
    user: {
      login: options.reviewer,
    },
  };
}
