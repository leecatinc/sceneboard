import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { build } from 'esbuild';

import {
  PRODUCTION_API_URL,
  resolveSceneBoardServer,
} from '../../plugins/sceneboard/scripts/sceneboard-mcp-config.mjs';
import * as pluginConfigModule from '../../plugins/sceneboard/scripts/sceneboard-mcp-config.mjs';
import { parseBoardConfigV1 } from '../../src/config/board-config.js';

const { configResolutionFailureCodeV1, readProjectRootServer, sceneBoardLaunchFailureLineV1 } =
  pluginConfigModule as unknown as {
    configResolutionFailureCodeV1(failure: unknown): string;
    readProjectRootServer(options: {
      projectRoot: string;
      pluginRoot?: string;
      environment?: NodeJS.ProcessEnv;
      read?: (path: string, encoding: string) => Promise<string>;
      stat?: (path: string) => Promise<Awaited<ReturnType<typeof lstat>>>;
    }): Promise<unknown>;
    sceneBoardLaunchFailureLineV1(code: string): string;
  };

const pluginRoot = resolve(import.meta.dirname, '../../plugins/sceneboard');
const repositoryRoot = resolve(import.meta.dirname, '../../..');
const launcherPath = join(pluginRoot, 'scripts/launch-sceneboard-mcp.mjs');
const configResolverPath = join(pluginRoot, 'scripts/sceneboard-mcp-config.mjs');
const pluginPublisherPath = join(repositoryRoot, 'scripts/build-sceneboard-plugin.mjs');
const testApiKey = `sbk_v1.${'L'.repeat(22)}.${'M'.repeat(43)}`;
const testLegacyToken = `lcbg_v1.${'N'.repeat(22)}.${'P'.repeat(43)}`;
const codexAbsentMessage = "Error: No MCP server named 'sceneboard' found.\n";
const codexAbsentResult = {
  status: 1,
  signal: null,
  stdout: '',
  stderr: codexAbsentMessage,
};
const codexAbsentFixture = `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(
  codexAbsentMessage,
)});\nprocess.exitCode = 1;\n`;

type LauncherResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

const runLauncher = ({
  cwd,
  environment,
  launcher,
}: {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  launcher: string;
}): Promise<LauncherResult> =>
  new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [launcher], {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('plugin launcher test timed out'));
    }, 5_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ code, signal, stdout, stderr });
    });
  });

const writeEnvironmentObserver = async (path: string) => {
  await writeFile(
    path,
    `const env = process.env;
process.stdout.write(JSON.stringify({
  explicit: env.PLUGIN_TEST_FORWARD ?? null,
  undeclaredAmbientPresent: Object.hasOwn(env, 'UNDECLARED_AMBIENT'),
  exactApiKeyPresent: Object.hasOwn(env, 'SCENEBOARD_API_KEY'),
  exactApiKeyMatches: env.SCENEBOARD_API_KEY === ${JSON.stringify(testApiKey)},
  legacyAccessTokenPresent: Object.hasOwn(env, 'SCENEBOARD_ACCESS_TOKEN'),
  legacyAccessTokenMatches: env.SCENEBOARD_ACCESS_TOKEN === ${JSON.stringify(testLegacyToken)},
  caseVariantApiKeyPresent: Object.hasOwn(env, 'SceneBoard_Api_Key'),
  aliasedApiKeyPresent: Object.hasOwn(env, 'API_KEY_BACKUP'),
  safeAliasApiKeyPresent: Object.hasOwn(env, 'LANG'),
  credentialMode: env.BOARD_CREDENTIAL_MODE ?? null,
  accessTokenRef: env.BOARD_ACCESS_TOKEN_REF ?? null,
  configDepth: env.SCENEBOARD_CONFIG_DEPTH ?? null,
}));
`,
  );
};

const createLauncherFixture = async (root: string) => {
  const fixturePluginRoot = join(root, 'plugin');
  const scriptsRoot = join(fixturePluginRoot, 'scripts');
  const runtimeRoot = join(fixturePluginRoot, 'runtime');
  const nativeRoot = join(fixturePluginRoot, 'native');
  const exportNativeRoot = join(nativeRoot, 'linux-x64-gnu');
  await Promise.all([
    mkdir(scriptsRoot, { recursive: true }),
    mkdir(runtimeRoot, { recursive: true }),
    mkdir(exportNativeRoot, { recursive: true }),
  ]);
  await Promise.all([
    copyFile(launcherPath, join(scriptsRoot, 'launch-sceneboard-mcp.mjs')),
    copyFile(configResolverPath, join(scriptsRoot, 'sceneboard-mcp-config.mjs')),
    writeEnvironmentObserver(join(runtimeRoot, 'index.js')),
    writeFile(join(nativeRoot, 'profile-lease-helper'), ''),
    writeFile(join(nativeRoot, 'profile-lease-helper.sha256'), ''),
    writeFile(join(exportNativeRoot, 'local-export-helper'), ''),
    writeFile(join(exportNativeRoot, 'local-export-helper.sha256'), ''),
    writeFile(join(nativeRoot, 'local-export-helper.manifest.json'), '{}'),
  ]);
  await Promise.all([
    chmod(fixturePluginRoot, 0o755),
    chmod(runtimeRoot, 0o755),
    chmod(nativeRoot, 0o755),
    chmod(exportNativeRoot, 0o755),
  ]);
  return {
    launcher: join(scriptsRoot, 'launch-sceneboard-mcp.mjs'),
    runtime: join(runtimeRoot, 'index.js'),
  };
};

const launcherEnvironment = (root: string, overrides: NodeJS.ProcessEnv = {}) => ({
  HOME: root,
  PATH: process.env.PATH,
  ...overrides,
});

const parseLauncherObservation = (result: LauncherResult) => {
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout) as Record<string, unknown>;
};

