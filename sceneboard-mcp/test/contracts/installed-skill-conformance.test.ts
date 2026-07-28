import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { BOARD_TOOL_NAMES_V1 } from '../../src/tools/register-tools.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = resolve(packageRoot, 'plugins/sceneboard/skills/sceneboard');
const referenceNames = [
  'commands.md',
  'auth-and-config.md',
  'scene-contract.md',
  'artifacts.md',
  'history.md',
  'fallback.md',
  'platform.md',
] as const;

test('downloadable sceneboard skill matches the exact terminal tool and authority contracts', async () => {
  const skill = await readFile(join(root, 'SKILL.md'), 'utf8');
  const references = Object.fromEntries(
    await Promise.all(
      referenceNames.map(
        async (name) => [name, await readFile(join(root, 'references', name), 'utf8')] as const,
      ),
    ),
  );
  const combined = `${skill}\n${Object.values(references).join('\n')}`;

  const i40SourceOnly = new Set(['sceneboard_media_upload', 'sceneboard_media_place']);
  for (const name of BOARD_TOOL_NAMES_V1.filter((candidate) => !i40SourceOnly.has(candidate)))
    assert.equal(combined.includes(`\`${name}\``), true, name);
  for (const name of i40SourceOnly) assert.equal(combined.includes(`\`${name}\``), false, name);
  assert.match(skill, /exactly the 28|all 28 terminal descriptors/u);
  assert.match(skill, /board_artifact_remove.*do not exist|board_artifact_remove.*does not exist/u);
  assert.match(
    skill,
    /board_interaction_cancel.*do not exist|board_interaction_cancel.*does not exist/u,
  );
  assert.match(skill, /bounded-wait status is the default|primary delivery path/u);
  assert.match(skill, /vendored fixed Mermaid|vendored content-hashed Mermaid/u);
  assert.match(skill, /Raster data is a `data:` URI/u);
  assert.match(references['commands.md'] ?? '', /only reachable `CAPABILITY_DENIED` branch/u);
  assert.match(
    references['scene-contract.md'] ?? '',
    /packages\/board-sdk\/scene-transform|board_scene_patch/u,
  );
  assert.match(references['history.md'] ?? '', /MySQL owns.*pairing records\/deadlines\/outcomes/u);
  assert.match(references['platform.md'] ?? '', /Redis is never pairing-state\/TTL/u);

  assert.doesNotMatch(
    combined,
    /server confirms exactly one active writable board|the only active board/u,
  );
  assert.doesNotMatch(combined, /Redis owns[^\n]*pairing state|Redis[^\n]*pairing TTL/u);
  assert.doesNotMatch(
    combined,
    /Use transient patches|Default `checkpoint`|common fields \+ optional `message`/u,
  );
  assert.doesNotMatch(
    combined,
    /shared DTOs, scene\/layout\/block schemas|Keep a stable `blockId`/u,
  );
});
