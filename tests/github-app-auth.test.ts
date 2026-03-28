import { generateKeyPairSync } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  GitHubAppAuthError,
  GitHubAppPermissionError,
  createGitHubAppAuth,
} from '../src/github/auth.js';
import { createGitHubApiClient } from '../src/github/client.js';

describe('GitHub App auth and client boundary', () => {
  const issuedAt = new Date('2026-03-28T12:00:00.000Z');
  const keyPair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_PAT;
  });

  it('obtains an installation token and uses it for central GitHub API calls', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });

      if (url.endsWith('/app/installations/99/access_tokens')) {
        expect(init?.headers).toMatchObject({
          authorization: expect.stringMatching(/^Bearer /),
          accept: 'application/vnd.github+json',
        });

        return new Response(
          JSON.stringify({
            token: 'installation-token',
            expires_at: '2026-03-28T13:00:00Z',
            permissions: {
              actions: 'write',
              administration: 'write',
              contents: 'read',
              metadata: 'read',
              pull_requests: 'read',
              statuses: 'read',
            },
          }),
          { status: 201 },
        );
      }

      if (url.endsWith('/orgs/test-repo-yocto/repos')) {
        expect(init?.headers).toMatchObject({
          authorization: 'Bearer installation-token',
        });

        return new Response(JSON.stringify({ id: 1, name: 'proj-my-service', private: true }), {
          status: 201,
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    };

    const auth = createGitHubAppAuth({
      credentials: {
        appId: '123',
        installationId: '99',
        privateKey,
      },
      fetch: fetchMock,
      now: () => issuedAt,
    });

    const client = createGitHubApiClient({ auth, fetch: fetchMock });
    const response = await client.createOrganizationRepository({
      name: 'proj-my-service',
      description: 'sandbox repo',
    });

    expect(response).toEqual({ id: 1, name: 'proj-my-service', private: true });
    expect(requests).toHaveLength(2);
  });

  it('fails explicitly when installation-token auth fails', async () => {
    const fetchMock: typeof fetch = async (input) => {
      const url = String(input);

      if (url.endsWith('/app/installations/99/access_tokens')) {
        return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
      }

      throw new Error(`Unexpected request: ${url}`);
    };

    const auth = createGitHubAppAuth({
      credentials: {
        appId: '123',
        installationId: '99',
        privateKey,
      },
      fetch: fetchMock,
      now: () => issuedAt,
    });

    const client = createGitHubApiClient({ auth, fetch: fetchMock });

    await expect(
      client.createOrganizationRepository({
        name: 'proj-my-service',
        description: 'sandbox repo',
      }),
    ).rejects.toThrow(GitHubAppAuthError);
  });

  it('fails explicitly when the installation token is missing required permissions', async () => {
    const fetchMock: typeof fetch = async (input) => {
      const url = String(input);

      if (url.endsWith('/app/installations/99/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'installation-token',
            expires_at: '2026-03-28T13:00:00Z',
            permissions: {
              administration: 'write',
              metadata: 'read',
              pull_requests: 'read',
            },
          }),
          { status: 201 },
        );
      }

      throw new Error(`Unexpected request: ${url}`);
    };

    const auth = createGitHubAppAuth({
      credentials: {
        appId: '123',
        installationId: '99',
        privateKey,
      },
      fetch: fetchMock,
      now: () => issuedAt,
    });

    await expect(auth.getInstallationToken()).rejects.toMatchObject({
      name: 'GitHubAppPermissionError',
      missingPermissions: ['actions:write', 'contents:read', 'statuses:read'],
    });
  });

  it('does not silently fall back to PAT-style environment variables', async () => {
    process.env.GITHUB_TOKEN = 'pat-token';
    process.env.GITHUB_PAT = 'another-pat-token';
    const requests: string[] = [];

    const fetchMock: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);

      if (url.endsWith('/app/installations/99/access_tokens')) {
        return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
      }

      throw new Error(`Unexpected request: ${url}`);
    };

    const auth = createGitHubAppAuth({
      credentials: {
        appId: '123',
        installationId: '99',
        privateKey,
      },
      fetch: fetchMock,
      now: () => issuedAt,
    });

    const client = createGitHubApiClient({ auth, fetch: fetchMock });

    await expect(
      client.createOrganizationRepository({
        name: 'proj-my-service',
        description: 'sandbox repo',
      }),
    ).rejects.toThrow('GitHub App authentication failed while requesting an installation token.');

    expect(requests).toEqual(['https://api.github.com/app/installations/99/access_tokens']);
  });

  it('surfaces explicit permission errors when GitHub rejects an authenticated API call', async () => {
    const fetchMock: typeof fetch = async (input) => {
      const url = String(input);

      if (url.endsWith('/app/installations/99/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'installation-token',
            expires_at: '2026-03-28T13:00:00Z',
            permissions: {
              actions: 'write',
              administration: 'write',
              contents: 'read',
              metadata: 'read',
              pull_requests: 'read',
              statuses: 'read',
            },
          }),
          { status: 201 },
        );
      }

      if (url.endsWith('/repos/test-repo-yocto/proj-my-service/branches/main/protection')) {
        return new Response(
          JSON.stringify({ message: 'Resource not accessible by integration' }),
          { status: 403 },
        );
      }

      throw new Error(`Unexpected request: ${url}`);
    };

    const auth = createGitHubAppAuth({
      credentials: {
        appId: '123',
        installationId: '99',
        privateKey,
      },
      fetch: fetchMock,
      now: () => issuedAt,
    });

    const client = createGitHubApiClient({ auth, fetch: fetchMock });

    await expect(
      client.updateBranchProtection({
        owner: 'test-repo-yocto',
        repo: 'proj-my-service',
        branch: 'main',
        protection: { required_status_checks: null },
      }),
    ).rejects.toThrow(GitHubAppPermissionError);
  });
});