const withProject = async (run: (projectRoot: string) => Promise<void>) => {
  const base = join(tmpdir(), 'sceneboard-plugin-');
  await mkdir(tmpdir(), { recursive: true });
  const projectRoot = await mkdtemp(base);
  try {
    await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
};

type PublisherFixture = {
  root: string;
  script: string;
  runtimeSource: string;
  profileHelperSource: string;
  exportHelperSource: string;
  runtime: string;
  profileHelper: string;
  profileDigest: string;
  exportHelper: string;
  exportDigest: string;
  exportManifest: string;
};

const createPublisherFixture = async (projectRoot: string): Promise<PublisherFixture> => {
  const root = join(projectRoot, 'publisher');
  const script = join(root, 'scripts/build-sceneboard-plugin.mjs');
  const runtimeSource = join(root, 'sceneboard-mcp/src/index.ts');
  const profileHelperSource = join(root, 'sceneboard-mcp/native/profile-lease-helper.c');
  const exportHelperSource = join(root, 'sceneboard-mcp/native/local-export-helper.c');
  const pluginFixtureRoot = join(root, 'sceneboard-mcp/plugins/sceneboard');
  const nativeRoot = join(root, 'sceneboard-mcp/plugins/sceneboard/native');
  await Promise.all([
    mkdir(join(root, 'scripts'), { recursive: true }),
    mkdir(join(root, 'bin'), { recursive: true }),
    mkdir(join(root, 'sceneboard-mcp/src'), { recursive: true }),
    mkdir(join(root, 'sceneboard-mcp/native'), { recursive: true }),
    mkdir(join(pluginFixtureRoot, 'runtime'), { recursive: true }),
    mkdir(join(pluginFixtureRoot, 'scripts'), { recursive: true }),
    mkdir(join(pluginFixtureRoot, 'skills/sceneboard'), { recursive: true }),
    mkdir(join(nativeRoot, 'linux-x64-gnu'), { recursive: true }),
  ]);
  const compiler = join(root, 'bin/cc');
  await Promise.all([
    copyFile(pluginPublisherPath, script),
    symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir'),
    writeFile(
      compiler,
      `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const outputIndex = process.argv.indexOf('-o');
const source = process.argv.at(-1);
if (outputIndex < 0 || source === undefined) process.exit(2);
writeFileSync(process.argv[outputIndex + 1], Buffer.concat([
  Buffer.from('fixture-native-artifact\\n'),
  readFileSync(source),
]));
`,
    ),
    writeFile(runtimeSource, 'process.stdout.write("publisher-runtime-v1");\n'),
    writeFile(profileHelperSource, 'int main(void) { return 0; }\n'),
    writeFile(exportHelperSource, 'int main(void) { return 0; }\n'),
    writeFile(join(pluginFixtureRoot, '.mcp.json'), '{}\n'),
    copyFile(launcherPath, join(pluginFixtureRoot, 'scripts/launch-sceneboard-mcp.mjs')),
    copyFile(configResolverPath, join(pluginFixtureRoot, 'scripts/sceneboard-mcp-config.mjs')),
    writeFile(join(pluginFixtureRoot, 'skills/sceneboard/SKILL.md'), '# Fixture\n'),
    writeFile(join(pluginFixtureRoot, 'runtime/index.js'), 'process.stdout.write("seed");\n'),
    writeFile(join(nativeRoot, 'profile-lease-helper'), 'seed'),
    writeFile(join(nativeRoot, 'profile-lease-helper.sha256'), 'seed\n'),
    writeFile(join(nativeRoot, 'linux-x64-gnu/local-export-helper'), 'seed'),
    writeFile(join(nativeRoot, 'linux-x64-gnu/local-export-helper.sha256'), 'seed\n'),
    writeFile(join(nativeRoot, 'local-export-helper.manifest.json'), '{}\n'),
  ]);
  await Promise.all([
    chmod(compiler, 0o500),
    chmod(join(pluginFixtureRoot, 'scripts/launch-sceneboard-mcp.mjs'), 0o755),
    chmod(join(nativeRoot, 'profile-lease-helper'), 0o500),
    chmod(join(nativeRoot, 'profile-lease-helper.sha256'), 0o400),
    chmod(join(nativeRoot, 'linux-x64-gnu/local-export-helper'), 0o500),
    chmod(join(nativeRoot, 'linux-x64-gnu/local-export-helper.sha256'), 0o400),
    chmod(join(nativeRoot, 'local-export-helper.manifest.json'), 0o400),
  ]);
  return {
    root,
    script,
    runtimeSource,
    profileHelperSource,
    exportHelperSource,
    runtime: join(root, 'sceneboard-mcp/plugins/sceneboard/runtime/index.js'),
    profileHelper: join(nativeRoot, 'profile-lease-helper'),
    profileDigest: join(nativeRoot, 'profile-lease-helper.sha256'),
    exportHelper: join(nativeRoot, 'linux-x64-gnu/local-export-helper'),
    exportDigest: join(nativeRoot, 'linux-x64-gnu/local-export-helper.sha256'),
    exportManifest: join(nativeRoot, 'local-export-helper.manifest.json'),
  };
};

const activePublisherRoot = async (fixture: PublisherFixture) => {
  const root = dirname(dirname(fixture.runtime));
  const releaseName = (await readFile(join(root, '.sceneboard-current'), 'utf8')).trim();
  assert.match(releaseName, /^generation-[A-Za-z0-9-]+$/u);
  return join(root, '.sceneboard-releases', releaseName);
};

const activePublisherTargets = async (fixture: PublisherFixture) => {
  const root = await activePublisherRoot(fixture);
  return {
    root,
    runtime: join(root, 'runtime/index.js'),
    profileHelper: join(root, 'native/profile-lease-helper'),
    profileDigest: join(root, 'native/profile-lease-helper.sha256'),
    exportHelper: join(root, 'native/linux-x64-gnu/local-export-helper'),
    exportDigest: join(root, 'native/linux-x64-gnu/local-export-helper.sha256'),
    exportManifest: join(root, 'native/local-export-helper.manifest.json'),
  };
};

const assertCompletePublisherInventory = async (fixture: PublisherFixture) => {
  const active = await activePublisherTargets(fixture);
  for (const path of [
    '.mcp.json',
    'scripts/launch-sceneboard-mcp.mjs',
    'skills/sceneboard/SKILL.md',
    'runtime/index.js',
    'native/profile-lease-helper',
    'native/profile-lease-helper.sha256',
    'native/linux-x64-gnu/local-export-helper',
    'native/linux-x64-gnu/local-export-helper.sha256',
    'native/local-export-helper.manifest.json',
  ]) {
    const status = await lstat(join(active.root, path));
    assert.equal(status.isSymbolicLink(), false, path);
    assert.equal(status.isFile(), true, path);
  }
  assert.deepEqual(
    await Promise.all(Object.values(active).slice(1).map(modeOf)),
    [0o644, 0o500, 0o400, 0o500, 0o400, 0o400],
  );
  return active;
};

const runPublisher = async (
  fixture: PublisherFixture,
  args: string[] = [],
  environment: NodeJS.ProcessEnv = {},
) => {
  const result = await new Promise<LauncherResult>((resolveResult, reject) => {
    const child = spawn(process.execPath, [fixture.script, ...args], {
      cwd: fixture.root,
      env: {
        PATH: `${join(fixture.root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        ...environment,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('plugin publisher test timed out'));
    }, 20_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ code, signal, stdout, stderr });
    });
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'BUILT',
    runtime: 'runtime/index.js',
  });
};

const startCheckpointProcess = ({
  command,
  args,
  cwd,
  environment,
  event,
}: {
  command: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  event: string;
}) => {
  const child = spawn(command, args, {
    cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  assert(child.stdout !== null);
  assert(child.stderr !== null);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const checkpoint = new Promise<void>((resolveCheckpoint, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${event} checkpoint timed out`)), 4_000);
    child.once('message', (message) => {
      clearTimeout(timeout);
      assert.deepEqual(message, { event });
      resolveCheckpoint();
    });
  });
  const result = new Promise<LauncherResult>((resolveResult, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${event} process timed out`));
    }, 20_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ code, signal, stdout, stderr });
    });
  });
  return { child, checkpoint, result };
};

const expectedRuntimeBytes = async (fixture: PublisherFixture) => {
  const expected = join(fixture.root, 'expected-runtime.js');
  await build({
    entryPoints: [fixture.runtimeSource],
    outfile: expected,
    absWorkingDir: fixture.root,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    legalComments: 'none',
    logLevel: 'silent',
  });
  return readFile(expected);
};

const modeOf = async (path: string) => (await lstat(path)).mode & 0o777;

test('prefers the open project root .mcp.json over Codex configuration', async () => {
  await withProject(async (projectRoot) => {
    await writeFile(
      join(projectRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          sceneboard: {
            command: '/trusted/project/node',
            args: ['/trusted/project/server.js'],
            env: { BOARD_API_URL: 'http://127.0.0.1:3411' },
          },
        },
      }),
    );
    const selected = await resolveSceneBoardServer({
      cwd: pluginRoot,
      pluginRoot,
      environment: { PWD: projectRoot },
      run: () => {
        throw new Error('Codex config must not be read');
      },
    });
    assert.equal(selected.source, 'project_root_mcp_json');
    assert.equal(selected.server.command, '/trusted/project/node');
    assert.equal(selected.server.env.BOARD_API_URL, 'http://127.0.0.1:3411');
  });
});

test('uses the effective Codex project or user config when no root override exists', async () => {
  await withProject(async (projectRoot) => {
    const selected = await resolveSceneBoardServer({
      cwd: projectRoot,
      pluginRoot,
      environment: { BOARD_TEST_SETTING: 'forwarded' },
      run: () => ({
        status: 0,
        stdout: JSON.stringify({
          name: 'sceneboard',
          enabled: true,
          transport: {
            type: 'stdio',
            command: 'sceneboard-mcp',
            args: ['--profile', 'work'],
            env: { BOARD_PROFILE: 'work' },
            env_vars: ['BOARD_TEST_SETTING'],
            cwd: null,
          },
        }),
      }),
    });
    assert.equal(selected.source, 'codex_config_toml');
    assert.equal(selected.server.command, 'sceneboard-mcp');
    assert.deepEqual(selected.server.args, ['--profile', 'work']);
    assert.equal(selected.server.env.BOARD_TEST_SETTING, 'forwarded');
  });
});

test('falls back to the sceneboard.dev production contract without credentials', async () => {
  await withProject(async (projectRoot) => {
    const selected = await resolveSceneBoardServer({
      cwd: projectRoot,
      pluginRoot,
      run: () => codexAbsentResult,
    });
    assert.equal(selected.source, 'production_default');
    assert.equal(selected.server.env.BOARD_API_URL, PRODUCTION_API_URL);
    assert.equal(selected.server.env.BOARD_CREDENTIAL_MODE, 'pairing');
    assert.equal(selected.server.env.BOARD_ACCESS_TOKEN_REF, 'store://sceneboard');
    assert.equal('SCENEBOARD_ACCESS_TOKEN' in selected.server.env, false);
  });
});

test('production pairing fallback remains runtime-valid for a non-default profile', async () => {
  await withProject(async (projectRoot) => {
    const selected = await resolveSceneBoardServer({
      cwd: projectRoot,
      pluginRoot,
      environment: { BOARD_PROFILE: 'owner' },
      run: () => codexAbsentResult,
    });
    assert.equal(selected.source, 'production_default');
    assert.equal(selected.server.env.BOARD_ACCESS_TOKEN_REF, 'store://owner');
    assert.equal(
      parseBoardConfigV1(
        {
          version: 1,
          baseUrl: selected.server.env.BOARD_API_URL,
          credentialMode: selected.server.env.BOARD_CREDENTIAL_MODE,
          accessTokenRef: selected.server.env.BOARD_ACCESS_TOKEN_REF,
          authScheme: 'bearer',
          timeoutMs: Number(selected.server.env.BOARD_TIMEOUT_MS),
          profile: selected.server.env.BOARD_PROFILE,
        },
        'environment',
      ).accessTokenRef,
      'store://owner',
    );
  });
});

test('production plugin forwards only an explicit API-key mode and reference', async () => {
  await withProject(async (projectRoot) => {
    const selected = await resolveSceneBoardServer({
      cwd: projectRoot,
      pluginRoot,
      environment: {
        BOARD_CREDENTIAL_MODE: 'api_key',
        BOARD_ACCESS_TOKEN_REF: 'env://SCENEBOARD_API_KEY',
        SCENEBOARD_API_KEY: `sbk_v1.${'A'.repeat(22)}.${'B'.repeat(43)}`,
      },
      run: () => codexAbsentResult,
    });
    assert.equal(selected.source, 'production_default');
    assert.equal(selected.server.env.BOARD_CREDENTIAL_MODE, 'api_key');
    assert.equal(selected.server.env.BOARD_ACCESS_TOKEN_REF, 'env://SCENEBOARD_API_KEY');
    assert.equal('SCENEBOARD_API_KEY' in selected.server.env, false);
  });
});

test('production API-key mode accepts the matching non-default profile store', async () => {
  await withProject(async (projectRoot) => {
    const selected = await resolveSceneBoardServer({
      cwd: projectRoot,
      pluginRoot,
      environment: {
        BOARD_CREDENTIAL_MODE: 'api_key',
        BOARD_ACCESS_TOKEN_REF: 'store://owner',
        BOARD_PROFILE: 'owner',
      },
      run: () => codexAbsentResult,
    });
    assert.equal(selected.source, 'production_default');
    assert.equal(selected.server.env.BOARD_ACCESS_TOKEN_REF, 'store://owner');
  });
});

test('production credentials reject empty, cross-mode, malformed, and foreign-profile references', async () => {
  await withProject(async (projectRoot) => {
    for (const [credentialMode, accessTokenRef] of [
      ['pairing', ''],
      ['pairing', 'env://SCENEBOARD_API_KEY'],
      ['pairing', 'store://'],
      ['pairing', 'store://other'],
      ['pairing', 'file://credential.json'],
      ['api_key', 'env://SCENEBOARD_ACCESS_TOKEN'],
      ['api_key', 'store://other'],
    ] as const) {
      await assert.rejects(
        resolveSceneBoardServer({
          cwd: projectRoot,
          pluginRoot,
          environment: {
            BOARD_CREDENTIAL_MODE: credentialMode,
            BOARD_ACCESS_TOKEN_REF: accessTokenRef,
            BOARD_PROFILE: 'sceneboard',
          },
          run: () => codexAbsentResult,
        }),
        (error: unknown) =>
          error instanceof TypeError && error.message === 'invalid_sceneboard_access_token_ref',
        `${credentialMode}:${accessTokenRef}`,
      );
    }
  });
});

test('launcher rejects invalid production credential references before starting a child', async () => {
  await withProject(async (projectRoot) => {
    const fixture = await createLauncherFixture(projectRoot);
    const codexBinary = join(projectRoot, 'codex-unavailable.mjs');
    await writeFile(codexBinary, codexAbsentFixture);
    await chmod(codexBinary, 0o500);
    for (const [credentialMode, accessTokenRef] of [
      ['pairing', ''],
      ['pairing', 'env://SCENEBOARD_API_KEY'],
      ['pairing', 'store://other'],
      ['api_key', 'env://SCENEBOARD_ACCESS_TOKEN'],
      ['api_key', 'store://other'],
      ['api_key', 'store:/sceneboard'],
    ] as const) {
      const result = await runLauncher({
        cwd: projectRoot,
        launcher: fixture.launcher,
        environment: launcherEnvironment(projectRoot, {
          CODEX_BINARY: codexBinary,
          BOARD_CREDENTIAL_MODE: credentialMode,
          BOARD_ACCESS_TOKEN_REF: accessTokenRef,
          BOARD_PROFILE: 'sceneboard',
        }),
      });
      assert.equal(result.code, 78, `${credentialMode}:${accessTokenRef}`);
      assert.equal(result.stdout, '');
      assert.deepEqual(JSON.parse(result.stderr), {
        event: 'sceneboard_mcp_launch_failed',
        code: 'invalid_sceneboard_access_token_ref',
        setupUrl: 'https://sceneboard.dev/integrations/codex',
      });
    }
  });
});

for (const source of ['project', 'codex'] as const) {
  test(`launcher gives a ${source}-selected child only normalized explicit environment`, async () => {
    await withProject(async (projectRoot) => {
      const fixture = await createLauncherFixture(projectRoot);
      let codexBinary: string | undefined;
      let codexResolverObservation: string | undefined;
      if (source === 'project') {
        await writeFile(
          join(projectRoot, '.mcp.json'),
          JSON.stringify({
            mcpServers: {
              sceneboard: {
                command: process.execPath,
                args: [fixture.runtime],
                env: { PLUGIN_TEST_FORWARD: 'project-explicit' },
              },
            },
          }),
        );
      } else {
        codexBinary = join(projectRoot, 'codex-fixture.mjs');
        codexResolverObservation = join(projectRoot, 'codex-resolver-environment.json');
        await writeFile(
          codexBinary,
          `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const environment = process.env;
writeFileSync(${JSON.stringify(codexResolverObservation)}, JSON.stringify({
  exactApiKeyPresent: Object.hasOwn(environment, 'SCENEBOARD_API_KEY'),
  caseVariantApiKeyPresent: Object.hasOwn(environment, 'SceneBoard_Api_Key'),
  aliasedApiKeyPresent: Object.hasOwn(environment, 'API_KEY_BACKUP'),
  unrelatedCanaryPresent: Object.hasOwn(environment, 'LANG'),
  apiKeyValuePresent: Object.values(environment).includes(${JSON.stringify(testApiKey)}),
}));
process.stdout.write(${JSON.stringify(
            JSON.stringify({
              name: 'sceneboard',
              enabled: true,
              transport: {
                type: 'stdio',
                command: process.execPath,
                args: [fixture.runtime],
                env_vars: ['PLUGIN_TEST_FORWARD'],
              },
            }),
          )});
`,
        );
        await chmod(codexBinary, 0o500);
      }

      const result = await runLauncher({
        cwd: projectRoot,
        launcher: fixture.launcher,
        environment: launcherEnvironment(projectRoot, {
          ...(source === 'codex'
            ? {
                CODEX_BINARY: codexBinary,
                PLUGIN_TEST_FORWARD: 'codex-explicit',
              }
            : {}),
          UNDECLARED_AMBIENT: 'must-not-be-forwarded',
          SCENEBOARD_API_KEY: testApiKey,
          SceneBoard_Api_Key: 'case-variant-secret',
          API_KEY_BACKUP: testApiKey,
          LANG: testApiKey,
        }),
      });
      assert.deepEqual(parseLauncherObservation(result), {
        explicit: `${source}-explicit`,
        undeclaredAmbientPresent: false,
        exactApiKeyPresent: false,
        exactApiKeyMatches: false,
        legacyAccessTokenPresent: false,
        legacyAccessTokenMatches: false,
        caseVariantApiKeyPresent: false,
        aliasedApiKeyPresent: false,
        safeAliasApiKeyPresent: false,
        credentialMode: null,
        accessTokenRef: null,
        configDepth: '1',
      });
      if (source === 'codex') {
        assert(codexResolverObservation !== undefined);
        assert.deepEqual(JSON.parse(await readFile(codexResolverObservation, 'utf8')), {
          exactApiKeyPresent: false,
          caseVariantApiKeyPresent: false,
          aliasedApiKeyPresent: false,
          unrelatedCanaryPresent: false,
          apiKeyValuePresent: false,
        });
      }
    });
  });
}

for (const source of ['project', 'codex'] as const) {
  test(`launcher accepts the documented explicit API-key ${source} configuration`, async () => {
    await withProject(async (projectRoot) => {
      const fixture = await createLauncherFixture(projectRoot);
      const transport = {
        command: process.execPath,
        args: [fixture.runtime],
        env: {
          BOARD_CREDENTIAL_MODE: 'api_key',
          BOARD_ACCESS_TOKEN_REF: 'env://SCENEBOARD_API_KEY',
        },
        env_vars: ['SCENEBOARD_API_KEY'],
      };
      let codexBinary: string | undefined;
      if (source === 'project') {
        await writeFile(
          join(projectRoot, '.mcp.json'),
          JSON.stringify({ mcpServers: { sceneboard: transport } }),
        );
      } else {
        codexBinary = join(projectRoot, 'codex-fixture.mjs');
        await writeFile(
          codexBinary,
          `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(
            JSON.stringify({
              name: 'sceneboard',
              enabled: true,
              transport: { type: 'stdio', ...transport },
            }),
          )});\n`,
        );
        await chmod(codexBinary, 0o500);
      }
      const result = await runLauncher({
        cwd: projectRoot,
        launcher: fixture.launcher,
        environment: launcherEnvironment(projectRoot, {
          ...(source === 'codex' ? { CODEX_BINARY: codexBinary } : {}),
          SCENEBOARD_API_KEY: testApiKey,
          SCENEBOARD_ACCESS_TOKEN: testLegacyToken,
          UNDECLARED_AMBIENT: 'must-not-be-forwarded',
        }),
      });
      assert.deepEqual(parseLauncherObservation(result), {
        explicit: null,
        undeclaredAmbientPresent: false,
        exactApiKeyPresent: true,
        exactApiKeyMatches: true,
        legacyAccessTokenPresent: false,
        legacyAccessTokenMatches: false,
        caseVariantApiKeyPresent: false,
        aliasedApiKeyPresent: false,
        safeAliasApiKeyPresent: false,
        credentialMode: 'api_key',
        accessTokenRef: 'env://SCENEBOARD_API_KEY',
        configDepth: '1',
      });
    });
  });
}

for (const mode of ['api_key', 'pairing'] as const) {
  test(`production ${mode} launcher forwards only its declared credential contract`, async () => {
    await withProject(async (projectRoot) => {
      const fixture = await createLauncherFixture(projectRoot);
      const codexBinary = join(projectRoot, 'codex-unavailable.mjs');
      await writeFile(codexBinary, codexAbsentFixture);
      await chmod(codexBinary, 0o500);
      const result = await runLauncher({
        cwd: projectRoot,
        launcher: fixture.launcher,
        environment: launcherEnvironment(projectRoot, {
          CODEX_BINARY: codexBinary,
          BOARD_CREDENTIAL_MODE: mode,
          ...(mode === 'api_key' ? { BOARD_ACCESS_TOKEN_REF: 'env://SCENEBOARD_API_KEY' } : {}),
          UNDECLARED_AMBIENT: 'must-not-be-forwarded',
          SCENEBOARD_API_KEY: testApiKey,
          SceneBoard_Api_Key: 'case-variant-secret',
          API_KEY_BACKUP: testApiKey,
          LANG: testApiKey,
        }),
      });
      assert.deepEqual(parseLauncherObservation(result), {
        explicit: null,
        undeclaredAmbientPresent: false,
        exactApiKeyPresent: mode === 'api_key',
        exactApiKeyMatches: mode === 'api_key',
        legacyAccessTokenPresent: false,
        legacyAccessTokenMatches: false,
        caseVariantApiKeyPresent: false,
        aliasedApiKeyPresent: false,
        safeAliasApiKeyPresent: false,
        credentialMode: mode,
        accessTokenRef: mode === 'api_key' ? 'env://SCENEBOARD_API_KEY' : 'store://sceneboard',
        configDepth: '1',
      });
    });
  });
}

test('production pairing launcher forwards only the exact legacy environment reference', async () => {
  await withProject(async (projectRoot) => {
    const fixture = await createLauncherFixture(projectRoot);
    const codexBinary = join(projectRoot, 'codex-unavailable.mjs');
    await writeFile(codexBinary, codexAbsentFixture);
    await chmod(codexBinary, 0o500);
    const result = await runLauncher({
      cwd: projectRoot,
      launcher: fixture.launcher,
      environment: launcherEnvironment(projectRoot, {
        CODEX_BINARY: codexBinary,
        BOARD_CREDENTIAL_MODE: 'pairing',
        BOARD_ACCESS_TOKEN_REF: 'env://SCENEBOARD_ACCESS_TOKEN',
        SCENEBOARD_ACCESS_TOKEN: testLegacyToken,
        SCENEBOARD_API_KEY: testApiKey,
      }),
    });
    const observation = parseLauncherObservation(result);
    assert.equal(observation.legacyAccessTokenPresent, true);
    assert.equal(observation.legacyAccessTokenMatches, true);
    assert.equal(observation.exactApiKeyPresent, false);
  });
});

test('launcher descriptor chmod rejects a path replacement without touching the replacement', async () => {
  await withProject(async (projectRoot) => {
    const fixture = await createLauncherFixture(projectRoot);
    const codexBinary = join(projectRoot, 'codex-unavailable.mjs');
    const heldRuntime = `${fixture.runtime}.held`;
    await writeFile(codexBinary, codexAbsentFixture);
    await Promise.all([chmod(codexBinary, 0o500), chmod(fixture.runtime, 0o400)]);

    const child = spawn(process.execPath, [fixture.launcher], {
      cwd: projectRoot,
      env: launcherEnvironment(projectRoot, {
        CODEX_BINARY: codexBinary,
        SCENEBOARD_PLUGIN_LAUNCH_TEST_FAULT: 'pause-before-first-chmod',
      }),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '';
    let stderr = '';
    assert(child.stdout !== null);
    assert(child.stderr !== null);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const closed = new Promise<LauncherResult>((resolveResult, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }));
    });
    await new Promise<void>((resolveCheckpoint, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('launcher race checkpoint timed out')),
        2_000,
      );
      child.once('message', (message) => {
        clearTimeout(timeout);
        assert.deepEqual(message, { event: 'sceneboard_plugin_before_first_chmod' });
        resolveCheckpoint();
      });
    });
    await rename(fixture.runtime, heldRuntime);
    await writeFile(fixture.runtime, 'process.stdout.write("replacement");\n', { mode: 0o600 });
    await chmod(fixture.runtime, 0o600);
    child.send('resume');

    const result = await closed;
    assert.equal(result.code, 78);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).code, 'production_runtime_unavailable');
    assert.equal(await modeOf(heldRuntime), 0o644);
    assert.equal(await modeOf(fixture.runtime), 0o600);
  });
});

test('launcher process-start failure is one privacy-safe JSON line', async () => {
  await withProject(async (projectRoot) => {
    const fixture = await createLauncherFixture(projectRoot);
    const canaryCommand = join(projectRoot, `missing-${testApiKey}`);
    await writeFile(
      join(projectRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          sceneboard: { command: canaryCommand, args: [], env: {} },
        },
      }),
    );
    const result = await runLauncher({
      cwd: projectRoot,
      launcher: fixture.launcher,
      environment: launcherEnvironment(projectRoot, {
        SCENEBOARD_API_KEY: testApiKey,
        API_KEY_BACKUP: testApiKey,
      }),
    });
    assert.equal(result.code, 78);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.endsWith('\n'), true);
    assert.equal(result.stderr.slice(0, -1).includes('\n'), false);
    assert.equal(result.stderr.includes(projectRoot), false);
    assert.equal(result.stderr.includes(testApiKey), false);
    assert.deepEqual(JSON.parse(result.stderr), {
      event: 'sceneboard_mcp_launch_failed',
      code: 'server_process_start_failed',
      setupUrl: 'https://sceneboard.dev/integrations/codex',
    });
  });
});

test('only the exact shipped descriptor and plugin-root relationship may bootstrap production', async () => {
  const shipped = JSON.parse(await readFile(join(pluginRoot, '.mcp.json'), 'utf8')).mcpServers
    .sceneboard;
  assert.equal(
    await readProjectRootServer({ projectRoot: pluginRoot, pluginRoot, environment: {} }),
    null,
  );
  await withProject(async (projectRoot) => {
    const selected = await resolveSceneBoardServer({
      cwd: projectRoot,
      pluginRoot,
      run: () => ({
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          name: 'sceneboard',
          enabled: true,
          transport: { type: 'stdio', ...shipped, cwd: pluginRoot },
        }),
        stderr: '',
      }),
    });
    assert.equal(selected.source, 'production_default');
  });
});

for (const source of ['project', 'codex'] as const) {
  for (const [name, args] of [
    ['recursive launcher', ['/plugin/scripts/launch-sceneboard-mcp.mjs']],
    ['substring launcher match', ['/plugin/scripts/not-launch-sceneboard-mcp.mjs.backup']],
  ] as const) {
    test(`${source} ${name} fails closed without consulting a later source`, async () => {
      await withProject(async (projectRoot) => {
        const transport = { command: 'node', args: [...args], env: {} };
        let codexConsulted = false;
        if (source === 'project') {
          await writeFile(
            join(projectRoot, '.mcp.json'),
            JSON.stringify({ mcpServers: { sceneboard: transport } }),
          );
        }
        await assert.rejects(
          resolveSceneBoardServer({
            cwd: projectRoot,
            pluginRoot,
            productionApiUrl: 'http://must-not-be-consulted.invalid',
            run: () => {
              codexConsulted = true;
              return {
                status: 0,
                signal: null,
                stdout: JSON.stringify({
                  name: 'sceneboard',
                  enabled: true,
                  transport: { type: 'stdio', ...transport },
                }),
                stderr: '',
              };
            },
          }),
          (error: unknown) =>
            error instanceof TypeError && error.message === 'recursive_sceneboard_launcher',
        );
        assert.equal(codexConsulted, source === 'codex');
      });
    });
  }
}

for (const source of ['project', 'codex'] as const) {
  test(`launcher rejects selected ${source} recursion before starting a server child`, async () => {
    await withProject(async (projectRoot) => {
      const fixture = await createLauncherFixture(projectRoot);
      const transport = {
        command: 'node',
        args: ['/plugin/scripts/launch-sceneboard-mcp.mjs'],
        env: {},
      };
      let codexBinary: string | undefined;
      if (source === 'project') {
        await writeFile(
          join(projectRoot, '.mcp.json'),
          JSON.stringify({ mcpServers: { sceneboard: transport } }),
        );
      } else {
        codexBinary = join(projectRoot, 'codex-recursive.mjs');
        await writeFile(
          codexBinary,
          `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(
            JSON.stringify({
              name: 'sceneboard',
              enabled: true,
              transport: { type: 'stdio', ...transport },
            }),
          )});\n`,
        );
        await chmod(codexBinary, 0o500);
      }
      const result = await runLauncher({
        cwd: projectRoot,
        launcher: fixture.launcher,
        environment: launcherEnvironment(projectRoot, {
          ...(codexBinary === undefined ? {} : { CODEX_BINARY: codexBinary }),
        }),
      });
      assert.equal(result.code, 78);
      assert.equal(result.stdout, '');
      assert.deepEqual(JSON.parse(result.stderr), {
        event: 'sceneboard_mcp_launch_failed',
        code: 'recursive_sceneboard_launcher',
        setupUrl: 'https://sceneboard.dev/integrations/codex',
      });
    });
  });
}

for (const source of ['project', 'codex'] as const) {
  for (const secretCase of [
    { name: 'case-variant literal key', key: 'SceneBoard_Api_Key', value: 'not-a-key' },
    {
      name: 'aliased literal value',
      key: 'API_KEY_BACKUP',
      value: `sbk_v1.${'G'.repeat(22)}.${'H'.repeat(43)}`,
    },
  ] as const) {
    test(`recursive ${source} config rejects ${secretCase.name} as recursion without disclosure`, async () => {
      await withProject(async (projectRoot) => {
        const transport = {
          command: 'node',
          args: ['./scripts/launch-sceneboard-mcp.mjs'],
          env_vars: ['SCENEBOARD_API_KEY'],
          env: { [secretCase.key]: secretCase.value },
        };
        if (source === 'project') {
          await writeFile(
            join(projectRoot, '.mcp.json'),
            JSON.stringify({ mcpServers: { sceneboard: transport } }),
          );
        }
        await assert.rejects(
          resolveSceneBoardServer({
            cwd: projectRoot,
            pluginRoot,
            run: () =>
              source === 'codex'
                ? {
                    status: 0,
                    stdout: JSON.stringify({
                      name: 'sceneboard',
                      enabled: true,
                      transport: { type: 'stdio', ...transport },
                    }),
                  }
                : codexAbsentResult,
          }),
          (thrown: unknown) => {
            assert(thrown instanceof TypeError);
            assert.equal(thrown.message, 'recursive_sceneboard_launcher');
            assert.equal(thrown.message.includes(secretCase.key), false);
            assert.equal(thrown.message.includes(secretCase.value), false);
            return true;
          },
        );
      });
    });
  }
}

test('fails closed on an invalid project SceneBoard entry', async () => {
  await withProject(async (projectRoot) => {
    await writeFile(
      join(projectRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: { sceneboard: { command: '', env: {} } },
      }),
    );
    await assert.rejects(
      resolveSceneBoardServer({
        cwd: projectRoot,
        pluginRoot,
        run: () => codexAbsentResult,
      }),
      /invalid_sceneboard_project_command/,
    );
  });
});

for (const source of ['project', 'codex'] as const) {
  for (const extraField of ['unknown', 'commnad'] as const) {
    test(`${source} config rejects the ${extraField} stdio field`, async () => {
      await withProject(async (projectRoot) => {
        const transport = {
          command: '/trusted/node',
          args: ['/trusted/runtime.js'],
          env: {},
          [extraField]: 'must-not-be-ignored',
        };
        if (source === 'project') {
          await writeFile(
            join(projectRoot, '.mcp.json'),
            JSON.stringify({ mcpServers: { sceneboard: transport } }),
          );
        }
        await assert.rejects(
          resolveSceneBoardServer({
            cwd: projectRoot,
            pluginRoot,
            run: () =>
              source === 'codex'
                ? {
                    status: 0,
                    signal: null,
                    stdout: JSON.stringify({
                      name: 'sceneboard',
                      enabled: true,
                      transport: { type: 'stdio', ...transport },
                    }),
                    stderr: '',
                  }
                : codexAbsentResult,
          }),
          new RegExp(`^TypeError: invalid_sceneboard_${source}_server$`),
        );
      });
    });
  }
}

test('project unknown fields fail before the launcher can spawn a server child', async () => {
  await withProject(async (projectRoot) => {
    const fixture = await createLauncherFixture(projectRoot);
    await writeFile(
      join(projectRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          sceneboard: {
            command: process.execPath,
            args: [fixture.runtime],
            env: {},
            command_path: fixture.runtime,
          },
        },
      }),
    );
    const result = await runLauncher({
      cwd: projectRoot,
      launcher: fixture.launcher,
      environment: launcherEnvironment(projectRoot),
    });
    assert.equal(result.code, 78);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), {
      event: 'sceneboard_mcp_launch_failed',
      code: 'invalid_sceneboard_project_server',
      setupUrl: 'https://sceneboard.dev/integrations/codex',
    });
  });
});

test('Codex resolver failures fail closed without production fallback or a server child', async () => {
  await withProject(async (projectRoot) => {
    const fixture = await createLauncherFixture(projectRoot);
    const codexBinary = join(projectRoot, 'codex-fixture.mjs');
    const canary = `${projectRoot}/${testApiKey}`;
    const cases = [
      {
        name: 'execution-error',
        binary: join(projectRoot, 'missing-codex'),
        source: null,
        code: 'sceneboard_codex_resolution_failed',
      },
      {
        name: 'error-output',
        binary: codexBinary,
        source: `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(
          `resolver failed at ${canary}\n`,
        )});\nprocess.exitCode = 2;\n`,
        code: 'sceneboard_codex_resolution_failed',
      },
      {
        name: 'oversized-output',
        binary: codexBinary,
        source: `#!${process.execPath}\nprocess.stdout.write('x'.repeat(1024 * 1024 + 1));\n`,
        code: 'sceneboard_codex_resolution_failed',
      },
      {
        name: 'malformed-output',
        binary: codexBinary,
        source: `#!${process.execPath}\nprocess.stdout.write('{');\n`,
        code: 'invalid_sceneboard_codex_json',
      },
      {
        name: 'indeterminate-result',
        binary: codexBinary,
        source: `#!${process.execPath}\nprocess.kill(process.pid, 'SIGTERM');\n`,
        code: 'sceneboard_codex_resolution_failed',
      },
      {
        name: 'unknown-field',
        binary: codexBinary,
        source: `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(
          JSON.stringify({
            name: 'sceneboard',
            enabled: true,
            transport: {
              type: 'stdio',
              command: process.execPath,
              args: [fixture.runtime],
              env: {},
              command_path: canary,
            },
          }),
        )});\n`,
        code: 'invalid_sceneboard_codex_server',
      },
    ] as const;

    for (const resolverCase of cases) {
      if (resolverCase.source !== null) {
        await chmod(codexBinary, 0o600).catch(() => undefined);
        await writeFile(codexBinary, resolverCase.source);
        await chmod(codexBinary, 0o500);
      }
      const result = await runLauncher({
        cwd: projectRoot,
        launcher: fixture.launcher,
        environment: launcherEnvironment(projectRoot, {
          CODEX_BINARY: resolverCase.binary,
          SCENEBOARD_API_KEY: testApiKey,
        }),
      });
      assert.equal(result.code, 78, resolverCase.name);
      assert.equal(result.signal, null, resolverCase.name);
      assert.equal(result.stdout, '', resolverCase.name);
      assert.equal(result.stderr.endsWith('\n'), true, resolverCase.name);
      assert.equal(result.stderr.slice(0, -1).includes('\n'), false, resolverCase.name);
      assert.equal(result.stderr.includes(projectRoot), false, resolverCase.name);
      assert.equal(result.stderr.includes(testApiKey), false, resolverCase.name);
      assert.deepEqual(JSON.parse(result.stderr), {
        event: 'sceneboard_mcp_launch_failed',
        code: resolverCase.code,
        setupUrl: 'https://sceneboard.dev/integrations/codex',
      });
    }
  });
});

