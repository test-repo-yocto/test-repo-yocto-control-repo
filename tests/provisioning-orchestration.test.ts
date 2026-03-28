import { describe, expect, it, vi } from 'vitest';

import { REQUIRED_TEMPLATE_ARTIFACTS } from '../src/contracts/template-metadata.js';
import { REQUESTER_REVIEW_POLICY_CHECK } from '../src/github/branch-protection.js';
import { GitHubApiError } from '../src/github/client.js';
import {
  formatProvisioningStageLogs,
  runProvisioningWorkflow,
  type ProvisioningWorkflowDependencies,
} from '../src/provisioning/orchestration.js';

interface TestDependencies extends ProvisioningWorkflowDependencies {
    mocks: {
      getRepository: ReturnType<typeof vi.fn>;
      createRepositoryFromTemplate: ReturnType<typeof vi.fn>;
      upsertRepositoryFile: ReturnType<typeof vi.fn>;
      updateBranchProtection: ReturnType<typeof vi.fn>;
      getBranchProtection: ReturnType<typeof vi.fn>;
      getRepositoryContent: ReturnType<typeof vi.fn>;
    };
}

function createDependencies(options?: {
  enforcementReadinessCheck?: ProvisioningWorkflowDependencies['config']['enforcementReadinessCheck'];
}): TestDependencies {
  const getRepository = vi.fn<(input: unknown) => Promise<unknown>>(async () => {
    throw new GitHubApiError('Not Found', {
      method: 'GET',
      path: '/repos/test-repo-yocto/proj-my-service',
      status: 404,
    });
  });
  const createRepositoryFromTemplate = vi.fn<(input: unknown) => Promise<unknown>>(async () => ({
    name: 'proj-my-service',
    private: true,
    html_url: 'https://github.com/test-repo-yocto/proj-my-service',
  }));
  const updateBranchProtection = vi.fn<(input: unknown) => Promise<unknown>>(async () => ({ ok: true }));
  const upsertRepositoryFile = vi.fn<(input: unknown) => Promise<unknown>>(async () => ({
    content: {
      path: '.github/provisioning/requester-metadata.json',
    },
  }));
  const getBranchProtection = vi.fn<(input: unknown) => Promise<unknown>>(async () => ({
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
  }));
  const getRepositoryContent = vi.fn<(owner: string, repo: string, path: string, ref?: string) => Promise<unknown>>(
    async () => ({ type: 'file' }),
  );

  return {
    client: {
      getRepository: async <T = unknown>(input: unknown) => getRepository(input) as Promise<T>,
      createRepositoryFromTemplate: async <T = unknown>(input: unknown) =>
        createRepositoryFromTemplate(input) as Promise<T>,
      upsertRepositoryFile: async <T = unknown>(input: unknown) => upsertRepositoryFile(input) as Promise<T>,
      updateBranchProtection: async <T = unknown>(input: unknown) => updateBranchProtection(input) as Promise<T>,
      getBranchProtection: async <T = unknown>(input: unknown) => getBranchProtection(input) as Promise<T>,
      getRepositoryContent: async <T = unknown>(owner: string, repo: string, path: string, ref?: string) =>
        getRepositoryContent(owner, repo, path, ref) as Promise<T>,
    },
    config: {
      templateRepository: 'test-repo-yocto/template-repository',
      requesterLogin: 'alice',
      workflowRef: '.github/workflows/provision-repository.yml@refs/heads/main',
      sandboxOwner: 'test-repo-yocto-sandbox',
      enforcementReadinessCheck: options?.enforcementReadinessCheck,
      now: () => new Date('2026-03-28T12:00:00.000Z'),
    },
    mocks: {
      getRepository,
      createRepositoryFromTemplate,
      upsertRepositoryFile,
      updateBranchProtection,
      getBranchProtection,
      getRepositoryContent,
    },
  };
}

