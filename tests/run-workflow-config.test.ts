import { describe, expect, it } from 'vitest';

import {
  formatMissingGitHubActionsConfigurationError,
  loadProvisioningRuntimeConfig,
} from '../src/provisioning/run-workflow.js';

describe('loadProvisioningRuntimeConfig', () => {
  it('loads required GitHub Actions secrets and variables when present', () => {
    const config = loadProvisioningRuntimeConfig({
      GITHUB_APP_ID: '12345',
      GITHUB_APP_INSTALLATION_ID: '67890',
      GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
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

  it('reports all missing required GitHub Actions secrets and variables with setup guidance', () => {
    expect(() =>
      loadProvisioningRuntimeConfig({
        GITHUB_APP_ID: '12345',
      }),
    ).toThrowErrorMatchingInlineSnapshot(`
      [Error: GitHub Actions provisioning configuration is incomplete.
      This workflow requires GitHub Actions secrets and variables to be configured before src/provisioning/run-workflow.ts can authenticate and resolve the approved template.

      Missing required GitHub Actions secrets:
      - GITHUB_APP_INSTALLATION_ID
      - GITHUB_APP_PRIVATE_KEY

      Missing required GitHub Actions variables:
      - PROVISIONING_TEMPLATE_REPOSITORY

      Configure these values in GitHub before rerunning the workflow:
      - Repository Settings → Secrets and variables → Actions, or the organization-level Secrets and Variables pages if this control repository inherits shared provisioning config.
      - Secrets: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY
      - Variables: PROVISIONING_TEMPLATE_REPOSITORY
      - Optional variables used by this workflow: PROVISIONING_TEMPLATE_REPOSITORY_REF, PROVISIONING_SANDBOX_OWNER
      - PROVISIONING_TEMPLATE_REPOSITORY must be set to the approved template repository in <owner>/<repo> form.]
    `);
  });
});

describe('formatMissingGitHubActionsConfigurationError', () => {
  it('distinguishes secrets from variables and keeps optional vars documented', () => {
    const message = formatMissingGitHubActionsConfigurationError({
      missingSecrets: ['GITHUB_APP_PRIVATE_KEY'],
      missingVariables: ['PROVISIONING_TEMPLATE_REPOSITORY'],
    });

    expect(message).toContain('Missing required GitHub Actions secrets:');
    expect(message).toContain('- GITHUB_APP_PRIVATE_KEY');
    expect(message).toContain('Missing required GitHub Actions variables:');
    expect(message).toContain('- PROVISIONING_TEMPLATE_REPOSITORY');
    expect(message).toContain('Optional variables used by this workflow: PROVISIONING_TEMPLATE_REPOSITORY_REF, PROVISIONING_SANDBOX_OWNER');
    expect(message).toContain('Repository Settings → Secrets and variables → Actions');
  });
});
