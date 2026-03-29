// src/provisioning/run-workflow.ts
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// src/github/auth.ts
import { createPrivateKey, createSign } from "node:crypto";

// src/github/permissions.ts
var GITHUB_APP_PERMISSION_REQUIREMENTS = [
  {
    operation: "organization_repository_create",
    repository: {
      administration: "write",
      metadata: "read"
    },
    purpose: "Create private repositories in the target organization."
  },
  {
    operation: "repository_variable_write",
    repository: {
      actions: "write",
      metadata: "read"
    },
    purpose: "Persist repository-scoped Actions variables and inspect repository metadata."
  },
  {
    operation: "branch_protection_write",
    repository: {
      administration: "write",
      contents: "read",
      metadata: "read"
    },
    purpose: "Apply classic branch protection after verifying target branches exist."
  },
  {
    operation: "pull_request_reviews_read",
    repository: {
      metadata: "read",
      pull_requests: "read"
    },
    purpose: "Read pull request review history for requester-review enforcement."
  },
  {
    operation: "commit_statuses_read",
    repository: {
      metadata: "read",
      statuses: "read"
    },
    purpose: "Inspect commit status checks during later merge-readiness verification."
  }
];
var ACCESS_LEVEL = {
  read: 1,
  write: 2
};
function permissionSatisfies(actual, required) {
  if (actual === void 0) {
    return false;
  }
  return ACCESS_LEVEL[actual] >= ACCESS_LEVEL[required];
}
function describeMissingRepositoryPermissions(actualPermissions, requirements = GITHUB_APP_PERMISSION_REQUIREMENTS) {
  const missing = /* @__PURE__ */ new Set();
  for (const requirement of requirements) {
    for (const [permissionName, requiredAccess] of Object.entries(requirement.repository)) {
      const actualAccess = actualPermissions[permissionName];
      if (!permissionSatisfies(actualAccess, requiredAccess)) {
        missing.add(`${permissionName}:${requiredAccess}`);
      }
    }
  }
  return [...missing].sort();
}

// src/github/auth.ts
var DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
var DEFAULT_JWT_TTL_SECONDS = 9 * 60;
var GITHUB_ACCEPT_HEADER = "application/vnd.github+json";
var GITHUB_API_VERSION = "2022-11-28";
var GitHubAppAuthError = class extends Error {
  cause;
  constructor(message, options) {
    super(message);
    this.name = "GitHubAppAuthError";
    this.cause = options?.cause;
  }
};
var GitHubAppPermissionError = class extends Error {
  missingPermissions;
  constructor(message, missingPermissions) {
    super(message);
    this.name = "GitHubAppPermissionError";
    this.missingPermissions = missingPermissions;
  }
};
function createGitHubAppAuth(options) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new Error("A fetch implementation is required to create GitHub App auth.");
  }
  const permissionRequirements = options.permissionRequirements ?? GITHUB_APP_PERMISSION_REQUIREMENTS;
  const apiBaseUrl = stripTrailingSlash(options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL);
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  let cachedToken;
  return {
    async getInstallationToken() {
      if (cachedToken && cachedToken.expiresAt.getTime() - now().getTime() > 6e4) {
        return cachedToken;
      }
      const appJwt = createGitHubAppJwt(options.credentials.appId, options.credentials.privateKey, now);
      const url = `${apiBaseUrl}/app/installations/${options.credentials.installationId}/access_tokens`;
      let response;
      try {
        response = await fetchImplementation(url, {
          method: "POST",
          headers: {
            accept: GITHUB_ACCEPT_HEADER,
            authorization: `Bearer ${appJwt}`,
            "content-type": "application/json",
            "x-github-api-version": GITHUB_API_VERSION
          },
          body: JSON.stringify({})
        });
      } catch (error) {
        throw new GitHubAppAuthError("GitHub App installation token request failed.", { cause: error });
      }
      if (response.status === 401) {
        throw new GitHubAppAuthError("GitHub App authentication failed while requesting an installation token.");
      }
      if (!response.ok) {
        throw new GitHubAppAuthError(
          `GitHub App installation token request failed with status ${response.status}.`
        );
      }
      const payload = await response.json();
      const token = assertString(payload.token, "GitHub installation token response is missing token.");
      const expiresAt = new Date(
        assertString(payload.expires_at, "GitHub installation token response is missing expires_at.")
      );
      if (Number.isNaN(expiresAt.getTime())) {
        throw new GitHubAppAuthError("GitHub installation token response returned an invalid expires_at timestamp.");
      }
      const permissions = normalizePermissions(payload.permissions);
      const missingPermissions = describeMissingRepositoryPermissions(permissions, permissionRequirements);
      if (missingPermissions.length > 0) {
        throw new GitHubAppPermissionError(
          `GitHub App installation token is missing required permissions: ${missingPermissions.join(", ")}.`,
          missingPermissions
        );
      }
      cachedToken = {
        token,
        expiresAt,
        permissions
      };
      return cachedToken;
    }
  };
}
function createGitHubAppJwt(appId, privateKey, now = () => /* @__PURE__ */ new Date()) {
  const issuedAt = Math.floor(now().getTime() / 1e3);
  const payload = {
    iat: issuedAt - 60,
    exp: issuedAt + DEFAULT_JWT_TTL_SECONDS,
    iss: appId
  };
  const encodedHeader = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signer = createSign("RSA-SHA256");
  signer.update(`${encodedHeader}.${encodedPayload}`);
  signer.end();
  const signature = signer.sign(createPrivateKey(privateKey));
  return `${encodedHeader}.${encodedPayload}.${base64UrlEncode(signature)}`;
}
function normalizePermissions(value) {
  if (value === null || typeof value !== "object") {
    throw new GitHubAppAuthError("GitHub installation token response is missing repository permissions.");
  }
  const permissions = {};
  for (const [key, rawAccess] of Object.entries(value)) {
    if (rawAccess === "read" || rawAccess === "write") {
      permissions[key] = rawAccess;
    }
  }
  return permissions;
}
function stripTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function assertString(value, message) {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitHubAppAuthError(message);
  }
  return value;
}

// src/contracts/provisioning.ts
var ORGANIZATION_SLUG = "test-repo-yocto";
var REPOSITORY_PREFIX = "proj-";
var MAX_FINAL_REPOSITORY_NAME_LENGTH = 50;
var EXECUTION_MODES = ["dry-run", "sandbox"];
var slugPattern = /^[a-z0-9-]+$/;
function buildTargetRepositoryName(repoSlug) {
  return `${REPOSITORY_PREFIX}${repoSlug}`;
}
function maxRepoSlugLength() {
  return MAX_FINAL_REPOSITORY_NAME_LENGTH - REPOSITORY_PREFIX.length;
}
function normalizeProvisioningRequest(input) {
  const repoSlug = input.repo_slug.trim();
  const description = input.description.trim();
  const requestedExecutionMode = input.execution_mode ?? "dry-run";
  if (repoSlug.length === 0) {
    throw new Error("repo_slug is required.");
  }
  if (description.length === 0) {
    throw new Error("description is required.");
  }
  if (!isExecutionMode(requestedExecutionMode)) {
    throw new Error(`execution_mode must be one of: ${EXECUTION_MODES.join(", ")}.`);
  }
  if (repoSlug !== repoSlug.toLowerCase()) {
    throw new Error("repo_slug must be lowercase; uppercase characters are rejected.");
  }
  if (repoSlug.includes("_")) {
    throw new Error("repo_slug must not contain underscores.");
  }
  if (!slugPattern.test(repoSlug)) {
    throw new Error("repo_slug may only contain lowercase letters, digits, and dashes.");
  }
  if (repoSlug.includes("--")) {
    throw new Error("repo_slug must not contain double dashes.");
  }
  if (repoSlug.startsWith("-") || repoSlug.endsWith("-")) {
    throw new Error("repo_slug must not start or end with a dash.");
  }
  if (repoSlug.length > maxRepoSlugLength()) {
    throw new Error(
      `repo_slug is too long; ${REPOSITORY_PREFIX}<slug> must be <= ${MAX_FINAL_REPOSITORY_NAME_LENGTH} characters.`
    );
  }
  return {
    repoSlug,
    description,
    executionMode: requestedExecutionMode,
    targetRepositoryName: buildTargetRepositoryName(repoSlug)
  };
}
function isExecutionMode(value) {
  return EXECUTION_MODES.includes(value);
}

