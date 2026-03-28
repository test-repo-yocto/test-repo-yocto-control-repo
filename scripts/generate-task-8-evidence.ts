import { writeTask8EvidenceArtifacts, type Task8EvidenceScenarioName } from '../src/verification/task-8-evidence.js';

async function main(): Promise<void> {
  const scenario = readScenario(process.argv.slice(2));
  const manifest = await writeTask8EvidenceArtifacts({ scenario });
  console.log(JSON.stringify(manifest, null, 2));
}

function readScenario(args: string[]): Task8EvidenceScenarioName | 'all' {
  const scenarioFlagIndex = args.findIndex((value) => value === '--scenario');

  if (scenarioFlagIndex === -1) {
    return 'all';
  }

  const candidate = args[scenarioFlagIndex + 1];

  if (candidate === 'success' || candidate === 'policy-failure' || candidate === 'all') {
    return candidate;
  }

  throw new Error('Expected --scenario success|policy-failure|all');
}

void main();
