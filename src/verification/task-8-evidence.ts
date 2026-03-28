import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { REQUESTER_REVIEW_POLICY_CHECK } from '../github/branch-protection.js';
import { GitHubApiError, type GitHubApiClient } from '../github/client.js';
import {
  buildRequesterReviewPolicyReviews,
  evaluateRequesterReviewPolicy,
  type RequesterReviewPolicyEvaluation,
} from '../policy/requester-review-policy.js';
import { runProvisioningWorkflow, type ProvisioningWorkflowResult } from '../provisioning/orchestration.js';

export const TASK_8_EVIDENCE_TIMESTAMP = '2026-03-28T12:00:00.000Z';
export const TASK_8_EVIDENCE_WORKFLOW_PATH = '.github/workflows/requester-review-policy.yml';

export type Task8EvidenceScenarioName = 'success' | 'policy-failure';

export interface Task8EvidenceLiveContextObservation {
  status: 'observable_but_unverified_locally';
  expectedRequiredCheckContext: string;
  workflowPath: string;
  workflowName: string | null;
  workflowJobId: string | null;
  workflowJobName: string | null;
  localNamesMatchExpectedContext: boolean;
  liveGitHubCheckContextVerified: false;
  explanation: string;
  nextVerificationStep: string;
}

export interface Task8EvidenceArtifact {
  schemaVersion: 1;
  task: 8;
  scenario: Task8EvidenceScenarioName;
  generatedAt: string;
  execution: {
    kind: 'mocked-sandbox-integration';
    liveGitHubExercised: false;
    label: 'LOCAL_SIMULATION_ONLY';
  };
  assertions: {
    provisioningReady: boolean;
    requesterPolicyOutcomeObserved: boolean;
    liveContextGapExplicit: boolean;
  };
  provisioning: ProvisioningWorkflowResult;
  requesterReviewPolicy: RequesterReviewPolicyEvaluation;
  liveRequiredCheckContextObservation: Task8EvidenceLiveContextObservation;
}

export interface Task8EvidenceManifest {
  schemaVersion: 1;
  task: 8;
  generatedAt: string;
  execution: {
    kind: 'mocked-sandbox-integration';
    liveGitHubExercised: false;
    label: 'LOCAL_SIMULATION_ONLY';
  };
  scenarios: Array<{
    scenario: Task8EvidenceScenarioName;
    jsonArtifact: string;
    textArtifact: string;
    provisioningOutcome: ProvisioningWorkflowResult['outcome'];
    requesterPolicyOk: boolean;
  }>;
}

export async function createTask8EvidenceArtifact(
  scenario: Task8EvidenceScenarioName,
): Promise<Task8EvidenceArtifact> {
  const provisioning = await runProvisioningScenario();
  const requesterReviewPolicy = createPolicyScenarioEvaluation(scenario);
  const liveRequiredCheckContextObservation = observeLiveRequiredCheckContext();

  return {
    schemaVersion: 1,
    task: 8,
    scenario,
    generatedAt: TASK_8_EVIDENCE_TIMESTAMP,
    execution: {
      kind: 'mocked-sandbox-integration',
      liveGitHubExercised: false,
      label: 'LOCAL_SIMULATION_ONLY',
    },
    assertions: {
      provisioningReady: provisioning.ok && provisioning.readiness === 'ready',
      requesterPolicyOutcomeObserved: scenario === 'success' ? requesterReviewPolicy.ok : !requesterReviewPolicy.ok,
      liveContextGapExplicit:
        liveRequiredCheckContextObservation.status === 'observable_but_unverified_locally' &&
        liveRequiredCheckContextObservation.liveGitHubCheckContextVerified === false,
    },
    provisioning,
    requesterReviewPolicy,
    liveRequiredCheckContextObservation,
  };
}

