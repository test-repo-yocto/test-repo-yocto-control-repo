import { appendFileSync } from 'node:fs';

import { createGitHubAppAuth } from '../github/auth.js';
import { createGitHubApiClient } from '../github/client.js';
import { getRequesterReviewEnforcementReadinessForRepository } from '../policy/requester-review-policy.js';
import { formatProvisioningStageLogs, runProvisioningWorkflow } from './orchestration.js';

async function main(): Promise<void> {
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
            appId: requiredEnv('GITHUB_APP_ID'),
            installationId: requiredEnv('GITHUB_APP_INSTALLATION_ID'),
            privateKey: requiredEnv('GITHUB_APP_PRIVATE_KEY'),
          },
        }),
      }),
      config: {
        templateRepository: requiredEnv('PROVISIONING_TEMPLATE_REPOSITORY'),
        templateRef: process.env.PROVISIONING_TEMPLATE_REPOSITORY_REF,
        requesterLogin: requiredEnv('GITHUB_ACTOR'),
        workflowRef:
          process.env.GITHUB_WORKFLOW_REF ?? '.github/workflows/provision-repository.yml@refs/heads/main',
        sandboxOwner: process.env.PROVISIONING_SANDBOX_OWNER,
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

  if (!result.ok) {
    process.exitCode = 1;
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();

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

function writeGitHubOutput(name: string, value: string): void {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

void main();
