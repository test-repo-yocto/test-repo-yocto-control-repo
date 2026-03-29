import {
  ORGANIZATION_SLUG,
  type ExecutionMode,
  type NormalizedProvisioningRequest,
  type ProvisioningDispatchInput,
  normalizeProvisioningRequest,
} from '../contracts/provisioning.js';
import {
  REQUIRED_TEMPLATE_ARTIFACTS,
  type ApprovedTemplateSource,
  type RequiredTemplateArtifact,
  createRequesterMetadataArtifacts,
  normalizeApprovedTemplateSource,
} from '../contracts/template-metadata.js';
import {
  REQUESTER_REVIEW_POLICY_CHECK,
  applyClassicMainBranchProtection,
  createClassicMainBranchProtection,
} from '../github/branch-protection.js';
import { GitHubAppPermissionError } from '../github/auth.js';
import { GitHubApiError, type GitHubApiClient } from '../github/client.js';

export const PROVISIONING_STAGE_NAMES = [
  'contract_validation',
  'mode_resolution',
  'template_source_resolution',
  'duplicate_target_preflight',
  'create_or_plan',
  'branch_protection_apply',
  'branch_protection_verify',
  'template_artifact_verify',
  'enforcement_readiness_verify',
] as const;

export type ProvisioningStageName = (typeof PROVISIONING_STAGE_NAMES)[number];
export type ProvisioningStageStatus = 'success' | 'failure' | 'planned' | 'skipped';
export type ProvisioningOutcome = 'success' | 'failed' | 'quarantined' | 'not_ready';
export type ProvisioningReadiness = 'ready' | 'not_ready';
export type ProvisioningFailureClass =
  | 'validation_failed'
  | 'template_source_failed'
  | 'duplicate_target'
  | 'duplicate_preflight_failed'
  | 'create_failed'
  | 'metadata_persistence_failed'
  | 'hardening_manual_required'
  | 'hardening_apply_failed'
  | 'hardening_verification_failed'
  | 'template_artifacts_missing'
  | 'enforcement_not_ready';

