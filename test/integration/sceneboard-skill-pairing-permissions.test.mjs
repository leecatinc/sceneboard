import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve('skills/sceanboard');
const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');
const fallback = readFileSync(join(root, 'references/api-fallback.md'), 'utf8');
const commands = readFileSync(join(root, 'references/commands.md'), 'utf8');
const demoCommon = readFileSync(resolve('demo/_COMMON.md'), 'utf8');
const numberedDemos = [
  '01-hitl-illustration.md',
  '02-3d-paper-diorama.md',
  '03-interactive-app-prototype.md',
  '04-live-data-story.md',
  '05-architecture-incident.md',
  '06-revision-time-travel.md',
  '07-code-review-visual.md',
].map((name) => [name, readFileSync(resolve('demo', name), 'utf8')]);

const requestedScopes = [
  'board.read',
  'board.write',
  'board.history.read',
  'board.hitl.request',
  'board.hitl.respond',
  'artifact.publish',
  'artifact.control',
];
const requestedLifecyclePermissions = ['board.create', 'board.archive'];

test('skill pairing requests every supported grant scope and lifecycle permission', () => {
  for (const capability of [...requestedScopes, ...requestedLifecyclePermissions]) {
    assert.ok(skill.includes(`\`${capability}\``));
  }
  assert.match(skill, /Always request the complete grant catalog/);
  assert.match(skill, /never claim unapproved capabilities/);
});

test('API fallback pairing example sends the complete ordered catalogs', () => {
  const match = fallback.match(/Send this exact object on stdin:\s*```json\s*([\s\S]*?)\s*```/);
  assert.ok(match);
  const input = JSON.parse(match[1]);

  assert.deepEqual(input.requestedScopes, requestedScopes);
  assert.deepEqual(input.requestedLifecyclePermissions, requestedLifecyclePermissions);
});

test('HITL guidance requires a real open request, visible presentation, and bounded status waits', () => {
  for (const source of [skill, demoCommon]) {
    assert.match(source, /board_interaction_request/);
    assert.match(source, /automatic decision tray/);
    assert.match(source, /content\.hitl/);
    assert.match(source, /board_interaction_status/);
  }
  assert.match(skill, /Visible prose.*is not an interaction/);
  assert.match(commands, /waiting message is not a substitute/);
});

test('numbered demos reuse one approved board and clear its live Scene without re-pairing', () => {
  assert.match(demoCommon, /Pair once before the first recording/);
  assert.match(demoCommon, /board_connection_status/);
  assert.match(demoCommon, /board_scene_clear/);
  assert.match(demoCommon, /Reuse the same board across every demo file/);

  for (const [name, source] of numberedDemos) {
    assert.doesNotMatch(source, /PAIRING_CODE|\{\{SB_CODE\}\}/, name);
    assert.match(source, /mandatory shared-board reset/, name);
    assert.match(source, /Do not pair again or create another board/, name);
  }
});
