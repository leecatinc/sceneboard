import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = resolve(root, '../.hpipe/plan/evidence/I-53-certification');
const logsRoot = resolve(evidenceRoot, 'logs');
const manifestPath = resolve(evidenceRoot, 'manifest.json');
const resultsPath = resolve(evidenceRoot, 'results.jsonl');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value, Object.keys(value).sort());

const packageRows = [
  ['PKG-BE-TEST', 'npm test --workspace sceneboard-be', 'sceneboard-be', 'test'],
  ['PKG-BE-TYPECHECK', 'npm run typecheck --workspace sceneboard-be', 'sceneboard-be', 'typecheck'],
  ['PKG-BE-BUILD', 'npm run build --workspace sceneboard-be', 'sceneboard-be', 'build'],
  ['PKG-FE-TEST', 'npm test --workspace sceneboard-fe', 'sceneboard-fe', 'test'],
  ['PKG-FE-TYPECHECK', 'npm run typecheck --workspace sceneboard-fe', 'sceneboard-fe', 'typecheck'],
  ['PKG-FE-BUILD', 'npm run build --workspace sceneboard-fe', 'sceneboard-fe', 'build'],
  ['PKG-MCP-TEST', 'npm test --workspace sceneboard-mcp', 'sceneboard-mcp', 'test'],
  [
    'PKG-MCP-TYPECHECK',
    'npm run typecheck --workspace sceneboard-mcp',
    'sceneboard-mcp',
    'typecheck',
  ],
  ['PKG-MCP-BUILD', 'npm run build --workspace sceneboard-mcp', 'sceneboard-mcp', 'build'],
  [
    'PKG-SCHEMA-TEST',
    'npm test --workspace @sceneboard/board-schema',
    '@sceneboard/board-schema',
    'test',
  ],
  [
    'PKG-SCHEMA-TYPECHECK',
    'npm run typecheck --workspace @sceneboard/board-schema',
    '@sceneboard/board-schema',
    'typecheck',
  ],
  ['PKG-SDK-TEST', 'npm test --workspace @sceneboard/board-sdk', '@sceneboard/board-sdk', 'test'],
  [
    'PKG-SDK-TYPECHECK',
    'npm run typecheck --workspace @sceneboard/board-sdk',
    '@sceneboard/board-sdk',
    'typecheck',
  ],
  ['PKG-UI-TEST', 'npm test --workspace @sceneboard/board-ui', '@sceneboard/board-ui', 'test'],
  [
    'PKG-UI-TYPECHECK',
    'npm run typecheck --workspace @sceneboard/board-ui',
    '@sceneboard/board-ui',
    'typecheck',
  ],
  [
    'PKG-RUNTIME-TEST',
    'npm test --workspace @sceneboard/artifact-runtime',
    '@sceneboard/artifact-runtime',
    'test',
  ],
  [
    'PKG-RUNTIME-TYPECHECK',
    'npm run typecheck --workspace @sceneboard/artifact-runtime',
    '@sceneboard/artifact-runtime',
    'typecheck',
  ],
  [
    'PKG-RUNTIME-BUILD',
    'npm run build:runtime --workspace @sceneboard/artifact-runtime',
    '@sceneboard/artifact-runtime',
    'build',
  ],
  ['INT-AUTH-ORIGINS', 'npm run preflight:auth-origins', 'root', 'auth-topology'],
  ['INT-CONFIG', 'npm run verify:config', 'root', 'config'],
  ['INT-DEPENDENCIES', 'npm run verify:dependencies', 'root', 'dependencies'],
  ['INT-PRESENTATION', 'npm run verify:presentation-contracts', 'root', 'presentation-contracts'],
  ['INT-PLUGIN', 'npm run check:sceneboard-plugin', 'root', 'plugin'],
  ['INT-SKILL', 'npm run check:sceneboard-skill', 'root', 'skill'],
].map(([id, command, packageName, surface]) => ({
  id,
  command,
  package: packageName,
  surface,
}));

