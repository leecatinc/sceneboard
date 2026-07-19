import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SCENE_RECIPE_BLOCK_KINDS_V1 } from '../../skills/sceanboard/scripts/scene-recipe-core.mjs';
import { SCENE_ARTIFACT_MOTION_LEVELS_V1, SCENE_ARTIFACT_TEMPLATE_NAMES_V1 } from '../../skills/sceanboard/scripts/scene-artifact-core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills/sceanboard');
const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');
const reference = readFileSync(join(root, 'references/visual-composer.md'), 'utf8');
const sceneContract = readFileSync(join(root, 'references/scene-contract.md'), 'utf8');

test('router remains concise and links one progressive-disclosure reference', () => {
  assert.ok(skill.split('\n').length < 500); assert.equal(skill.match(/^## Visual composition routing$/gm)?.length, 1);
  assert.match(skill, /scripts\/scene-recipe\.mjs/); assert.match(skill, /scripts\/scene-artifact\.mjs/);
  assert.match(skill, /visual-composer\.md/); assert.ok(reference.length > 1000);
});

test('reference covers exact catalogs, commands, and output modes', () => {
  for (const value of SCENE_RECIPE_BLOCK_KINDS_V1) assert.match(reference, new RegExp(`\\b${value.replace('.', '\\.') }\\b`));
  for (const value of SCENE_ARTIFACT_TEMPLATE_NAMES_V1) assert.match(reference, new RegExp(value));
  for (const value of SCENE_ARTIFACT_MOTION_LEVELS_V1) assert.match(reference, new RegExp(`\\b${value}\\b`));
  for (const command of ['validate', 'compile', 'preset-list', 'preset-compile', 'template-list', 'place']) assert.match(reference, new RegExp(command));
  assert.match(reference, /scene-replace-input/); assert.match(reference, /result\.artifact\.artifact/);
});

test('native-first and safe two-stage routing remain explicit', () => {
  assert.ok(reference.indexOf('Native-first decision') < reference.indexOf('Artifact commands'));
  for (const text of [skill, sceneContract]) { assert.match(text, /native|trusted nodes/i); assert.match(text, /materially required|materially needs/i); assert.match(text, /Never request a CDN|never a content delivery network/i); }
  assert.match(reference, /board_artifact_put/); assert.match(reference, /board_scene_get/); assert.match(reference, /content\.artifact/);
  assert.match(reference, /expectedRevisionId/); assert.match(reference, /idempotencyKey/); assert.match(reference, /requestedCapabilities/);
  assert.match(reference, /human-readable delivery contract/); assert.match(reference, /reduced motion/);
});

test('transport and browser truth contracts are preserved', () => {
  assert.match(skill, /MCP descriptors are absent/); assert.match(skill, /Never switch transports after an MCP auth/);
  assert.match(skill, /Persistence is not proof/); assert.match(skill, /history browsing is non-destructive/i); assert.match(skill, /answered.*expired.*cancelled.*superseded/);
  assert.doesNotMatch(reference, /server (sanitizes|rewrites) JavaScript/i);
});
