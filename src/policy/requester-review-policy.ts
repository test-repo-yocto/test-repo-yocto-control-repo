import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  REQUESTER_METADATA_FILE_PATH,
} from '../contracts/template-metadata.js';
import { GitHubApiError, type GitHubApiClient } from '../github/client.js';

export const REQUESTER_REVIEW_POLICY_WORKFLOW_PATH = '.github/workflows/requester-review-policy.yml';

const COUNTING_PERMISSION_LEVELS = new Set<ReviewerPermissionLevel>(['admin', 'maintain', 'write']);
const ALLOWED_REVIEW_STATES = new Set<GitHubPullRequestReviewState>([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
  'PENDING',
]);

export type ReviewerPermissionLevel = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';
export type GitHubPullRequestReviewState =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'COMMENTED'
  | 'DISMISSED'
  | 'PENDING';
export type RequesterReviewPolicyFailureCode =
  | 'missing_requester_metadata'
  | 'ambiguous_review_data'
  | 'missing_qualifying_approval';

export interface GitHubPullRequestReviewPayload {
  id?: unknown;
  state?: unknown;
  submitted_at?: unknown;
  commit_id?: unknown;
  user?: {
    login?: unknown;
  } | null;
}

export interface NormalizedGitHubPullRequestReview {
  reviewId: number;
  reviewerLogin: string;
  state: GitHubPullRequestReviewState;
  submittedAt: string;
  commitId: string;
}

export interface RequesterReviewPolicyReview extends NormalizedGitHubPullRequestReview {
  permissionLevel: ReviewerPermissionLevel;
  countsTowardNativeReviewRequirement: boolean;
}

export interface EvaluateRequesterReviewPolicyInput {
  requesterLogin: string;
  prAuthorLogin: string;
  headCommitSha: string;
  reviews: RequesterReviewPolicyReview[];
}

export interface RequesterReviewPolicyEvaluation {
  ok: boolean;
  summary: string;
  failureCode?: RequesterReviewPolicyFailureCode;
  requesterLogin: string;
  prAuthorLogin: string;
  headCommitSha: string;
  requiredApproval:
    | {
        type: 'requester';
        reviewerLogin: string;
      }
    | {
        type: 'alternate-authorized-reviewer';
        requesterSelfApprovalIgnored: true;
      };
  qualifyingApprovals: Array<{
    reviewerLogin: string;
    permissionLevel: ReviewerPermissionLevel;
    countsTowardNativeReviewRequirement: boolean;
    commitId: string;
    reviewId: number;
  }>;
  ignoredApprovals: Array<{
    reviewerLogin: string;
    reason: string;
    reviewId: number;
  }>;
}

export interface RequesterReviewEnforcementReadiness {
  ready: boolean;
  summary: string;
  details: {
    workflowPath: string;
    workflowFilePresent: boolean;
    evaluatorAvailable: boolean;
  };
}

export interface RequesterReviewEnforcementTargetReadiness {
  ready: boolean;
  summary: string;
  details: {
    owner: string;
    repository: string;
    ref: string;
    workflowPath: string;
    workflowFilePresentInTargetRepository: boolean;
    metadataFilePath: string;
    metadataFilePresentInTargetRepository: boolean;
    evaluatorAvailable: boolean;
  };
}

export class RequesterReviewPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequesterReviewPolicyError';
  }
}

export function normalizeGitHubPullRequestReviews(
  reviews: unknown,
): NormalizedGitHubPullRequestReview[] {
  if (!Array.isArray(reviews)) {
    throw new RequesterReviewPolicyError('Review payload must be an array of pull request reviews.');
  }

  return reviews.map((review, index) => normalizeGitHubPullRequestReview(review, index));
}