// src/github/client.ts
var DEFAULT_GITHUB_API_BASE_URL2 = "https://api.github.com";
var GITHUB_ACCEPT_HEADER2 = "application/vnd.github+json";
var GITHUB_API_VERSION2 = "2022-11-28";
var GitHubApiError = class extends Error {
  context;
  constructor(message, context) {
    super(message);
    this.name = "GitHubApiError";
    this.context = context;
  }
};
function createGitHubApiClient(options) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new Error("A fetch implementation is required to create the GitHub API client.");
  }
  const apiBaseUrl = stripTrailingSlash2(options.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL2);
  async function request(method, path, body) {
    const installationToken = await options.auth.getInstallationToken();
    const url = `${apiBaseUrl}${path}`;
    let response;
    try {
      response = await fetchImplementation(url, {
        method,
        headers: {
          accept: GITHUB_ACCEPT_HEADER2,
          authorization: `Bearer ${installationToken.token}`,
          "content-type": "application/json",
          "x-github-api-version": GITHUB_API_VERSION2
        },
        body: body === void 0 ? void 0 : JSON.stringify(body)
      });
    } catch (error) {
      throw new GitHubApiError(`GitHub API request failed for ${method} ${path}.`, {
        method,
        path,
        status: 0
      });
    }
    if (response.ok) {
      if (response.status === 204) {
        return void 0;
      }
      return await response.json();
    }
    const errorPayload = await safeJson(response);
    const documentationUrl = typeof errorPayload.documentation_url === "string" ? errorPayload.documentation_url : void 0;
    const message = typeof errorPayload.message === "string" ? errorPayload.message : `GitHub API request failed with status ${response.status}.`;
    if (response.status === 401) {
      throw new GitHubAppAuthError(`GitHub API rejected the installation token for ${method} ${path}.`);
    }
    if (response.status === 403) {
      throw new GitHubAppPermissionError(
        `GitHub API permission failure for ${method} ${path}: ${message}`,
        []
      );
    }
    throw new GitHubApiError(message, {
      method,
      path,
      status: response.status,
      documentationUrl
    });
  }
  return {
    request,
    createOrganizationRepository(input) {
      return request("POST", `/orgs/${ORGANIZATION_SLUG}/repos`, {
        name: input.name,
        description: input.description,
        private: input.private ?? true
      });
    },
    createRepositoryFromTemplate(input) {
      return request("POST", `/repos/${input.templateOwner}/${input.templateRepo}/generate`, {
        owner: input.owner,
        name: input.name,
        description: input.description,
        private: input.private ?? true
      });
    },
    getRepository(input) {
      return request("GET", `/repos/${input.owner}/${input.repo}`);
    },
    upsertRepositoryVariable(input) {
      return request("POST", `/repos/${input.owner}/${input.repo}/actions/variables`, {
        name: input.name,
        value: input.value
      }).catch(async (error) => {
        if (!(error instanceof GitHubApiError) || error.context.status !== 409) {
          throw error;
        }
        return request(
          "PATCH",
          `/repos/${input.owner}/${input.repo}/actions/variables/${encodeURIComponent(input.name)}`,
          {
            name: input.name,
            value: input.value
          }
        );
      });
    },
    async upsertRepositoryFile(input) {
      const encodedPath = input.path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
      const branch = input.branch?.trim() || "main";
      let existingSha;
      try {
        const existingFile = await request(
          "GET",
          `/repos/${input.owner}/${input.repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`
        );
        if (typeof existingFile.sha === "string" && existingFile.sha.trim().length > 0) {
          existingSha = existingFile.sha;
        }
      } catch (error) {
        if (!(error instanceof GitHubApiError) || error.context.status !== 404) {
          throw error;
        }
      }
      return request("PUT", `/repos/${input.owner}/${input.repo}/contents/${encodedPath}`, {
        message: input.message,
        content: Buffer.from(input.content, "utf8").toString("base64"),
        branch,
        ...existingSha ? { sha: existingSha } : {}
      });
    },
    updateBranchProtection(input) {
      return request("PUT", `/repos/${input.owner}/${input.repo}/branches/${input.branch}/protection`, input.protection);
    },
    getBranchProtection(input) {
      return request("GET", `/repos/${input.owner}/${input.repo}/branches/${input.branch}/protection`);
    },
    getRepositoryVariable(owner, repo, name) {
      return request("GET", `/repos/${owner}/${repo}/actions/variables/${encodeURIComponent(name)}`);
    },
    getRepositoryContent(owner, repo, path, ref) {
      const encodedPath = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      return request("GET", `/repos/${owner}/${repo}/contents/${encodedPath}${query}`);
    },
    listPullRequestReviews(owner, repo, pullNumber) {
      return request("GET", `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`);
    },
    getCollaboratorPermissionLevel(owner, repo, username) {
      return request("GET", `/repos/${owner}/${repo}/collaborators/${username}/permission`);
    },
    listCommitStatuses(owner, repo, ref) {
      return request("GET", `/repos/${owner}/${repo}/commits/${ref}/statuses`);
    }
  };
}
async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return void 0;
  }
}
function stripTrailingSlash2(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

// src/contracts/template-metadata.ts
var PROVISIONING_TEMPLATE_REPOSITORY_CONFIG_KEY = "PROVISIONING_TEMPLATE_REPOSITORY";
var DEFAULT_TEMPLATE_SOURCE_REF = "main";
var REQUESTER_METADATA_FILE_PATH = ".github/provisioning/requester-metadata.json";
var REQUIRED_TEMPLATE_ARTIFACT_PATHS = {
  readme: "README.md",
  license: "LICENSE",
  defaultCiWorkflow: ".github/workflows/ci.yml"
};
var REQUESTER_METADATA_KIND = "test-repo-yocto/requester-metadata";
var REQUESTER_METADATA_SCHEMA_VERSION = 1;
var REQUIRED_TEMPLATE_ARTIFACTS = [
  {
    key: "readme",
    label: "README",
    path: REQUIRED_TEMPLATE_ARTIFACT_PATHS.readme
  },
  {
    key: "license",
    label: "LICENSE",
    path: REQUIRED_TEMPLATE_ARTIFACT_PATHS.license
  },
  {
    key: "default_ci_workflow",
    label: "default CI workflow",
    path: REQUIRED_TEMPLATE_ARTIFACT_PATHS.defaultCiWorkflow
  }
];
var templateRepositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
var requesterLoginPattern = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
var workflowIdentityPattern = /^[A-Za-z0-9._/@:-]+$/;
var ProvisioningMetadataContractError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ProvisioningMetadataContractError";
  }
};
function normalizeApprovedTemplateSource(repository, ref = DEFAULT_TEMPLATE_SOURCE_REF) {
  const trimmedRepository = repository.trim();
  const trimmedRef = ref.trim();
  if (trimmedRepository.length === 0) {
    throw new ProvisioningMetadataContractError(
      `${PROVISIONING_TEMPLATE_REPOSITORY_CONFIG_KEY} is required and must point to exactly one template repository.`
    );
  }
  if (!templateRepositoryPattern.test(trimmedRepository)) {
    throw new ProvisioningMetadataContractError(
      `${PROVISIONING_TEMPLATE_REPOSITORY_CONFIG_KEY} must use the form <owner>/<repo>.`
    );
  }
  if (trimmedRef.length === 0) {
    throw new ProvisioningMetadataContractError("Template source ref must not be empty.");
  }
  const [owner, repo] = trimmedRepository.split("/");
  return {
    configKey: PROVISIONING_TEMPLATE_REPOSITORY_CONFIG_KEY,
    owner,
    repository: repo,
    fullName: trimmedRepository,
    ref: trimmedRef
  };
}
function createRequesterMetadataArtifacts(input) {
  const requesterLogin = normalizeRequesterLoginInput(input.requesterLogin);
  const provisionedAt = normalizeProvisionedAt(input.provisionedAt);
  const provisionedByWorkflow = normalizeProvisionedByWorkflow(input.provisionedByWorkflow);
  const metadataFile = {
    kind: REQUESTER_METADATA_KIND,
    schema_version: REQUESTER_METADATA_SCHEMA_VERSION,
    requester_login: requesterLogin,
    provisioned_at: provisionedAt,
    provisioned_by_workflow: provisionedByWorkflow
  };
  return {
    metadataFilePath: REQUESTER_METADATA_FILE_PATH,
    metadataFile,
    metadataFileContents: serializeRequesterMetadataFile(metadataFile),
    parsed: {
      requesterLogin,
      provisionedAt,
      provisionedByWorkflow,
      metadataFilePath: REQUESTER_METADATA_FILE_PATH,
      metadataFile
    }
  };
}
function serializeRequesterMetadataFile(metadata) {
  return `${JSON.stringify(metadata, null, 2)}
`;
}
function normalizeRequesterLoginInput(value) {
  const normalized = value.trim().toLowerCase();
  return validateRequesterLogin(normalized);
}
function validateRequesterLogin(normalized) {
  if (normalized.length === 0) {
    throw new ProvisioningMetadataContractError("requester_login must not be empty.");
  }
  if (!requesterLoginPattern.test(normalized) || normalized.includes("--")) {
    throw new ProvisioningMetadataContractError(
      "requester_login must be a canonical lowercase GitHub login using only letters, digits, and single dashes."
    );
  }
  return normalized;
}
function normalizeProvisionedAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ProvisioningMetadataContractError(
      "provisioned_at must be a valid ISO-8601 timestamp."
    );
  }
  const canonical = date.toISOString();
  const rawValue = value instanceof Date ? canonical : value.trim();
  if (rawValue !== canonical) {
    throw new ProvisioningMetadataContractError(
      "provisioned_at must use canonical UTC ISO-8601 format (Date#toISOString)."
    );
  }
  return canonical;
}
function normalizeProvisionedByWorkflow(value) {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ProvisioningMetadataContractError("provisioned_by_workflow must not be empty.");
  }
  if (!workflowIdentityPattern.test(normalized)) {
    throw new ProvisioningMetadataContractError(
      "provisioned_by_workflow must use a stable workflow identifier/path string with no spaces."
    );
  }
  return normalized;
}

