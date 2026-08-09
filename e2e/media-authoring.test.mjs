import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('web and MCP authoring consume the one canonical image placement transform', () => {
  const web = read('sceneboard-fe/components/board/BoardImageUploadControl.tsx');
  const mcp = read('sceneboard-mcp/src/tools/media.tools.ts');
  const canonical = read('packages/board-sdk/src/document-transform/document-transform.ts');
  for (const consumer of [web, mcp]) {
    assert.match(consumer, /@sceneboard\/board-sdk\/document-transform/u);
    assert.match(consumer, /placeMediaImageOnPageV1/u);
  }
  assert.match(canonical, /export (?:const|function) placeMediaImageOnPageV1/u);
  assert.doesNotMatch(mcp, /(?:function|const) placeMediaImageOnPageV1\s*[=(]/u);
});

test('installed skill has one synthetic caller path and no output-path echo instruction', () => {
  const commands = read(
    'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/references/commands.md',
  );
  const skill = read('sceneboard-mcp/plugins/sceneboard/skills/sceneboard/SKILL.md');
  const combined = `${skill}\n${commands}`;
  assert.equal(combined.match(/\/absolute\/path\/to\/image\.png/gu)?.length, 1);
  assert.match(commands, /sceneboard_media_upload/u);
  assert.match(commands, /sceneboard_media_place/u);
  assert.doesNotMatch(combined, /(?:result|response|error|log|state).{0,40}\/absolute\/path/iu);
});