export function buildRequesterReviewPolicyReviews(input: {
  reviews: NormalizedGitHubPullRequestReview[];
  reviewerPermissions: Record<string, ReviewerPermissionLevel>;
}): RequesterReviewPolicyReview[] {
  const latestReviews = selectLatestGitHubPullRequestReviews(input.reviews);

  return latestReviews.map((review) => {
    if (review.state !== 'APPROVED') {
      return {
        ...review,
        permissionLevel: 'none',
        countsTowardNativeReviewRequirement: false,
      };
    }

    const permissionLevel = input.reviewerPermissions[review.reviewerLogin];

    if (!permissionLevel) {
      throw new RequesterReviewPolicyError(
        `Missing reviewer permission data for ${review.reviewerLogin}; requester-review policy cannot determine whether the approval counts toward native merge rules.`,
      );
    }

    return {
      ...review,
      permissionLevel,
      countsTowardNativeReviewRequirement: COUNTING_PERMISSION_LEVELS.has(permissionLevel),
    };
  });
}

export function evaluateRequesterReviewPolicy(
  input: EvaluateRequesterReviewPolicyInput,
): RequesterReviewPolicyEvaluation {
  const requesterLogin = normalizeLogin(input.requesterLogin, 'requester login');
  const prAuthorLogin = normalizeLogin(input.prAuthorLogin, 'PR author login');
  const headCommitSha = normalizeCommitSha(input.headCommitSha);
  const reviews = input.reviews.map((review) => normalizePolicyReview(review));
  const qualifyingApprovals: RequesterReviewPolicyEvaluation['qualifyingApprovals'] = [];
  const ignoredApprovals: RequesterReviewPolicyEvaluation['ignoredApprovals'] = [];
  const effectiveApprovals: RequesterReviewPolicyEvaluation['qualifyingApprovals'] = [];

  for (const review of reviews) {
    if (review.state !== 'APPROVED') {
      continue;
    }

    if (review.commitId !== headCommitSha) {
      ignoredApprovals.push({
        reviewerLogin: review.reviewerLogin,
        reviewId: review.reviewId,
        reason: `Approval is stale for ${review.reviewerLogin}; it targets ${review.commitId} instead of current head ${headCommitSha}.`,
      });
      continue;
    }

    if (!review.countsTowardNativeReviewRequirement) {
      ignoredApprovals.push({
        reviewerLogin: review.reviewerLogin,
        reviewId: review.reviewId,
        reason: `Approval from ${review.reviewerLogin} does not count toward native required reviews for this repository.`,
      });
      continue;
    }

    qualifyingApprovals.push({
      reviewerLogin: review.reviewerLogin,
      permissionLevel: review.permissionLevel,
      countsTowardNativeReviewRequirement: review.countsTowardNativeReviewRequirement,
      commitId: review.commitId,
      reviewId: review.reviewId,
    });

    if (requesterLogin === prAuthorLogin && review.reviewerLogin === prAuthorLogin) {
      ignoredApprovals.push({
        reviewerLogin: review.reviewerLogin,
        reviewId: review.reviewId,
        reason: `Self-approval from ${review.reviewerLogin} is ignored because the requester authored the PR.`,
      });
      continue;
    }

    effectiveApprovals.push({
      reviewerLogin: review.reviewerLogin,
      permissionLevel: review.permissionLevel,
      countsTowardNativeReviewRequirement: review.countsTowardNativeReviewRequirement,
      commitId: review.commitId,
      reviewId: review.reviewId,
    });
  }

  if (requesterLogin !== prAuthorLogin) {
    const requesterApproval = effectiveApprovals.find((review) => review.reviewerLogin === requesterLogin);

    if (!requesterApproval) {
      return {
        ok: false,
        failureCode: 'missing_qualifying_approval',
        summary: `Requester ${requesterLogin} must provide a current authorized approval because the PR author is ${prAuthorLogin}.`,
        requesterLogin,
        prAuthorLogin,
        headCommitSha,
        requiredApproval: {
          type: 'requester',
          reviewerLogin: requesterLogin,
        },
        qualifyingApprovals: effectiveApprovals,
        ignoredApprovals,
      };
    }

    return {
      ok: true,
      summary: `Requester ${requesterLogin} has provided the required current authorized approval for a PR authored by ${prAuthorLogin}.`,
      requesterLogin,
      prAuthorLogin,
      headCommitSha,
      requiredApproval: {
        type: 'requester',
        reviewerLogin: requesterLogin,
      },
      qualifyingApprovals: effectiveApprovals,
      ignoredApprovals,
    };
  }

  const alternateApproval = effectiveApprovals.find((review) => review.reviewerLogin !== prAuthorLogin);

  if (!alternateApproval) {
    return {
      ok: false,
      failureCode: 'missing_qualifying_approval',
      summary: `Requester ${requesterLogin} authored this PR, so another authorized reviewer must approve; self-approval does not satisfy policy.`,
      requesterLogin,
      prAuthorLogin,
      headCommitSha,
      requiredApproval: {
        type: 'alternate-authorized-reviewer',
        requesterSelfApprovalIgnored: true,
      },
      qualifyingApprovals: effectiveApprovals,
      ignoredApprovals,
    };
  }

  return {
    ok: true,
    summary: `Requester ${requesterLogin} authored this PR and alternate authorized reviewer ${alternateApproval.reviewerLogin} approved the current head commit.`,
    requesterLogin,
    prAuthorLogin,
    headCommitSha,
    requiredApproval: {
      type: 'alternate-authorized-reviewer',
      requesterSelfApprovalIgnored: true,
    },
    qualifyingApprovals: effectiveApprovals,
    ignoredApprovals,
  };
}