test('rejects an API-key literal in project .mcp.json env', async () => {
  await withProject(async (projectRoot) => {
    await writeFile(
      join(projectRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          sceneboard: {
            command: 'node',
            args: ['/trusted/runtime.js'],
            env: {
              BOARD_CREDENTIAL_MODE: 'api_key',
              SCENEBOARD_API_KEY: `sbk_v1.${'A'.repeat(22)}.${'B'.repeat(43)}`,
            },
          },
        },
      }),
    );
    await assert.rejects(
      resolveSceneBoardServer({
        cwd: projectRoot,
        pluginRoot,
        run: () => codexAbsentResult,
      }),
      /invalid_sceneboard_project_raw_api_key/,
    );
  });
});

for (const source of ['project', 'codex'] as const) {
  for (const secretCase of [
    { name: 'case-variant reserved name', key: 'sceneboard_api_key', inherited: false },
    { name: 'aliased literal value', key: 'API_KEY_BACKUP', inherited: false },
    {
      name: 'exact inherited name outside the explicit API-key contract',
      key: 'SCENEBOARD_API_KEY',
      inherited: true,
    },
    { name: 'case-variant inherited name', key: 'SceneBoard_Api_Key', inherited: true },
    { name: 'aliased inherited value', key: 'API_KEY_BACKUP', inherited: true },
  ] as const) {
    test(`${source} config rejects ${secretCase.name} without disclosing the field or value`, async () => {
      await withProject(async (projectRoot) => {
        const secret = `sbk_v1.${'C'.repeat(22)}.${'D'.repeat(43)}`;
        const transport = {
          command: '/trusted/node',
          args: ['/trusted/runtime.js'],
          ...(secretCase.inherited
            ? { env_vars: [secretCase.key] }
            : { env: { [secretCase.key]: secret } }),
        };
        if (source === 'project') {
          await writeFile(
            join(projectRoot, '.mcp.json'),
            JSON.stringify({ mcpServers: { sceneboard: transport } }),
          );
        }
        await assert.rejects(
          resolveSceneBoardServer({
            cwd: projectRoot,
            pluginRoot,
            environment: secretCase.inherited ? { [secretCase.key]: secret } : {},
            run: () =>
              source === 'codex'
                ? {
                    status: 0,
                    stdout: JSON.stringify({
                      name: 'sceneboard',
                      enabled: true,
                      transport: { type: 'stdio', ...transport },
                    }),
                  }
                : codexAbsentResult,
          }),
          (thrown: unknown) => {
            assert(thrown instanceof TypeError);
            assert.match(thrown.message, new RegExp(`^invalid_sceneboard_${source}_raw_api_key$`));
            assert.equal(thrown.message.includes(secretCase.key), false);
            assert.equal(thrown.message.includes(secret), false);
            return true;
          },
        );
      });
    });
  }
}

