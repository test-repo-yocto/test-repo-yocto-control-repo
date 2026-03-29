import { describe, expect, it } from 'vitest';

import {
  formatMissingGitHubActionsConfigurationError,
  isManualHardeningFollowupResult,
  loadProvisioningRuntimeConfig,
  shouldFailProvisioningRun,
} from '../src/provisioning/run-workflow.js';
import type { ProvisioningWorkflowResult } from '../src/provisioning/orchestration.js';

describe('loadProvisioningRuntimeConfig', () => {
  it('loads required GitHub Actions secrets and variables when present', () => {
    const config = loadProvisioningRuntimeConfig({
      PROVISIONING_GITHUB_APP_ID: '12345',
      PROVISIONING_GITHUB_APP_INSTALLATION_ID: '67890',
      PROVISIONING_GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
      PROVISIONING_TEMPLATE_REPOSITORY: 'test-repo-yocto/template-repository',
      PROVISIONING_TEMPLATE_REPOSITORY_REF: 'refs/heads/main',
      PROVISIONING_SANDBOX_OWNER: 'test-repo-yocto-sandbox',
    });

    expect(config).toEqual({
      githubApp: {
        appId: '12345',
        installationId: '67890',
        privateKey: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
      },
      templateRepository: 'test-repo-yocto/template-repository',
      templateRef: 'refs/heads/main',
      sandboxOwner: 'test-repo-yocto-sandbox',
    });
  });

  it('accepts legacy GITHUB_APP_* env names only as a local/manual fallback', () => {
    const config = loadProvisioningRuntimeConfig({
      GITHUB_APP_ID: '12345',
      GITHUB_APP_INSTALLATION_ID: '67890',
      GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nlegacy\n-----END PRIVATE KEY-----',
      PROVISIONING_TEMPLATE_REPOSITORY: 'test-repo-yocto/template-repository',
    });

    expect(config.githubApp).toEqual({
      appId: '12345',
      installationId: '67890',
      privateKey: '-----BEGIN PRIVATE KEY-----\nlegacy\n-----END PRIVATE KEY-----',
    });
  });

  it('reports all missing required GitHub Actions secrets and variables with setup guidance', () => {
    expect(() =>
      loadProvisioningRuntimeConfig({
        PROVISIONING_GITHUB_APP_ID: '12345',
      }),
    ).toThrowErrorMatchingInlineSnapshot(`
      [Error: GitHub Actions provisioning configuration is incomplete.
      This workflow requires GitHub Actions secrets and variables to be configured before src/provisioning/run-workflow.ts can authenticate and resolve the approved template.

      Missing required GitHub Actions secrets:
      - PROVISIONING_GITHUB_APP_INSTALLATION_ID
      - PROVISIONING_GITHUB_APP_PRIVATE_KEY

      Missing required GitHub Actions variables:
      - PROVISIONING_TEMPLATE_REPOSITORY

      Configure these values in GitHub before rerunning the workflow:
      - Repository Settings → Secrets and variables → Actions, or the organization-level Secrets and Variables pages if this control repository inherits shared provisioning config.
      - Secrets: PROVISIONING_GITHUB_APP_ID, PROVISIONING_GITHUB_APP_INSTALLATION_ID, PROVISIONING_GITHUB_APP_PRIVATE_KEY (GitHub Actions repo/org secret names cannot start with GITHUB_, so these PROVISIONING_* names are the supported Actions contract).
      - Variables: PROVISIONING_TEMPLATE_REPOSITORY
      - Optional variables used by this workflow: PROVISIONING_TEMPLATE_REPOSITORY_REF, PROVISIONING_SANDBOX_OWNER
      - PROVISIONING_TEMPLATE_REPOSITORY must be set to the approved template repository in <owner>/<repo> form.
      - Legacy local/manual fallback env names remain supported only outside the primary Actions contract: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY.]
    `);
  });
});

describe('formatMissingGitHubActionsConfigurationError', () => {
  it('distinguishes secrets from variables and keeps optional vars documented', () => {
    const message = formatMissingGitHubActionsConfigurationError({
      missingSecrets: ['PROVISIONING_GITHUB_APP_PRIVATE_KEY'],
      missingVariables: ['PROVISIONING_TEMPLATE_REPOSITORY'],
    });

    expect(message).toContain('Missing required GitHub Actions secrets:');
    expect(message).toContain('- PROVISIONING_GITHUB_APP_PRIVATE_KEY');
    expect(message).toContain('Missing required GitHub Actions variables:');
    expect(message).toContain('- PROVISIONING_TEMPLATE_REPOSITORY');
    expect(message).toContain('Optional variables used by this workflow: PROVISIONING_TEMPLATE_REPOSITORY_REF, PROVISIONING_SANDBOX_OWNER');
    expect(message).toContain('Repository Settings → Secrets and variables → Actions');
    expect(message).toContain('cannot start with GITHUB_');
    expect(message).toContain('Legacy local/manual fallback env names remain supported');
  });
});

describe('shouldFailProvisioningRun', () => {
  function createResult(overrides?: Partial<ProvisioningWorkflowResult>): ProvisioningWorkflowResult {
    return {
      ok: false,
      outcome: 'failed',
      readiness: 'not_ready',
      scopeSuccess: false,
      executionMode: 'sandbox',
      failureClass: 'create_failed',
      scope: {
        repositoryCreated: false,
        hardeningApplied: false,
        hardeningVerified: false,
        templateArtifactsVerified: false,
        enforcementReady: false,
      },
      stages: [],
      ...overrides,
    };
  }

  it('does not fail workflow process exit for manual hardening follow-up result', () => {
    const result = createResult({
      outcome: 'not_ready',
      failureClass: 'hardening_manual_required',
      scope: {
        repositoryCreated: true,
        hardeningApplied: false,
        hardeningVerified: false,
        templateArtifactsVerified: false,
        enforcementReady: false,
      },
    });

    expect(isManualHardeningFollowupResult(result)).toBe(true);
    expect(shouldFailProvisioningRun(result)).toBe(false);
  });

  it('still fails workflow process exit for non-manual hardening provisioning failures', () => {
    const result = createResult({
      outcome: 'quarantined',
      failureClass: 'hardening_apply_failed',
      scope: {
        repositoryCreated: true,
        hardeningApplied: false,
        hardeningVerified: false,
        templateArtifactsVerified: false,
        enforcementReady: false,
      },
    });

    expect(isManualHardeningFollowupResult(result)).toBe(false);
    expect(shouldFailProvisioningRun(result)).toBe(true);
  });
});
