import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const staging = resolve(packageRoot, '.runtime-build');
const publicDirectory = resolve(staging, 'public');
const assetsDirectory = resolve(publicDirectory, 'assets');
const output = resolve(packageRoot, 'dist');
const prior = resolve(packageRoot, '.runtime-build-prior');
const source = resolve(packageRoot, 'src/runner');
const mediaType = 'application/javascript; charset=utf-8';

await access(resolve(staging, 'node/server/main.js'));
await mkdir(assetsDirectory, { recursive: true });

const mermaidSource = resolve(packageRoot, '../../node_modules/mermaid/dist/mermaid.min.js');
try {
  await access(mermaidSource);
} catch {
  throw new Error('the pinned Mermaid package is required to build the artifact runtime');
}
const mermaidBytes = await readFile(mermaidSource);
const mermaidHash = createHash('sha256').update(mermaidBytes).digest('hex');
const mermaidPath = `/assets/mermaid.${mermaidHash}.js`;

const threeResult = await build({
  entryPoints: [resolve(source, 'three-global.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'none',
  sourcemap: false,
  charset: 'utf8',
});
const threeBytes = threeResult.outputFiles?.[0]?.contents;
if (threeBytes === undefined) throw new Error('Three.js did not emit one fixed asset');
const threeHash = createHash('sha256').update(threeBytes).digest('hex');
const threePath = `/assets/three.${threeHash}.js`;

const innerResult = await build({
  entryPoints: [resolve(source, 'inner-bootstrap.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'none',
  sourcemap: false,
  charset: 'utf8',
});
const innerBytes = innerResult.outputFiles?.[0]?.contents;
if (innerBytes === undefined) throw new Error('inner bootstrap did not emit one fixed asset');

const outerResult = await build({
  entryPoints: [resolve(source, 'outer.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'none',
  sourcemap: false,
  charset: 'utf8',
  define: {
    __INNER_BOOTSTRAP_SOURCE__: JSON.stringify(new TextDecoder().decode(innerBytes)),
    __MERMAID_ASSET_PATH__: JSON.stringify(mermaidPath),
    __THREE_ASSET_PATH__: JSON.stringify(threePath),
  },
});
const outerBytes = outerResult.outputFiles?.[0]?.contents;
if (outerBytes === undefined) throw new Error('outer runner did not emit one fixed asset');
const outerHash = createHash('sha256').update(outerBytes).digest('hex');
const outerPath = `/assets/outer.${outerHash}.js`;

const entries = [
  {
    logicalName: 'mermaid',
    path: mermaidPath,
    sha256: mermaidHash,
    byteLength: mermaidBytes.byteLength,
    mediaType,
  },
  {
    logicalName: 'outer',
    path: outerPath,
    sha256: outerHash,
    byteLength: outerBytes.byteLength,
    mediaType,
  },
  {
    logicalName: 'three',
    path: threePath,
    sha256: threeHash,
    byteLength: threeBytes.byteLength,
    mediaType,
  },
].sort((left, right) => left.path.localeCompare(right.path));
const template = await readFile(resolve(source, 'runner.html'), 'utf8');
if ((template.match(/__OUTER_ASSET_PATH__/g) ?? []).length !== 1)
  throw new Error('runner template outer placeholder is invalid');
const runner = template.replace('__OUTER_ASSET_PATH__', outerPath);

await Promise.all([
  writeFile(resolve(publicDirectory, `.${mermaidPath}`), mermaidBytes, { flag: 'wx' }),
  writeFile(resolve(publicDirectory, `.${outerPath}`), outerBytes, { flag: 'wx' }),
  writeFile(resolve(publicDirectory, `.${threePath}`), threeBytes, { flag: 'wx' }),
  writeFile(resolve(publicDirectory, 'runner.html'), runner, { encoding: 'utf8', flag: 'wx' }),
  writeFile(
    resolve(publicDirectory, 'fixed-assets.v1.json'),
    `${JSON.stringify(entries, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  ),
]);

await rm(prior, { recursive: true, force: true });
let movedPrior = false;
try {
  await rename(output, prior);
  movedPrior = true;
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
try {
  await rename(staging, output);
  await rm(prior, { recursive: true, force: true });
} catch (error) {
  if (movedPrior) await rename(prior, output).catch(() => undefined);
  throw error;
}