test('rejects a symlinked project-root MCP configuration', async () => {
  await withProject(async (projectRoot) => {
    const target = join(projectRoot, 'linked-mcp.json');
    await writeFile(target, JSON.stringify({ mcpServers: {} }));
    await symlink(target, join(projectRoot, '.mcp.json'));
    await assert.rejects(
      resolveSceneBoardServer({
        cwd: projectRoot,
        pluginRoot,
        run: () => codexAbsentResult,
      }),
      /invalid_sceneboard_project_config_file/,
    );
  });
});

test('resolver filesystem and unknown failures produce only privacy-safe launcher events', async () => {
  await withProject(async (projectRoot) => {
    const configPath = join(projectRoot, '.mcp.json');
    await writeFile(configPath, JSON.stringify({ mcpServers: {} }));
    const canaryPath = `${projectRoot}/private-config-canary.json`;
    const secret = `sbk_v1.${'J'.repeat(22)}.${'K'.repeat(43)}`;
    const failures: Array<{ error: unknown; code: string }> = [];

    for (const [phase, code] of [
      ['stat', 'EACCES'],
      ['read', 'ENOTDIR'],
    ] as const) {
      try {
        await readProjectRootServer({
          projectRoot,
          ...(phase === 'stat'
            ? {
                stat: async () => {
                  throw Object.assign(new Error(`${code}: ${canaryPath} ${secret}`), { code });
                },
              }
            : {
                read: async () => {
                  throw Object.assign(new Error(`${code}: ${canaryPath} ${secret}`), { code });
                },
              }),
        });
        assert.fail(`${phase} failure must reject`);
      } catch (error) {
        failures.push({
          error,
          code:
            phase === 'stat'
              ? 'sceneboard_project_config_stat_failed'
              : 'sceneboard_project_config_read_failed',
        });
      }
    }
    failures.push({
      error: new Error(`unknown ${canaryPath} ${secret}`),
      code: 'config_resolution_failed',
    });

    for (const failure of failures) {
      const line = sceneBoardLaunchFailureLineV1(configResolutionFailureCodeV1(failure.error));
      assert.equal(line.endsWith('\n'), true);
      assert.equal(line.slice(0, -1).includes('\n'), false);
      const event = JSON.parse(line);
      assert.deepEqual(Object.keys(event).sort(), ['code', 'event', 'setupUrl']);
      assert.equal(event.event, 'sceneboard_mcp_launch_failed');
      assert.equal(event.code, failure.code);
      assert.equal(event.setupUrl, 'https://sceneboard.dev/integrations/codex');
      assert.equal(line.includes(projectRoot), false);
      assert.equal(line.includes('private-config-canary.json'), false);
      assert.equal(line.includes(secret), false);
      assert.equal(line.includes('unknown'), false);
      assert.equal(line.includes('EACCES'), false);
      assert.equal(line.includes('ENOTDIR'), false);
    }
  });
});

