import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argument = process.argv[2];
if (process.argv.length !== 3 || argument === undefined) {
  process.stderr.write('usage: verify-ai-export-certification.mjs <manifest.json>\n');
  process.exit(2);
}

const manifestPath = resolve(root, argument);
const evidenceRoot = dirname(manifestPath);
const resultsPath = resolve(evidenceRoot, 'results.jsonl');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const resultLines = readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean);
const results = resultLines.map((line) => JSON.parse(line));
const exactKeys = (value, keys) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const rowKeys = [
  'version',
  'issue',
  'acceptanceCriterion',
  'testCase',
  'command',
  'package',
  'surface',
  'environment',
  'commit',
  'artifactSha256',
  'exitCode',
  'result',
  'timestamp',
  'redactedLogRef',
];
const requiredCommands = new Set(manifest.requiredRows.map(({ command }) => command));
const inputs = results.filter(({ command }) => requiredCommands.has(command));
if (
  inputs.length !== requiredCommands.size ||
  new Set(inputs.map(({ command }) => command)).size !== inputs.length
)
  throw new Error('required certification input set is missing or duplicated');

const blockers = [];
for (const row of inputs) {
  if (!exactKeys(row, rowKeys)) throw new Error('certification row is not closed');
  if (
    row.version !== 1 ||
    row.issue !== 'I-53' ||
    row.acceptanceCriterion !== manifest.acceptanceCriterion ||
    row.testCase !== manifest.testCase ||
    !['PASS', 'FAIL', 'BLOCKED', 'UNVERIFIED'].includes(row.result) ||
    !Number.isInteger(row.exitCode) ||
    !/^[0-9a-f]{64}$/u.test(row.artifactSha256) ||
    !/^[0-9a-f]{40}$/u.test(row.commit)
  )
    throw new Error('certification row value is invalid');
  const definition = manifest.requiredRows.find(({ command }) => command === row.command);
  if (
    definition === undefined ||
    row.package !== definition.package ||
    row.surface !== definition.surface
  )
    throw new Error('certification row does not match its manifest definition');
  const artifactPath = resolve(evidenceRoot, `${definition.id.toLowerCase()}.json`);
  if (!existsSync(artifactPath)) throw new Error('certification artifact is missing');
  const artifactBytes = readFileSync(artifactPath);
  if (createHash('sha256').update(artifactBytes).digest('hex') !== row.artifactSha256)
    throw new Error('certification artifact hash differs');
  const logPath = resolve(root, row.redactedLogRef);
  if (!existsSync(logPath) || !logPath.startsWith(evidenceRoot))
    throw new Error('certification redacted log reference is invalid');
  if (row.result === 'PASS' && row.exitCode !== 0)
    throw new Error('PASS certification row has a nonzero exit code');
  if (row.result !== 'PASS') blockers.push(definition.id);
}

const result =
  blockers.length === 0
    ? 'PASS'
    : inputs.some(({ result: value }) => value === 'FAIL')
      ? 'FAIL'
      : 'BLOCKED';
const rollup = {
  version: 1,
  issue: 'I-53',
  rowId: manifest.derivedRow.id,
  result,
  blockers,
  requiredInputCount: manifest.requiredRows.length,
  verifiedInputCount: inputs.length,
};
const rollupBytes = Buffer.from(`${JSON.stringify(rollup, null, 2)}\n`);
const rollupPath = resolve(evidenceRoot, 'rollup.json');
writeFileSync(rollupPath, rollupBytes, { mode: 0o600 });
const existingDerived = results.filter(({ command }) => command !== manifest.derivedRow.command);
const record = {
  version: 1,
  issue: 'I-53',
  acceptanceCriterion: manifest.acceptanceCriterion,
  testCase: manifest.testCase,
  command: manifest.derivedRow.command,
  package: 'root',
  surface: 'rollup',
  environment: 'local-linux-x64-glibc',
  commit: inputs[0].commit,
  artifactSha256: createHash('sha256').update(rollupBytes).digest('hex'),
  exitCode: result === 'PASS' ? 0 : 1,
  result,
  timestamp: new Date().toISOString(),
  redactedLogRef: '../.hpipe/plan/evidence/I-53-certification/rollup.json',
};
writeFileSync(
  resultsPath,
  `${[...existingDerived, record].map((value) => JSON.stringify(value)).join('\n')}\n`,
  { mode: 0o600 },
);
process.stdout.write(`${JSON.stringify(rollup)}\n`);
if (result !== 'PASS') process.exitCode = 1;