export function selectLatestGitHubPullRequestReviews(
  reviews: NormalizedGitHubPullRequestReview[],
): NormalizedGitHubPullRequestReview[] {
  return collapseToLatestReviews(reviews);
}

export function failClosedRequesterReviewPolicyEvaluation(input: {
  requesterLogin?: string;
  prAuthorLogin?: string;
  headCommitSha?: string;
  summary: string;
  failureCode: Exclude<RequesterReviewPolicyFailureCode, 'missing_qualifying_approval'>;
}): RequesterReviewPolicyEvaluation {
  return {
    ok: false,
    failureCode: input.failureCode,
    summary: input.summary,
    requesterLogin: input.requesterLogin?.trim() || 'unknown',
    prAuthorLogin: input.prAuthorLogin?.trim() || 'unknown',
    headCommitSha: input.headCommitSha?.trim() || 'unknown',
    requiredApproval: {
      type: 'alternate-authorized-reviewer',
      requesterSelfApprovalIgnored: true,
    },
    qualifyingApprovals: [],
    ignoredApprovals: [],
  };
}

export function getRequesterReviewEnforcementReadiness(options?: {
  workflowPath?: string;
  workflowFilePresent?: boolean;
  evaluatorAvailable?: boolean;
}): RequesterReviewEnforcementReadiness {
  const workflowPath = options?.workflowPath ?? REQUESTER_REVIEW_POLICY_WORKFLOW_PATH;
  const workflowFilePresent =
    options?.workflowFilePresent ?? existsSync(resolve(process.cwd(), workflowPath));
  const evaluatorAvailable =
    options?.evaluatorAvailable ?? typeof evaluateRequesterReviewPolicy === 'function';
  const ready = workflowFilePresent && evaluatorAvailable;

  return {
    ready,
    summary: ready
      ? 'Requester-review enforcement workflow and evaluator are present.'
      : 'Requester-review enforcement workflow readiness is incomplete.',
    details: {
      workflowPath,
      workflowFilePresent,
      evaluatorAvailable,
    },
  };
}

