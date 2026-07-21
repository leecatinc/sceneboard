import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOCAL_BOARD_API_ORIGIN = 'http://127.0.0.1:3411';
const LOCAL_ARTIFACT_RUNTIME_ORIGIN = 'http://127.0.0.2:3412';

export const createBuildCheckEnvironment = (source = process.env) => ({
  ...source,
  NODE_ENV: 'production',
  SCENEBOARD_NEXT_DIST_DIR: '.next-check',
  NEXT_PUBLIC_BOARD_API_URL: source.NEXT_PUBLIC_BOARD_API_URL ?? LOCAL_BOARD_API_ORIGIN,
  NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN:
    source.NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN ?? LOCAL_ARTIFACT_RUNTIME_ORIGIN,
});

export const withRestoredFile = (path, action) => {
  const original = readFileSync(path);
  try {
    return action();
  } finally {
    const current = readFileSync(path);
    if (!current.equals(original)) writeFileSync(path, original);
  }
};

const run = () => {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined || npmCli.length === 0) {
    throw new TypeError('npm_execpath is required to run the workspace build check');
  }

  const declarationPath = resolve(process.cwd(), 'sceneboard-fe', 'next-env.d.ts');
  const result = withRestoredFile(declarationPath, () =>
    spawnSync(process.execPath, [npmCli, 'run', 'build'], {
      cwd: process.cwd(),
      env: createBuildCheckEnvironment(),
      stdio: 'inherit',
    }),
  );

  if (result.error !== undefined) throw result.error;
  process.exitCode = result.status ?? 1;
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) run();
