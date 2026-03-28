import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('GitHub App secret/env naming contract', () => {
  it('uses only GITHUB_APP_* naming across workflows and docs', () => {
    const files = [
      '.github/workflows/provision-repository.yml',
      '.github/workflows/requester-review-policy.yml',
      'src/provisioning/run-workflow.ts',
      'src/policy/run-requester-review-policy.ts',
      'docs/provisioning-workflow.md',
    ];

    for (const relativePath of files) {
      const content = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
      expect(content).toMatch(/GITHUB_APP_ID/);
      expect(content).toMatch(/GITHUB_APP_INSTALLATION_ID/);
      expect(content).toMatch(/GITHUB_APP_PRIVATE_KEY/);
      expect(content).not.toMatch(/GH_APP_ID/);
      expect(content).not.toMatch(/GH_APP_INSTALLATION_ID/);
      expect(content).not.toMatch(/GH_APP_PRIVATE_KEY/);
    }
  });
});
