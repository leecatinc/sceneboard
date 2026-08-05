import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SCENE_RECIPE_BLOCK_KINDS_V1 } from '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/scene-recipe-core.mjs';
import {
  SCENE_ARTIFACT_MOTION_LEVELS_V1,
  SCENE_ARTIFACT_TEMPLATE_NAMES_V1,
  shouldUseSceneSlideDeck,
} from '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/scene-artifact-core.mjs';

const root = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'sceneboard-mcp/plugins/sceneboard/skills/sceneboard',
);
const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');
const reference = readFileSync(join(root, 'references/visual-composer.md'), 'utf8');
const sceneContract = readFileSync(join(root, 'references/scene-contract.md'), 'utf8');
const slideDeck = readFileSync(join(root, 'references/slide-deck.md'), 'utf8');

test('router remains concise and links one progressive-disclosure reference', () => {
  assert.ok(skill.split('\n').length < 500);
  assert.equal(skill.match(/^## Visual composition routing$/gm)?.length, 1);
  assert.match(skill, /scripts\/scene-recipe\.mjs/);
  assert.match(skill, /scripts\/scene-artifact\.mjs/);
  assert.match(skill, /visual-composer\.md/);
  assert.ok(reference.length > 1000);
});

test('reference covers exact catalogs, commands, and output modes', () => {
  for (const value of SCENE_RECIPE_BLOCK_KINDS_V1)
    assert.match(reference, new RegExp(`\\b${value.replace('.', '\\.')}\\b`));
  for (const value of SCENE_ARTIFACT_TEMPLATE_NAMES_V1) assert.match(reference, new RegExp(value));
  for (const value of SCENE_ARTIFACT_MOTION_LEVELS_V1)
    assert.match(reference, new RegExp(`\\b${value}\\b`));
  for (const command of [
    'validate',
    'compile',
    'preset-list',
    'preset-compile',
    'template-list',
    'place',
  ])
    assert.match(reference, new RegExp(command));
  assert.match(reference, /scene-replace-input/);
  assert.match(reference, /result\.artifact\.artifact/);
});

test('native-first and safe two-stage routing remain explicit', () => {
  assert.ok(reference.indexOf('Native-first decision') < reference.indexOf('Artifact commands'));
  for (const text of [skill, sceneContract]) {
    assert.match(text, /native|trusted nodes/i);
    assert.match(text, /materially required|materially needs/i);
    assert.match(text, /Never request a CDN|never a content delivery network/i);
  }
  assert.match(reference, /board_artifact_put/);
  assert.match(reference, /board_scene_get/);
  assert.match(reference, /content\.artifact/);
  assert.match(reference, /expectedRevisionId/);
  assert.match(reference, /idempotencyKey/);
  assert.match(reference, /requestedCapabilities/);
  assert.match(reference, /human-readable delivery contract/);
  assert.match(reference, /reduced motion/);
  assert.match(reference, /1920×1080/);
  assert.match(reference, /devicePixelRatio/);
  assert.match(reference, /WebGL/);
  assert.match(reference, /Three\.js r184/);
  assert.match(reference, /trusted runtime asset/i);
});

test('slide-deck routing is limited to the exact presentation-material and PPT triggers', () => {
  for (const request of ['발표자료로 만들어줘', 'PPT로 만들어줘', 'ppt 자료', 'PpT deck'])
    assert.equal(shouldUseSceneSlideDeck(request), true);
  for (const request of [
    '일반 보드 작성 요청',
    'Markdown 문서로 정리해줘',
    'presentation으로 만들어줘',
    '프레젠테이션 개요를 만들어줘',
    '탭으로 구분해줘',
  ])
    assert.equal(shouldUseSceneSlideDeck(request), false);
  assert.match(skill, /If and only if/);
  assert.match(skill, /발표자료/);
  assert.match(skill, /case|letter case/i);
  assert.match(skill, /presentation.*do not activate|do not activate.*presentation/is);
  assert.match(slideDeck, /Exact routing contract/);
  assert.match(slideDeck, /changePresentationPage/);
  assert.match(slideDeck, /initial notification|first slide is visible/i);
  assert.match(skill, /custom HTML or PPT-derived presentation artifacts/i);
  assert.match(skill, /stable logical page IDs/i);
});

test('transport and browser truth contracts are preserved', () => {
  assert.match(skill, /MCP descriptors are absent/);
  assert.match(skill, /Never switch transports after an MCP auth/);
  assert.match(skill, /Persistence is not proof/);
  assert.match(skill, /history browsing is non-destructive/i);
  assert.match(skill, /answered.*expired.*cancelled.*superseded/);
  assert.doesNotMatch(reference, /server (sanitizes|rewrites) JavaScript/i);
});