// src/policy/requester-review-policy.ts
var REQUESTER_REVIEW_POLICY_WORKFLOW_PATH = ".github/workflows/requester-review-policy.yml";
var ALLOWED_REVIEW_STATES = /* @__PURE__ */ new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING"
]);
var RequesterReviewPolicyError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "RequesterReviewPolicyError";
  }
};
function evaluateRequesterReviewPolicy(input) {
  const requesterLogin = normalizeLogin(input.requesterLogin, "requester login");
  const prAuthorLogin = normalizeLogin(input.prAuthorLogin, "PR author login");
  const headCommitSha = normalizeCommitSha(input.headCommitSha);
  const reviews = input.reviews.map((review) => normalizePolicyReview(review));
  const qualifyingApprovals = [];
  const ignoredApprovals = [];
  const effectiveApprovals = [];
  for (const review of reviews) {
    if (review.state !== "APPROVED") {
      continue;
    }
    if (review.commitId !== headCommitSha) {
      ignoredApprovals.push({
        reviewerLogin: review.reviewerLogin,
        reviewId: review.reviewId,
        reason: `Approval is stale for ${review.reviewerLogin}; it targets ${review.commitId} instead of current head ${headCommitSha}.`
      });
      continue;
    }
    if (!review.countsTowardNativeReviewRequirement) {
      ignoredApprovals.push({
        reviewerLogin: review.reviewerLogin,
        reviewId: review.reviewId,
        reason: `Approval from ${review.reviewerLogin} does not count toward native required reviews for this repository.`
      });
      continue;
    }
    qualifyingApprovals.push({
      reviewerLogin: review.reviewerLogin,
      permissionLevel: review.permissionLevel,
      countsTowardNativeReviewRequirement: review.countsTowardNativeReviewRequirement,
      commitId: review.commitId,
      reviewId: review.reviewId
    });
    if (requesterLogin === prAuthorLogin && review.reviewerLogin === prAuthorLogin) {
      ignoredApprovals.push({
        reviewerLogin: review.reviewerLogin,
        reviewId: review.reviewId,
        reason: `Self-approval from ${review.reviewerLogin} is ignored because the requester authored the PR.`
      });
      continue;
    }
    effectiveApprovals.push({
      reviewerLogin: review.reviewerLogin,
      permissionLevel: review.permissionLevel,
      countsTowardNativeReviewRequirement: review.countsTowardNativeReviewRequirement,
      commitId: review.commitId,
      reviewId: review.reviewId
    });
  }
  if (requesterLogin !== prAuthorLogin) {
    const requesterApproval = effectiveApprovals.find((review) => review.reviewerLogin === requesterLogin);
    if (!requesterApproval) {
      return {
        ok: false,
        failureCode: "missing_qualifying_approval",
        summary: `Requester ${requesterLogin} must provide a current authorized approval because the PR author is ${prAuthorLogin}.`,
        requesterLogin,
        prAuthorLogin,
        headCommitSha,
        requiredApproval: {
          type: "requester",
          reviewerLogin: requesterLogin
        },
        qualifyingApprovals: effectiveApprovals,
        ignoredApprovals
      };
    }
    return {
      ok: true,
      summary: `Requester ${requesterLogin} has provided the required current authorized approval for a PR authored by ${prAuthorLogin}.`,
      requesterLogin,
      prAuthorLogin,
      headCommitSha,
      requiredApproval: {
        type: "requester",
        reviewerLogin: requesterLogin
      },
      qualifyingApprovals: effectiveApprovals,
      ignoredApprovals
    };
  }
  const alternateApproval = effectiveApprovals.find((review) => review.reviewerLogin !== prAuthorLogin);
  if (!alternateApproval) {
    return {
      ok: false,
      failureCode: "missing_qualifying_approval",
      summary: `Requester ${requesterLogin} authored this PR, so another authorized reviewer must approve; self-approval does not satisfy policy.`,
      requesterLogin,
      prAuthorLogin,
      headCommitSha,
      requiredApproval: {
        type: "alternate-authorized-reviewer",
        requesterSelfApprovalIgnored: true
      },
      qualifyingApprovals: effectiveApprovals,
      ignoredApprovals
    };
  }
  return {
    ok: true,
    summary: `Requester ${requesterLogin} authored this PR and alternate authorized reviewer ${alternateApproval.reviewerLogin} approved the current head commit.`,
    requesterLogin,
    prAuthorLogin,
    headCommitSha,
    requiredApproval: {
      type: "alternate-authorized-reviewer",
      requesterSelfApprovalIgnored: true
    },
    qualifyingApprovals: effectiveApprovals,
    ignoredApprovals
  };
}
async function getRequesterReviewEnforcementReadinessForRepository(input) {
  const workflowPath = input.workflowPath ?? REQUESTER_REVIEW_POLICY_WORKFLOW_PATH;
  const metadataFilePath = input.metadataFilePath ?? REQUESTER_METADATA_FILE_PATH;
  const ref = input.ref?.trim() || "main";
  const owner = input.owner.trim();
  const repo = input.repo.trim();
  const evaluatorAvailable = typeof evaluateRequesterReviewPolicy === "function";
  const [workflowFilePresentInTargetRepository, metadataFilePresentInTargetRepository] = await Promise.all([
    repositoryFileExists(input.client, owner, repo, workflowPath, ref),
    repositoryFileExists(input.client, owner, repo, metadataFilePath, ref)
  ]);
  const ready = workflowFilePresentInTargetRepository && metadataFilePresentInTargetRepository && evaluatorAvailable;
  const missingArtifacts = [
    ...!workflowFilePresentInTargetRepository ? [`workflow ${workflowPath} missing in target repository`] : [],
    ...!metadataFilePresentInTargetRepository ? [`metadata file ${metadataFilePath} missing in target repository`] : [],
    ...!evaluatorAvailable ? ["requester-review evaluator unavailable in control repository runtime"] : []
  ];
  return {
    ready,
    summary: ready ? "Requester-review enforcement readiness verified from provisioned target repository artifacts." : `Requester-review enforcement readiness is incomplete in the provisioned target repository: ${missingArtifacts.join("; ")}.`,
    details: {
      owner,
      repository: repo,
      ref,
      workflowPath,
      workflowFilePresentInTargetRepository,
      metadataFilePath,
      metadataFilePresentInTargetRepository,
      evaluatorAvailable
    }
  };
}
async function repositoryFileExists(client, owner, repo, path, ref) {
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
function normalizePolicyReview(review) {
  return {
    reviewId: review.reviewId,
    reviewerLogin: normalizeLogin(review.reviewerLogin, `review ${review.reviewId} reviewer login`),
    state: normalizeReviewState(review.state, review.reviewId),
    submittedAt: normalizeTimestamp(review.submittedAt, review.reviewId),
    commitId: normalizeCommitId(review.commitId, review.reviewId),
    permissionLevel: normalizePermissionLevel(review.permissionLevel, review.reviewId),
    countsTowardNativeReviewRequirement: review.countsTowardNativeReviewRequirement === true
  };
}
function normalizeReviewState(state, reviewId) {
  if (!ALLOWED_REVIEW_STATES.has(state)) {
    throw new RequesterReviewPolicyError(
      `Review ${reviewId} uses unsupported state ${state}; requester-review policy fails closed on ambiguous review data.`
    );
  }
  return state;
}
function normalizeTimestamp(value, reviewId) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new RequesterReviewPolicyError(`Review ${reviewId} is missing a valid submittedAt timestamp.`);
  }
  return timestamp.toISOString();
}
function normalizeCommitId(value, reviewId) {
  const commitId = value.trim();
  if (commitId.length === 0) {
    throw new RequesterReviewPolicyError(`Review ${reviewId} is missing commitId needed for stale-review rejection.`);
  }
  return commitId;
}
function normalizeCommitSha(value) {
  const commitSha = value.trim();
  if (commitSha.length === 0) {
    throw new RequesterReviewPolicyError("Current PR head sha is required for requester-review evaluation.");
  }
  return commitSha;
}
function normalizeLogin(value, fieldName) {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new RequesterReviewPolicyError(`${fieldName} is required for requester-review evaluation.`);
  }
  if (trimmed !== trimmed.toLowerCase()) {
    throw new RequesterReviewPolicyError(`${fieldName} must already be canonical lowercase.`);
  }
  return trimmed;
}
function normalizePermissionLevel(permissionLevel, reviewId) {
  if (!["admin", "maintain", "write", "triage", "read", "none"].includes(permissionLevel)) {
    throw new RequesterReviewPolicyError(
      `Review ${reviewId} is missing a supported reviewer permission level.`
    );
  }
  return permissionLevel;
}

