export const PROVISIONING_TEMPLATE_REPOSITORY_CONFIG_KEY = 'PROVISIONING_TEMPLATE_REPOSITORY';
export const DEFAULT_TEMPLATE_SOURCE_REF = 'main';
export const REQUESTER_LOGIN_REPOSITORY_VARIABLE_NAME = 'REQUESTER_LOGIN';
export const REQUESTER_METADATA_FILE_PATH = '.github/provisioning/requester-metadata.json';
export const REQUIRED_TEMPLATE_ARTIFACT_PATHS = {
  readme: 'README.md',
  license: 'LICENSE',
  defaultCiWorkflow: '.github/workflows/ci.yml',
} as const;
export const REQUESTER_METADATA_KIND = 'test-repo-yocto/requester-metadata';
export const REQUESTER_METADATA_SCHEMA_VERSION = 1 as const;

export const REQUIRED_TEMPLATE_ARTIFACTS = [
  {
    key: 'readme',
    label: 'README',
    path: REQUIRED_TEMPLATE_ARTIFACT_PATHS.readme,
  },
  {
    key: 'license',
    label: 'LICENSE',
    path: REQUIRED_TEMPLATE_ARTIFACT_PATHS.license,
  },
  {
    key: 'default_ci_workflow',
    label: 'default CI workflow',
    path: REQUIRED_TEMPLATE_ARTIFACT_PATHS.defaultCiWorkflow,
  },
] as const;

const templateRepositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const requesterLoginPattern = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const workflowIdentityPattern = /^[A-Za-z0-9._/@:-]+$/;

export class ProvisioningMetadataContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningMetadataContractError';
  }
}

export interface ApprovedTemplateSource {
  configKey: typeof PROVISIONING_TEMPLATE_REPOSITORY_CONFIG_KEY;
  owner: string;
  repository: string;
  fullName: string;
  ref: string;
}

export type RequiredTemplateArtifact = (typeof REQUIRED_TEMPLATE_ARTIFACTS)[number];

export interface RequesterLoginRepositoryVariable {
  name: typeof REQUESTER_LOGIN_REPOSITORY_VARIABLE_NAME;
  value: string;
}

export interface RequesterMetadataFile {
  kind: typeof REQUESTER_METADATA_KIND;
  schema_version: typeof REQUESTER_METADATA_SCHEMA_VERSION;
  requester_login: string;
  provisioned_at: string;
  provisioned_by_workflow: string;
}

export interface ParsedRequesterMetadata {
  requesterLogin: string;
  provisionedAt: string;
  provisionedByWorkflow: string;
  repositoryVariable: RequesterLoginRepositoryVariable;
  metadataFilePath: typeof REQUESTER_METADATA_FILE_PATH;
  metadataFile: RequesterMetadataFile;
}

export interface CreateRequesterMetadataInput {
  requesterLogin: string;
  provisionedAt: string | Date;
  provisionedByWorkflow: string;
}

export interface RequesterMetadataArtifacts {
  repositoryVariable: RequesterLoginRepositoryVariable;
  metadataFilePath: typeof REQUESTER_METADATA_FILE_PATH;
  metadataFile: RequesterMetadataFile;
  metadataFileContents: string;
  parsed: ParsedRequesterMetadata;
}

export interface ParseRequesterMetadataInput {
  metadataFileContent: string | RequesterMetadataFile | unknown;
  repositoryVariableValue?: unknown;
}