test('production plugin carries exactly the verified linux-x64-gnu local export helper', async () => {
  const manifestPath = resolve(pluginRoot, 'native/local-export-helper.manifest.json');
  const helperPath = resolve(pluginRoot, 'native/linux-x64-gnu/local-export-helper');
  const digestPath = resolve(pluginRoot, 'native/linux-x64-gnu/local-export-helper.sha256');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(Object.keys(manifest.targets), ['linux-x64-gnu']);
  assert.deepEqual(Object.keys(manifest.targets['linux-x64-gnu']).sort(), [
    'mode',
    'path',
    'sha256',
  ]);
  assert.equal(manifest.targets['linux-x64-gnu'].path, 'linux-x64-gnu/local-export-helper');
  assert.equal(manifest.targets['linux-x64-gnu'].mode, '0500');
  const helperBytes = await readFile(helperPath);
  const digest = createHash('sha256').update(helperBytes).digest('hex');
  assert.equal(manifest.targets['linux-x64-gnu'].sha256, digest);
  assert.equal(await readFile(digestPath, 'utf8'), `${digest}\n`);
  assert.equal((await lstat(helperPath)).mode & 0o777, 0o500);
  assert.equal((await lstat(manifestPath)).mode & 0o777, 0o400);
});

test('plugin publisher phase-orders runtime-only publication for absent and read-only targets', async () => {
  await withProject(async (projectRoot) => {
    const fixture = await createPublisherFixture(projectRoot);

    const firstExpected = await expectedRuntimeBytes(fixture);
    await runPublisher(fixture, ['--runtime-only']);
    const first = await activePublisherTargets(fixture);
    assert.deepEqual(await readFile(first.runtime), firstExpected);
    assert.equal(await modeOf(first.runtime), 0o644);

    await chmod(first.runtime, 0o400);
    await writeFile(fixture.runtimeSource, 'process.stdout.write("publisher-runtime-v2");\n');
    const secondExpected = await expectedRuntimeBytes(fixture);
    await runPublisher(fixture, ['--runtime-only']);
    const second = await activePublisherTargets(fixture);
    assert.deepEqual(await readFile(second.runtime), secondExpected);
    assert.notDeepEqual(secondExpected, firstExpected);
    assert.equal(await modeOf(second.runtime), 0o644);
  });
});

