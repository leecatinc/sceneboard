import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const assets = [
  'packages/board-schema/src/history.ts',
  'packages/board-schema/src/parsers.ts',
  'packages/board-schema/test/fixtures/valid/history-retained-metadata.v1.json',
  'packages/board-schema/test/fixtures/invalid/history-retained-metadata.v1.json',
  'packages/board-sdk/src/http/http-result.parser.ts',
  'packages/board-sdk/src/client/history-metadata.ts',
  'sceneboard-fe/lib/api/board-api-types.ts',
  'sceneboard-mcp/src/tools/history.tools.ts',
];
const commands = [
  'npm test --workspace=@sceneboard/board-schema',
  'npm test --workspace=@sceneboard/board-sdk',
  'npm test --workspace=sceneboard-fe',
  'npm test --workspace=sceneboard-mcp',
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digestAssets = async () =>
  Object.fromEntries(
    await Promise.all(assets.map(async (asset) => [asset, sha256(await readFile(asset))])),
  );
const artifact = async () => ({
  version: 1,
  type: 'history-retained-compatibility',
  assets: await digestAssets(),
  compatibility: {
    oldEmissionOldClient: 'pass',
    oldEmissionDualClient: 'pass',
    newEmissionDualClient: 'pass',
    newEmissionOldClient: 'reject',
  },
  requiredTestCommands: commands,
  minimumDeployedParserDigests: {
    sdk: sha256(await readFile('packages/board-sdk/src/http/http-result.parser.ts')),
    frontend: sha256(await readFile('sceneboard-fe/lib/api/board-api-types.ts')),
    mcp: sha256(await readFile('sceneboard-mcp/src/tools/history.tools.ts')),
  },
});

const expected = `${JSON.stringify(await artifact(), null, 2)}\n`;
if (process.argv.includes('--print')) {
  process.stdout.write(expected);
  process.exit(0);
}
const target = 'test/certification/history-retained-compatibility.v1.json';
const actual = await readFile(target, 'utf8').catch(() => '');
if (actual !== expected) {
  process.stderr.write(
    `${target} is stale; run this script with --print and update the artifact\n`,
  );
  process.exit(1);
}
process.stdout.write('history retained compatibility certificate is current\n');
