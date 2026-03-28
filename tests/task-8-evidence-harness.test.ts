import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createTask8EvidenceArtifact,
  TASK_8_EVIDENCE_TIMESTAMP,
  task8EvidenceJsonArtifactPath,
  task8EvidenceTextArtifactPath,
  writeTask8EvidenceArtifacts,
} from '../src/verification/task-8-evidence.js';

describe('task 8 evidence harness', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('builds a ready success artifact with explicit local-only limitation', async () => {
    const artifact = await createTask8EvidenceArtifact('success');

    expect(artifact.generatedAt).toBe(TASK_8_EVIDENCE_TIMESTAMP);
    expect(artifact.provisioning.ok).toBe(true);
    expect(artifact.provisioning.outcome).toBe('success');
    expect(artifact.requesterReviewPolicy.ok).toBe(true);
    expect(artifact.assertions).toEqual({
      provisioningReady: true,
      requesterPolicyOutcomeObserved: true,
      liveContextGapExplicit: true,
    });
    expect(artifact.liveRequiredCheckContextObservation).toMatchObject({
      expectedRequiredCheckContext: 'requester-review-policy',
      localNamesMatchExpectedContext: true,
      liveGitHubCheckContextVerified: false,
      status: 'observable_but_unverified_locally',
    });
  });

  it('builds a requester-policy failure artifact without faking a live sandbox pass', async () => {
    const artifact = await createTask8EvidenceArtifact('policy-failure');

    expect(artifact.provisioning.ok).toBe(true);
    expect(artifact.requesterReviewPolicy.ok).toBe(false);
    expect(artifact.requesterReviewPolicy.failureCode).toBe('missing_qualifying_approval');
    expect(artifact.requesterReviewPolicy.summary).toContain('Requester alice must provide');
    expect(artifact.execution.liveGitHubExercised).toBe(false);
  });

  it('writes json, txt, and manifest artifacts for rerunnable evidence generation', async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), 'task-8-evidence-'));
    tempDirs.push(evidenceDir);

    const manifest = await writeTask8EvidenceArtifacts({ evidenceDir, scenario: 'all' });

    expect(manifest.scenarios).toHaveLength(2);
    expect(existsSync(task8EvidenceJsonArtifactPath('success', evidenceDir))).toBe(true);
    expect(existsSync(task8EvidenceTextArtifactPath('success', evidenceDir))).toBe(true);
    expect(existsSync(task8EvidenceJsonArtifactPath('policy-failure', evidenceDir))).toBe(true);
    expect(existsSync(task8EvidenceTextArtifactPath('policy-failure', evidenceDir))).toBe(true);

    const successArtifact = JSON.parse(
      readFileSync(task8EvidenceJsonArtifactPath('success', evidenceDir), 'utf8'),
    ) as { scenario: string; requesterReviewPolicy: { ok: boolean } };
    expect(successArtifact).toMatchObject({
      scenario: 'success',
      requesterReviewPolicy: {
        ok: true,
      },
    });

    const failureSummary = readFileSync(task8EvidenceTextArtifactPath('policy-failure', evidenceDir), 'utf8');
    expect(failureSummary).toContain('scenario=policy-failure');
    expect(failureSummary).toContain('policy_ok=false');
  });
});