test('plugin publisher restores the prior complete generation when activation is interrupted', async () => {
  await withProject(async (projectRoot) => {
    const fixture = await createPublisherFixture(projectRoot);
    await runPublisher(fixture, ['--runtime-only']);
    const prior = await activePublisherTargets(fixture);
    const priorRuntime = await readFile(prior.runtime);
    await writeFile(fixture.runtimeSource, 'process.stdout.write("interrupted-runtime");\n');
    await assert.rejects(
      runPublisher(fixture, ['--runtime-only'], {
        SCENEBOARD_PLUGIN_PUBLISH_TEST_FAULT: 'after-retire',
      }),
    );
    const current = await activePublisherTargets(fixture);
    assert.deepEqual(await readFile(current.runtime), priorRuntime);
    assert.equal(await modeOf(current.runtime), 0o644);
  });
});

test('an uncatchable publisher stop before atomic activation leaves the prior release launchable', async () => {
  await withProject(async (projectRoot) => {
    const fixture = await createPublisherFixture(projectRoot);
    await runPublisher(fixture);
    const prior = await activePublisherTargets(fixture);
    const priorRuntime = await readFile(prior.runtime);
    await writeFile(fixture.runtimeSource, 'process.stdout.write("publisher-runtime-v2");\n');
    const publishing = startCheckpointProcess({
      command: process.execPath,
      args: [fixture.script],
      cwd: fixture.root,
      environment: {
        PATH: `${join(fixture.root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        SCENEBOARD_PLUGIN_PUBLISH_TEST_FAULT: 'pause-after-retire',
      },
      event: 'sceneboard_plugin_after_retire',
    });
    await publishing.checkpoint;
    publishing.child.kill('SIGKILL');
    const publishResult = await publishing.result;
    assert.equal(publishResult.signal, 'SIGKILL');
    const active = await assertCompletePublisherInventory(fixture);
    assert.deepEqual(await readFile(active.runtime), priorRuntime);
  });
});

test('overlapping publishers atomically select one complete winner across an interrupted activation', async () => {
  await withProject(async (projectRoot) => {
    const fixture = await createPublisherFixture(projectRoot);
    await runPublisher(fixture);
    await writeFile(fixture.runtimeSource, 'process.stdout.write("publisher-runtime-v2");\n');
    const versionTwo = await expectedRuntimeBytes(fixture);
    const first = startCheckpointProcess({
      command: process.execPath,
      args: [fixture.script],
      cwd: fixture.root,
      environment: {
        PATH: `${join(fixture.root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        SCENEBOARD_PLUGIN_PUBLISH_TEST_FAULT: 'pause-after-retire',
      },
      event: 'sceneboard_plugin_after_retire',
    });
    await first.checkpoint;
    await writeFile(fixture.runtimeSource, 'process.stdout.write("publisher-runtime-v3");\n');
    const second = startCheckpointProcess({
      command: process.execPath,
      args: [fixture.script],
      cwd: fixture.root,
      environment: {
        PATH: `${join(fixture.root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        SCENEBOARD_PLUGIN_PUBLISH_TEST_FAULT: 'pause-after-activate',
      },
      event: 'sceneboard_plugin_after_activate',
    });
    await second.checkpoint;
    second.child.kill('SIGKILL');
    assert.equal((await second.result).signal, 'SIGKILL');
    first.child.send('resume');
    const firstResult = await first.result;
    assert.equal(firstResult.code, 0, firstResult.stderr);
    const active = await assertCompletePublisherInventory(fixture);
    assert.deepEqual(await readFile(active.runtime), versionTwo);
  });
});

test('a launcher already in flight crosses plugin publication without observing a mixed generation', async () => {
  await withProject(async (projectRoot) => {
    const fixture = await createPublisherFixture(projectRoot);
    await runPublisher(fixture);
    const publishedPluginRoot = dirname(dirname(fixture.runtime));
    const publishedScripts = join(publishedPluginRoot, 'scripts');
    const publishedLauncher = join(publishedScripts, 'launch-sceneboard-mcp.mjs');
    const codexBinary = join(projectRoot, 'codex-unavailable.mjs');
    await mkdir(publishedScripts, { recursive: true, mode: 0o755 });
    await Promise.all([
      copyFile(launcherPath, publishedLauncher),
      copyFile(configResolverPath, join(publishedScripts, 'sceneboard-mcp-config.mjs')),
      writeFile(codexBinary, codexAbsentFixture),
      writeFile(fixture.runtimeSource, 'process.stdout.write("publisher-runtime-v2");\n'),
    ]);
    await Promise.all([chmod(publishedScripts, 0o755), chmod(codexBinary, 0o500)]);

    const launching = startCheckpointProcess({
      command: process.execPath,
      args: [publishedLauncher],
      cwd: projectRoot,
      environment: launcherEnvironment(projectRoot, {
        CODEX_BINARY: codexBinary,
        SCENEBOARD_PLUGIN_LAUNCH_TEST_FAULT: 'pause-before-production-release',
      }),
      event: 'sceneboard_plugin_before_production_release',
    });
    await launching.checkpoint;

    const publishing = startCheckpointProcess({
      command: process.execPath,
      args: [fixture.script, '--runtime-only'],
      cwd: fixture.root,
      environment: {
        PATH: `${join(fixture.root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        SCENEBOARD_PLUGIN_PUBLISH_TEST_FAULT: 'pause-after-retire',
      },
      event: 'sceneboard_plugin_after_retire',
    });
    await publishing.checkpoint;
    launching.child.send('resume');
    publishing.child.send('resume');

    const [launchResult, publishResult] = await Promise.all([launching.result, publishing.result]);
    assert.equal(launchResult.code, 0);
    assert.equal(launchResult.signal, null);
    assert.equal(launchResult.stderr, '');
    assert.equal(
      ['publisher-runtime-v1', 'publisher-runtime-v2'].includes(launchResult.stdout),
      true,
    );
    assert.equal(publishResult.code, 0, publishResult.stderr);
    assert.equal(publishResult.signal, null);
    assert.equal(publishResult.stderr, '');
    assert.deepEqual(JSON.parse(publishResult.stdout), {
      status: 'BUILT',
      runtime: 'runtime/index.js',
    });
  });
});

test('a launcher lease retains its acquired generation until the child resolves the runtime', async () => {
  await withProject(async (projectRoot) => {
    const fixture = await createPublisherFixture(projectRoot);
    await runPublisher(fixture);
    const retained = await activePublisherTargets(fixture);
    const publishedPluginRoot = dirname(dirname(fixture.runtime));
    const codexBinary = join(projectRoot, 'codex-unavailable.mjs');
    await Promise.all([
      writeFile(codexBinary, codexAbsentFixture),
      writeFile(fixture.runtimeSource, 'process.stdout.write("publisher-runtime-v2");\n'),
    ]);
    await chmod(codexBinary, 0o500);
    const launching = startCheckpointProcess({
      command: process.execPath,
      args: [join(publishedPluginRoot, 'scripts/launch-sceneboard-mcp.mjs')],
      cwd: projectRoot,
      environment: launcherEnvironment(projectRoot, {
        CODEX_BINARY: codexBinary,
        SCENEBOARD_PLUGIN_LAUNCH_TEST_FAULT: 'pause-after-production-release',
      }),
      event: 'sceneboard_plugin_after_production_release',
    });
    await launching.checkpoint;
    await runPublisher(fixture, [], { SCENEBOARD_PLUGIN_PUBLISH_TEST_CLEANUP: 'immediate' });
    assert.equal((await lstat(retained.root)).isDirectory(), true);
    launching.child.send('resume');
    assert.deepEqual(await launching.result, {
      code: 0,
      signal: null,
      stdout: 'publisher-runtime-v1',
      stderr: '',
    });
    await writeFile(fixture.runtimeSource, 'process.stdout.write("publisher-runtime-v3");\n');
    await runPublisher(fixture, [], { SCENEBOARD_PLUGIN_PUBLISH_TEST_CLEANUP: 'immediate' });
    await assert.rejects(lstat(retained.root), /ENOENT/u);
  });
});

test('plugin publisher phase-orders every native artifact and seals exact digests and modes', async () => {
  await withProject(async (projectRoot) => {
    const fixture = await createPublisherFixture(projectRoot);
    const firstExpectedRuntime = await expectedRuntimeBytes(fixture);
    await runPublisher(fixture);
    const first = await activePublisherTargets(fixture);
    const firstProfileHelper = await readFile(first.profileHelper);
    const firstExportHelper = await readFile(first.exportHelper);
    assert.deepEqual(await readFile(first.runtime), firstExpectedRuntime);

    await Promise.all(
      Object.values(first)
        .slice(1)
        .map((target) => chmod(target, 0o400)),
    );
    await Promise.all([
      writeFile(fixture.runtimeSource, 'process.stdout.write("publisher-runtime-v2");\n'),
      writeFile(fixture.profileHelperSource, 'int main(void) { return 7; }\n'),
      writeFile(fixture.exportHelperSource, 'int main(void) { return 9; }\n'),
    ]);
    const secondExpectedRuntime = await expectedRuntimeBytes(fixture);
    await runPublisher(fixture);

    const second = await activePublisherTargets(fixture);
    const profileHelper = await readFile(second.profileHelper);
    const exportHelper = await readFile(second.exportHelper);
    const profileDigest = createHash('sha256').update(profileHelper).digest('hex');
    const exportDigest = createHash('sha256').update(exportHelper).digest('hex');
    assert.deepEqual(await readFile(second.runtime), secondExpectedRuntime);
    assert.notDeepEqual(profileHelper, firstProfileHelper);
    assert.notDeepEqual(exportHelper, firstExportHelper);
    assert.equal(await readFile(second.profileDigest, 'utf8'), `${profileDigest}\n`);
    assert.equal(await readFile(second.exportDigest, 'utf8'), `${exportDigest}\n`);
    assert.equal(
      await readFile(second.exportManifest, 'utf8'),
      `${JSON.stringify(
        {
          version: 1,
          targets: {
            'linux-x64-gnu': {
              path: 'linux-x64-gnu/local-export-helper',
              sha256: exportDigest,
              mode: '0500',
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    assert.deepEqual(
      await Promise.all(Object.values(second).slice(1).map(modeOf)),
      [0o644, 0o500, 0o400, 0o500, 0o400, 0o400],
    );
  });
});
