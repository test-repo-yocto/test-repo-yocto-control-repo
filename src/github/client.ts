import { ORGANIZATION_SLUG } from '../contracts/provisioning.js';
import {
  GitHubAppAuthError,
  GitHubAppPermissionError,
  type GitHubAppAuth,
} from './auth.js';

const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_ACCEPT_HEADER = 'application/vnd.github+json';
const GITHUB_API_VERSION = '2022-11-28';

export interface GitHubApiClientOptions {
  auth: GitHubAppAuth;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
}

export interface GitHubApiErrorContext {
  method: string;
  path: string;
  status: number;
  documentationUrl?: string;
}

export class GitHubApiError extends Error {
  readonly context: GitHubApiErrorContext;

  constructor(message: string, context: GitHubApiErrorContext) {
    super(message);
    this.name = 'GitHubApiError';
    this.context = context;
  }
}

export interface CreateOrganizationRepositoryInput {
  name: string;
  description: string;
  private?: boolean;
}

export interface CreateRepositoryFromTemplateInput {
  templateOwner: string;
  templateRepo: string;
  owner: string;
  name: string;
  description: string;
  private?: boolean;
}

export interface GetRepositoryInput {
  owner: string;
  repo: string;
}

export interface UpsertRepositoryVariableInput {
  owner: string;
  repo: string;
  name: string;
  value: string;
}

export interface UpsertRepositoryFileInput {
  owner: string;
  repo: string;
  path: string;
  content: string;
  message: string;
  branch?: string;
}

export interface UpdateBranchProtectionInput {
  owner: string;
  repo: string;
  branch: string;
  protection: Record<string, unknown>;
}

export interface GetBranchProtectionInput {
  owner: string;
  repo: string;
  branch: string;
}

export interface GitHubApiClient {
  createOrganizationRepository<T = unknown>(input: CreateOrganizationRepositoryInput): Promise<T>;
  createRepositoryFromTemplate<T = unknown>(input: CreateRepositoryFromTemplateInput): Promise<T>;
  getRepository<T = unknown>(input: GetRepositoryInput): Promise<T>;
  upsertRepositoryVariable<T = unknown>(input: UpsertRepositoryVariableInput): Promise<T>;
  upsertRepositoryFile<T = unknown>(input: UpsertRepositoryFileInput): Promise<T>;
  updateBranchProtection<T = unknown>(input: UpdateBranchProtectionInput): Promise<T>;
  getBranchProtection<T = unknown>(input: GetBranchProtectionInput): Promise<T>;
  getRepositoryVariable<T = unknown>(owner: string, repo: string, name: string): Promise<T>;
  getRepositoryContent<T = unknown>(owner: string, repo: string, path: string, ref?: string): Promise<T>;
  listPullRequestReviews<T = unknown>(owner: string, repo: string, pullNumber: number): Promise<T>;
  getCollaboratorPermissionLevel<T = unknown>(owner: string, repo: string, username: string): Promise<T>;
  listCommitStatuses<T = unknown>(owner: string, repo: string, ref: string): Promise<T>;
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
}

interface GitHubApiErrorResponse {
  message?: unknown;
  documentation_url?: unknown;
}

