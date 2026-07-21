import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('Windows fallback launcher delegates exclusively to the official Node adapter', async () => {
  const script = await read(
    '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/sceneboard-api.ps1',
  );

  assert.match(script, /Join-Path \$PSScriptRoot 'sceneboard-api\.mjs'/u);
  assert.match(script, /\$payload \| & \$node @arguments/u);
  assert.doesNotMatch(
    script,
    /Invoke-RestMethod|Invoke-WebRequest|System\.Net\.Http|curl(?:\.exe)?/iu,
  );
});

test('skill contract forbids improvised Windows REST fallback and native substitution', async () => {
  const [skill, fallback] = await Promise.all([
    read('../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/SKILL.md'),
    read('../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/references/api-fallback.md'),
  ]);

  for (const source of [skill, fallback]) {
    assert.match(source, /sceneboard-api\.ps1/u);
    assert.match(source, /Invoke-SceneBoardApi/u);
  }
  assert.match(fallback, /\$\.result\.result\.artifact\.artifact/u);
  assert.match(skill, /do not issue a substitute native Scene/u);
});
