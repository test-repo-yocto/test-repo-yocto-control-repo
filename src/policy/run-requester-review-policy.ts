import { appendFileSync, readFileSync } from 'node:fs';

import {
  REQUESTER_LOGIN_REPOSITORY_VARIABLE_NAME,
  REQUESTER_METADATA_FILE_PATH,
  parseRequesterMetadata,
} from '../contracts/template-metadata.js';
import { createGitHubAppAuth } from '../github/auth.js';
import { createGitHubApiClient } from '../github/client.js';
import {
  buildRequesterReviewPolicyReviews,
  evaluateRequesterReviewPolicy,
  failClosedRequesterReviewPolicyEvaluation,
  normalizeGitHubPullRequestReviews,
  selectLatestGitHubPullRequestReviews,
  type RequesterReviewPolicyEvaluation,
  type RequesterReviewPolicyFailureCode,
  type ReviewerPermissionLevel,
} from './requester-review-policy.js';

interface PullRequestPolicyContext {
  owner: string;
  repo: string;
  pullNumber: number;
  prAuthorLogin: string;
  headCommitSha: string;
}

async function main(): Promise<void> {
  const client = createGitHubApiClient({
    auth: createGitHubAppAuth({
      credentials: {
        appId: requiredEnv('GITHUB_APP_ID'),
        installationId: requiredEnv('GITHUB_APP_INSTALLATION_ID'),
        privateKey: requiredEnv('GITHUB_APP_PRIVATE_KEY'),
      },
    }),
  });
  const context = readPolicyContext(requiredEnv('GITHUB_EVENT_PATH'));

  const evaluation = await evaluatePolicyForPullRequest(client, context);
  console.log(JSON.stringify(evaluation));
  writeGitHubOutput('result', JSON.stringify(evaluation));
  writeGitHubOutput('ok', String(evaluation.ok));
  writeGitHubOutput('summary', evaluation.summary);
  writeGitHubOutput('failure_code', evaluation.failureCode ?? '');

  if (!evaluation.ok) {
    process.exitCode = 1;
  }
}

async function evaluatePolicyForPullRequest(
  client: ReturnType<typeof createGitHubApiClient>,
  context: PullRequestPolicyContext,
): Promise<RequesterReviewPolicyEvaluation> {
  try {
    const [metadataFileResponse, requesterVariableResponse, reviewsResponse] = await Promise.all([
      client.getRepositoryContent(context.owner, context.repo, REQUESTER_METADATA_FILE_PATH),
      client.getRepositoryVariable(context.owner, context.repo, REQUESTER_LOGIN_REPOSITORY_VARIABLE_NAME),
      client.listPullRequestReviews(context.owner, context.repo, context.pullNumber),
    ]);

    const parsedMetadata = parseRequesterMetadata({
      metadataFileContent: decodeRepositoryFileContent(metadataFileResponse),
      repositoryVariableValue: readRepositoryVariableValue(requesterVariableResponse),
    });
    const normalizedReviews = normalizeGitHubPullRequestReviews(reviewsResponse);
    const latestApproverLogins = [
      ...new Set(
        selectLatestGitHubPullRequestReviews(normalizedReviews)
          .filter((review) => review.state === 'APPROVED')
          .map((review) => review.reviewerLogin),
      ),
    ];
    const reviewerPermissions = Object.fromEntries(
      await Promise.all(
        latestApproverLogins.map(async (reviewerLogin) => [
          reviewerLogin,
          await getReviewerPermissionLevel(client, context.owner, context.repo, reviewerLogin),
        ]),
      ),
    ) as Record<string, ReviewerPermissionLevel>;
    const policyReviews = buildRequesterReviewPolicyReviews({
      reviews: normalizedReviews,
      reviewerPermissions,
    });

    return evaluateRequesterReviewPolicy({
      requesterLogin: parsedMetadata.requesterLogin,
      prAuthorLogin: context.prAuthorLogin,
      headCommitSha: context.headCommitSha,
      reviews: policyReviews,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Requester-review policy evaluation failed closed.';
    const failureCode: RequesterReviewPolicyFailureCode =
      message.includes('Requester metadata') ||
      message.includes('requester_login') ||
      message.includes(REQUESTER_METADATA_FILE_PATH) ||
      message.includes(REQUESTER_LOGIN_REPOSITORY_VARIABLE_NAME)
        ? 'missing_requester_metadata'
        : 'ambiguous_review_data';

    return failClosedRequesterReviewPolicyEvaluation({
      requesterLogin: undefined,
      prAuthorLogin: context.prAuthorLogin,
      headCommitSha: context.headCommitSha,
      summary: message,
      failureCode,
    });
  }
}

function readRepositoryVariableValue(response: unknown): string {
  const value = asRecord(response).value;

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `Repository variable ${REQUESTER_LOGIN_REPOSITORY_VARIABLE_NAME} is missing or unreadable for requester-review policy.`,
    );
  }

  return value;
}

