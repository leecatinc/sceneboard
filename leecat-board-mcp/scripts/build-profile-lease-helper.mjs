import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';

const source = new URL('../native/profile-lease-helper.c', import.meta.url);
const output = new URL('../native/profile-lease-helper', import.meta.url);
const temporary = new URL('../native/profile-lease-helper.tmp', import.meta.url);
const digest = new URL('../native/profile-lease-helper.sha256', import.meta.url);
const temporaryDigest = new URL('../native/profile-lease-helper.sha256.tmp', import.meta.url);

const setExactMode = async (path, mode) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const chmod = spawn('/usr/bin/chmod', [mode, path.pathname], { stdio: 'inherit' });
    const exitCode = await new Promise((resolve, reject) => {
      chmod.once('error', reject);
      chmod.once('exit', resolve);
    });
    if (exitCode !== 0) throw new Error('profile lease helper permission setup failed');
    if (((await lstat(path)).mode & 0o777) === Number.parseInt(mode, 8)) return;
  }
  throw new Error('profile lease helper exact mode could not be established');
};

await rm(temporary, { force: true });
const child = spawn('cc', ['-std=c17', '-D_FORTIFY_SOURCE=2', '-O2', '-fPIE', '-pie', '-Wall', '-Wextra', '-Werror', '-o', temporary.pathname, source.pathname], {
  stdio: 'inherit',
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
});
const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', resolve);
});
if (exitCode !== 0) throw new Error('profile lease helper compilation failed');
await rename(temporary, output);
await setExactMode(output, '0500');
const hash = createHash('sha256').update(await readFile(output)).digest('hex');
await rm(temporaryDigest, { force: true });
await writeFile(temporaryDigest, `${hash}\n`, { flag: 'wx', mode: 0o400 });
await rename(temporaryDigest, digest);