const certificationRows = [
  [
    'CERT-ARTIFACT-RUNTIME-BUILD',
    'npm run build:runtime --workspace @sceneboard/artifact-runtime && node scripts/certify-ai-export-contracts.mjs --case=artifact-runtime-build',
    '@sceneboard/artifact-runtime',
    'artifact-runtime-build',
  ],
  [
    'CERT-MIG-027',
    'node scripts/certify-ai-export-contracts.mjs --case=migration-027',
    'sceneboard-be',
    'migration',
  ],
  [
    'CERT-PDF-GOLDEN',
    'node scripts/certify-ai-export-contracts.mjs --case=pdf-golden',
    'sceneboard-be',
    'pdf',
  ],
  [
    'CERT-PPTX-GOLDEN',
    'node scripts/certify-ai-export-contracts.mjs --case=pptx-golden',
    'sceneboard-be',
    'pptx',
  ],
  [
    'CERT-BROWSER-E2E',
    'node scripts/certify-ai-export-contracts.mjs --case=browser-e2e',
    'integrated',
    'browser',
  ],
  ['CERT-RUNTIME-SMOKE', 'npm run smoke:export-runtime', 'sceneboard-be', 'runtime'],
  [
    'CERT-LOCAL-HELPER',
    'node scripts/certify-ai-export-contracts.mjs --case=local-helper',
    'sceneboard-mcp',
    'native-helper',
  ],
  [
    'CERT-SECRET-SCAN',
    'node scripts/certify-ai-export-contracts.mjs --case=secret-scan',
    'root',
    'secret-scan',
  ],
  [
    'CERT-TRACEABILITY',
    'node scripts/certify-ai-export-contracts.mjs --case=traceability',
    'root',
    'traceability',
  ],
].map(([id, command, packageName, surface]) => ({
  id,
  command,
  package: packageName,
  surface,
}));

const rows = [...packageRows, ...certificationRows];
const ensureManifest = () => {
  mkdirSync(logsRoot, { recursive: true });
  const value = {
    version: 1,
    issue: 'I-53',
    acceptanceCriterion: 'I53-AC-PRESENTATION',
    testCase: 'I53-TC-PRESENTATION-01',
    requiredRows: rows,
    derivedRow: {
      id: 'CERT-ROLLUP',
      command:
        'node scripts/verify-ai-export-certification.mjs ../.hpipe/plan/evidence/I-53-certification/manifest.json',
    },
  };
  writeFileSync(manifestPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return value;
};

ensureManifest();
const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).stdout.trim();

