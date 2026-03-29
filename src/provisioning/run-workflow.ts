import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createGitHubAppAuth } from '../github/auth.js';
import { createGitHubApiClient } from '../github/client.js';
import { getRequesterReviewEnforcementReadinessForRepository } from '../policy/requester-review-policy.js';
import {
  formatGitHubAppSecretContract,
  formatLegacyGitHubAppFallbackNote,
  getConfiguredGitHubActionsSecretNames,
  loadGitHubAppRuntimeCredentials,
} from './github-actions-config.js';
import {
  formatProvisioningStageLogs,
  runProvisioningWorkflow,
  type ProvisioningWorkflowResult,
} from './orchestration.js';

const REQUIRED_GITHUB_ACTIONS_VARIABLES = ['PROVISIONING_TEMPLATE_REPOSITORY'] as const;

const OPTIONAL_GITHUB_ACTIONS_VARIABLES = [
  'PROVISIONING_TEMPLATE_REPOSITORY_REF',
  'PROVISIONING_SANDBOX_OWNER',
] as const;

type RunWorkflowEnvironment = NodeJS.ProcessEnv;

async function main(): Promise<void> {
  const runtimeConfig = loadProvisioningRuntimeConfig();

  const result = await runProvisioningWorkflow(
    {
      repo_slug: requiredEnv('INPUT_REPO_SLUG'),
      description: requiredEnv('INPUT_DESCRIPTION'),
      execution_mode: optionalExecutionMode(process.env.INPUT_EXECUTION_MODE),
    },
    {
      client: createGitHubApiClient({
        auth: createGitHubAppAuth({
          credentials: {
            appId: runtimeConfig.githubApp.appId,
            installationId: runtimeConfig.githubApp.installationId,
            privateKey: runtimeConfig.githubApp.privateKey,
          },
        }),
      }),
      config: {
        templateRepository: runtimeConfig.templateRepository,
        templateRef: runtimeConfig.templateRef,
        requesterLogin: requiredEnv('GITHUB_ACTOR'),
        workflowRef:
          process.env.GITHUB_WORKFLOW_REF ?? '.github/workflows/provision-repository.yml@refs/heads/main',
        sandboxOwner: runtimeConfig.sandboxOwner,
        enforcementReadinessCheck: ({ owner, repo, ref, client }) =>
          getRequesterReviewEnforcementReadinessForRepository({
            client,
            owner,
            repo,
            ref,
          }),
      },
    },
  );

  for (const line of formatProvisioningStageLogs(result)) {
    console.log(line);
  }

  writeGitHubOutput('result', JSON.stringify(result));
  writeGitHubOutput('ok', String(result.ok));
  writeGitHubOutput('outcome', result.outcome);
  writeGitHubOutput('readiness', result.readiness);
  writeGitHubOutput('scope_success', String(result.scopeSuccess));

  if (shouldFailProvisioningRun(result)) {
    process.exitCode = 1;
  }
}

export function shouldFailProvisioningRun(result: ProvisioningWorkflowResult): boolean {
  if (result.ok) {
    return false;
  }

  if (isManualHardeningFollowupResult(result)) {
    return false;
  }

  return true;
}

export function isManualHardeningFollowupResult(result: ProvisioningWorkflowResult): boolean {
  return (
    result.outcome === 'not_ready' &&
    result.failureClass === 'hardening_manual_required' &&
    result.scope.repositoryCreated === true &&
    result.scope.hardeningApplied === false &&
    result.executionMode === 'sandbox'
  );
}

export interface ProvisioningRuntimeConfig {
  githubApp: {
    appId: string;
    installationId: string;
    privateKey: string;
  };
  templateRepository: string;
  templateRef?: string;
  sandboxOwner?: string;
}

export function loadProvisioningRuntimeConfig(env: RunWorkflowEnvironment = process.env): ProvisioningRuntimeConfig {
  const missingSecrets = getConfiguredGitHubActionsSecretNames(env);
  const missingVariables = missingEnvNames(env, REQUIRED_GITHUB_ACTIONS_VARIABLES);

  if (missingSecrets.length > 0 || missingVariables.length > 0) {
    throw new Error(formatMissingGitHubActionsConfigurationError({ missingSecrets, missingVariables }));
  }

  return {
    githubApp: {
      ...loadGitHubAppRuntimeCredentials(env),
    },
    templateRepository: requiredEnv('PROVISIONING_TEMPLATE_REPOSITORY', env),
    templateRef: optionalExecutionMode(env.PROVISIONING_TEMPLATE_REPOSITORY_REF),
    sandboxOwner: optionalExecutionMode(env.PROVISIONING_SANDBOX_OWNER),
  };
}

export function formatMissingGitHubActionsConfigurationError(input: {
  missingSecrets: string[];
  missingVariables: string[];
}): string {
  const lines = [
    'GitHub Actions provisioning configuration is incomplete.',
    'This workflow requires GitHub Actions secrets and variables to be configured before src/provisioning/run-workflow.ts can authenticate and resolve the approved template.',
  ];

  if (input.missingSecrets.length > 0) {
    lines.push('', 'Missing required GitHub Actions secrets:', ...input.missingSecrets.map((name) => `- ${name}`));
  }

  if (input.missingVariables.length > 0) {
    lines.push('', 'Missing required GitHub Actions variables:', ...input.missingVariables.map((name) => `- ${name}`));
  }

  lines.push(
    '',
    'Configure these values in GitHub before rerunning the workflow:',
    '- Repository Settings → Secrets and variables → Actions, or the organization-level Secrets and Variables pages if this control repository inherits shared provisioning config.',
    `- Secrets: ${formatGitHubAppSecretContract()}`,
    '- Variables: PROVISIONING_TEMPLATE_REPOSITORY',
    `- Optional variables used by this workflow: ${OPTIONAL_GITHUB_ACTIONS_VARIABLES.join(', ')}`,
    '- PROVISIONING_TEMPLATE_REPOSITORY must be set to the approved template repository in <owner>/<repo> form.',
    `- ${formatLegacyGitHubAppFallbackNote()}`,
  );

  return lines.join('\n');
}

function requiredEnv(name: string, env: RunWorkflowEnvironment = process.env): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function optionalExecutionMode(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value.trim();
}

function missingEnvNames(env: RunWorkflowEnvironment, names: readonly string[]): string[] {
  return names.filter((name) => !env[name]?.trim());
}

function writeGitHubOutput(name: string, value: string): void {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