describe('runProvisioningWorkflow', () => {
  it('dry-run validates and emits a planned create without calling GitHub create', async () => {
    const dependencies = createDependencies();

    const result = await runProvisioningWorkflow(
      {
        repo_slug: 'my-service',
        description: 'sandbox repo',
        execution_mode: 'dry-run',
      },
      dependencies,
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('not_ready');
    expect(result.readiness).toBe('not_ready');
    expect(result.scopeSuccess).toBe(false);
    expect(result.executionMode).toBe('dry-run');
    expect(result.targetOwner).toBe('test-repo-yocto-sandbox');
    expect(dependencies.mocks.getRepository).toHaveBeenCalledWith({
      owner: 'test-repo-yocto-sandbox',
      repo: 'proj-my-service',
    });
    expect(dependencies.mocks.createRepositoryFromTemplate).not.toHaveBeenCalled();
    expect(result.stages.map((stage) => [stage.stage, stage.status])).toEqual([
      ['contract_validation', 'success'],
      ['mode_resolution', 'success'],
      ['template_source_resolution', 'success'],
      ['duplicate_target_preflight', 'success'],
      ['create_or_plan', 'planned'],
      ['branch_protection_apply', 'planned'],
      ['branch_protection_verify', 'planned'],
      ['template_artifact_verify', 'planned'],
      ['enforcement_readiness_verify', 'planned'],
    ]);
    expect(formatProvisioningStageLogs(result)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"stage":"contract_validation"'),
        expect.stringContaining('"stage":"create_or_plan"'),
        expect.stringContaining('"status":"planned"'),
      ]),
    );
  });

  it('sandbox mode creates a private repository from the approved template', async () => {
    const dependencies = createDependencies({
      enforcementReadinessCheck: async () => ({
        ready: true,
      }),
    });

    const result = await runProvisioningWorkflow(
      {
        repo_slug: 'my-service',
        description: 'sandbox repo',
        execution_mode: 'sandbox',
      },
      dependencies,
    );

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('success');
    expect(result.readiness).toBe('ready');
    expect(result.scopeSuccess).toBe(true);
    expect(result.scope.templateArtifactsVerified).toBe(true);
    expect(dependencies.mocks.createRepositoryFromTemplate).toHaveBeenCalledWith({
      templateOwner: 'test-repo-yocto',
      templateRepo: 'template-repository',
      owner: 'test-repo-yocto-sandbox',
      name: 'proj-my-service',
      description: 'sandbox repo',
      private: true,
    });
    expect(dependencies.mocks.upsertRepositoryFile).toHaveBeenCalledTimes(1);
    expect(dependencies.mocks.upsertRepositoryFile).toHaveBeenCalledWith({
      owner: 'test-repo-yocto-sandbox',
      repo: 'proj-my-service',
      path: '.github/provisioning/requester-metadata.json',
      content: expect.stringContaining('"requester_login": "alice"'),
      message: 'chore(provisioning): persist requester metadata',
      branch: 'main',
    });
    expect(result.repository).toEqual({
      owner: 'test-repo-yocto-sandbox',
      name: 'proj-my-service',
      private: true,
      url: 'https://github.com/test-repo-yocto/proj-my-service',
    });
    expect(result.stages.at(-1)).toMatchObject({
      stage: 'enforcement_readiness_verify',
      status: 'success',
    });
    expect(dependencies.mocks.updateBranchProtection).toHaveBeenCalledWith({
      owner: 'test-repo-yocto-sandbox',
      repo: 'proj-my-service',
      branch: 'main',
      protection: expect.objectContaining({
        enforce_admins: true,
        restrictions: {
          users: [],
          teams: [],
          apps: [],
        },
      }),
    });
    expect(dependencies.mocks.getBranchProtection).toHaveBeenCalledWith({
      owner: 'test-repo-yocto-sandbox',
      repo: 'proj-my-service',
      branch: 'main',
    });
    for (const artifact of REQUIRED_TEMPLATE_ARTIFACTS) {
      expect(dependencies.mocks.getRepositoryContent).toHaveBeenCalledWith(
        'test-repo-yocto-sandbox',
        'proj-my-service',
        artifact.path,
        'main',
      );
    }
  });

  it('rejects invalid slugs before any duplicate check or create attempt', async () => {
    const dependencies = createDependencies();

    const result = await runProvisioningWorkflow(
      {
        repo_slug: 'Bad_Name',
        description: 'sandbox repo',
        execution_mode: 'sandbox',
      },
      dependencies,
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('failed');
    expect(result.failureClass).toBe('validation_failed');
    expect(dependencies.mocks.getRepository).not.toHaveBeenCalled();
    expect(dependencies.mocks.createRepositoryFromTemplate).not.toHaveBeenCalled();
    expect(result.stages).toMatchObject([
      {
        stage: 'contract_validation',
        status: 'failure',
        summary: 'repo_slug must be lowercase; uppercase characters are rejected.',
        details: {
          requestedExecutionMode: 'sandbox',
          remediation: {
            code: 'validation_failed',
          },
        },
      },
    ]);
    expect(formatProvisioningStageLogs(result)[0]).toContain('repo_slug must be lowercase');
  });

  it('fails duplicate targets during preflight before create is attempted', async () => {
    const dependencies = createDependencies();
    dependencies.mocks.getRepository.mockResolvedValueOnce({
      name: 'proj-my-service',
      private: true,
      html_url: 'https://github.com/test-repo-yocto-sandbox/proj-my-service',
    });

    const result = await runProvisioningWorkflow(
      {
        repo_slug: 'my-service',
        description: 'sandbox repo',
        execution_mode: 'sandbox',
      },
      dependencies,
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('failed');
    expect(result.failureClass).toBe('duplicate_target');
    expect(dependencies.mocks.createRepositoryFromTemplate).not.toHaveBeenCalled();
    expect(result.stages.map((stage) => [stage.stage, stage.status])).toEqual([
      ['contract_validation', 'success'],
      ['mode_resolution', 'success'],
      ['template_source_resolution', 'success'],
      ['duplicate_target_preflight', 'failure'],
      ['create_or_plan', 'skipped'],
      ['branch_protection_apply', 'skipped'],
      ['branch_protection_verify', 'skipped'],
      ['template_artifact_verify', 'skipped'],
      ['enforcement_readiness_verify', 'skipped'],
    ]);
    expect(result.stages[3]).toMatchObject({
      summary: 'Duplicate target repository detected; provisioning stopped before any create call.',
      details: expect.objectContaining({
        repository: 'proj-my-service',
      }),
    });
    expect(formatProvisioningStageLogs(result)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"stage":"duplicate_target_preflight"'),
        expect.stringContaining('Duplicate target repository detected'),
      ]),
    );
  });

  it('fails sandbox provisioning when branch protection verification detects drift', async () => {
    const dependencies = createDependencies();
    dependencies.mocks.getBranchProtection.mockResolvedValueOnce({
      required_status_checks: {
        strict: true,
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
      required_linear_history: true,
      allow_force_pushes: false,
      allow_deletions: false,
      block_creations: true,
      required_conversation_resolution: true,
    });

    const result = await runProvisioningWorkflow(
      {
        repo_slug: 'my-service',
        description: 'sandbox repo',
        execution_mode: 'sandbox',
      },
      dependencies,
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('quarantined');
    expect(result.readiness).toBe('not_ready');
    expect(result.scopeSuccess).toBe(false);
    expect(result.failureClass).toBe('hardening_verification_failed');
    expect(result.quarantine).toMatchObject({
      required: true,
      owner: 'test-repo-yocto-sandbox',
      repository: 'proj-my-service',
    });
    expect(result.repository).toEqual({
      owner: 'test-repo-yocto-sandbox',
      name: 'proj-my-service',
      private: true,
      url: 'https://github.com/test-repo-yocto/proj-my-service',
    });
    expect(result.stages.map((stage) => [stage.stage, stage.status])).toEqual([
      ['contract_validation', 'success'],
      ['mode_resolution', 'success'],
      ['template_source_resolution', 'success'],
      ['duplicate_target_preflight', 'success'],
      ['create_or_plan', 'success'],
      ['branch_protection_apply', 'failure'],
      ['branch_protection_verify', 'failure'],
      ['template_artifact_verify', 'skipped'],
      ['enforcement_readiness_verify', 'skipped'],
    ]);
    expect(result.stages.find((stage) => stage.stage === 'branch_protection_verify')).toMatchObject({
      details: expect.objectContaining({
        issues: expect.arrayContaining([
          `Required status checks must include ${REQUESTER_REVIEW_POLICY_CHECK}.`,
          'Admin enforcement must be enabled so administrators cannot bypass main protection.',
        ]),
      }),
    });
  });

  it('returns quarantined when repository creation succeeds but hardening apply throws', async () => {
    const dependencies = createDependencies();
    dependencies.mocks.updateBranchProtection.mockRejectedValueOnce(new Error('branch protection API failed'));

    const result = await runProvisioningWorkflow(
      {
        repo_slug: 'my-service',
        description: 'sandbox repo',
        execution_mode: 'sandbox',
      },
      dependencies,
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('quarantined');
    expect(result.failureClass).toBe('hardening_apply_failed');
    expect(result.scopeSuccess).toBe(false);
    expect(result.repository).toEqual({
      owner: 'test-repo-yocto-sandbox',
      name: 'proj-my-service',
      private: true,
      url: 'https://github.com/test-repo-yocto/proj-my-service',
    });
    expect(result.quarantine).toMatchObject({
      required: true,
      owner: 'test-repo-yocto-sandbox',
      repository: 'proj-my-service',
    });
    expect(result.stages.map((stage) => [stage.stage, stage.status])).toEqual([
      ['contract_validation', 'success'],
      ['mode_resolution', 'success'],
      ['template_source_resolution', 'success'],
      ['duplicate_target_preflight', 'success'],
      ['create_or_plan', 'success'],
      ['branch_protection_apply', 'failure'],
      ['branch_protection_verify', 'skipped'],
      ['template_artifact_verify', 'skipped'],
      ['enforcement_readiness_verify', 'skipped'],
    ]);
  });

  it('returns non-ready with explicit remediation when required template artifacts are missing', async () => {
    const dependencies = createDependencies({
      enforcementReadinessCheck: async () => ({
        ready: true,
      }),
    });
    dependencies.mocks.getRepositoryContent.mockImplementation(
      async (_owner: string, _repo: string, path: string) => {
        if (path === '.github/workflows/ci.yml') {
          throw new GitHubApiError('Not Found', {
            method: 'GET',
            path: '/repos/test-repo-yocto-sandbox/proj-my-service/contents/.github/workflows/ci.yml',
            status: 404,
          });
        }

        return { type: 'file', path };
      },
    );

    const result = await runProvisioningWorkflow(
      {
        repo_slug: 'my-service',
        description: 'sandbox repo',
        execution_mode: 'sandbox',
      },
      dependencies,
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('not_ready');
    expect(result.failureClass).toBe('template_artifacts_missing');
    expect(result.scopeSuccess).toBe(false);
    expect(result.scope).toMatchObject({
      repositoryCreated: true,
      hardeningApplied: true,
      hardeningVerified: true,
      templateArtifactsVerified: false,
      enforcementReady: false,
    });
    expect(result.remediation?.actions).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Restore the missing target-repository artifact paths'),
      ]),
    );
    expect(result.stages.map((stage) => [stage.stage, stage.status])).toEqual([
      ['contract_validation', 'success'],
      ['mode_resolution', 'success'],
      ['template_source_resolution', 'success'],
      ['duplicate_target_preflight', 'success'],
      ['create_or_plan', 'success'],
      ['branch_protection_apply', 'success'],
      ['branch_protection_verify', 'success'],
      ['template_artifact_verify', 'failure'],
      ['enforcement_readiness_verify', 'skipped'],
    ]);
    expect(result.stages.find((stage) => stage.stage === 'template_artifact_verify')).toMatchObject({
      summary:
        'Required template artifacts are missing from the provisioned target repository: .github/workflows/ci.yml.',
      details: expect.objectContaining({
        missingArtifacts: ['.github/workflows/ci.yml'],
      }),
    });
  });

  it('reports non-ready when hardening succeeds but enforcement readiness is not ready', async () => {
    const dependencies = createDependencies({
      enforcementReadinessCheck: async () => ({
        ready: false,
        summary: 'Requester-review workflow file missing in target repository.',
        details: {
          missingWorkflow: '.github/workflows/requester-review-policy.yml',
        },
      }),
    });

    const result = await runProvisioningWorkflow(
      {
        repo_slug: 'my-service',
        description: 'sandbox repo',
        execution_mode: 'sandbox',
      },
      dependencies,
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('not_ready');
    expect(result.failureClass).toBe('enforcement_not_ready');
    expect(result.scopeSuccess).toBe(true);
    expect(result.scope).toMatchObject({
      repositoryCreated: true,
      hardeningApplied: true,
      hardeningVerified: true,
      templateArtifactsVerified: true,
      enforcementReady: false,
    });
    expect(result.quarantine).toBeUndefined();
    expect(result.stages.at(-1)).toMatchObject({
      stage: 'enforcement_readiness_verify',
      status: 'failure',
      summary: 'Requester-review workflow file missing in target repository.',
    });
  });

  it('reports ready only when target-repository enforcement artifacts are observed', async () => {
    const dependencies = createDependencies({
      enforcementReadinessCheck: async ({ client, owner, repo, ref }) => {
        await client.getRepositoryContent(owner, repo, '.github/workflows/requester-review-policy.yml', ref);
        await client.getRepositoryContent(owner, repo, '.github/provisioning/requester-metadata.json', ref);

        return {
          ready: true,
          summary: 'Target repository contains workflow and requester metadata file artifacts.',
          details: {
            owner,
            repo,
            ref,
          },
        };
      },
    });

    const result = await runProvisioningWorkflow(
      {
        repo_slug: 'my-service',
        description: 'sandbox repo',
        execution_mode: 'sandbox',
      },
      dependencies,
    );

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('success');
    expect(result.readiness).toBe('ready');
    expect(result.scope.templateArtifactsVerified).toBe(true);
    expect(result.scope.enforcementReady).toBe(true);
    for (const artifact of REQUIRED_TEMPLATE_ARTIFACTS) {
      expect(dependencies.mocks.getRepositoryContent).toHaveBeenCalledWith(
        'test-repo-yocto-sandbox',
        'proj-my-service',
        artifact.path,
        'main',
      );
    }
    expect(dependencies.mocks.getRepositoryContent).toHaveBeenCalledWith(
      'test-repo-yocto-sandbox',
      'proj-my-service',
      '.github/workflows/requester-review-policy.yml',
      'main',
    );
    expect(dependencies.mocks.getRepositoryContent).toHaveBeenCalledWith(
      'test-repo-yocto-sandbox',
      'proj-my-service',
      '.github/provisioning/requester-metadata.json',
      'main',
    );
  });

  it('quarantines repository when metadata persistence fails after create', async () => {
    const dependencies = createDependencies();
    dependencies.mocks.upsertRepositoryFile.mockRejectedValueOnce(new Error('metadata file commit failed'));

    const result = await runProvisioningWorkflow(
      {
        repo_slug: 'my-service',
        description: 'sandbox repo',
        execution_mode: 'sandbox',
      },
      dependencies,
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('quarantined');
    expect(result.failureClass).toBe('metadata_persistence_failed');
    expect(result.scope).toMatchObject({
      repositoryCreated: true,
      hardeningApplied: false,
      hardeningVerified: false,
      enforcementReady: false,
    });
    expect(result.stages.map((stage) => [stage.stage, stage.status])).toEqual([
      ['contract_validation', 'success'],
      ['mode_resolution', 'success'],
      ['template_source_resolution', 'success'],
      ['duplicate_target_preflight', 'success'],
      ['create_or_plan', 'failure'],
      ['branch_protection_apply', 'skipped'],
      ['branch_protection_verify', 'skipped'],
      ['template_artifact_verify', 'skipped'],
      ['enforcement_readiness_verify', 'skipped'],
    ]);
  });
});
