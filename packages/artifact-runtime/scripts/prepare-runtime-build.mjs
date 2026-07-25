import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const staging = resolve(packageRoot, '.runtime-build');
if (!staging.startsWith(`${packageRoot}/`))
  throw new Error('runtime staging path escaped the package root');
await rm(staging, { recursive: true, force: true });
await mkdir(resolve(staging, 'node'), { recursive: true });
