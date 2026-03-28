import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('GitHub App secret/env naming contract', () => {
  it('uses PROVISIONING_GITHUB_APP_* as the Actions secret contract in workflows and runtime docs', () => {
    const files = [
      '.github/workflows/provision-repository.yml',
      '.github/workflows/requester-review-policy.yml',
      'src/provisioning/github-actions-config.ts',
      'docs/provisioning-workflow.md',
    ];

    for (const relativePath of files) {
      const content = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
      expect(content).toMatch(/PROVISIONING_GITHUB_APP_ID/);
      expect(content).toMatch(/PROVISIONING_GITHUB_APP_INSTALLATION_ID/);
      expect(content).toMatch(/PROVISIONING_GITHUB_APP_PRIVATE_KEY/);
      expect(content).not.toMatch(/secrets\.GITHUB_APP_ID/);
      expect(content).not.toMatch(/secrets\.GITHUB_APP_INSTALLATION_ID/);
      expect(content).not.toMatch(/secrets\.GITHUB_APP_PRIVATE_KEY/);
    }
  });

  it('documents the legacy GITHUB_APP_* names only as fallback guidance', () => {
    const content = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');
    expect(content).toMatch(/PROVISIONING_GITHUB_APP_ID/);
    expect(content).toMatch(/GITHUB_APP_ID/);
    expect(content).toContain('`GITHUB_`로 시작할 수 없습니다');
  });
});
