import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve('sceneboard-mcp/plugins/sceneboard/skills/sceneboard');
const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');
const fallback = readFileSync(join(root, 'references/api-fallback.md'), 'utf8');
const commands = readFileSync(join(root, 'references/commands.md'), 'utf8');

const requestedScopes = [
  'board.read',
  'board.write',
  'board.history.read',
  'board.hitl.request',
  'board.hitl.respond',
  'board.media.write',
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
  assert.match(skill, /board_interaction_request/);
  assert.match(skill, /automatic decision tray/);
  assert.match(skill, /content\.hitl/);
  assert.match(skill, /board_interaction_status/);
  assert.match(skill, /Visible prose.*is not an interaction/);
  assert.match(commands, /waiting message is not a substitute/);
});
