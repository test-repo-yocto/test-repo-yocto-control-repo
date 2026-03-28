export const REQUIRED_GITHUB_ACTIONS_SECRETS = [
  'PROVISIONING_GITHUB_APP_ID',
  'PROVISIONING_GITHUB_APP_INSTALLATION_ID',
  'PROVISIONING_GITHUB_APP_PRIVATE_KEY',
] as const;

export const LEGACY_GITHUB_APP_ENV_FALLBACKS = {
  PROVISIONING_GITHUB_APP_ID: 'GITHUB_APP_ID',
  PROVISIONING_GITHUB_APP_INSTALLATION_ID: 'GITHUB_APP_INSTALLATION_ID',
  PROVISIONING_GITHUB_APP_PRIVATE_KEY: 'GITHUB_APP_PRIVATE_KEY',
} as const;

export interface GitHubAppRuntimeCredentials {
  appId: string;
  installationId: string;
  privateKey: string;
}

export function getConfiguredGitHubActionsSecretNames(env: NodeJS.ProcessEnv): string[] {
  return REQUIRED_GITHUB_ACTIONS_SECRETS.filter((name) => !readConfiguredValue(name, env));
}

export function loadGitHubAppRuntimeCredentials(env: NodeJS.ProcessEnv): GitHubAppRuntimeCredentials {
  return {
    appId: requiredConfiguredValue('PROVISIONING_GITHUB_APP_ID', env),
    installationId: requiredConfiguredValue('PROVISIONING_GITHUB_APP_INSTALLATION_ID', env),
    privateKey: requiredConfiguredValue('PROVISIONING_GITHUB_APP_PRIVATE_KEY', env),
  };
}

export function formatGitHubAppSecretContract(): string {
  return `${REQUIRED_GITHUB_ACTIONS_SECRETS.join(', ')} (GitHub Actions repo/org secret names cannot start with GITHUB_, so these PROVISIONING_* names are the supported Actions contract).`;
}

export function formatLegacyGitHubAppFallbackNote(): string {
  return 'Legacy local/manual fallback env names remain supported only outside the primary Actions contract: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY.';
}

function requiredConfiguredValue(
  primaryName: keyof typeof LEGACY_GITHUB_APP_ENV_FALLBACKS,
  env: NodeJS.ProcessEnv,
): string {
  const value = readConfiguredValue(primaryName, env);

  if (!value) {
    throw new Error(`${primaryName} is required.`);
  }

  return value;
}

function readConfiguredValue(
  primaryName: keyof typeof LEGACY_GITHUB_APP_ENV_FALLBACKS,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const primaryValue = env[primaryName]?.trim();

  if (primaryValue) {
    return primaryValue;
  }

  const legacyName = LEGACY_GITHUB_APP_ENV_FALLBACKS[primaryName];
  const legacyValue = env[legacyName]?.trim();

  return legacyValue || undefined;
}