export function normalizeApprovedTemplateSource(
  repository: string,
  ref = DEFAULT_TEMPLATE_SOURCE_REF,
): ApprovedTemplateSource {
  const trimmedRepository = repository.trim();
  const trimmedRef = ref.trim();

  if (trimmedRepository.length === 0) {
    throw new ProvisioningMetadataContractError(
      `${PROVISIONING_TEMPLATE_REPOSITORY_CONFIG_KEY} is required and must point to exactly one template repository.`,
    );
  }

  if (!templateRepositoryPattern.test(trimmedRepository)) {
    throw new ProvisioningMetadataContractError(
      `${PROVISIONING_TEMPLATE_REPOSITORY_CONFIG_KEY} must use the form <owner>/<repo>.`,
    );
  }

  if (trimmedRef.length === 0) {
    throw new ProvisioningMetadataContractError('Template source ref must not be empty.');
  }

  const [owner, repo] = trimmedRepository.split('/');

  return {
    configKey: PROVISIONING_TEMPLATE_REPOSITORY_CONFIG_KEY,
    owner,
    repository: repo,
    fullName: trimmedRepository,
    ref: trimmedRef,
  };
}

export function createRequesterMetadataArtifacts(
  input: CreateRequesterMetadataInput,
): RequesterMetadataArtifacts {
  const requesterLogin = normalizeRequesterLoginInput(input.requesterLogin);
  const provisionedAt = normalizeProvisionedAt(input.provisionedAt);
  const provisionedByWorkflow = normalizeProvisionedByWorkflow(input.provisionedByWorkflow);
  const repositoryVariable = createRequesterLoginRepositoryVariable(requesterLogin);
  const metadataFile: RequesterMetadataFile = {
    kind: REQUESTER_METADATA_KIND,
    schema_version: REQUESTER_METADATA_SCHEMA_VERSION,
    requester_login: requesterLogin,
    provisioned_at: provisionedAt,
    provisioned_by_workflow: provisionedByWorkflow,
  };

  return {
    repositoryVariable,
    metadataFilePath: REQUESTER_METADATA_FILE_PATH,
    metadataFile,
    metadataFileContents: serializeRequesterMetadataFile(metadataFile),
    parsed: {
      requesterLogin,
      provisionedAt,
      provisionedByWorkflow,
      repositoryVariable,
      metadataFilePath: REQUESTER_METADATA_FILE_PATH,
      metadataFile,
    },
  };
}

export function createRequesterLoginRepositoryVariable(
  requesterLogin: string,
): RequesterLoginRepositoryVariable {
  return {
    name: REQUESTER_LOGIN_REPOSITORY_VARIABLE_NAME,
    value: normalizeRequesterLoginInput(requesterLogin),
  };
}

export function parseRequesterMetadata(input: ParseRequesterMetadataInput): ParsedRequesterMetadata {
  const metadataFile = parseRequesterMetadataFile(input.metadataFileContent);
  const requesterLogin = parseCanonicalRequesterLogin(metadataFile.requester_login);
  const provisionedAt = normalizeProvisionedAt(metadataFile.provisioned_at);
  const provisionedByWorkflow = normalizeProvisionedByWorkflow(metadataFile.provisioned_by_workflow);

  if (input.repositoryVariableValue !== undefined) {
    const repositoryVariableValue = normalizeRequesterLoginRepositoryVariableValue(input.repositoryVariableValue);

    if (repositoryVariableValue !== requesterLogin) {
      throw new ProvisioningMetadataContractError(
        `Requester metadata mismatch: repository variable ${REQUESTER_LOGIN_REPOSITORY_VARIABLE_NAME} must exactly match ${REQUESTER_METADATA_FILE_PATH}.`,
      );
    }
  }

  const repositoryVariable = createRequesterLoginRepositoryVariable(requesterLogin);

  return {
    requesterLogin,
    provisionedAt,
    provisionedByWorkflow,
    repositoryVariable,
    metadataFilePath: REQUESTER_METADATA_FILE_PATH,
    metadataFile: {
      kind: REQUESTER_METADATA_KIND,
      schema_version: REQUESTER_METADATA_SCHEMA_VERSION,
      requester_login: requesterLogin,
      provisioned_at: provisionedAt,
      provisioned_by_workflow: provisionedByWorkflow,
    },
  };
}

