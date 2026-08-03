import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(new URL('..', import.meta.url).pathname);
const runtimeRoot = process.env.SCENEBOARD_EXPORT_RUNTIME_ROOT ?? '/opt/sceneboard';
const chromium = JSON.parse(
  await readFile(resolve(repositoryRoot, 'deploy/sceneboard-be-export/chromium.lock.json'), 'utf8'),
);
const fonts = JSON.parse(
  await readFile(resolve(repositoryRoot, 'deploy/sceneboard-be-export/fonts.lock.json'), 'utf8'),
);
const browserCatalog = JSON.parse(
  await readFile(resolve(repositoryRoot, 'node_modules/playwright-core/browsers.json'), 'utf8'),
);
const installedPlaywright = JSON.parse(
  await readFile(resolve(repositoryRoot, 'node_modules/playwright/package.json'), 'utf8'),
);
const installedPptxGen = JSON.parse(
  await readFile(resolve(repositoryRoot, 'node_modules/pptxgenjs/package.json'), 'utf8'),
);
const runtimePackages = (
  await readFile(
    resolve(repositoryRoot, 'deploy/sceneboard-be-export/runtime-packages.lock'),
    'utf8',
  )
)
  .split('\n')
  .map((value) => value.trim())
  .filter(Boolean);
const selected = browserCatalog.browsers.find((entry) => entry.name === chromium.browserName);
if (
  installedPlaywright.version !== chromium.playwrightVersion ||
  selected?.revision !== chromium.revision ||
  selected?.browserVersion !== chromium.browserVersion
)
  throw new Error('locked Playwright Chromium identity does not match');
if (installedPptxGen.version !== '4.0.1')
  throw new Error('locked PptxGenJS identity does not match');

for (const locked of runtimePackages) {
  const separator = locked.indexOf('=');
  if (separator < 1) throw new Error('runtime package lock is invalid');
  const name = locked.slice(0, separator);
  const version = locked.slice(separator + 1);
  const installed = spawnSync('dpkg-query', ['-W', '-f=${Version}', name], { encoding: 'utf8' });
  if (installed.status !== 0 || installed.stdout.trim() !== version)
    throw new Error(`locked runtime package mismatch: ${name}`);
}

const executable = resolve(runtimeRoot, 'ms-playwright', chromium.executableRelativePath);
await access(executable);
const ldd = spawnSync('ldd', [executable], { encoding: 'utf8' });
if (ldd.status !== 0 || /not found/u.test(`${ldd.stdout}${ldd.stderr}`))
  throw new Error('locked Chromium has unresolved shared libraries');

for (const font of fonts.fonts) {
  const bytes = await readFile(resolve(runtimeRoot, 'fonts', font.file));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== font.sha256) throw new Error(`locked export font mismatch: ${font.subset}`);
}
await access(resolve(runtimeRoot, 'fonts/OFL-1.1.txt'));
const [sourceLua, builtLua] = await Promise.all([
  readFile(resolve(repositoryRoot, 'sceneboard-be/src/exports/export-render-session-v1.lua')),
  readFile(resolve(repositoryRoot, 'sceneboard-be/dist/exports/export-render-session-v1.lua')),
]);
if (!sourceLua.equals(builtLua)) throw new Error('built export render Lua does not match source');
process.stdout.write(
  `verified Playwright ${chromium.playwrightVersion}, Chromium ${chromium.revision}, PptxGenJS ${installedPptxGen.version}, ${runtimePackages.length} runtime packages, Lua, and ${fonts.fonts.length} fonts\n`,
);