export async function writeTask8EvidenceArtifacts(options?: {
  scenario?: Task8EvidenceScenarioName | 'all';
  evidenceDir?: string;
}): Promise<Task8EvidenceManifest> {
  const evidenceDir = resolve(options?.evidenceDir ?? '.sisyphus/evidence');
  const selectedScenarios =
    options?.scenario && options.scenario !== 'all' ? [options.scenario] : (['success', 'policy-failure'] as const);

  mkdirSync(evidenceDir, { recursive: true });

  const manifest: Task8EvidenceManifest = {
    schemaVersion: 1,
    task: 8,
    generatedAt: TASK_8_EVIDENCE_TIMESTAMP,
    execution: {
      kind: 'mocked-sandbox-integration',
      liveGitHubExercised: false,
      label: 'LOCAL_SIMULATION_ONLY',
    },
    scenarios: [],
  };

  for (const scenario of selectedScenarios) {
    const artifact = await createTask8EvidenceArtifact(scenario);
    const baseName =
      scenario === 'success' ? 'task-8-sandbox-e2e' : 'task-8-sandbox-policy-failure';
    const jsonArtifact = resolve(evidenceDir, `${baseName}.json`);
    const textArtifact = resolve(evidenceDir, `${baseName}.txt`);

    writeFileSync(jsonArtifact, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    writeFileSync(textArtifact, renderTask8EvidenceSummary(artifact), 'utf8');

    manifest.scenarios.push({
      scenario,
      jsonArtifact,
      textArtifact,
      provisioningOutcome: artifact.provisioning.outcome,
      requesterPolicyOk: artifact.requesterReviewPolicy.ok,
    });
  }

  writeFileSync(resolve(evidenceDir, 'task-8-evidence-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return manifest;
}

export function renderTask8EvidenceSummary(artifact: Task8EvidenceArtifact): string {
  return [
    `task=8`,
    `scenario=${artifact.scenario}`,
    `execution=${artifact.execution.kind}`,
    `label=${artifact.execution.label}`,
    `provisioning_outcome=${artifact.provisioning.outcome}`,
    `provisioning_ready=${artifact.provisioning.readiness}`,
    `policy_ok=${artifact.requesterReviewPolicy.ok}`,
    `policy_summary=${artifact.requesterReviewPolicy.summary}`,
    `required_check_context=${artifact.liveRequiredCheckContextObservation.expectedRequiredCheckContext}`,
    `live_context_status=${artifact.liveRequiredCheckContextObservation.status}`,
    `live_context_verified=${artifact.liveRequiredCheckContextObservation.liveGitHubCheckContextVerified}`,
    `limitation=${artifact.liveRequiredCheckContextObservation.explanation}`,
  ].join('\n').concat('\n');
}

function createMockGitHubClient(): Pick<
  GitHubApiClient,
  | 'getRepository'
  | 'createRepositoryFromTemplate'
  | 'upsertRepositoryVariable'
  | 'upsertRepositoryFile'
  | 'updateBranchProtection'
  | 'getBranchProtection'
  | 'getRepositoryContent'
  | 'getRepositoryVariable'
> {
  return {
    async getRepository<T = unknown>(): Promise<T> {
      throw new GitHubApiError('Not Found', {
        method: 'GET',
        path: '/repos/test-repo-yocto-sandbox/proj-my-service',
        status: 404,
      });
    },
    async createRepositoryFromTemplate<T = unknown>(): Promise<T> {
      return {
        name: 'proj-my-service',
        private: true,
        html_url: 'https://github.com/test-repo-yocto-sandbox/proj-my-service',
      } as T;
    },
    async updateBranchProtection<T = unknown>(): Promise<T> {
      return { ok: true } as T;
    },
    async upsertRepositoryVariable<T = unknown>(): Promise<T> {
      return { name: 'REQUESTER_LOGIN', value: 'alice' } as T;
    },
    async upsertRepositoryFile<T = unknown>(): Promise<T> {
      return { content: { path: '.github/provisioning/requester-metadata.json' } } as T;
    },
    async getBranchProtection<T = unknown>(): Promise<T> {
      return {
        required_status_checks: {
          strict: true,
          contexts: [REQUESTER_REVIEW_POLICY_CHECK],
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
      } as T;
    },
    async getRepositoryContent<T = unknown>(): Promise<T> {
      return { type: 'file', path: '.github/workflows/requester-review-policy.yml' } as T;
    },
    async getRepositoryVariable<T = unknown>(): Promise<T> {
      return { name: 'REQUESTER_LOGIN', value: 'alice' } as T;
    },
  };
}

async function runProvisioningScenario(): Promise<ProvisioningWorkflowResult> {
  return runProvisioningWorkflow(
    {
      repo_slug: 'my-service',
      description: 'sandbox repo',
      execution_mode: 'sandbox',
    },
    {
      client: createMockGitHubClient(),
      config: {
        templateRepository: 'test-repo-yocto/template-repository',
        requesterLogin: 'alice',
        workflowRef: '.github/workflows/provision-repository.yml@refs/heads/main',
        sandboxOwner: 'test-repo-yocto-sandbox',
        enforcementReadinessCheck: async () => ({
          ready: true,
          summary:
            'Mocked local harness verified target-repository readiness signals only; live required-check context still needs a real sandbox/org run.',
          details: {
            mode: 'mocked-local-sandbox-integration',
            readinessSignalsReadFromTargetRepository: true,
            liveRequiredCheckContextVerified: false,
          },
        }),
        now: () => new Date(TASK_8_EVIDENCE_TIMESTAMP),
      },
    },
  );
}

function createPolicyScenarioEvaluation(scenario: Task8EvidenceScenarioName): RequesterReviewPolicyEvaluation {
  const reviews =
    scenario === 'success'
      ? buildRequesterReviewPolicyReviews({
          reviews: [
            {
              reviewId: 101,
              reviewerLogin: 'alice',
              state: 'APPROVED',
              submittedAt: TASK_8_EVIDENCE_TIMESTAMP,
              commitId: 'head-sha',
            },
          ],
          reviewerPermissions: {
            alice: 'write',
          },
        })
      : buildRequesterReviewPolicyReviews({
          reviews: [
            {
              reviewId: 102,
              reviewerLogin: 'carol',
              state: 'APPROVED',
              submittedAt: TASK_8_EVIDENCE_TIMESTAMP,
              commitId: 'head-sha',
            },
          ],
          reviewerPermissions: {
            carol: 'write',
          },
        });

  return evaluateRequesterReviewPolicy({
    requesterLogin: 'alice',
    prAuthorLogin: 'bob',
    headCommitSha: 'head-sha',
    reviews,
  });
}

function observeLiveRequiredCheckContext(): Task8EvidenceLiveContextObservation {
  const workflowPath = resolve(process.cwd(), TASK_8_EVIDENCE_WORKFLOW_PATH);
  const workflowContent = readFileSync(workflowPath, 'utf8');
  const parsed = parseWorkflowIdentity(workflowContent);
  const localNames = [parsed.workflowName, parsed.workflowJobName].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );

  return {
    status: 'observable_but_unverified_locally',
    expectedRequiredCheckContext: REQUESTER_REVIEW_POLICY_CHECK,
    workflowPath: TASK_8_EVIDENCE_WORKFLOW_PATH,
    workflowName: parsed.workflowName,
    workflowJobId: parsed.workflowJobId,
    workflowJobName: parsed.workflowJobName,
    localNamesMatchExpectedContext: localNames.every((value) => value === REQUESTER_REVIEW_POLICY_CHECK),
    liveGitHubCheckContextVerified: false,
    explanation:
      'This harness can observe the configured required-check string and workflow/job names locally, but GitHub only reveals the final live required-check context after a real workflow run in a real repository.',
    nextVerificationStep:
      'Run the requester-review-policy workflow in a real sandbox repository and compare the emitted check context visible in branch protection / PR checks against requester-review-policy.',
  };
}

function parseWorkflowIdentity(workflowContent: string): {
  workflowName: string | null;
  workflowJobId: string | null;
  workflowJobName: string | null;
} {
  const lines = workflowContent.split(/\r?\n/);
  let workflowName: string | null = null;
  let workflowJobId: string | null = null;
  let workflowJobName: string | null = null;
  let inJobs = false;
  let currentJobId: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!workflowName && line.startsWith('name:')) {
      workflowName = trimmed.slice('name:'.length).trim() || null;
      continue;
    }

    if (trimmed === 'jobs:') {
      inJobs = true;
      continue;
    }

    if (!inJobs) {
      continue;
    }

    const jobIdMatch = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (jobIdMatch) {
      currentJobId = jobIdMatch[1];
      if (!workflowJobId) {
        workflowJobId = currentJobId;
      }
      continue;
    }

    if (currentJobId && !workflowJobName) {
      const jobNameMatch = line.match(/^    name:\s*(.+)\s*$/);
      if (jobNameMatch) {
        workflowJobName = jobNameMatch[1].trim() || null;
        break;
      }
    }
  }

  return {
    workflowName,
    workflowJobId,
    workflowJobName,
  };
}

export function task8EvidenceJsonArtifactPath(scenario: Task8EvidenceScenarioName, evidenceDir = '.sisyphus/evidence'): string {
  const fileName = scenario === 'success' ? 'task-8-sandbox-e2e.json' : 'task-8-sandbox-policy-failure.json';
  return resolve(evidenceDir, fileName);
}

export function task8EvidenceTextArtifactPath(scenario: Task8EvidenceScenarioName, evidenceDir = '.sisyphus/evidence'): string {
  const fileName = scenario === 'success' ? 'task-8-sandbox-e2e.txt' : 'task-8-sandbox-policy-failure.txt';
  return resolve(evidenceDir, fileName);
}

export function ensureParentDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
