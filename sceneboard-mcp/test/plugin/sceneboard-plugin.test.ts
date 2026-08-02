import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  const nativeRoot = join(root, 'sceneboard-mcp/plugins/sceneboard/native');
  await Promise.all([
    mkdir(join(root, 'scripts'), { recursive: true }),
    mkdir(join(root, 'bin'), { recursive: true }),
    mkdir(join(root, 'sceneboard-mcp/src'), { recursive: true }),
    mkdir(join(root, 'sceneboard-mcp/native'), { recursive: true }),
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
  ]);
  await chmod(compiler, 0o500);
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

const runPublisher = async (fixture: PublisherFixture, args: string[] = []) => {
  const result = await new Promise<LauncherResult>((resolveResult, reject) => {
    const child = spawn(process.execPath, [fixture.script, ...args], {
      cwd: fixture.root,
      env: { PATH: `${join(fixture.root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}` },
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
      run: () => ({ status: 1, stdout: '' }),
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
      run: () => ({ status: 1, stdout: '' }),
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
      run: () => ({ status: 1, stdout: '' }),
    });
    assert.equal(selected.source, 'production_default');
    assert.equal(selected.server.env.BOARD_CREDENTIAL_MODE, 'api_key');
    assert.equal(selected.server.env.BOARD_ACCESS_TOKEN_REF, 'env://SCENEBOARD_API_KEY');
    assert.equal('SCENEBOARD_API_KEY' in selected.server.env, false);
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

for (const mode of ['api_key', 'pairing'] as const) {
  test(`production ${mode} launcher forwards only its declared credential contract`, async () => {
    await withProject(async (projectRoot) => {
      const fixture = await createLauncherFixture(projectRoot);
      const codexBinary = join(projectRoot, 'codex-unavailable.mjs');
      await writeFile(codexBinary, `#!${process.execPath}\nprocess.exitCode = 1;\n`);
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

test('does not recursively select the plugin launcher from Codex config', async () => {
  await withProject(async (projectRoot) => {
    const selected = await resolveSceneBoardServer({
      cwd: projectRoot,
      pluginRoot,
      run: () => ({
        status: 0,
        stdout: JSON.stringify({
          name: 'sceneboard',
          enabled: true,
          transport: {
            type: 'stdio',
            command: 'node',
            args: ['/plugin/scripts/launch-sceneboard-mcp.mjs'],
            env: {},
          },
        }),
      }),
    });
    assert.equal(selected.source, 'production_default');
  });
});

test('the shipped recursive project and Codex descriptors fall back without forwarding credentials', async () => {
  const shipped = JSON.parse(await readFile(join(pluginRoot, '.mcp.json'), 'utf8')).mcpServers
    .sceneboard;
  const secret = `sbk_v1.${'E'.repeat(22)}.${'F'.repeat(43)}`;
  for (const source of ['project', 'codex'] as const) {
    await withProject(async (projectRoot) => {
      if (source === 'project') {
        await writeFile(
          join(projectRoot, '.mcp.json'),
          JSON.stringify({ mcpServers: { sceneboard: shipped } }),
        );
      }
      const selected = await resolveSceneBoardServer({
        cwd: projectRoot,
        pluginRoot,
        environment: {
          BOARD_CREDENTIAL_MODE: 'api_key',
          BOARD_ACCESS_TOKEN_REF: 'env://SCENEBOARD_API_KEY',
          BOARD_PROFILE: 'sceneboard',
          SCENEBOARD_API_KEY: secret,
        },
        run: () =>
          source === 'codex'
            ? {
                status: 0,
                stdout: JSON.stringify({
                  name: 'sceneboard',
                  enabled: true,
                  transport: { type: 'stdio', ...shipped },
                }),
              }
            : { status: 1, stdout: '' },
      });
      assert.equal(selected.source, 'production_default');
      assert.equal('SCENEBOARD_API_KEY' in selected.server.env, false);
      assert.equal(JSON.stringify(selected).includes(secret), false);
    });
  }
});

for (const source of ['project', 'codex'] as const) {
  for (const secretCase of [
    { name: 'case-variant literal key', key: 'SceneBoard_Api_Key', value: 'not-a-key' },
    {
      name: 'aliased literal value',
      key: 'API_KEY_BACKUP',
      value: `sbk_v1.${'G'.repeat(22)}.${'H'.repeat(43)}`,
    },
  ] as const) {
    test(`recursive ${source} config rejects ${secretCase.name} without disclosure`, async () => {
      await withProject(async (projectRoot) => {
        const transport = {
          type: 'stdio',
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
                    stdout: JSON.stringify({ name: 'sceneboard', enabled: true, transport }),
                  }
                : { status: 1, stdout: '' },
          }),
          (thrown: unknown) => {
            assert(thrown instanceof TypeError);
            assert.equal(thrown.message, `invalid_sceneboard_${source}_raw_api_key`);
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
        run: () => ({ status: 1, stdout: '' }),
      }),
      /invalid_sceneboard_project_command/,
    );
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
        run: () => ({ status: 1, stdout: '' }),
      }),
      /invalid_sceneboard_project_raw_api_key/,
    );
  });
});

for (const source of ['project', 'codex'] as const) {
  for (const secretCase of [
    { name: 'case-variant reserved name', key: 'sceneboard_api_key', inherited: false },
    { name: 'aliased literal value', key: 'API_KEY_BACKUP', inherited: false },
    { name: 'case-variant inherited name', key: 'SceneBoard_Api_Key', inherited: true },
    { name: 'aliased inherited value', key: 'API_KEY_BACKUP', inherited: true },
  ] as const) {
    test(`${source} config rejects ${secretCase.name} without disclosing the field or value`, async () => {
      await withProject(async (projectRoot) => {
        const secret = `sbk_v1.${'C'.repeat(22)}.${'D'.repeat(43)}`;
        const transport = {
          type: 'stdio',
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
                      transport,
                    }),
                  }
                : { status: 1, stdout: '' },
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
        run: () => ({ status: 1, stdout: '' }),
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
    assert.deepEqual(await readFile(fixture.runtime), firstExpected);
    assert.equal(await modeOf(fixture.runtime), 0o644);

    await chmod(fixture.runtime, 0o400);
    await writeFile(fixture.runtimeSource, 'process.stdout.write("publisher-runtime-v2");\n');
    const secondExpected = await expectedRuntimeBytes(fixture);
    await runPublisher(fixture, ['--runtime-only']);
    assert.deepEqual(await readFile(fixture.runtime), secondExpected);
    assert.notDeepEqual(secondExpected, firstExpected);
    assert.equal(await modeOf(fixture.runtime), 0o644);
  });
});

test('plugin publisher phase-orders every native artifact and seals exact digests and modes', async () => {
  await withProject(async (projectRoot) => {
    const fixture = await createPublisherFixture(projectRoot);
    const targets = [
      fixture.runtime,
      fixture.profileHelper,
      fixture.profileDigest,
      fixture.exportHelper,
      fixture.exportDigest,
      fixture.exportManifest,
    ];

    const firstExpectedRuntime = await expectedRuntimeBytes(fixture);
    await runPublisher(fixture);
    const firstProfileHelper = await readFile(fixture.profileHelper);
    const firstExportHelper = await readFile(fixture.exportHelper);
    assert.deepEqual(await readFile(fixture.runtime), firstExpectedRuntime);

    await Promise.all(targets.map((target) => chmod(target, 0o400)));
    await Promise.all([
      writeFile(fixture.runtimeSource, 'process.stdout.write("publisher-runtime-v2");\n'),
      writeFile(fixture.profileHelperSource, 'int main(void) { return 7; }\n'),
      writeFile(fixture.exportHelperSource, 'int main(void) { return 9; }\n'),
    ]);
    const secondExpectedRuntime = await expectedRuntimeBytes(fixture);
    await runPublisher(fixture);

    const profileHelper = await readFile(fixture.profileHelper);
    const exportHelper = await readFile(fixture.exportHelper);
    const profileDigest = createHash('sha256').update(profileHelper).digest('hex');
    const exportDigest = createHash('sha256').update(exportHelper).digest('hex');
    assert.deepEqual(await readFile(fixture.runtime), secondExpectedRuntime);
    assert.notDeepEqual(profileHelper, firstProfileHelper);
    assert.notDeepEqual(exportHelper, firstExportHelper);
    assert.equal(await readFile(fixture.profileDigest, 'utf8'), `${profileDigest}\n`);
    assert.equal(await readFile(fixture.exportDigest, 'utf8'), `${exportDigest}\n`);
    assert.equal(
      await readFile(fixture.exportManifest, 'utf8'),
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
      await Promise.all(targets.map(modeOf)),
      [0o644, 0o500, 0o400, 0o500, 0o400, 0o400],
    );
  });
});