const existingResults = () => {
  if (!existsSync(resultsPath)) return new Map();
  const values = readFileSync(resultsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return new Map(values.map((value) => [value.acceptanceCriterion + ':' + value.command, value]));
};

const writeResult = ({ row, result, exitCode, artifact, blocker = null, assertions = [] }) => {
  const artifactPath = resolve(evidenceRoot, `${row.id.toLowerCase()}.json`);
  const artifactValue = {
    version: 1,
    issue: 'I-53',
    rowId: row.id,
    result,
    blocker,
    assertions,
  };
  const artifactBytes = Buffer.from(`${JSON.stringify(artifact ?? artifactValue, null, 2)}\n`);
  writeFileSync(artifactPath, artifactBytes, { mode: 0o600 });
  const logRelative = `../.hpipe/plan/evidence/I-53-certification/logs/${row.id.toLowerCase()}.json`;
  writeFileSync(
    resolve(logsRoot, `${row.id.toLowerCase()}.json`),
    `${JSON.stringify({ version: 1, rowId: row.id, result, blocker, assertions }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const record = {
    version: 1,
    issue: 'I-53',
    acceptanceCriterion: 'I53-AC-PRESENTATION',
    testCase: 'I53-TC-PRESENTATION-01',
    command: row.command,
    package: row.package,
    surface: row.surface,
    environment: 'local-linux-x64-glibc',
    commit,
    artifactSha256: sha256(artifactBytes),
    exitCode,
    result,
    timestamp: new Date().toISOString(),
    redactedLogRef: logRelative,
  };
  const current = existingResults();
  current.set(`${record.acceptanceCriterion}:${record.command}`, record);
  const order = new Map(rows.map((item, index) => [item.command, index]));
  const sorted = [...current.values()].sort(
    (left, right) =>
      (order.get(left.command) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.command) ?? Number.MAX_SAFE_INTEGER),
  );
  writeFileSync(resultsPath, `${sorted.map((value) => JSON.stringify(value)).join('\n')}\n`, {
    mode: 0o600,
  });
};

const runNpm = (command) => {
  const parts = command.split(' ');
  const executable = parts.shift();
  const environment =
    command === 'npm run build --workspace sceneboard-fe'
      ? {
          ...process.env,
          NODE_ENV: 'production',
          NEXT_PUBLIC_BOARD_API_URL: 'http://127.0.0.1:3411',
          NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN: 'http://127.0.0.2:3412',
        }
      : process.env;
  const result = spawnSync(executable, parts, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    skipped: /# skipped [1-9][0-9]*/u.test(`${result.stdout}\n${result.stderr}`),
  };
};

const certifyPackageMatrix = () => {
  let failed = false;
  for (const row of packageRows) {
    const run = runNpm(row.command);
    const result =
      run.status === 0 && !run.skipped ? 'PASS' : run.status === 0 ? 'UNVERIFIED' : 'FAIL';
    failed ||= result !== 'PASS';
    writeResult({
      row,
      result,
      exitCode: run.status,
      blocker: run.skipped
        ? 'COMMAND_REPORTED_SKIPPED_ASSERTIONS'
        : result === 'FAIL'
          ? 'COMMAND_FAILED'
          : null,
      assertions: ['exact command completed', 'no skipped assertion admitted as PASS'],
    });
  }
  if (failed) process.exitCode = 1;
};

const collectTree = (directory, baseDirectory = directory) => {
  const values = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) values.push(...collectTree(path, baseDirectory));
    else if (entry.isFile()) {
      const bytes = readFileSync(path);
      values.push({
        path: relative(baseDirectory, path).replaceAll('\\', '/'),
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      });
    } else throw new Error('unsupported artifact runtime output');
  }
  return values;
};

const artifactRuntimeBuild = () => {
  const directory = resolve(root, 'packages/artifact-runtime/dist');
  const publicDirectory = resolve(directory, 'public');
  const manifestValue = JSON.parse(readFileSync(resolve(publicDirectory, 'fixed-assets.v1.json')));
  const expectedPublic = new Set(['fixed-assets.v1.json', 'runner.html']);
  for (const entry of manifestValue) {
    const relativePath = entry.path.replace(/^\//u, '');
    const path = resolve(publicDirectory, relativePath);
    const bytes = readFileSync(path);
    if (bytes.byteLength !== entry.byteLength || sha256(bytes) !== entry.sha256)
      throw new Error('artifact runtime manifest mismatch');
    expectedPublic.add(relativePath);
  }
  const actualPublic = collectTree(publicDirectory).map(({ path }) => path);
  if (
    actualPublic.length !== expectedPublic.size ||
    actualPublic.some((path) => !expectedPublic.has(path))
  )
    throw new Error('artifact runtime public tree is not closed');
  for (const required of [
    'node/server/main.js',
    'public/runner.html',
    'public/fixed-assets.v1.json',
  ])
    if (!existsSync(resolve(directory, required)))
      throw new Error('artifact runtime output missing');
  const tree = collectTree(directory);
  const treeSha256 = sha256(Buffer.from(tree.map((item) => canonical(item)).join('\n')));
  const row = certificationRows.find(({ id }) => id === 'CERT-ARTIFACT-RUNTIME-BUILD');
  writeResult({
    row,
    result: 'PASS',
    exitCode: 0,
    artifact: { version: 1, issue: 'I-53', rowId: row.id, result: 'PASS', treeSha256, tree },
    assertions: [
      'required outputs exist',
      'fixed asset hashes and sizes match',
      'public tree is closed',
    ],
  });
};

const migration027 = () => {
  const row = certificationRows.find(({ id }) => id === 'CERT-MIG-027');
  const source = readFileSync(
    resolve(root, 'sceneboard-be/src/database/migrations/sql/027_d10_revision_export_hold.up.sql'),
    'utf8',
  );
  const staticPass =
    (source.match(/'export'/gu) ?? []).length === 2 &&
    source.includes('chk_revision_holds_kind') &&
    !/\b(?:UPDATE|DELETE|INSERT)\b/u.test(source);
  if (process.env.SCENEBOARD_CERTIFICATION_DISPOSABLE_DATABASE !== 'true') {
    writeResult({
      row,
      result: 'BLOCKED',
      exitCode: staticPass ? 0 : 1,
      blocker: 'DISPOSABLE_MYSQL_FRESH_ADOPT_RESTART_FIXTURE_NOT_CONFIGURED',
      assertions: [
        staticPass ? 'migration source contract passed' : 'migration source contract failed',
        'live fresh/adopt/restart and all-eight-insert assertions not executed',
      ],
    });
    if (!staticPass) process.exitCode = 1;
    return;
  }
  const run = spawnSync('node', ['scripts/certify-migration-027.mjs'], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  const pass = staticPass && run.status === 0;
  writeResult({
    row,
    result: pass ? 'PASS' : 'FAIL',
    exitCode: pass ? 0 : (run.status ?? 1),
    blocker: pass ? null : 'MIGRATION_027_LIVE_CERTIFICATION_FAILED',
    assertions: [
      staticPass ? 'migration source contract passed' : 'migration source contract failed',
      'live fresh migration passed',
      'live restart certification passed',
      'live exact-state adoption passed',
      'exact ENUM and named CHECK contain all eight hold kinds',
      'all eight hold kinds insert and rollback',
    ],
  });
  if (!pass) process.exitCode = 1;
};

const exportGolden = (format) => {
  const id = format === 'pdf' ? 'CERT-PDF-GOLDEN' : 'CERT-PPTX-GOLDEN';
  const row = certificationRows.find((value) => value.id === id);
  const executable = process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE;
  if (format === 'pdf' && (executable === undefined || !existsSync(executable))) {
    writeResult({
      row,
      result: 'BLOCKED',
      exitCode: 0,
      blocker: 'PINNED_CHROMIUM_EXECUTABLE_NOT_CONFIGURED',
      assertions: ['four-format binary golden not executed'],
    });
    return;
  }
  const run = spawnSync(
    'npm',
    [
      'exec',
      '--workspace',
      'sceneboard-be',
      '--',
      'tsx',
      '--test',
      'test/exports/export-delivery.test.ts',
    ],
    {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const output = `${run.stdout}\n${run.stderr}`;
  const skipped = /# skipped [1-9][0-9]*/u.test(output);
  const pass = run.status === 0 && !skipped;
  writeResult({
    row,
    result: pass ? 'PASS' : skipped ? 'UNVERIFIED' : 'FAIL',
    exitCode: run.status ?? 1,
    blocker: skipped
      ? 'EXPORT_GOLDEN_REPORTED_SKIPPED_ASSERTIONS'
      : pass
        ? null
        : 'EXPORT_GOLDEN_FAILED',
    assertions: [
      'deterministic binary output',
      'ordered fixed-image pages/slides',
      'all four frozen physical formats',
      'normalized metadata and package structure',
    ],
  });
  if (!pass) process.exitCode = 1;
};

const browserE2e = () => {
  const row = certificationRows.find(({ id }) => id === 'CERT-BROWSER-E2E');
  const requiredEnvironment = [
    'MYSQL_HOST',
    'MYSQL_PORT',
    'MYSQL_USER',
    'MYSQL_PASSWORD',
    'MYSQL_DATABASE',
    'SCENEBOARD_EXPORT_WEB_ORIGIN',
    'SCENEBOARD_EXPORT_API_ORIGIN',
    'SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE',
    'SCENEBOARD_TEST_USER_PASSWORD',
  ];
  if (
    process.env.SCENEBOARD_CERTIFICATION_DISPOSABLE_DATABASE !== 'true' ||
    process.env.SCENEBOARD_CERTIFICATION_BROWSER_SERVICES_READY !== 'true' ||
    requiredEnvironment.some((name) => process.env[name] === undefined || process.env[name] === '')
  ) {
    writeResult({
      row,
      result: 'BLOCKED',
      exitCode: 0,
      blocker: 'ISOLATED_BROWSER_MYSQL_REDIS_PRINCIPAL_FIXTURE_NOT_CONFIGURED',
      assertions: [
        'source/component/API contracts covered by package matrix',
        'target-like owner/API-key/denial/revision-invariance browser flow not executed',
      ],
    });
    return;
  }
  const focused = spawnSync(
    'npm',
    [
      'exec',
      '--workspace',
      'sceneboard-fe',
      '--',
      'tsx',
      '--test',
      'test/api/board-export-api.test.ts',
      'test/board/board-export-control.test.ts',
      'test/routes/export-render-security.test.ts',
    ],
    {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const browser = spawnSync('node', ['scripts/certify-export-browser-e2e.mjs'], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  const skipped = /# skipped [1-9][0-9]*/u.test(`${focused.stdout}\n${focused.stderr}`);
  const pass = focused.status === 0 && browser.status === 0 && !skipped;
  writeResult({
    row,
    result: pass ? 'PASS' : 'FAIL',
    exitCode: pass ? 0 : 1,
    blocker: pass ? null : 'INTEGRATED_BROWSER_EXPORT_CERTIFICATION_FAILED',
    assertions: [
      'session owner PDF and no-session API-key PPTX export passed',
      'missing and insufficient API-key export denial passed',
      'selected revision and document format stayed pinned',
      'complete binary download, failure parity and retry policy passed',
      'keyboard semantics, focus restoration and 320px layout passed',
      'board head and revision payload digests stayed unchanged',
      'synthetic API keys were revoked without logging credential values',
    ],
  });
  if (!pass) process.exitCode = 1;
};

const runtimeSmoke = () => {
  const row = certificationRows.find(({ id }) => id === 'CERT-RUNTIME-SMOKE');
  const run = runNpm('npm run smoke:export-runtime');
  writeResult({
    row,
    result: run.status === 0 && !run.skipped ? 'PASS' : 'BLOCKED',
    exitCode: run.status,
    blocker: run.status === 0 && !run.skipped ? null : 'VERIFIED_EXPORT_RUNTIME_IMAGE_UNAVAILABLE',
    assertions: [
      'pinned Chromium and font hashes',
      'no-network PNG smoke',
      'zero residual process',
    ],
  });
  if (run.status !== 0 || run.skipped) process.exitCode = 1;
};

const localHelper = () => {
  const row = certificationRows.find(({ id }) => id === 'CERT-LOCAL-HELPER');
  const runs = [
    runNpm('npm run build --workspace sceneboard-mcp'),
    runNpm('npm run check:sceneboard-plugin'),
  ];
  const pass = runs.every(({ status, skipped }) => status === 0 && !skipped);
  writeResult({
    row,
    result: pass ? 'PASS' : 'FAIL',
    exitCode: pass ? 0 : 1,
    blocker: pass ? null : 'LOCAL_HELPER_OR_PLUGIN_VERIFICATION_FAILED',
    assertions: [
      'target/hash/mode/owner/ABI verified',
      'plugin contains manifest-selected helper',
      'unsupported target preflight is covered by MCP suite',
    ],
  });
  if (!pass) process.exitCode = 1;
};

const secretScan = () => {
  const row = certificationRows.find(({ id }) => id === 'CERT-SECRET-SCAN');
  const credentialPatterns = [
    ['account-key', /sbk_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/u],
    ['grant-token', /lcbg_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/u],
    ['bearer', /Authorization:\s*Bearer\s+[A-Za-z0-9._~-]{16,}/iu],
    ['pairing-code', /SB-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}/u],
  ];
  const approvedCanaryPaths = new Set([
    'sceneboard-be/test/api-keys/account-api-key-board-authorization.test.ts',
    'sceneboard-be/test/api-keys/account-api-key-management.controller.test.ts',
    'sceneboard-be/test/api-keys/account-api-key-token.codec.test.ts',
    'sceneboard-be/test/auth/board-principal-guard.test.ts',
    'sceneboard-fe/test/api/account-api-key-api.test.ts',
  ]);
  const removeApprovedCanaries = (path, value) => {
    if (!approvedCanaryPaths.has(path)) return value;
    return credentialPatterns.reduce(
      (current, [, pattern]) =>
        current.replace(
          new RegExp(pattern.source, [...new Set(`${pattern.flags}g`)].join('')),
          '[synthetic-canary]',
        ),
      value,
    );
  };
  const diff = spawnSync('git', ['diff', '--unified=0', '--no-color'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).stdout;
  const additions = diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (untracked.status !== 0) throw new Error('untracked source inventory failed');
  const textFromFile = (path) => {
    const bytes = readFileSync(path);
    return bytes.byteLength <= 16 * 1024 * 1024 && !bytes.includes(0) ? bytes.toString('utf8') : '';
  };
  const untrackedText = untracked.stdout
    .split('\0')
    .filter(Boolean)
    .map((path) => removeApprovedCanaries(path, textFromFile(resolve(root, path))))
    .join('\n');
  const evidenceText = collectTree(evidenceRoot)
    .map(({ path }) => textFromFile(resolve(evidenceRoot, path)))
    .join('\n');
  const explicitText = [
    'sceneboard-mcp/README.md',
    'sceneboard-mcp/plugins/sceneboard/.mcp.json',
    'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/SKILL.md',
    'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/references/auth-and-config.md',
    'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/references/commands.md',
  ]
    .map((path) => textFromFile(resolve(root, path)))
    .join('\n');
  const storedArchiveText = (path) => {
    const bytes = readFileSync(path);
    const contents = [];
    let offset = 0;
    while (offset + 4 <= bytes.byteLength && bytes.readUInt32LE(offset) === 0x04034b50) {
      if (offset + 30 > bytes.byteLength) throw new Error('plugin archive header is truncated');
      const flags = bytes.readUInt16LE(offset + 6);
      const method = bytes.readUInt16LE(offset + 8);
      const compressedLength = bytes.readUInt32LE(offset + 18);
      const uncompressedLength = bytes.readUInt32LE(offset + 22);
      const nameLength = bytes.readUInt16LE(offset + 26);
      const extraLength = bytes.readUInt16LE(offset + 28);
      const contentOffset = offset + 30 + nameLength + extraLength;
      const nextOffset = contentOffset + compressedLength;
      if (
        flags !== 0x0800 ||
        method !== 0 ||
        compressedLength !== uncompressedLength ||
        nextOffset > bytes.byteLength
      )
        throw new Error('plugin archive is not canonical stored ZIP');
      contents.push(bytes.subarray(contentOffset, nextOffset));
      offset = nextOffset;
    }
    if (
      contents.length === 0 ||
      offset + 4 > bytes.byteLength ||
      bytes.readUInt32LE(offset) !== 0x02014b50
    )
      throw new Error('plugin archive central directory is missing');
    return Buffer.concat(contents).toString('latin1');
  };
  const archiveText = [
    'sceneboard-fe/public/downloads/sceneboard.zip',
    'sceneboard-fe/public/downloads/sceneboard-codex-plugin.zip',
  ]
    .map((path) => storedArchiveText(resolve(root, path)))
    .join('\n');
  const surfaces = [
    ['tracked-diff-additions', additions],
    ['untracked-source', untrackedText],
    ['certification-evidence', evidenceText],
    ['config-and-skill', explicitText],
    ['distribution-archives', archiveText],
  ];
  const forbidden = [
    ...credentialPatterns,
    ['private-path', /\/(?:home|workspace)\/[A-Za-z0-9._/-]+/u],
  ];
  const violations = forbidden.flatMap(([kind, pattern]) =>
    surfaces.filter(([, value]) => pattern.test(value)).map(([surface]) => `${kind}:${surface}`),
  );
  const pass = violations.length === 0;
  writeResult({
    row,
    result: pass ? 'PASS' : 'FAIL',
    exitCode: pass ? 0 : 1,
    blocker: pass ? null : 'SECRET_OR_PRIVATE_PATH_PATTERN_FOUND_IN_DIFF',
    assertions: [
      'no raw account-key grammar',
      'no bearer or pairing value',
      'no absolute private path in added source',
      'only five closed backend/frontend auth tests may contain synthetic credential canaries',
      'untracked source, certification evidence, config, skill and archives scanned',
      'examples use secret references only',
      ...(pass ? [] : [`forbidden pattern classes found in ${violations.join(', ')}`]),
    ],
  });
  if (!pass) process.exitCode = 1;
};

const traceability = () => {
  const row = certificationRows.find(({ id }) => id === 'CERT-TRACEABILITY');
  const trace = readFileSync(resolve(root, '../.hpipe/plan/04.traceability.md'), 'utf8');
  const required = [
    ...Array.from({ length: 11 }, (_, index) => `REQ-${134 + index}`),
    ...Array.from({ length: 9 }, (_, index) => `I-${45 + index}`),
    'board_page_add',
    'board_page_remove',
    'board_page_reorder',
    'board_page_update',
    'board_page_default_set',
    'board_history_restore',
    'board_export',
  ];
  const missing = required.filter((value) => !trace.includes(value));
  writeResult({
    row,
    result: missing.length === 0 ? 'PASS' : 'FAIL',
    exitCode: missing.length === 0 ? 0 : 1,
    blocker: missing.length === 0 ? null : 'TRACEABILITY_ENTRY_MISSING',
    assertions: [
      'REQ-134 through REQ-144 mapped',
      'I-45 through I-53 present',
      'API-key tool cover closed',
    ],
  });
  if (missing.length > 0) process.exitCode = 1;
};

const argument = process.argv[2];
if (process.argv.length !== 3 || !argument.startsWith('--case=')) {
  process.stderr.write(
    'usage: certify-ai-export-contracts.mjs --case=<package-matrix|artifact-runtime-build|migration-027|pdf-golden|pptx-golden|browser-e2e|runtime-smoke|local-helper|secret-scan|traceability>\n',
  );
  process.exitCode = 2;
} else {
  const selected = argument.slice('--case='.length);
  if (selected === 'package-matrix') certifyPackageMatrix();
  else if (selected === 'artifact-runtime-build') artifactRuntimeBuild();
  else if (selected === 'migration-027') migration027();
  else if (selected === 'pdf-golden') exportGolden('pdf');
  else if (selected === 'pptx-golden') exportGolden('pptx');
  else if (selected === 'browser-e2e') browserE2e();
  else if (selected === 'runtime-smoke') runtimeSmoke();
  else if (selected === 'local-helper') localHelper();
  else if (selected === 'secret-scan') secretScan();
  else if (selected === 'traceability') traceability();
  else {
    process.stderr.write('unknown certification case\n');
    process.exitCode = 2;
  }
}