function readPolicyContext(eventPath: string): PullRequestPolicyContext {
  const eventPayload = JSON.parse(readFileSync(eventPath, 'utf8')) as Record<string, unknown>;
  const repository = asRecord(eventPayload.repository);
  const owner = asRecord(repository.owner).login ?? asRecord(repository.owner).name;
  const pullRequest = asRecord(eventPayload.pull_request);
  const pullNumber = pullRequest.number ?? eventPayload.number;
  const prAuthorLogin = asRecord(pullRequest.user).login;
  const headCommitSha = asRecord(pullRequest.head).sha;
  const repo = repository.name;

  if (typeof owner !== 'string' || owner.trim().length === 0) {
    throw new Error('GitHub event payload is missing repository.owner.login for requester-review policy.');
  }

  if (typeof repo !== 'string' || repo.trim().length === 0) {
    throw new Error('GitHub event payload is missing repository.name for requester-review policy.');
  }

  if (typeof pullNumber !== 'number' || !Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new Error('GitHub event payload is missing pull_request.number for requester-review policy.');
  }

  if (typeof prAuthorLogin !== 'string' || prAuthorLogin.trim().length === 0) {
    throw new Error('GitHub event payload is missing pull_request.user.login for requester-review policy.');
  }

  if (typeof headCommitSha !== 'string' || headCommitSha.trim().length === 0) {
    throw new Error('GitHub event payload is missing pull_request.head.sha for requester-review policy.');
  }

  return {
    owner: owner.trim(),
    repo: repo.trim(),
    pullNumber,
    prAuthorLogin: prAuthorLogin.trim(),
    headCommitSha: headCommitSha.trim(),
  };
}

function decodeRepositoryFileContent(response: unknown): string {
  const candidate = asRecord(response);
  const type = candidate.type;
  const content = candidate.content;
  const encoding = candidate.encoding;

  if (type !== 'file' || typeof content !== 'string' || encoding !== 'base64') {
    throw new Error(
      `Requester metadata file ${REQUESTER_METADATA_FILE_PATH} is missing or unreadable from the repository contents API.`,
    );
  }

  return Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf8');
}

async function getReviewerPermissionLevel(
  client: ReturnType<typeof createGitHubApiClient>,
  owner: string,
  repo: string,
  reviewerLogin: string,
): Promise<ReviewerPermissionLevel> {
  const response = await client.getCollaboratorPermissionLevel(owner, repo, reviewerLogin);
  const permission = asRecord(response).permission;
  const roleName = asRecord(response).role_name;
  const candidate = typeof roleName === 'string' && roleName.length > 0 ? roleName : permission;

  if (
    candidate === 'admin' ||
    candidate === 'maintain' ||
    candidate === 'write' ||
    candidate === 'triage' ||
    candidate === 'read' ||
    candidate === 'none'
  ) {
    return candidate;
  }

  throw new Error(
    `Reviewer permission data for ${reviewerLogin} is missing a supported permission level, so requester-review policy fails closed.`,
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function writeGitHubOutput(name: string, value: string): void {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

void main();