export async function getRequesterReviewEnforcementReadinessForRepository(input: {
  client: Pick<GitHubApiClient, 'getRepositoryContent'>;
  owner: string;
  repo: string;
  ref?: string;
  workflowPath?: string;
  metadataFilePath?: string;
}): Promise<RequesterReviewEnforcementTargetReadiness> {
  const workflowPath = input.workflowPath ?? REQUESTER_REVIEW_POLICY_WORKFLOW_PATH;
  const metadataFilePath = input.metadataFilePath ?? REQUESTER_METADATA_FILE_PATH;
  const ref = input.ref?.trim() || 'main';
  const owner = input.owner.trim();
  const repo = input.repo.trim();
  const evaluatorAvailable = typeof evaluateRequesterReviewPolicy === 'function';

  const [workflowFilePresentInTargetRepository, metadataFilePresentInTargetRepository] =
    await Promise.all([
      repositoryFileExists(input.client, owner, repo, workflowPath, ref),
      repositoryFileExists(input.client, owner, repo, metadataFilePath, ref),
    ]);
  const ready =
    workflowFilePresentInTargetRepository &&
    metadataFilePresentInTargetRepository &&
    evaluatorAvailable;
  const missingArtifacts = [
    ...(!workflowFilePresentInTargetRepository
      ? [`workflow ${workflowPath} missing in target repository`] : []),
    ...(!metadataFilePresentInTargetRepository
      ? [`metadata file ${metadataFilePath} missing in target repository`] : []),
    ...(!evaluatorAvailable ? ['requester-review evaluator unavailable in control repository runtime'] : []),
  ];

  return {
    ready,
    summary: ready
      ? 'Requester-review enforcement readiness verified from provisioned target repository artifacts.'
      : `Requester-review enforcement readiness is incomplete in the provisioned target repository: ${missingArtifacts.join('; ')}.`,
    details: {
      owner,
      repository: repo,
      ref,
      workflowPath,
      workflowFilePresentInTargetRepository,
      metadataFilePath,
      metadataFilePresentInTargetRepository,
      evaluatorAvailable,
    },
  };
}