// src/provisioning/github-actions-config.ts
var REQUIRED_GITHUB_ACTIONS_SECRETS = [
  "PROVISIONING_GITHUB_APP_ID",
  "PROVISIONING_GITHUB_APP_INSTALLATION_ID",
  "PROVISIONING_GITHUB_APP_PRIVATE_KEY"
];
var LEGACY_GITHUB_APP_ENV_FALLBACKS = {
  PROVISIONING_GITHUB_APP_ID: "GITHUB_APP_ID",
  PROVISIONING_GITHUB_APP_INSTALLATION_ID: "GITHUB_APP_INSTALLATION_ID",
  PROVISIONING_GITHUB_APP_PRIVATE_KEY: "GITHUB_APP_PRIVATE_KEY"
};
function getConfiguredGitHubActionsSecretNames(env) {
  return REQUIRED_GITHUB_ACTIONS_SECRETS.filter((name) => !readConfiguredValue(name, env));
}
function loadGitHubAppRuntimeCredentials(env) {
  return {
    appId: requiredConfiguredValue("PROVISIONING_GITHUB_APP_ID", env),
    installationId: requiredConfiguredValue("PROVISIONING_GITHUB_APP_INSTALLATION_ID", env),
    privateKey: requiredConfiguredValue("PROVISIONING_GITHUB_APP_PRIVATE_KEY", env)
  };
}
function formatGitHubAppSecretContract() {
  return `${REQUIRED_GITHUB_ACTIONS_SECRETS.join(", ")} (GitHub Actions repo/org secret names cannot start with GITHUB_, so these PROVISIONING_* names are the supported Actions contract).`;
}
function formatLegacyGitHubAppFallbackNote() {
  return "Legacy local/manual fallback env names remain supported only outside the primary Actions contract: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY.";
}
function requiredConfiguredValue(primaryName, env) {
  const value = readConfiguredValue(primaryName, env);
  if (!value) {
    throw new Error(`${primaryName} is required.`);
  }
  return value;
}
function readConfiguredValue(primaryName, env) {
  const primaryValue = env[primaryName]?.trim();
  if (primaryValue) {
    return primaryValue;
  }
  const legacyName = LEGACY_GITHUB_APP_ENV_FALLBACKS[primaryName];
  const legacyValue = env[legacyName]?.trim();
  return legacyValue || void 0;
}

// src/github/branch-protection.ts
var CLASSIC_BRANCH_PROTECTION_BRANCH = "main";
var REQUESTER_REVIEW_POLICY_CHECK = "requester-review-policy";
function createClassicMainBranchProtection() {
  return {
    required_status_checks: {
      strict: true,
      contexts: [REQUESTER_REVIEW_POLICY_CHECK]
    },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      require_last_push_approval: false,
      required_approving_review_count: 1
    },
    restrictions: createNoBypassRestrictions(),
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: true,
    required_conversation_resolution: true,
    lock_branch: false,
    allow_fork_syncing: false
  };
}
function verifyClassicMainBranchProtection(protection) {
  const issues = [];
  const root = asRecord(protection);
  const requiredStatusChecks = asRecord(root.required_status_checks);
  const requiredPullRequestReviews = asRecord(root.required_pull_request_reviews);
  const restrictions = normalizeRestrictions(root.restrictions);
  const requiredContexts = normalizeRequiredStatusCheckContexts(requiredStatusChecks);
  const approvals = requiredPullRequestReviews.required_approving_review_count;
  if (!readEnabledFlag(requiredStatusChecks, "strict")) {
    issues.push("Strict required status checks must be enabled so PRs stay up to date with main.");
  }
  if (!requiredContexts.includes(REQUESTER_REVIEW_POLICY_CHECK)) {
    issues.push(`Required status checks must include ${REQUESTER_REVIEW_POLICY_CHECK}.`);
  }
  if (typeof approvals !== "number" || approvals < 1) {
    issues.push("At least one approving review must be required before merging to main.");
  }
  if (!readEnabledFlag(root, "enforce_admins")) {
    issues.push("Admin enforcement must be enabled so administrators cannot bypass main protection.");
  }
  if (!readEnabledFlag(root, "required_linear_history")) {
    issues.push("Linear history should be required to keep merge behavior constrained to reviewed PR flow.");
  }
  if (!readEnabledFlag(root, "required_conversation_resolution")) {
    issues.push("Conversation resolution must be required before merge.");
  }
  if (readEnabledFlag(root, "allow_force_pushes")) {
    issues.push("Force pushes must remain disabled on main.");
  }
  if (readEnabledFlag(root, "allow_deletions")) {
    issues.push("Branch deletions must remain disabled on main.");
  }
  if (!readEnabledFlag(root, "block_creations")) {
    issues.push("Branch creation from matching refs must remain blocked on main.");
  }
  if (!restrictions) {
    issues.push("Push restrictions must be explicitly configured to block direct pushes to main.");
  } else if (restrictions.users.length > 0 || restrictions.teams.length > 0 || restrictions.apps.length > 0) {
    issues.push("Push restrictions must use empty allowlists so no actor can push directly to main.");
  }
  return {
    ok: issues.length === 0,
    issues
  };
}
async function applyClassicMainBranchProtection(dependencies, input) {
  const branch = input.branch ?? CLASSIC_BRANCH_PROTECTION_BRANCH;
  await dependencies.updateBranchProtection({
    owner: input.owner,
    repo: input.repo,
    branch,
    protection: createClassicMainBranchProtection()
  });
  const appliedProtection = await dependencies.getBranchProtection({
    owner: input.owner,
    repo: input.repo,
    branch
  });
  return verifyClassicMainBranchProtection(appliedProtection);
}
function createNoBypassRestrictions() {
  return {
    users: [],
    teams: [],
    apps: []
  };
}
function normalizeRequiredStatusCheckContexts(requiredStatusChecks) {
  const legacyContexts = Array.isArray(requiredStatusChecks.contexts) ? requiredStatusChecks.contexts.filter((value) => typeof value === "string") : [];
  const checks = Array.isArray(requiredStatusChecks.checks) ? requiredStatusChecks.checks.flatMap((value) => {
    const record = asRecord(value);
    return typeof record.context === "string" ? [record.context] : [];
  }) : [];
  return [.../* @__PURE__ */ new Set([...legacyContexts, ...checks])];
}
function normalizeRestrictions(value) {
  const restrictions = asRecord(value);
  if (!("users" in restrictions) && !("teams" in restrictions) && !("apps" in restrictions)) {
    return void 0;
  }
  return {
    users: normalizeStringArray(restrictions.users),
    teams: normalizeStringArray(restrictions.teams),
    apps: normalizeStringArray(restrictions.apps)
  };
}
function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      return [entry];
    }
    const record = asRecord(entry);
    return typeof record.slug === "string" ? [record.slug] : typeof record.login === "string" ? [record.login] : typeof record.name === "string" ? [record.name] : [];
  });
}
function readEnabledFlag(source, key) {
  const value = source[key];
  if (typeof value === "boolean") {
    return value;
  }
  const record = asRecord(value);
  return record.enabled === true;
}
function asRecord(value) {
  return value !== null && typeof value === "object" ? value : {};
}

