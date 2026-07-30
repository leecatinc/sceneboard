import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

const source = new URL('../native/local-export-helper.c', import.meta.url);
const directory = new URL('../native/linux-x64-gnu/', import.meta.url);
const output = new URL('local-export-helper', directory);
const temporary = new URL('local-export-helper.tmp', directory);
const digest = new URL('local-export-helper.sha256', directory);
const manifest = new URL('../native/local-export-helper.manifest.json', import.meta.url);

const setExactMode = async (path, mode) => {
  const clearAcl = spawn('/usr/bin/setfacl', ['-b', path.pathname], { stdio: 'ignore' });
  await new Promise((resolve) => {
    clearAcl.once('error', () => resolve(null));
    clearAcl.once('exit', resolve);
  });
  await chmod(path, mode);
};

await mkdir(directory, { recursive: true });
await rm(temporary, { force: true });
const child = spawn(
  'cc',
  [
    '-std=c17',
    '-D_FORTIFY_SOURCE=2',
    '-O2',
    '-fPIE',
    '-pie',
    '-Wl,--build-id=none',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-o',
    temporary.pathname,
    source.pathname,
  ],
  { stdio: 'inherit', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
);
const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', resolve);
});
if (exitCode !== 0) throw new Error('local export helper compilation failed');
await rename(temporary, output);
await setExactMode(output, 0o500);
const hash = createHash('sha256')
  .update(await readFile(output))
  .digest('hex');
await setExactMode(digest, 0o600).catch((error) => {
  if (error?.code !== 'ENOENT') throw error;
});
await writeFile(digest, `${hash}\n`, { mode: 0o400 });
await setExactMode(digest, 0o400);
await setExactMode(manifest, 0o600).catch((error) => {
  if (error?.code !== 'ENOENT') throw error;
});
await writeFile(
  manifest,
  `${JSON.stringify(
    {
      version: 1,
      targets: {
        'linux-x64-gnu': {
          path: 'linux-x64-gnu/local-export-helper',
          sha256: hash,
          mode: '0500',
        },
      },
    },
    null,
    2,
  )}\n`,
  { mode: 0o400 },
);
await setExactMode(manifest, 0o400);