export interface ProvisioningStageOutput {
  stage: ProvisioningStageName;
  status: ProvisioningStageStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface ProvisioningWorkflowConfig {
  templateRepository: string;
  templateRef?: string;
  requesterLogin: string;
  workflowRef: string;
  sandboxOwner?: string;
  enforcementReadiness?: {
    ready: boolean;
    summary?: string;
    details?: Record<string, unknown>;
    remediationActions?: string[];
  };
  enforcementReadinessCheck?: (input: {
    owner: string;
    repo: string;
    ref?: string;
    client: Pick<GitHubApiClient, 'getRepositoryContent'>;
  }) =>
    | Promise<{
        ready: boolean;
        summary?: string;
        details?: Record<string, unknown>;
      }>
    | {
        ready: boolean;
        summary?: string;
        details?: Record<string, unknown>;
      };
  now?: () => Date;
}

export interface ProvisioningWorkflowDependencies {
  client: Pick<
    GitHubApiClient,
    | 'getRepository'
    | 'createRepositoryFromTemplate'
    | 'upsertRepositoryFile'
    | 'updateBranchProtection'
    | 'getBranchProtection'
    | 'getRepositoryContent'
  >;
  config: ProvisioningWorkflowConfig;
}

export interface ProvisioningWorkflowResult {
  ok: boolean;
  outcome: ProvisioningOutcome;
  readiness: ProvisioningReadiness;
  scopeSuccess: boolean;
  executionMode: ExecutionMode | 'unknown';
  targetOwner?: string;
  targetRepositoryName?: string;
  failureClass?: ProvisioningFailureClass;
  remediation?: ProvisioningRemediation;
  quarantine?: ProvisioningQuarantine;
  scope: ProvisioningScopeState;
  repository?: {
    owner: string;
    name: string;
    private: boolean;
    url?: string;
  };
  stages: ProvisioningStageOutput[];
}

interface GitHubRepositoryRecord {
  name?: string;
  private?: boolean;
  html_url?: string;
}

export interface ProvisioningRemediation {
  code: ProvisioningFailureClass;
  summary: string;
  actions: string[];
}

export interface ProvisioningQuarantine {
  required: boolean;
  owner: string;
  repository: string;
  reason: string;
  remediation: ProvisioningRemediation;
}

export interface ProvisioningScopeState {
  repositoryCreated: boolean;
  hardeningApplied: boolean;
  hardeningVerified: boolean;
  templateArtifactsVerified: boolean;
  enforcementReady: boolean;
}

interface ResultBuildInput {
  executionMode: ExecutionMode | 'unknown';
  stages: ProvisioningStageOutput[];
  outcome: ProvisioningOutcome;
  targetOwner?: string;
  targetRepositoryName?: string;
  repository?: {
    owner: string;
    name: string;
    private: boolean;
    url?: string;
  };
  failureClass?: ProvisioningFailureClass;
  remediation?: ProvisioningRemediation;
  quarantine?: ProvisioningQuarantine;
  scope?: Partial<ProvisioningScopeState>;
}

export async function runProvisioningWorkflow(
  input: ProvisioningDispatchInput,
  dependencies: ProvisioningWorkflowDependencies,
): Promise<ProvisioningWorkflowResult> {
  const stages: ProvisioningStageOutput[] = [];
  const requestedExecutionMode = input.execution_mode ?? 'dry-run';
  let createdRepositoryState:
    | {
        owner: string;
        name: string;
        private: boolean;
        url?: string;
      }
    | undefined;

  let normalizedRequest: NormalizedProvisioningRequest;

  try {
    normalizedRequest = normalizeProvisioningRequest(input);
    stages.push({
      stage: 'contract_validation',
      status: 'success',
      summary: 'Provisioning request passed canonical contract validation.',
      details: {
        repoSlug: normalizedRequest.repoSlug,
        targetRepositoryName: normalizedRequest.targetRepositoryName,
      },
    });
  } catch (error) {
    stages.push({
      stage: 'contract_validation',
      status: 'failure',
      summary: error instanceof Error ? error.message : 'Provisioning request validation failed.',
      details: {
        requestedExecutionMode,
        remediation: remediationForValidation(error instanceof Error ? error.message : undefined),
      },
    });

    return buildResult({
      executionMode: isExecutionMode(requestedExecutionMode) ? requestedExecutionMode : 'unknown',
      outcome: 'failed',
      failureClass: 'validation_failed',
      remediation: remediationForValidation(error instanceof Error ? error.message : undefined),
      stages,
    });
  }

  const executionMode = normalizedRequest.executionMode;
  const targetOwner = resolveTargetOwner(executionMode, dependencies.config.sandboxOwner);
  stages.push({
    stage: 'mode_resolution',
    status: 'success',
    summary:
      executionMode === 'dry-run'
        ? 'Dry-run mode selected; provisioning will emit planned actions only.'
        : 'Sandbox mode selected; provisioning will create the repository in the sandbox target.',
    details: {
      executionMode,
      targetOwner,
      createEnabled: executionMode === 'sandbox',
    },
  });

  let templateSource: ApprovedTemplateSource;

  try {
    templateSource = normalizeApprovedTemplateSource(
      dependencies.config.templateRepository,
      dependencies.config.templateRef,
    );
    stages.push({
      stage: 'template_source_resolution',
      status: 'success',
      summary: 'Template source resolved from the single approved contract value.',
      details: {
        template: templateSource.fullName,
        ref: templateSource.ref,
      },
    });
  } catch (error) {
    stages.push({
      stage: 'template_source_resolution',
      status: 'failure',
      summary: error instanceof Error ? error.message : 'Template source resolution failed.',
      details: {
        remediation: remediationForTemplateResolution(),
      },
    });
    stages.push(skipStage('duplicate_target_preflight', 'Skipped because template source resolution failed.'));
    stages.push(skipStage('create_or_plan', 'Skipped because template source resolution failed.'));
    stages.push(skipStage('branch_protection_apply', 'Skipped because template source resolution failed.'));
    stages.push(skipStage('branch_protection_verify', 'Skipped because template source resolution failed.'));
    stages.push(skipStage('template_artifact_verify', 'Skipped because template source resolution failed.'));
    stages.push(skipStage('enforcement_readiness_verify', 'Skipped because template source resolution failed.'));

    return buildResult({
      executionMode,
      outcome: 'failed',
      targetOwner,
      targetRepositoryName: normalizedRequest.targetRepositoryName,
      failureClass: 'template_source_failed',
      remediation: remediationForTemplateResolution(),
      stages,
    });
  }

  try {
    const existingRepository = await dependencies.client.getRepository<GitHubRepositoryRecord>({
      owner: targetOwner,
      repo: normalizedRequest.targetRepositoryName,
    });

    stages.push({
      stage: 'duplicate_target_preflight',
      status: 'failure',
      summary: 'Duplicate target repository detected; provisioning stopped before any create call.',
      details: {
        owner: targetOwner,
        repository: existingRepository.name ?? normalizedRequest.targetRepositoryName,
        private: existingRepository.private ?? null,
        url: existingRepository.html_url,
        remediation: remediationForDuplicateTarget(),
      },
    });
    stages.push(skipStage('create_or_plan', 'Skipped because duplicate target preflight failed.'));
    stages.push(skipStage('branch_protection_apply', 'Skipped because duplicate target preflight failed.'));
    stages.push(skipStage('branch_protection_verify', 'Skipped because duplicate target preflight failed.'));
    stages.push(skipStage('template_artifact_verify', 'Skipped because duplicate target preflight failed.'));
    stages.push(skipStage('enforcement_readiness_verify', 'Skipped because duplicate target preflight failed.'));

    return buildResult({
      executionMode,
      outcome: 'failed',
      targetOwner,
      targetRepositoryName: normalizedRequest.targetRepositoryName,
      failureClass: 'duplicate_target',
      remediation: remediationForDuplicateTarget(),
      stages,
    });
  } catch (error) {
    if (!isRepositoryMissingError(error)) {
      stages.push({
        stage: 'duplicate_target_preflight',
        status: 'failure',
        summary: error instanceof Error ? error.message : 'Duplicate target preflight failed.',
        details: {
          remediation: remediationForDuplicatePreflight(),
        },
      });
      stages.push(skipStage('create_or_plan', 'Skipped because duplicate target preflight failed.'));
      stages.push(skipStage('branch_protection_apply', 'Skipped because duplicate target preflight failed.'));
      stages.push(skipStage('branch_protection_verify', 'Skipped because duplicate target preflight failed.'));
      stages.push(skipStage('template_artifact_verify', 'Skipped because duplicate target preflight failed.'));
      stages.push(skipStage('enforcement_readiness_verify', 'Skipped because duplicate target preflight failed.'));

      return buildResult({
        executionMode,
        outcome: 'failed',
        targetOwner,
        targetRepositoryName: normalizedRequest.targetRepositoryName,
        failureClass: 'duplicate_preflight_failed',
        remediation: remediationForDuplicatePreflight(),
        stages,
      });
    }
  }

  stages.push({
    stage: 'duplicate_target_preflight',
    status: 'success',
    summary: 'Target repository name is available; create path may proceed.',
    details: {
      owner: targetOwner,
      repository: normalizedRequest.targetRepositoryName,
    },
  });

  const metadataArtifacts = createRequesterMetadataArtifacts({
    requesterLogin: dependencies.config.requesterLogin,
    provisionedAt: (dependencies.config.now ?? (() => new Date()))(),
    provisionedByWorkflow: dependencies.config.workflowRef,
  });

  if (executionMode === 'dry-run') {
    stages.push({
      stage: 'create_or_plan',
      status: 'planned',
      summary: 'Dry-run completed; repository creation was not attempted.',
      details: {
        plannedAction: 'create_repository_from_template',
        owner: targetOwner,
        repository: normalizedRequest.targetRepositoryName,
        private: true,
        template: templateSource.fullName,
        templateRef: templateSource.ref,
        branchProtection: createClassicMainBranchProtection(),
        requesterMetadata: summarizeRequesterMetadata(metadataArtifacts),
      },
    });
    stages.push({
      stage: 'branch_protection_apply',
      status: 'planned',
      summary: 'Dry-run planned classic branch protection application for main.',
      details: {
        owner: targetOwner,
        repository: normalizedRequest.targetRepositoryName,
        branch: 'main',
      },
    });
    stages.push({
      stage: 'branch_protection_verify',
      status: 'planned',
      summary: 'Dry-run planned post-apply verification for classic main branch protection.',
      details: {
        owner: targetOwner,
        repository: normalizedRequest.targetRepositoryName,
        branch: 'main',
      },
    });
    stages.push({
      stage: 'template_artifact_verify',
      status: 'planned',
      summary: 'Dry-run planned target-repository template artifact verification.',
      details: {
        owner: targetOwner,
        repository: normalizedRequest.targetRepositoryName,
        requiredArtifacts: REQUIRED_TEMPLATE_ARTIFACTS,
      },
    });
    stages.push({
      stage: 'enforcement_readiness_verify',
      status: 'planned',
      summary: 'Dry-run planned requester-review enforcement readiness verification.',
      details: {
        owner: targetOwner,
        repository: normalizedRequest.targetRepositoryName,
      },
    });

    return buildResult({
      executionMode,
      outcome: 'not_ready',
      targetOwner,
      targetRepositoryName: normalizedRequest.targetRepositoryName,
      failureClass: 'enforcement_not_ready',
      remediation: remediationForEnforcementNotReady(
        'Dry-run does not provision a repository, so enforcement readiness cannot be verified yet.',
      ),
      scope: {
        repositoryCreated: false,
        hardeningApplied: false,
        hardeningVerified: false,
        templateArtifactsVerified: false,
        enforcementReady: false,
      },
      stages,
    });
  }

  try {
    const createdRepository = await dependencies.client.createRepositoryFromTemplate<GitHubRepositoryRecord>({
      templateOwner: templateSource.owner,
      templateRepo: templateSource.repository,
      owner: targetOwner,
      name: normalizedRequest.targetRepositoryName,
      description: normalizedRequest.description,
      private: true,
    });

    const repository = {
      owner: targetOwner,
      name: createdRepository.name ?? normalizedRequest.targetRepositoryName,
      private: createdRepository.private ?? true,
      url: createdRepository.html_url,
    };
    createdRepositoryState = repository;

    try {
      await dependencies.client.upsertRepositoryFile({
        owner: repository.owner,
        repo: repository.name,
        path: metadataArtifacts.metadataFilePath,
        content: metadataArtifacts.metadataFileContents,
        message: 'chore(provisioning): persist requester metadata',
        branch: 'main',
      });
    } catch (error) {
      const remediation = remediationForMetadataPersistenceFailure();

      stages.push({
        stage: 'create_or_plan',
        status: 'failure',
        summary:
          error instanceof Error
            ? error.message
            : 'Repository created, but requester metadata persistence failed.',
        details: {
          owner: repository.owner,
          repository: repository.name,
          private: repository.private,
          url: repository.url,
          template: templateSource.fullName,
          templateRef: templateSource.ref,
          requesterMetadata: summarizeRequesterMetadata(metadataArtifacts),
          remediation,
        },
      });
      stages.push(skipStage('branch_protection_apply', 'Skipped because requester metadata persistence failed.'));
      stages.push(skipStage('branch_protection_verify', 'Skipped because requester metadata persistence failed.'));
      stages.push(skipStage('template_artifact_verify', 'Skipped because requester metadata persistence failed.'));
      stages.push(skipStage('enforcement_readiness_verify', 'Skipped because requester metadata persistence failed.'));

      return buildResult({
        executionMode,
        outcome: 'quarantined',
        targetOwner,
        targetRepositoryName: normalizedRequest.targetRepositoryName,
        repository,
        failureClass: 'metadata_persistence_failed',
        remediation,
        quarantine: createQuarantine(
          repository,
          'Repository created but requester metadata persistence failed.',
          remediation,
        ),
        scope: {
          repositoryCreated: true,
          hardeningApplied: false,
          hardeningVerified: false,
          templateArtifactsVerified: false,
          enforcementReady: false,
        },
        stages,
      });
    }

    stages.push({
      stage: 'create_or_plan',
      status: 'success',
      summary: 'Sandbox provisioning created the repository from the approved template and persisted requester metadata.',
      details: {
        owner: repository.owner,
        repository: repository.name,
        private: repository.private,
        url: repository.url,
        template: templateSource.fullName,
        templateRef: templateSource.ref,
        requesterMetadata: summarizeRequesterMetadata(metadataArtifacts),
      },
    });

    const verification = await applyClassicMainBranchProtection(dependencies.client, {
      owner: repository.owner,
      repo: repository.name,
    });

    stages.push({
      stage: 'branch_protection_apply',
      status: 'success',
      summary: 'Classic branch protection payload submitted for main.',
      details: {
        owner: repository.owner,
        repository: repository.name,
        branch: 'main',
      },
    });

    if (!verification.ok) {
      stages[stages.length - 1] = {
        stage: 'branch_protection_apply',
        status: 'failure',
        summary: 'Classic branch protection application did not verify cleanly.',
        details: {
          owner: repository.owner,
          repository: repository.name,
          branch: 'main',
          issues: verification.issues,
        },
      };
      stages.push({
        stage: 'branch_protection_verify',
        status: 'failure',
        summary: 'Classic branch protection verification detected contract drift.',
        details: {
          owner: repository.owner,
          repository: repository.name,
          branch: 'main',
          issues: verification.issues,
          remediation: remediationForHardeningVerificationFailure(),
        },
      });
      stages.push(skipStage('template_artifact_verify', 'Skipped because hardening verification failed.'));
      stages.push(skipStage('enforcement_readiness_verify', 'Skipped because hardening verification failed.'));

      const remediation = remediationForHardeningVerificationFailure();

      return buildResult({
        executionMode,
        outcome: 'quarantined',
        targetOwner,
        targetRepositoryName: normalizedRequest.targetRepositoryName,
        repository,
        failureClass: 'hardening_verification_failed',
        remediation,
        quarantine: createQuarantine(repository, 'Hardening verification drift left repository non-ready.', remediation),
        scope: {
          repositoryCreated: true,
          hardeningApplied: true,
          hardeningVerified: false,
          templateArtifactsVerified: false,
          enforcementReady: false,
        },
        stages,
      });
    }

    stages.push({
      stage: 'branch_protection_verify',
      status: 'success',
      summary: 'Classic main branch protection verified after application.',
      details: {
        owner: repository.owner,
        repository: repository.name,
        branch: 'main',
      },
    });

    const templateArtifactVerification = await verifyRequiredTemplateArtifacts(dependencies.client, {
      owner: repository.owner,
      repo: repository.name,
      ref: 'main',
    });
    const templateArtifactRemediation = templateArtifactVerification.ok
      ? undefined
      : remediationForMissingTemplateArtifacts(templateArtifactVerification.missingArtifacts);

    stages.push({
      stage: 'template_artifact_verify',
      status: templateArtifactVerification.ok ? 'success' : 'failure',
      summary: templateArtifactVerification.summary,
      details: {
        owner: repository.owner,
        repository: repository.name,
        ref: templateArtifactVerification.ref,
        requiredArtifacts: templateArtifactVerification.requiredArtifacts,
        presentArtifacts: templateArtifactVerification.presentArtifacts,
        missingArtifacts: templateArtifactVerification.missingArtifacts,
        ...(templateArtifactRemediation ? { remediation: templateArtifactRemediation } : {}),
      },
    });

    if (!templateArtifactVerification.ok) {
      stages.push(
        skipStage(
          'enforcement_readiness_verify',
          'Skipped because required template artifacts were not verified in the target repository.',
        ),
      );

      return buildResult({
        executionMode,
        outcome: 'not_ready',
        targetOwner,
        targetRepositoryName: normalizedRequest.targetRepositoryName,
        repository,
        failureClass: 'template_artifacts_missing',
        remediation: templateArtifactRemediation,
        scope: {
          repositoryCreated: true,
          hardeningApplied: true,
          hardeningVerified: true,
          templateArtifactsVerified: false,
          enforcementReady: false,
        },
        stages,
      });
    }

    const enforcementReadiness = await resolveEnforcementReadiness(dependencies, {
      owner: repository.owner,
      repo: repository.name,
      ref: 'main',
    });
    const enforcementRemediation = enforcementReadiness.ready
      ? undefined
      : remediationForEnforcementNotReady(enforcementReadiness.summary);
    stages.push({
      stage: 'enforcement_readiness_verify',
      status: enforcementReadiness.ready ? 'success' : 'failure',
      summary: enforcementReadiness.summary,
      details: {
        owner: repository.owner,
        repository: repository.name,
        ...(enforcementReadiness.details ? { readinessDetails: enforcementReadiness.details } : {}),
        ...(enforcementRemediation ? { remediation: enforcementRemediation } : {}),
      },
    });

    if (!enforcementReadiness.ready) {
      return buildResult({
        executionMode,
        outcome: 'not_ready',
        targetOwner,
        targetRepositoryName: normalizedRequest.targetRepositoryName,
        repository,
        failureClass: 'enforcement_not_ready',
        remediation: enforcementRemediation,
        scope: {
          repositoryCreated: true,
          hardeningApplied: true,
          hardeningVerified: true,
          templateArtifactsVerified: true,
          enforcementReady: false,
        },
        stages,
      });
    }

    return buildResult({
      executionMode,
      outcome: 'success',
      targetOwner,
      targetRepositoryName: normalizedRequest.targetRepositoryName,
      repository,
      scope: {
        repositoryCreated: true,
        hardeningApplied: true,
        hardeningVerified: true,
        templateArtifactsVerified: true,
        enforcementReady: true,
      },
      stages,
    });
  } catch (error) {
    const failedStage = createdRepositoryStageFailed(stages) ? 'branch_protection_apply' : 'create_or_plan';
    const failedRepositoryOwner = createdRepositoryState?.owner ?? targetOwner;
    const failedRepositoryName = createdRepositoryState?.name ?? normalizedRequest.targetRepositoryName;
    const isBranchProtectionPlanLimit =
      failedStage === 'branch_protection_apply' &&
      isGitHubPrivateBranchProtectionPlanLimitError(error, {
        owner: failedRepositoryOwner,
        repo: failedRepositoryName,
        branch: 'main',
      });

    if (isBranchProtectionPlanLimit && createdRepositoryState) {
      const remediation = remediationForHardeningManualRequired();
      const platformLimitation = getBranchProtectionPlanLimitEvidence(error, {
        owner: createdRepositoryState.owner,
        repo: createdRepositoryState.name,
        branch: 'main',
      });

      stages.push({
        stage: 'branch_protection_apply',
        status: 'failure',
        summary:
          'Repository creation and requester metadata persistence succeeded, but GitHub plan limits blocked private-repository branch protection. Manual hardening follow-up is required.',
        details: {
          owner: createdRepositoryState.owner,
          repository: createdRepositoryState.name,
          branch: 'main',
          ...(platformLimitation ? { platformLimitation } : {}),
          remediation,
        },
      });
      stages.push(
        skipStage(
          'branch_protection_verify',
          'Skipped because GitHub plan limits blocked automatic branch protection for this private repository.',
        ),
      );
      stages.push(skipStage('template_artifact_verify', 'Skipped until manual hardening follow-up is completed.'));
      stages.push(skipStage('enforcement_readiness_verify', 'Skipped until manual hardening follow-up is completed.'));

      return buildResult({
        executionMode,
        outcome: 'not_ready',
        targetOwner,
        targetRepositoryName: normalizedRequest.targetRepositoryName,
        repository: createdRepositoryState,
        failureClass: 'hardening_manual_required',
        remediation,
        scope: {
          repositoryCreated: true,
          hardeningApplied: false,
          hardeningVerified: false,
          templateArtifactsVerified: false,
          enforcementReady: false,
        },
        stages,
      });
    }

    stages.push({
      stage: failedStage,
      status: 'failure',
      summary:
        error instanceof Error
          ? error.message
          : failedStage === 'create_or_plan'
            ? 'Repository creation failed.'
            : 'Classic branch protection application failed.',
      details: {
        owner: targetOwner,
        repository: normalizedRequest.targetRepositoryName,
        branch: failedStage === 'branch_protection_apply' ? 'main' : undefined,
        remediation:
          failedStage === 'create_or_plan'
            ? remediationForCreateFailure()
            : remediationForHardeningApplyFailure(),
      },
    });

    if (failedStage === 'branch_protection_apply') {
      stages.push(skipStage('branch_protection_verify', 'Skipped because branch protection application failed.'));
      stages.push(skipStage('template_artifact_verify', 'Skipped because branch protection application failed.'));
      stages.push(skipStage('enforcement_readiness_verify', 'Skipped because branch protection application failed.'));
      const remediation = remediationForHardeningApplyFailure();

      return buildResult({
        executionMode,
        outcome: createdRepositoryState ? 'quarantined' : 'failed',
        targetOwner,
        targetRepositoryName: normalizedRequest.targetRepositoryName,
        repository: createdRepositoryState,
        failureClass: 'hardening_apply_failed',
        remediation,
        quarantine: createdRepositoryState
          ? createQuarantine(createdRepositoryState, 'Repository created but hardening failed to apply.', remediation)
          : undefined,
        scope: {
          repositoryCreated: Boolean(createdRepositoryState),
          hardeningApplied: false,
          hardeningVerified: false,
          templateArtifactsVerified: false,
          enforcementReady: false,
        },
        stages,
      });
    }

    stages.push(skipStage('branch_protection_apply', 'Skipped because repository creation failed.'));
    stages.push(skipStage('branch_protection_verify', 'Skipped because repository creation failed.'));
    stages.push(skipStage('template_artifact_verify', 'Skipped because repository creation failed.'));
    stages.push(skipStage('enforcement_readiness_verify', 'Skipped because repository creation failed.'));

    return buildResult({
      executionMode,
      outcome: 'failed',
      targetOwner,
      targetRepositoryName: normalizedRequest.targetRepositoryName,
      repository: createdRepositoryState,
      failureClass: 'create_failed',
      remediation: remediationForCreateFailure(),
      scope: {
        repositoryCreated: false,
        hardeningApplied: false,
        hardeningVerified: false,
        templateArtifactsVerified: false,
        enforcementReady: false,
      },
      stages,
    });
  }
}

export function formatProvisioningStageLogs(result: ProvisioningWorkflowResult): string[] {
  return result.stages.map((stage) => JSON.stringify(stage));
}

function resolveTargetOwner(executionMode: ExecutionMode, sandboxOwner?: string): string {
  if (executionMode === 'sandbox') {
    return (sandboxOwner ?? ORGANIZATION_SLUG).trim() || ORGANIZATION_SLUG;
  }

  return (sandboxOwner ?? ORGANIZATION_SLUG).trim() || ORGANIZATION_SLUG;
}

function summarizeRequesterMetadata(metadataArtifacts: ReturnType<typeof createRequesterMetadataArtifacts>) {
      return {
    metadataFilePath: metadataArtifacts.metadataFilePath,
    metadataKind: metadataArtifacts.metadataFile.kind,
    requesterLogin: metadataArtifacts.parsed.requesterLogin,
  };
}

function skipStage(stage: ProvisioningStageName, summary: string): ProvisioningStageOutput {
  return {
    stage,
    status: 'skipped',
    summary,
  };
}

function isRepositoryMissingError(error: unknown): boolean {
  return error instanceof GitHubApiError && error.context.status === 404;
}

function isExecutionMode(value: string): value is ExecutionMode {
  return value === 'dry-run' || value === 'sandbox';
}

function createdRepositoryStageFailed(stages: ProvisioningStageOutput[]): boolean {
  return stages.some((stage) => stage.stage === 'create_or_plan' && stage.status === 'success');
}

function isGitHubPrivateBranchProtectionPlanLimitError(
  error: unknown,
  input: {
    owner: string;
    repo: string;
    branch: string;
  },
): boolean {
  const evidence = getBranchProtectionPlanLimitEvidence(error, input);
  return evidence !== undefined;
}

function getBranchProtectionPlanLimitEvidence(
  error: unknown,
  input: {
    owner: string;
    repo: string;
    branch: string;
  },
):
  | {
      errorType: 'GitHubApiError' | 'GitHubAppPermissionError';
      method: 'PUT';
      path: string;
      message: string;
      status?: number;
    }
  | undefined {
  const expectedMethod = 'PUT';
  const expectedPath = `/repos/${input.owner}/${input.repo}/branches/${input.branch}/protection`;
  const planLimitMessage = /upgrade to github pro or make this repository public to enable this feature\.?/i;

  if (error instanceof GitHubApiError) {
    if (error.context.status !== 403) {
      return undefined;
    }

    if (error.context.path !== expectedPath) {
      return undefined;
    }

    if (!planLimitMessage.test(error.message)) {
      return undefined;
    }

    return {
      errorType: 'GitHubApiError',
      method: expectedMethod,
      path: error.context.path,
      message: error.message,
      status: error.context.status,
    };
  }

  if (error instanceof GitHubAppPermissionError) {
    const match = /^GitHub API permission failure for (?<method>\S+) (?<path>\/\S+): (?<message>.+)$/i.exec(error.message);
    if (!match?.groups) {
      return undefined;
    }

    const method = match.groups.method?.toUpperCase();
    const path = match.groups.path;
    const message = match.groups.message?.trim();

    if (method !== expectedMethod) {
      return undefined;
    }

    if (path !== expectedPath) {
      return undefined;
    }

    if (!message || !planLimitMessage.test(message)) {
      return undefined;
    }

    return {
      errorType: 'GitHubAppPermissionError',
      method: expectedMethod,
      path,
      message,
    };
  }

  return undefined;
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

function buildResult(input: ResultBuildInput): ProvisioningWorkflowResult {
  const scope: ProvisioningScopeState = {
    repositoryCreated: input.scope?.repositoryCreated ?? false,
    hardeningApplied: input.scope?.hardeningApplied ?? false,
    hardeningVerified: input.scope?.hardeningVerified ?? false,
    templateArtifactsVerified: input.scope?.templateArtifactsVerified ?? false,
    enforcementReady: input.scope?.enforcementReady ?? false,
  };
  const scopeSuccess =
    scope.repositoryCreated &&
    scope.hardeningApplied &&
    scope.hardeningVerified &&
    scope.templateArtifactsVerified;

  return {
    ok: input.outcome === 'success',
    outcome: input.outcome,
    readiness: input.outcome === 'success' ? 'ready' : 'not_ready',
    scopeSuccess,
    executionMode: input.executionMode,
    targetOwner: input.targetOwner,
    targetRepositoryName: input.targetRepositoryName,
    failureClass: input.failureClass,
    remediation: input.remediation,
    quarantine: input.quarantine,
    scope,
    repository: input.repository,
    stages: input.stages,
  };
}

async function verifyRequiredTemplateArtifacts(
  client: Pick<GitHubApiClient, 'getRepositoryContent'>,
  repository: {
    owner: string;
    repo: string;
    ref?: string;
  },
): Promise<{
  ok: boolean;
  summary: string;
  ref: string;
  requiredArtifacts: readonly RequiredTemplateArtifact[];
  presentArtifacts: string[];
  missingArtifacts: string[];
}> {
  const ref = repository.ref?.trim() || 'main';
  const results = await Promise.all(
    REQUIRED_TEMPLATE_ARTIFACTS.map(async (artifact) => ({
      artifact,
      present: await repositoryFileExists(client, repository.owner, repository.repo, artifact.path, ref),
    })),
  );
  const presentArtifacts = results.filter((result) => result.present).map((result) => result.artifact.path);
  const missingArtifacts = results.filter((result) => !result.present).map((result) => result.artifact.path);
  const ok = missingArtifacts.length === 0;

  return {
    ok,
    summary: ok
      ? 'Required template artifacts were verified in the provisioned target repository.'
      : `Required template artifacts are missing from the provisioned target repository: ${missingArtifacts.join(', ')}.`,
    ref,
    requiredArtifacts: REQUIRED_TEMPLATE_ARTIFACTS,
    presentArtifacts,
    missingArtifacts,
  };
}

async function resolveEnforcementReadiness(
  dependencies: ProvisioningWorkflowDependencies,
  repository: {
    owner: string;
    repo: string;
    ref?: string;
  },
): Promise<{
  ready: boolean;
  summary: string;
  details?: Record<string, unknown>;
}> {
  if (dependencies.config.enforcementReadinessCheck) {
    const readiness = await dependencies.config.enforcementReadinessCheck({
      owner: repository.owner,
      repo: repository.repo,
      ref: repository.ref,
      client: dependencies.client,
    });

    return {
      ready: readiness.ready,
      summary:
        readiness.summary ??
        (readiness.ready
          ? 'Requester-review enforcement readiness verified in the provisioned target repository.'
          : 'Requester-review enforcement readiness check failed for the provisioned target repository.'),
      details: readiness.details,
    };
  }

  const config = dependencies.config;

  if (config.enforcementReadiness) {
    return {
      ready: config.enforcementReadiness.ready,
      summary:
        config.enforcementReadiness.summary ??
        (config.enforcementReadiness.ready
          ? 'Requester-review enforcement readiness verified.'
          : 'Requester-review enforcement readiness check failed.'),
      details: config.enforcementReadiness.details,
    };
  }

  return {
    ready: false,
    summary:
      'Requester-review enforcement is not implemented yet; repository remains non-ready until enforcement verification is available.',
    details: {
      pendingCapability: 'requester-review-policy-enforcement',
    },
  };
}

function remediationForMetadataPersistenceFailure(): ProvisioningRemediation {
  return {
    code: 'metadata_persistence_failed',
    summary: 'Repository was created but requester metadata file could not be persisted.',
    actions: [
      'Treat the repository as quarantined until requester metadata file is repaired.',
      'Write .github/provisioning/requester-metadata.json in the target repository with canonical requester metadata content.',
      'Re-run provisioning verification after metadata persistence succeeds.',
    ],
  };
}

function createQuarantine(
  repository: { owner: string; name: string; private: boolean; url?: string },
  reason: string,
  remediation: ProvisioningRemediation,
): ProvisioningQuarantine {
  return {
    required: true,
    owner: repository.owner,
    repository: repository.name,
    reason,
    remediation,
  };
}

function remediationForValidation(summary?: string): ProvisioningRemediation {
  return {
    code: 'validation_failed',
    summary: summary ?? 'Provisioning input validation failed.',
    actions: ['Correct workflow_dispatch inputs to satisfy the canonical provisioning contract.', 'Re-run provisioning after inputs pass validation.'],
  };
}

function remediationForTemplateResolution(): ProvisioningRemediation {
  return {
    code: 'template_source_failed',
    summary: 'Template source configuration is invalid or missing.',
    actions: [
      'Set PROVISIONING_TEMPLATE_REPOSITORY to a single approved value in <owner>/<repo> form.',
      'Optionally set PROVISIONING_TEMPLATE_REPOSITORY_REF to a non-empty ref.',
      'Re-run provisioning after template configuration is corrected.',
    ],
  };
}

function remediationForDuplicateTarget(): ProvisioningRemediation {
  return {
    code: 'duplicate_target',
    summary: 'Target repository already exists.',
    actions: [
      'Choose a different repo_slug that normalizes to a new proj-* repository name.',
      'If the existing repository is unexpected, investigate and resolve ownership before retrying provisioning.',
    ],
  };
}

function remediationForDuplicatePreflight(): ProvisioningRemediation {
  return {
    code: 'duplicate_preflight_failed',
    summary: 'Duplicate target preflight could not determine repository availability.',
    actions: [
      'Check GitHub API availability and GitHub App repository read permissions.',
      'Retry preflight once API access is healthy.',
    ],
  };
}

function remediationForCreateFailure(): ProvisioningRemediation {
  return {
    code: 'create_failed',
    summary: 'Repository creation from template failed.',
    actions: [
      'Inspect GitHub App permissions and org repository creation policy.',
      'Verify template repository accessibility for the installation token.',
      'Retry provisioning after resolving create-path errors.',
    ],
  };
}

function remediationForHardeningApplyFailure(): ProvisioningRemediation {
  return {
    code: 'hardening_apply_failed',
    summary: 'Repository was created but branch-protection hardening failed to apply.',
    actions: [
      'Treat the repository as quarantined and block normal use until hardening is repaired.',
      'Re-apply classic main branch protection and verify required checks/admin enforcement.',
      'Re-run provisioning verification after hardening is restored.',
    ],
  };
}

function remediationForHardeningManualRequired(): ProvisioningRemediation {
  return {
    code: 'hardening_manual_required',
    summary:
      'Repository was created and requester metadata was persisted, but GitHub Free/private-repository plan limits blocked automatic branch protection.',
    actions: [
      'Manually configure main branch protection for the new private repository before allowing normal development use.',
      `Apply the same canonical controls (required status check \"${REQUESTER_REVIEW_POLICY_CHECK}\", required approving review count >= 1, enforce admins, no direct push bypass) once available.`,
      'To automate this step in future runs, either upgrade the organization plan to support private-repo branch protection APIs or use a public repository where this API is available.',
    ],
  };
}

function remediationForHardeningVerificationFailure(): ProvisioningRemediation {
  return {
    code: 'hardening_verification_failed',
    summary: 'Repository hardening drift detected after branch-protection application.',
    actions: [
      'Treat the repository as quarantined and investigate branch protection drift immediately.',
      'Restore canonical classic main branch protection and re-verify before marking ready.',
      'Capture drift evidence for audit/review follow-up.',
    ],
  };
}

function remediationForMissingTemplateArtifacts(missingArtifacts: string[]): ProvisioningRemediation {
  return {
    code: 'template_artifacts_missing',
    summary: `Provisioned repository is missing required template artifacts: ${missingArtifacts.join(', ')}.`,
    actions: [
      'Treat the repository as non-ready until template propagation is repaired in the target repository.',
      `Confirm the approved template repository still contains the mandatory artifact paths (${REQUIRED_TEMPLATE_ARTIFACTS.map((artifact) => artifact.path).join(', ')}).`,
      `Restore the missing target-repository artifact paths and re-run provisioning verification (${missingArtifacts.join(', ')}).`,
    ],
  };
}

function remediationForEnforcementNotReady(summary?: string): ProvisioningRemediation {
  return {
    code: 'enforcement_not_ready',
    summary:
      summary ??
      'Requester-review enforcement verification is not ready; repository cannot be marked fully ready.',
    actions: [
      'Implement and enable requester-review enforcement workflow verification (Task 7).',
      'Register requester-review-policy check as passing and verify enforcement readiness in a follow-up run.',
    ],
  };
}
