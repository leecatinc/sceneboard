import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const staging = '/workspace/.tmp/agent/sceneboard-artifact-runtime-build';
if (!staging.startsWith('/workspace/.tmp/agent/'))
  throw new Error('runtime staging path escaped the agent temp root');
await rm(staging, { recursive: true, force: true });
await mkdir(resolve(staging, 'node'), { recursive: true });
