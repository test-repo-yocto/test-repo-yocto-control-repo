import { createPrivateKey, createSign } from 'node:crypto';

import {
  GITHUB_APP_PERMISSION_REQUIREMENTS,
  describeMissingRepositoryPermissions,
  type GitHubAppPermissionRequirement,
  type GitHubRepositoryPermissionSet,
} from './permissions.js';

const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
const DEFAULT_JWT_TTL_SECONDS = 9 * 60;
const GITHUB_ACCEPT_HEADER = 'application/vnd.github+json';
const GITHUB_API_VERSION = '2022-11-28';

export interface GitHubAppCredentials {
  appId: string;
  installationId: string;
  privateKey: string;
}

export interface GitHubAppInstallationToken {
  token: string;
  expiresAt: Date;
  permissions: GitHubRepositoryPermissionSet;
}

export interface GitHubAppAuthOptions {
  credentials: GitHubAppCredentials;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  permissionRequirements?: readonly GitHubAppPermissionRequirement[];
}

export class GitHubAppAuthError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'GitHubAppAuthError';
    this.cause = options?.cause;
  }
}

export class GitHubAppPermissionError extends Error {
  readonly missingPermissions: string[];

  constructor(message: string, missingPermissions: string[]) {
    super(message);
    this.name = 'GitHubAppPermissionError';
    this.missingPermissions = missingPermissions;
  }
}

export interface GitHubAppAuth {
  getInstallationToken(): Promise<GitHubAppInstallationToken>;
}

interface GitHubInstallationTokenResponse {
  token?: unknown;
  expires_at?: unknown;
  permissions?: unknown;
}

export function createGitHubAppAuth(options: GitHubAppAuthOptions): GitHubAppAuth {
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  if (typeof fetchImplementation !== 'function') {
    throw new Error('A fetch implementation is required to create GitHub App auth.');
  }

  const permissionRequirements = options.permissionRequirements ?? GITHUB_APP_PERMISSION_REQUIREMENTS;
  const apiBaseUrl = stripTrailingSlash(options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL);
  const now = options.now ?? (() => new Date());
  let cachedToken: GitHubAppInstallationToken | undefined;

  return {
    async getInstallationToken(): Promise<GitHubAppInstallationToken> {
      if (cachedToken && cachedToken.expiresAt.getTime() - now().getTime() > 60_000) {
        return cachedToken;
      }

      const appJwt = createGitHubAppJwt(options.credentials.appId, options.credentials.privateKey, now);
      const url = `${apiBaseUrl}/app/installations/${options.credentials.installationId}/access_tokens`;

      let response: Response;

      try {
        response = await fetchImplementation(url, {
          method: 'POST',
          headers: {
            accept: GITHUB_ACCEPT_HEADER,
            authorization: `Bearer ${appJwt}`,
            'content-type': 'application/json',
            'x-github-api-version': GITHUB_API_VERSION,
          },
          body: JSON.stringify({}),
        });
      } catch (error) {
        throw new GitHubAppAuthError('GitHub App installation token request failed.', { cause: error });
      }

      if (response.status === 401) {
        throw new GitHubAppAuthError('GitHub App authentication failed while requesting an installation token.');
      }

      if (!response.ok) {
        throw new GitHubAppAuthError(
          `GitHub App installation token request failed with status ${response.status}.`,
        );
      }

      const payload = (await response.json()) as GitHubInstallationTokenResponse;
      const token = assertString(payload.token, 'GitHub installation token response is missing token.');
      const expiresAt = new Date(
        assertString(payload.expires_at, 'GitHub installation token response is missing expires_at.'),
      );

      if (Number.isNaN(expiresAt.getTime())) {
        throw new GitHubAppAuthError('GitHub installation token response returned an invalid expires_at timestamp.');
      }

      const permissions = normalizePermissions(payload.permissions);
      const missingPermissions = describeMissingRepositoryPermissions(permissions, permissionRequirements);

      if (missingPermissions.length > 0) {
        throw new GitHubAppPermissionError(
          `GitHub App installation token is missing required permissions: ${missingPermissions.join(', ')}.`,
          missingPermissions,
        );
      }

      cachedToken = {
        token,
        expiresAt,
        permissions,
      };

      return cachedToken;
    },
  };
}

export function createGitHubAppJwt(
  appId: string,
  privateKey: string,
  now: () => Date = () => new Date(),
): string {
  const issuedAt = Math.floor(now().getTime() / 1000);
  const payload = {
    iat: issuedAt - 60,
    exp: issuedAt + DEFAULT_JWT_TTL_SECONDS,
    iss: appId,
  };
  const encodedHeader = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${encodedHeader}.${encodedPayload}`);
  signer.end();
  const signature = signer.sign(createPrivateKey(privateKey));

  return `${encodedHeader}.${encodedPayload}.${base64UrlEncode(signature)}`;
}

function normalizePermissions(value: unknown): GitHubRepositoryPermissionSet {
  if (value === null || typeof value !== 'object') {
    throw new GitHubAppAuthError('GitHub installation token response is missing repository permissions.');
  }

  const permissions: GitHubRepositoryPermissionSet = {};

  for (const [key, rawAccess] of Object.entries(value)) {
    if (rawAccess === 'read' || rawAccess === 'write') {
      permissions[key as keyof GitHubRepositoryPermissionSet] = rawAccess;
    }
  }

  return permissions;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function assertString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GitHubAppAuthError(message);
  }

  return value;
}