async function repositoryFileExists(
  client: Pick<GitHubApiClient, 'getRepositoryContent'>,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<boolean> {
  try {
    await client.getRepositoryContent(owner, repo, path, ref);
    return true;
  } catch (error) {
    if (error instanceof GitHubApiError && error.context.status === 404) {
      return false;
    }

    throw error;
  }
}

function normalizeGitHubPullRequestReview(
  review: unknown,
  index: number,
): NormalizedGitHubPullRequestReview {
  const candidate = asRecord(review);
  const reviewId = candidate.id;
  const state = candidate.state;
  const submittedAt = candidate.submitted_at;
  const commitId = candidate.commit_id;
  const reviewerLogin = asRecord(candidate.user).login;

  if (typeof reviewId !== 'number' || !Number.isInteger(reviewId) || reviewId <= 0) {
    throw new RequesterReviewPolicyError(`Review payload at index ${index} is missing an integer id.`);
  }

  if (typeof state !== 'string' || !ALLOWED_REVIEW_STATES.has(state as GitHubPullRequestReviewState)) {
    throw new RequesterReviewPolicyError(
      `Review payload ${reviewId} is missing a supported state needed for requester-review evaluation.`,
    );
  }

  if (typeof submittedAt !== 'string' || Number.isNaN(new Date(submittedAt).getTime())) {
    throw new RequesterReviewPolicyError(
      `Review payload ${reviewId} is missing a valid submitted_at timestamp.`,
    );
  }

  if (typeof commitId !== 'string' || commitId.trim().length === 0) {
    throw new RequesterReviewPolicyError(
      `Review payload ${reviewId} is missing commit_id needed to reject stale approvals.`,
    );
  }

  if (typeof reviewerLogin !== 'string' || reviewerLogin.trim().length === 0) {
    throw new RequesterReviewPolicyError(
      `Review payload ${reviewId} is missing user.login needed for requester-review evaluation.`,
    );
  }

  return {
    reviewId,
    reviewerLogin: normalizeLogin(reviewerLogin, `review ${reviewId} reviewer login`),
    state: state as GitHubPullRequestReviewState,
    submittedAt: new Date(submittedAt).toISOString(),
    commitId: commitId.trim(),
  };
}

function collapseToLatestReviews(
  reviews: NormalizedGitHubPullRequestReview[],
): NormalizedGitHubPullRequestReview[] {
  const latestByReviewer = new Map<string, NormalizedGitHubPullRequestReview>();

  for (const review of reviews) {
    const current = latestByReviewer.get(review.reviewerLogin);

    if (!current || compareReviewOrder(review, current) > 0) {
      latestByReviewer.set(review.reviewerLogin, review);
    }
  }

  return [...latestByReviewer.values()].sort(compareReviewOrder);
}

function compareReviewOrder(
  left: Pick<NormalizedGitHubPullRequestReview, 'submittedAt' | 'reviewId'>,
  right: Pick<NormalizedGitHubPullRequestReview, 'submittedAt' | 'reviewId'>,
): number {
  const leftTime = new Date(left.submittedAt).getTime();
  const rightTime = new Date(right.submittedAt).getTime();

  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return left.reviewId - right.reviewId;
}

function normalizePolicyReview(review: RequesterReviewPolicyReview): RequesterReviewPolicyReview {
  return {
    reviewId: review.reviewId,
    reviewerLogin: normalizeLogin(review.reviewerLogin, `review ${review.reviewId} reviewer login`),
    state: normalizeReviewState(review.state, review.reviewId),
    submittedAt: normalizeTimestamp(review.submittedAt, review.reviewId),
    commitId: normalizeCommitId(review.commitId, review.reviewId),
    permissionLevel: normalizePermissionLevel(review.permissionLevel, review.reviewId),
    countsTowardNativeReviewRequirement: review.countsTowardNativeReviewRequirement === true,
  };
}

function normalizeReviewState(state: string, reviewId: number): GitHubPullRequestReviewState {
  if (!ALLOWED_REVIEW_STATES.has(state as GitHubPullRequestReviewState)) {
    throw new RequesterReviewPolicyError(
      `Review ${reviewId} uses unsupported state ${state}; requester-review policy fails closed on ambiguous review data.`,
    );
  }

  return state as GitHubPullRequestReviewState;
}

function normalizeTimestamp(value: string, reviewId: number): string {
  const timestamp = new Date(value);

  if (Number.isNaN(timestamp.getTime())) {
    throw new RequesterReviewPolicyError(`Review ${reviewId} is missing a valid submittedAt timestamp.`);
  }

  return timestamp.toISOString();
}

function normalizeCommitId(value: string, reviewId: number): string {
  const commitId = value.trim();

  if (commitId.length === 0) {
    throw new RequesterReviewPolicyError(`Review ${reviewId} is missing commitId needed for stale-review rejection.`);
  }

  return commitId;
}

function normalizeCommitSha(value: string): string {
  const commitSha = value.trim();

  if (commitSha.length === 0) {
    throw new RequesterReviewPolicyError('Current PR head sha is required for requester-review evaluation.');
  }

  return commitSha;
}

function normalizeLogin(value: string, fieldName: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new RequesterReviewPolicyError(`${fieldName} is required for requester-review evaluation.`);
  }

  if (trimmed !== trimmed.toLowerCase()) {
    throw new RequesterReviewPolicyError(`${fieldName} must already be canonical lowercase.`);
  }

  return trimmed;
}

function normalizePermissionLevel(
  permissionLevel: ReviewerPermissionLevel,
  reviewId: number,
): ReviewerPermissionLevel {
  if (!['admin', 'maintain', 'write', 'triage', 'read', 'none'].includes(permissionLevel)) {
    throw new RequesterReviewPolicyError(
      `Review ${reviewId} is missing a supported reviewer permission level.`,
    );
  }

  return permissionLevel;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