// src/provisioning/orchestration.ts
async function runProvisioningWorkflow(input, dependencies) {
  const stages = [];
  const requestedExecutionMode = input.execution_mode ?? "dry-run";
  let createdRepositoryState;
  let normalizedRequest;
  try {
    normalizedRequest = normalizeProvisioningRequest(input);
    stages.push({
      stage: "contract_validation",
      status: "success",
      summary: "Provisioning request passed canonical contract validation.",
      details: {
        repoSlug: normalizedRequest.repoSlug,
        targetRepositoryName: normalizedRequest.targetRepositoryName
      }
    });
  } catch (error) {
    stages.push({
      stage: "contract_validation",
      status: "failure",
      summary: error instanceof Error ? error.message : "Provisioning request validation failed.",
      details: {
        requestedExecutionMode,
        remediation: remediationForValidation(error instanceof Error ? error.message : void 0)
      }
    });
    return buildResult({
      executionMode: isExecutionMode2(requestedExecutionMode) ? requestedExecutionMode : "unknown",
      outcome: "failed",
      failureClass: "validation_failed",
      remediation: remediationForValidation(error instanceof Error ? error.message : void 0),
      stages
    });
  }
  const executionMode = normalizedRequest.executionMode;
  const targetOwner = resolveTargetOwner(executionMode, dependencies.config.sandboxOwner);
  stages.push({
    stage: "mode_resolution",
    status: "success",
    summary: executionMode === "dry-run" ? "Dry-run mode selected; provisioning will emit planned actions only." : "Sandbox mode selected; provisioning will create the repository in the sandbox target.",
    details: {
      executionMode,
      targetOwner,
      createEnabled: executionMode === "sandbox"
    }
  });
  let templateSource;
  try {
    templateSource = normalizeApprovedTemplateSource(
      dependencies.config.templateRepository,
      dependencies.config.templateRef
    );
    stages.push({
      stage: "template_source_resolution",
      status: "success",
      summary: "Template source resolved from the single approved contract value.",
      details: {
        template: templateSource.fullName,
        ref: templateSource.ref
      }
    });
  } catch (error) {
    stages.push({
      stage: "template_source_resolution",
      status: "failure",
      summary: error instanceof Error ? error.message : "Template source resolution failed.",
      details: {
        remediation: remediationForTemplateResolution()
      }
    });
    stages.push(skipStage("duplicate_target_preflight", "Skipped because template source resolution failed."));
    stages.push(skipStage("create_or_plan", "Skipped because template source resolution failed."));
    stages.push(skipStage("branch_protection_apply", "Skipped because template source resolution failed."));
    stages.push(skipStage("branch_protection_verify", "Skipped because template source resolution failed."));
    stages.push(skipStage("template_artifact_verify", "Skipped because template source resolution failed."));
    stages.push(skipStage("enforcement_readiness_verify", "Skipped because template source resolution failed."));
    return buildResult({
      executionMode,
      outcome: "failed",
      targetOwner,
      targetRepositoryName: normalizedRequest.targetRepositoryName,
      failureClass: "template_source_failed",
      remediation: remediationForTemplateResolution(),
      stages
    });
  }
  try {
    const existingRepository = await dependencies.client.getRepository({
      owner: targetOwner,
      repo: normalizedRequest.targetRepositoryName
    });
    stages.push({
      stage: "duplicate_target_preflight",
      status: "failure",
      summary: "Duplicate target repository detected; provisioning stopped before any create call.",
      details: {
        owner: targetOwner,
        repository: existingRepository.name ?? normalizedRequest.targetRepositoryName,
        private: existingRepository.private ?? null,
        url: existingRepository.html_url,
        remediation: remediationForDuplicateTarget()
      }
    });
    stages.push(skipStage("create_or_plan", "Skipped because duplicate target preflight failed."));
    stages.push(skipStage("branch_protection_apply", "Skipped because duplicate target preflight failed."));
    stages.push(skipStage("branch_protection_verify", "Skipped because duplicate target preflight failed."));
    stages.push(skipStage("template_artifact_verify", "Skipped because duplicate target preflight failed."));
    stages.push(skipStage("enforcement_readiness_verify", "Skipped because duplicate target preflight failed."));
    return buildResult({
      executionMode,
      outcome: "failed",
      targetOwner,
      targetRepositoryName: normalizedRequest.targetRepositoryName,
      failureClass: "duplicate_target",
      remediation: remediationForDuplicateTarget(),
      stages
    });
  } catch (error) {
    if (!isRepositoryMissingError(error)) {
      stages.push({
        stage: "duplicate_target_preflight",
        status: "failure",
        summary: error instanceof Error ? error.message : "Duplicate target preflight failed.",
        details: {
          remediation: remediationForDuplicatePreflight()
        }
      });
      stages.push(skipStage("create_or_plan", "Skipped because duplicate target preflight failed."));
      stages.push(skipStage("branch_protection_apply", "Skipped because duplicate target preflight failed."));
      stages.push(skipStage("branch_protection_verify", "Skipped because duplicate target preflight failed."));
      stages.push(skipStage("template_artifact_verify", "Skipped because duplicate target preflight failed."));
      stages.push(skipStage("enforcement_readiness_verify", "Skipped because duplicate target preflight failed."));
      return buildResult({
        executionMode,
        outcome: "failed",
        targetOwner,
        targetRepositoryName: normalizedRequest.targetRepositoryName,
        failureClass: "duplicate_preflight_failed",
        remediation: remediationForDuplicatePreflight(),
        stages
      });
    }
  }
  stages.push({
    stage: "duplicate_target_preflight",
    status: "success",
    summary: "Target repository name is available; create path may proceed.",
    details: {
      owner: targetOwner,
      repository: normalizedRequest.targetRepositoryName
    }
  });
  const metadataArtifacts = createRequesterMetadataArtifacts({
    requesterLogin: dependencies.config.requesterLogin,
    provisionedAt: (dependencies.config.now ?? (() => /* @__PURE__ */ new Date()))(),
    provisionedByWorkflow: dependencies.config.workflowRef
  });
  if (executionMode === "dry-run") {
    stages.push({
      stage: "create_or_plan",
      status: "planned",
      summary: "Dry-run completed; repository creation was not attempted.",
      details: {
        plannedAction: "create_repository_from_template",
        owner: targetOwner,
        repository: normalizedRequest.targetRepositoryName,
        private: true,
        template: templateSource.fullName,
        templateRef: templateSource.ref,
        branchProtection: createClassicMainBranchProtection(),
        requesterMetadata: summarizeRequesterMetadata(metadataArtifacts)
      }
    });
    stages.push({
      stage: "branch_protection_apply",
      status: "planned",
      summary: "Dry-run planned classic branch protection application for main.",
      details: {
        owner: targetOwner,
        repository: normalizedRequest.targetRepositoryName,
        branch: "main"
      }
    });
    stages.push({
      stage: "branch_protection_verify",
      status: "planned",
      summary: "Dry-run planned post-apply verification for classic main branch protection.",
      details: {
        owner: targetOwner,
        repository: normalizedRequest.targetRepositoryName,
        branch: "main"
      }
    });
    stages.push({
      stage: "template_artifact_verify",
      status: "planned",
      summary: "Dry-run planned target-repository template artifact verification.",
      details: {
        owner: targetOwner,
        repository: normalizedRequest.targetRepositoryName,
        requiredArtifacts: REQUIRED_TEMPLATE_ARTIFACTS
      }
    });
    stages.push({
      stage: "enforcement_readiness_verify",
      status: "planned",
      summary: "Dry-run planned requester-review enforcement readiness verification.",
      details: {
        owner: targetOwner,
        repository: normalizedRequest.targetRepositoryName
      }
    });
    return buildResult({
      executionMode,
      outcome: "not_ready",
      targetOwner,
      targetRepositoryName: normalizedRequest.targetRepositoryName,
      failureClass: "enforcement_not_ready",
      remediation: remediationForEnforcementNotReady(
        "Dry-run does not provision a repository, so enforcement readiness cannot be verified yet."
      ),
      scope: {
        repositoryCreated: false,
        hardeningApplied: false,
        hardeningVerified: false,
        templateArtifactsVerified: false,
        enforcementReady: false
      },
      stages
    });
  }
  try {
    const createdRepository = await dependencies.client.createRepositoryFromTemplate({
      templateOwner: templateSource.owner,
      templateRepo: templateSource.repository,
      owner: targetOwner,
      name: normalizedRequest.targetRepositoryName,
      description: normalizedRequest.description,
      private: true
    });
    const repository = {
      owner: targetOwner,
      name: createdRepository.name ?? normalizedRequest.targetRepositoryName,
      private: createdRepository.private ?? true,
      url: createdRepository.html_url
    };
    createdRepositoryState = repository;
    try {
      await dependencies.client.upsertRepositoryFile({
        owner: repository.owner,
        repo: repository.name,
        path: metadataArtifacts.metadataFilePath,
        content: metadataArtifacts.metadataFileContents,
        message: "chore(provisioning): persist requester metadata",
        branch: "main"
      });
    } catch (error) {
      const remediation = remediationForMetadataPersistenceFailure();
      stages.push({
        stage: "create_or_plan",
        status: "failure",
        summary: error instanceof Error ? error.message : "Repository created, but requester metadata persistence failed.",
        details: {
          owner: repository.owner,
          repository: repository.name,
          private: repository.private,
          url: repository.url,
          template: templateSource.fullName,
          templateRef: templateSource.ref,
          requesterMetadata: summarizeRequesterMetadata(metadataArtifacts),
          remediation
        }
      });
      stages.push(skipStage("branch_protection_apply", "Skipped because requester metadata persistence failed."));
      stages.push(skipStage("branch_protection_verify", "Skipped because requester metadata persistence failed."));
      stages.push(skipStage("template_artifact_verify", "Skipped because requester metadata persistence failed."));
      stages.push(skipStage("enforcement_readiness_verify", "Skipped because requester metadata persistence failed."));
      return buildResult({
        executionMode,
        outcome: "quarantined",
        targetOwner,
        targetRepositoryName: normalizedRequest.targetRepositoryName,
        repository,
        failureClass: "metadata_persistence_failed",
        remediation,
        quarantine: createQuarantine(
          repository,
          "Repository created but requester metadata persistence failed.",
          remediation
        ),
        scope: {
          repositoryCreated: true,
          hardeningApplied: false,
          hardeningVerified: false,
          templateArtifactsVerified: false,
          enforcementReady: false
        },
        stages
      });
    }
    stages.push({
      stage: "create_or_plan",
      status: "success",
      summary: "Sandbox provisioning created the repository from the approved template and persisted requester metadata.",
      details: {
        owner: repository.owner,
        repository: repository.name,
        private: repository.private,
        url: repository.url,
        template: templateSource.fullName,
        templateRef: templateSource.ref,
        requesterMetadata: summarizeRequesterMetadata(metadataArtifacts)
      }
    });
    const verification = await applyClassicMainBranchProtection(dependencies.client, {
      owner: repository.owner,
      repo: repository.name
    });
    stages.push({
      stage: "branch_protection_apply",
      status: "success",
      summary: "Classic branch protection payload submitted for main.",
      details: {
        owner: repository.owner,
        repository: repository.name,
        branch: "main"
      }
    });
    if (!verification.ok) {
      stages[stages.length - 1] = {
        stage: "branch_protection_apply",
        status: "failure",
        summary: "Classic branch protection application did not verify cleanly.",
        details: {
          owner: repository.owner,
          repository: repository.name,
          branch: "main",
          issues: verification.issues
        }
      };
      stages.push({
        stage: "branch_protection_verify",
        status: "failure",
        summary: "Classic branch protection verification detected contract drift.",
        details: {
          owner: repository.owner,
          repository: repository.name,
          branch: "main",
          issues: verification.issues,
          remediation: remediationForHardeningVerificationFailure()
        }
      });
      stages.push(skipStage("template_artifact_verify", "Skipped because hardening verification failed."));
      stages.push(skipStage("enforcement_readiness_verify", "Skipped because hardening verification failed."));
      const remediation = remediationForHardeningVerificationFailure();
      return buildResult({
        executionMode,
        outcome: "quarantined",
        targetOwner,
        targetRepositoryName: normalizedRequest.targetRepositoryName,
        repository,
        failureClass: "hardening_verification_failed",
        remediation,
        quarantine: createQuarantine(repository, "Hardening verification drift left repository non-ready.", remediation),
        scope: {
          repositoryCreated: true,
          hardeningApplied: true,
          hardeningVerified: false,
          templateArtifactsVerified: false,
          enforcementReady: false
        },
        stages
      });
    }
    stages.push({
      stage: "branch_protection_verify",
      status: "success",
      summary: "Classic main branch protection verified after application.",
      details: {
        owner: repository.owner,
        repository: repository.name,
        branch: "main"
      }
    });
    const templateArtifactVerification = await verifyRequiredTemplateArtifacts(dependencies.client, {
      owner: repository.owner,
      repo: repository.name,
      ref: "main"
    });
    const templateArtifactRemediation = templateArtifactVerification.ok ? void 0 : remediationForMissingTemplateArtifacts(templateArtifactVerification.missingArtifacts);
    stages.push({
      stage: "template_artifact_verify",
      status: templateArtifactVerification.ok ? "success" : "failure",
      summary: templateArtifactVerification.summary,
      details: {
        owner: repository.owner,
        repository: repository.name,
        ref: templateArtifactVerification.ref,
        requiredArtifacts: templateArtifactVerification.requiredArtifacts,
        presentArtifacts: templateArtifactVerification.presentArtifacts,
        missingArtifacts: templateArtifactVerification.missingArtifacts,
        ...templateArtifactRemediation ? { remediation: templateArtifactRemediation } : {}
      }
    });
    if (!templateArtifactVerification.ok) {
      stages.push(
        skipStage(
          "enforcement_readiness_verify",
          "Skipped because required template artifacts were not verified in the target repository."
        )
      );
      return buildResult({
        executionMode,
        outcome: "not_ready",
        targetOwner,
        targetRepositoryName: normalizedRequest.targetRepositoryName,
        repository,
        failureClass: "template_artifacts_missing",
        remediation: templateArtifactRemediation,
        scope: {
          repositoryCreated: true,
          hardeningApplied: true,
          hardeningVerified: true,
          templateArtifactsVerified: false,
          enforcementReady: false
        },
        stages
      });
    }
    const enforcementReadiness = await resolveEnforcementReadiness(dependencies, {
      owner: repository.owner,
      repo: repository.name,
      ref: "main"
    });
    const enforcementRemediation = enforcementReadiness.ready ? void 0 : remediationForEnforcementNotReady(enforcementReadiness.summary);
    stages.push({
      stage: "enforcement_readiness_verify",
      status: enforcementReadiness.ready ? "success" : "failure",
      summary: enforcementReadiness.summary,
      details: {
        owner: repository.owner,
        repository: repository.name,
        ...enforcementReadiness.details ? { readinessDetails: enforcementReadiness.details } : {},
        ...enforcementRemediation ? { remediation: enforcementRemediation } : {}
      }
    });
    if (!enforcementReadiness.ready) {
      return buildResult({
        executionMode,
        outcome: "not_ready",
        targetOwner,
        targetRepositoryName: normalizedRequest.targetRepositoryName,
        repository,
        failureClass: "enforcement_not_ready",
        remediation: enforcementRemediation,
        scope: {
          repositoryCreated: true,
          hardeningApplied: true,
          hardeningVerified: true,
          templateArtifactsVerified: true,
          enforcementReady: false
        },
        stages
      });
    }
    return buildResult({
      executionMode,
      outcome: "success",
      targetOwner,
      targetRepositoryName: normalizedRequest.targetRepositoryName,
      repository,
      scope: {
        repositoryCreated: true,
        hardeningApplied: true,
        hardeningVerified: true,
        templateArtifactsVerified: true,
        enforcementReady: true
      },
      stages
    });
  } catch (error) {
    const failedStage = createdRepositoryStageFailed(stages) ? "branch_protection_apply" : "create_or_plan";
    const failedRepositoryOwner = createdRepositoryState?.owner ?? targetOwner;
    const failedRepositoryName = createdRepositoryState?.name ?? normalizedRequest.targetRepositoryName;
    const isBranchProtectionPlanLimit = failedStage === "branch_protection_apply" && isGitHubPrivateBranchProtectionPlanLimitError(error, {
      owner: failedRepositoryOwner,
      repo: failedRepositoryName,
      branch: "main"
    });
    if (isBranchProtectionPlanLimit && createdRepositoryState) {
      const remediation = remediationForHardeningManualRequired();
      const platformLimitation = getBranchProtectionPlanLimitEvidence(error, {
        owner: createdRepositoryState.owner,
        repo: createdRepositoryState.name,
        branch: "main"
      });
      stages.push({
        stage: "branch_protection_apply",
        status: "failure",
        summary: "Repository creation and requester metadata persistence succeeded, but GitHub plan limits blocked private-repository branch protection. Manual hardening follow-up is required.",
        details: {
          owner: createdRepositoryState.owner,
          repository: createdRepositoryState.name,
          branch: "main",
          ...platformLimitation ? { platformLimitation } : {},
          remediation
        }
      });
      stages.push(
        skipStage(
          "branch_protection_verify",
          "Skipped because GitHub plan limits blocked automatic branch protection for this private repository."
        )
      );
      stages.push(skipStage("template_artifact_verify", "Skipped until manual hardening follow-up is completed."));
      stages.push(skipStage("enforcement_readiness_verify", "Skipped until manual hardening follow-up is completed."));
      return buildResult({
        executionMode,
        outcome: "not_ready",
        targetOwner,
        targetRepositoryName: normalizedRequest.targetRepositoryName,
        repository: createdRepositoryState,
        failureClass: "hardening_manual_required",
        remediation,
        scope: {
          repositoryCreated: true,
          hardeningApplied: false,
          hardeningVerified: false,
          templateArtifactsVerified: false,
          enforcementReady: false
        },
        stages
      });
    }
    stages.push({
      stage: failedStage,
      status: "failure",
      summary: error instanceof Error ? error.message : failedStage === "create_or_plan" ? "Repository creation failed." : "Classic branch protection application failed.",
      details: {
        owner: targetOwner,
        repository: normalizedRequest.targetRepositoryName,
        branch: failedStage === "branch_protection_apply" ? "main" : void 0,
        remediation: failedStage === "create_or_plan" ? remediationForCreateFailure() : remediationForHardeningApplyFailure()
      }
    });
    if (failedStage === "branch_protection_apply") {
      stages.push(skipStage("branch_protection_verify", "Skipped because branch protection application failed."));
      stages.push(skipStage("template_artifact_verify", "Skipped because branch protection application failed."));
      stages.push(skipStage("enforcement_readiness_verify", "Skipped because branch protection application failed."));
      const remediation = remediationForHardeningApplyFailure();
      return buildResult({
        executionMode,
        outcome: createdRepositoryState ? "quarantined" : "failed",
        targetOwner,
        targetRepositoryName: normalizedRequest.targetRepositoryName,
        repository: createdRepositoryState,
        failureClass: "hardening_apply_failed",
        remediation,
        quarantine: createdRepositoryState ? createQuarantine(createdRepositoryState, "Repository created but hardening failed to apply.", remediation) : void 0,
        scope: {
          repositoryCreated: Boolean(createdRepositoryState),
          hardeningApplied: false,
          hardeningVerified: false,
          templateArtifactsVerified: false,
          enforcementReady: false
        },
        stages
      });
    }
    stages.push(skipStage("branch_protection_apply", "Skipped because repository creation failed."));
    stages.push(skipStage("branch_protection_verify", "Skipped because repository creation failed."));
    stages.push(skipStage("template_artifact_verify", "Skipped because repository creation failed."));
    stages.push(skipStage("enforcement_readiness_verify", "Skipped because repository creation failed."));
    return buildResult({
      executionMode,
      outcome: "failed",
      targetOwner,
      targetRepositoryName: normalizedRequest.targetRepositoryName,
      repository: createdRepositoryState,
      failureClass: "create_failed",
      remediation: remediationForCreateFailure(),
      scope: {
        repositoryCreated: false,
        hardeningApplied: false,
        hardeningVerified: false,
        templateArtifactsVerified: false,
        enforcementReady: false
      },
      stages
    });
  }
}
function formatProvisioningStageLogs(result) {
  return result.stages.map((stage) => JSON.stringify(stage));
}
function resolveTargetOwner(executionMode, sandboxOwner) {
  if (executionMode === "sandbox") {
    return (sandboxOwner ?? ORGANIZATION_SLUG).trim() || ORGANIZATION_SLUG;
  }
  return (sandboxOwner ?? ORGANIZATION_SLUG).trim() || ORGANIZATION_SLUG;
}
function summarizeRequesterMetadata(metadataArtifacts) {
  return {
    metadataFilePath: metadataArtifacts.metadataFilePath,
    metadataKind: metadataArtifacts.metadataFile.kind,
    requesterLogin: metadataArtifacts.parsed.requesterLogin
  };
}
function skipStage(stage, summary) {
  return {
    stage,
    status: "skipped",
    summary
  };
}
function isRepositoryMissingError(error) {
  return error instanceof GitHubApiError && error.context.status === 404;
}
function isExecutionMode2(value) {
  return value === "dry-run" || value === "sandbox";
}
function createdRepositoryStageFailed(stages) {
  return stages.some((stage) => stage.stage === "create_or_plan" && stage.status === "success");
}
function isGitHubPrivateBranchProtectionPlanLimitError(error, input) {
  const evidence = getBranchProtectionPlanLimitEvidence(error, input);
  return evidence !== void 0;
}
function getBranchProtectionPlanLimitEvidence(error, input) {
  const expectedMethod = "PUT";
  const expectedPath = `/repos/${input.owner}/${input.repo}/branches/${input.branch}/protection`;
  const planLimitMessage = /upgrade to github pro or make this repository public to enable this feature\.?/i;
  if (error instanceof GitHubApiError) {
    if (error.context.status !== 403) {
      return void 0;
    }
    if (error.context.path !== expectedPath) {
      return void 0;
    }
    if (!planLimitMessage.test(error.message)) {
      return void 0;
    }
    return {
      errorType: "GitHubApiError",
      method: expectedMethod,
      path: error.context.path,
      message: error.message,
      status: error.context.status
    };
  }
  if (error instanceof GitHubAppPermissionError) {
    const match = /^GitHub API permission failure for (?<method>\S+) (?<path>\/\S+): (?<message>.+)$/i.exec(error.message);
    if (!match?.groups) {
      return void 0;
    }
    const method = match.groups.method?.toUpperCase();
    const path = match.groups.path;
    const message = match.groups.message?.trim();
    if (method !== expectedMethod) {
      return void 0;
    }
    if (path !== expectedPath) {
      return void 0;
    }
    if (!message || !planLimitMessage.test(message)) {
      return void 0;
    }
    return {
      errorType: "GitHubAppPermissionError",
      method: expectedMethod,
      path,
      message
    };
  }
  return void 0;
}
async function repositoryFileExists2(client, owner, repo, path, ref) {
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
function buildResult(input) {
  const scope = {
    repositoryCreated: input.scope?.repositoryCreated ?? false,
    hardeningApplied: input.scope?.hardeningApplied ?? false,
    hardeningVerified: input.scope?.hardeningVerified ?? false,
    templateArtifactsVerified: input.scope?.templateArtifactsVerified ?? false,
    enforcementReady: input.scope?.enforcementReady ?? false
  };
  const scopeSuccess = scope.repositoryCreated && scope.hardeningApplied && scope.hardeningVerified && scope.templateArtifactsVerified;
  return {
    ok: input.outcome === "success",
    outcome: input.outcome,
    readiness: input.outcome === "success" ? "ready" : "not_ready",
    scopeSuccess,
    executionMode: input.executionMode,
    targetOwner: input.targetOwner,
    targetRepositoryName: input.targetRepositoryName,
    failureClass: input.failureClass,
    remediation: input.remediation,
    quarantine: input.quarantine,
    scope,
    repository: input.repository,
    stages: input.stages
  };
}
async function verifyRequiredTemplateArtifacts(client, repository) {
  const ref = repository.ref?.trim() || "main";
  const results = await Promise.all(
    REQUIRED_TEMPLATE_ARTIFACTS.map(async (artifact) => ({
      artifact,
      present: await repositoryFileExists2(client, repository.owner, repository.repo, artifact.path, ref)
    }))
  );
  const presentArtifacts = results.filter((result) => result.present).map((result) => result.artifact.path);
  const missingArtifacts = results.filter((result) => !result.present).map((result) => result.artifact.path);
  const ok = missingArtifacts.length === 0;
  return {
    ok,
    summary: ok ? "Required template artifacts were verified in the provisioned target repository." : `Required template artifacts are missing from the provisioned target repository: ${missingArtifacts.join(", ")}.`,
    ref,
    requiredArtifacts: REQUIRED_TEMPLATE_ARTIFACTS,
    presentArtifacts,
    missingArtifacts
  };
}
async function resolveEnforcementReadiness(dependencies, repository) {
  if (dependencies.config.enforcementReadinessCheck) {
    const readiness = await dependencies.config.enforcementReadinessCheck({
      owner: repository.owner,
      repo: repository.repo,
      ref: repository.ref,
      client: dependencies.client
    });
    return {
      ready: readiness.ready,
      summary: readiness.summary ?? (readiness.ready ? "Requester-review enforcement readiness verified in the provisioned target repository." : "Requester-review enforcement readiness check failed for the provisioned target repository."),
      details: readiness.details
    };
  }
  const config = dependencies.config;
  if (config.enforcementReadiness) {
    return {
      ready: config.enforcementReadiness.ready,
      summary: config.enforcementReadiness.summary ?? (config.enforcementReadiness.ready ? "Requester-review enforcement readiness verified." : "Requester-review enforcement readiness check failed."),
      details: config.enforcementReadiness.details
    };
  }
  return {
    ready: false,
    summary: "Requester-review enforcement is not implemented yet; repository remains non-ready until enforcement verification is available.",
    details: {
      pendingCapability: "requester-review-policy-enforcement"
    }
  };
}
function remediationForMetadataPersistenceFailure() {
  return {
    code: "metadata_persistence_failed",
    summary: "Repository was created but requester metadata file could not be persisted.",
    actions: [
      "Treat the repository as quarantined until requester metadata file is repaired.",
      "Write .github/provisioning/requester-metadata.json in the target repository with canonical requester metadata content.",
      "Re-run provisioning verification after metadata persistence succeeds."
    ]
  };
}
function createQuarantine(repository, reason, remediation) {
  return {
    required: true,
    owner: repository.owner,
    repository: repository.name,
    reason,
    remediation
  };
}
function remediationForValidation(summary) {
  return {
    code: "validation_failed",
    summary: summary ?? "Provisioning input validation failed.",
    actions: ["Correct workflow_dispatch inputs to satisfy the canonical provisioning contract.", "Re-run provisioning after inputs pass validation."]
  };
}
function remediationForTemplateResolution() {
  return {
    code: "template_source_failed",
    summary: "Template source configuration is invalid or missing.",
    actions: [
      "Set PROVISIONING_TEMPLATE_REPOSITORY to a single approved value in <owner>/<repo> form.",
      "Optionally set PROVISIONING_TEMPLATE_REPOSITORY_REF to a non-empty ref.",
      "Re-run provisioning after template configuration is corrected."
    ]
  };
}
function remediationForDuplicateTarget() {
  return {
    code: "duplicate_target",
    summary: "Target repository already exists.",
    actions: [
      "Choose a different repo_slug that normalizes to a new proj-* repository name.",
      "If the existing repository is unexpected, investigate and resolve ownership before retrying provisioning."
    ]
  };
}
function remediationForDuplicatePreflight() {
  return {
    code: "duplicate_preflight_failed",
    summary: "Duplicate target preflight could not determine repository availability.",
    actions: [
      "Check GitHub API availability and GitHub App repository read permissions.",
      "Retry preflight once API access is healthy."
    ]
  };
}
function remediationForCreateFailure() {
  return {
    code: "create_failed",
    summary: "Repository creation from template failed.",
    actions: [
      "Inspect GitHub App permissions and org repository creation policy.",
      "Verify template repository accessibility for the installation token.",
      "Retry provisioning after resolving create-path errors."
    ]
  };
}
function remediationForHardeningApplyFailure() {
  return {
    code: "hardening_apply_failed",
    summary: "Repository was created but branch-protection hardening failed to apply.",
    actions: [
      "Treat the repository as quarantined and block normal use until hardening is repaired.",
      "Re-apply classic main branch protection and verify required checks/admin enforcement.",
      "Re-run provisioning verification after hardening is restored."
    ]
  };
}
function remediationForHardeningManualRequired() {
  return {
    code: "hardening_manual_required",
    summary: "Repository was created and requester metadata was persisted, but GitHub Free/private-repository plan limits blocked automatic branch protection.",
    actions: [
      "Manually configure main branch protection for the new private repository before allowing normal development use.",
      `Apply the same canonical controls (required status check "${REQUESTER_REVIEW_POLICY_CHECK}", required approving review count >= 1, enforce admins, no direct push bypass) once available.`,
      "To automate this step in future runs, either upgrade the organization plan to support private-repo branch protection APIs or use a public repository where this API is available."
    ]
  };
}
function remediationForHardeningVerificationFailure() {
  return {
    code: "hardening_verification_failed",
    summary: "Repository hardening drift detected after branch-protection application.",
    actions: [
      "Treat the repository as quarantined and investigate branch protection drift immediately.",
      "Restore canonical classic main branch protection and re-verify before marking ready.",
      "Capture drift evidence for audit/review follow-up."
    ]
  };
}
function remediationForMissingTemplateArtifacts(missingArtifacts) {
  return {
    code: "template_artifacts_missing",
    summary: `Provisioned repository is missing required template artifacts: ${missingArtifacts.join(", ")}.`,
    actions: [
      "Treat the repository as non-ready until template propagation is repaired in the target repository.",
      `Confirm the approved template repository still contains the mandatory artifact paths (${REQUIRED_TEMPLATE_ARTIFACTS.map((artifact) => artifact.path).join(", ")}).`,
      `Restore the missing target-repository artifact paths and re-run provisioning verification (${missingArtifacts.join(", ")}).`
    ]
  };
}
function remediationForEnforcementNotReady(summary) {
  return {
    code: "enforcement_not_ready",
    summary: summary ?? "Requester-review enforcement verification is not ready; repository cannot be marked fully ready.",
    actions: [
      "Implement and enable requester-review enforcement workflow verification (Task 7).",
      "Register requester-review-policy check as passing and verify enforcement readiness in a follow-up run."
    ]
  };
}

// src/provisioning/run-workflow.ts
var REQUIRED_GITHUB_ACTIONS_VARIABLES = ["PROVISIONING_TEMPLATE_REPOSITORY"];
var OPTIONAL_GITHUB_ACTIONS_VARIABLES = [
  "PROVISIONING_TEMPLATE_REPOSITORY_REF",
  "PROVISIONING_SANDBOX_OWNER"
];
async function main() {
  const runtimeConfig = loadProvisioningRuntimeConfig();
  const result = await runProvisioningWorkflow(
    {
      repo_slug: requiredEnv("INPUT_REPO_SLUG"),
      description: requiredEnv("INPUT_DESCRIPTION"),
      execution_mode: optionalExecutionMode(process.env.INPUT_EXECUTION_MODE)
    },
    {
      client: createGitHubApiClient({
        auth: createGitHubAppAuth({
          credentials: {
            appId: runtimeConfig.githubApp.appId,
            installationId: runtimeConfig.githubApp.installationId,
            privateKey: runtimeConfig.githubApp.privateKey
          }
        })
      }),
      config: {
        templateRepository: runtimeConfig.templateRepository,
        templateRef: runtimeConfig.templateRef,
        requesterLogin: requiredEnv("GITHUB_ACTOR"),
        workflowRef: process.env.GITHUB_WORKFLOW_REF ?? ".github/workflows/provision-repository.yml@refs/heads/main",
        sandboxOwner: runtimeConfig.sandboxOwner,
        enforcementReadinessCheck: ({ owner, repo, ref, client }) => getRequesterReviewEnforcementReadinessForRepository({
          client,
          owner,
          repo,
          ref
        })
      }
    }
  );
  for (const line of formatProvisioningStageLogs(result)) {
    console.log(line);
  }
  writeGitHubOutput("result", JSON.stringify(result));
  writeGitHubOutput("ok", String(result.ok));
  writeGitHubOutput("outcome", result.outcome);
  writeGitHubOutput("readiness", result.readiness);
  writeGitHubOutput("scope_success", String(result.scopeSuccess));
  if (shouldFailProvisioningRun(result)) {
    process.exitCode = 1;
  }
}
function shouldFailProvisioningRun(result) {
  if (result.ok) {
    return false;
  }
  if (isManualHardeningFollowupResult(result)) {
    return false;
  }
  return true;
}
function isManualHardeningFollowupResult(result) {
  return result.outcome === "not_ready" && result.failureClass === "hardening_manual_required" && result.scope.repositoryCreated === true && result.scope.hardeningApplied === false && result.executionMode === "sandbox";
}
function loadProvisioningRuntimeConfig(env = process.env) {
  const missingSecrets = getConfiguredGitHubActionsSecretNames(env);
  const missingVariables = missingEnvNames(env, REQUIRED_GITHUB_ACTIONS_VARIABLES);
  if (missingSecrets.length > 0 || missingVariables.length > 0) {
    throw new Error(formatMissingGitHubActionsConfigurationError({ missingSecrets, missingVariables }));
  }
  return {
    githubApp: {
      ...loadGitHubAppRuntimeCredentials(env)
    },
    templateRepository: requiredEnv("PROVISIONING_TEMPLATE_REPOSITORY", env),
    templateRef: optionalExecutionMode(env.PROVISIONING_TEMPLATE_REPOSITORY_REF),
    sandboxOwner: optionalExecutionMode(env.PROVISIONING_SANDBOX_OWNER)
  };
}
function formatMissingGitHubActionsConfigurationError(input) {
  const lines = [
    "GitHub Actions provisioning configuration is incomplete.",
    "This workflow requires GitHub Actions secrets and variables to be configured before src/provisioning/run-workflow.ts can authenticate and resolve the approved template."
  ];
  if (input.missingSecrets.length > 0) {
    lines.push("", "Missing required GitHub Actions secrets:", ...input.missingSecrets.map((name) => `- ${name}`));
  }
  if (input.missingVariables.length > 0) {
    lines.push("", "Missing required GitHub Actions variables:", ...input.missingVariables.map((name) => `- ${name}`));
  }
  lines.push(
    "",
    "Configure these values in GitHub before rerunning the workflow:",
    "- Repository Settings \u2192 Secrets and variables \u2192 Actions, or the organization-level Secrets and Variables pages if this control repository inherits shared provisioning config.",
    `- Secrets: ${formatGitHubAppSecretContract()}`,
    "- Variables: PROVISIONING_TEMPLATE_REPOSITORY",
    `- Optional variables used by this workflow: ${OPTIONAL_GITHUB_ACTIONS_VARIABLES.join(", ")}`,
    "- PROVISIONING_TEMPLATE_REPOSITORY must be set to the approved template repository in <owner>/<repo> form.",
    `- ${formatLegacyGitHubAppFallbackNote()}`
  );
  return lines.join("\n");
}
function requiredEnv(name, env = process.env) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
function optionalExecutionMode(value) {
  if (value === void 0) {
    return void 0;
  }
  return value.trim();
}
function missingEnvNames(env, names) {
  return names.filter((name) => !env[name]?.trim());
}
function writeGitHubOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}
`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
export {
  formatMissingGitHubActionsConfigurationError,
  isManualHardeningFollowupResult,
  loadProvisioningRuntimeConfig,
  shouldFailProvisioningRun
};