export function parseRequesterMetadataFile(content: string | RequesterMetadataFile | unknown): RequesterMetadataFile {
  const parsed = typeof content === 'string' ? safeJsonParse(content) : content;

  if (parsed === null || typeof parsed !== 'object') {
    throw new ProvisioningMetadataContractError(
      `Requester metadata is missing or malformed; expected JSON object at ${REQUESTER_METADATA_FILE_PATH}.`,
    );
  }

  const candidate = parsed as Partial<RequesterMetadataFile>;

  if (candidate.kind !== REQUESTER_METADATA_KIND) {
    throw new ProvisioningMetadataContractError(
      `Requester metadata kind must be ${REQUESTER_METADATA_KIND}.`,
    );
  }

  if (candidate.schema_version !== REQUESTER_METADATA_SCHEMA_VERSION) {
    throw new ProvisioningMetadataContractError(
      `Requester metadata schema_version must be ${REQUESTER_METADATA_SCHEMA_VERSION}.`,
    );
  }

  return {
    kind: REQUESTER_METADATA_KIND,
    schema_version: REQUESTER_METADATA_SCHEMA_VERSION,
    requester_login: requireString(candidate.requester_login, 'requester_login'),
    provisioned_at: requireString(candidate.provisioned_at, 'provisioned_at'),
    provisioned_by_workflow: requireString(candidate.provisioned_by_workflow, 'provisioned_by_workflow'),
  };
}

export function serializeRequesterMetadataFile(metadata: RequesterMetadataFile): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

function normalizeRequesterLoginRepositoryVariableValue(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ProvisioningMetadataContractError(
      `Repository variable ${REQUESTER_LOGIN_REPOSITORY_VARIABLE_NAME} is required when provided and must be a string.`,
    );
  }

  return parseCanonicalRequesterLogin(value);
}

function normalizeRequesterLoginInput(value: string): string {
  const normalized = value.trim().toLowerCase();

  return validateRequesterLogin(normalized);
}

function parseCanonicalRequesterLogin(value: string): string {
  const trimmed = value.trim();
  const canonical = validateRequesterLogin(trimmed);

  if (trimmed !== canonical) {
    throw new ProvisioningMetadataContractError(
      'requester_login must already be stored in canonical lowercase form.',
    );
  }

  return canonical;
}

function validateRequesterLogin(normalized: string): string {
  
  if (normalized.length === 0) {
    throw new ProvisioningMetadataContractError('requester_login must not be empty.');
  }

  if (!requesterLoginPattern.test(normalized) || normalized.includes('--')) {
    throw new ProvisioningMetadataContractError(
      'requester_login must be a canonical lowercase GitHub login using only letters, digits, and single dashes.',
    );
  }

  return normalized;
}

function normalizeProvisionedAt(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new ProvisioningMetadataContractError(
      'provisioned_at must be a valid ISO-8601 timestamp.',
    );
  }

  const canonical = date.toISOString();
  const rawValue = value instanceof Date ? canonical : value.trim();

  if (rawValue !== canonical) {
    throw new ProvisioningMetadataContractError(
      'provisioned_at must use canonical UTC ISO-8601 format (Date#toISOString).',
    );
  }

  return canonical;
}

function normalizeProvisionedByWorkflow(value: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new ProvisioningMetadataContractError('provisioned_by_workflow must not be empty.');
  }

  if (!workflowIdentityPattern.test(normalized)) {
    throw new ProvisioningMetadataContractError(
      'provisioned_by_workflow must use a stable workflow identifier/path string with no spaces.',
    );
  }

  return normalized;
}

function safeJsonParse(content: string): unknown {
  const trimmed = content.trim();

  if (trimmed.length === 0) {
    throw new ProvisioningMetadataContractError(
      `Requester metadata is missing or malformed; expected JSON object at ${REQUESTER_METADATA_FILE_PATH}.`,
    );
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new ProvisioningMetadataContractError(
      `Requester metadata is missing or malformed; expected JSON object at ${REQUESTER_METADATA_FILE_PATH}.`,
    );
  }
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new ProvisioningMetadataContractError(`Requester metadata field ${fieldName} must be a string.`);
  }

  return value;
}