export function createGitHubApiClient(options: GitHubApiClientOptions): GitHubApiClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  if (typeof fetchImplementation !== 'function') {
    throw new Error('A fetch implementation is required to create the GitHub API client.');
  }

  const apiBaseUrl = stripTrailingSlash(options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL);

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const installationToken = await options.auth.getInstallationToken();
    const url = `${apiBaseUrl}${path}`;

    let response: Response;

    try {
      response = await fetchImplementation(url, {
        method,
        headers: {
          accept: GITHUB_ACCEPT_HEADER,
          authorization: `Bearer ${installationToken.token}`,
          'content-type': 'application/json',
          'x-github-api-version': GITHUB_API_VERSION,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new GitHubApiError(`GitHub API request failed for ${method} ${path}.`, {
        method,
        path,
        status: 0,
      });
    }

    if (response.ok) {
      if (response.status === 204) {
        return undefined as T;
      }

      return (await response.json()) as T;
    }

    const errorPayload = (await safeJson(response)) as GitHubApiErrorResponse;
    const documentationUrl =
      typeof errorPayload.documentation_url === 'string' ? errorPayload.documentation_url : undefined;
    const message =
      typeof errorPayload.message === 'string'
        ? errorPayload.message
        : `GitHub API request failed with status ${response.status}.`;

    if (response.status === 401) {
      throw new GitHubAppAuthError(`GitHub API rejected the installation token for ${method} ${path}.`);
    }

    if (response.status === 403) {
      throw new GitHubAppPermissionError(
        `GitHub API permission failure for ${method} ${path}: ${message}`,
        [],
      );
    }

    throw new GitHubApiError(message, {
      method,
      path,
      status: response.status,
      documentationUrl,
    });
  }

  return {
    request,
    createOrganizationRepository(input) {
      return request('POST', `/orgs/${ORGANIZATION_SLUG}/repos`, {
        name: input.name,
        description: input.description,
        private: input.private ?? true,
      });
    },
    createRepositoryFromTemplate(input) {
      return request('POST', `/repos/${input.templateOwner}/${input.templateRepo}/generate`, {
        owner: input.owner,
        name: input.name,
        description: input.description,
        private: input.private ?? true,
      });
    },
    getRepository(input) {
      return request('GET', `/repos/${input.owner}/${input.repo}`);
    },
    upsertRepositoryVariable<T = unknown>(input: UpsertRepositoryVariableInput) {
      return request<T>('POST', `/repos/${input.owner}/${input.repo}/actions/variables`, {
        name: input.name,
        value: input.value,
      }).catch(async (error): Promise<T> => {
        if (!(error instanceof GitHubApiError) || error.context.status !== 409) {
          throw error;
        }

        return request<T>(
          'PATCH',
          `/repos/${input.owner}/${input.repo}/actions/variables/${encodeURIComponent(input.name)}`,
          {
            name: input.name,
            value: input.value,
          },
        );
      });
    },
    async upsertRepositoryFile(input) {
      const encodedPath = input.path
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      const branch = input.branch?.trim() || 'main';
      let existingSha: string | undefined;

      try {
        const existingFile = await request<{ sha?: unknown }>(
          'GET',
          `/repos/${input.owner}/${input.repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
        );

        if (typeof existingFile.sha === 'string' && existingFile.sha.trim().length > 0) {
          existingSha = existingFile.sha;
        }
      } catch (error) {
        if (!(error instanceof GitHubApiError) || error.context.status !== 404) {
          throw error;
        }
      }

      return request('PUT', `/repos/${input.owner}/${input.repo}/contents/${encodedPath}`, {
        message: input.message,
        content: Buffer.from(input.content, 'utf8').toString('base64'),
        branch,
        ...(existingSha ? { sha: existingSha } : {}),
      });
    },
    updateBranchProtection(input) {
      return request('PUT', `/repos/${input.owner}/${input.repo}/branches/${input.branch}/protection`, input.protection);
    },
    getBranchProtection(input) {
      return request('GET', `/repos/${input.owner}/${input.repo}/branches/${input.branch}/protection`);
    },
    getRepositoryVariable(owner, repo, name) {
      return request('GET', `/repos/${owner}/${repo}/actions/variables/${encodeURIComponent(name)}`);
    },
    getRepositoryContent(owner, repo, path, ref) {
      const encodedPath = path
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      return request('GET', `/repos/${owner}/${repo}/contents/${encodedPath}${query}`);
    },
    listPullRequestReviews(owner, repo, pullNumber) {
      return request('GET', `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`);
    },
    getCollaboratorPermissionLevel(owner, repo, username) {
      return request('GET', `/repos/${owner}/${repo}/collaborators/${username}/permission`);
    },
    listCommitStatuses(owner, repo, ref) {
      return request('GET', `/repos/${owner}/${repo}/commits/${ref}/statuses`);
    },
  };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
