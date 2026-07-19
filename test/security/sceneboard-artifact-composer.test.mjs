import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  SCENE_ARTIFACT_MOTION_LEVELS_V1,
  SCENE_ARTIFACT_TEMPLATE_NAMES_V1,
  SceneArtifactError,
  auditSceneArtifactSource,
  compileSceneArtifactDraft,
  createSceneArtifactPlacement,
  validateSceneArtifactTemplateDescriptor,
} from '../../skills/sceanboard/scripts/scene-artifact-core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(root, 'skills/sceanboard/scripts/scene-artifact.mjs');
const descriptor = (name) => validateSceneArtifactTemplateDescriptor(JSON.parse(readFileSync(join(root, 'skills/sceanboard/assets/artifact-templates', `${name}.json`), 'utf8')));
const recipe = (template, motion = 'subtle') => ({
  artifactRecipeVersion: 1, template, placementKey: `${template}-visual`, title: 'Visual summary', fallbackText: 'The complete facts are listed in this visual.', theme: 'light', size: descriptor(template).defaultSize, motion,
  content: template === 'metric-story' ? { metrics: [{ label: 'Completion', value: '75%', detail: 'Three stages are complete.', trend: 'up' }] }
    : template === 'process-flow' ? { steps: [{ label: 'Prepare', detail: null, status: 'complete' }, { label: 'Review', detail: 'Check the evidence.', status: 'active' }] }
      : template === 'architecture-map' ? { nodes: [{ key: 'source', label: 'Source', role: 'source' }, { key: 'service', label: 'Service', role: 'service' }], edges: [{ from: 'source', to: 'service', label: 'Sends data' }] }
        : template === 'timeline' ? { events: [{ date: 'First', label: 'Prepare', detail: null, status: 'past' }, { date: 'Next', label: 'Review', detail: null, status: 'current' }] }
          : { seriesLabel: 'Completion', unit: '%', points: [{ label: 'First', value: 25 }, { label: 'Second', value: 75 }] },
});

test('template catalog and motion catalog are exact', () => {
  assert.deepEqual(SCENE_ARTIFACT_TEMPLATE_NAMES_V1, ['animated-data-story', 'architecture-map', 'metric-story', 'process-flow', 'timeline']);
  assert.deepEqual(SCENE_ARTIFACT_MOTION_LEVELS_V1, ['none', 'subtle', 'staged', 'focus']);
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [cli, 'template-list'], { encoding: 'utf8' })).templates, SCENE_ARTIFACT_TEMPLATE_NAMES_V1);
});

test('every closed template compiles with accessible static meaning', () => {
  for (const template of SCENE_ARTIFACT_TEMPLATE_NAMES_V1) for (const motion of SCENE_ARTIFACT_MOTION_LEVELS_V1) {
    const draft = compileSceneArtifactDraft(recipe(template, motion), descriptor(template));
    assert.equal(draft.source.artifactId, null); assert.deepEqual(draft.source.requestedCapabilities, []);
    assert.match(draft.source.html, /<h1>Visual summary<\/h1>/); assert.match(draft.source.html, /complete facts/);
    if (motion === 'none') assert.doesNotMatch(draft.source.css, /prefers-reduced-motion/); else assert.match(draft.source.css, /prefers-reduced-motion/);
  }
});

test('publication placement is a separate immutable boundary', () => {
  const draft = compileSceneArtifactDraft(recipe('metric-story'), descriptor('metric-story'));
  assert.throws(() => createSceneArtifactPlacement(draft), (error) => error instanceof SceneArtifactError && error.code === 'UNKNOWN_FIELD');
  const node = createSceneArtifactPlacement({ artifact: { artifactId: 'artifact_1', versionId: 'version_1' }, placement: draft.placement });
  assert.equal(node.type, 'content.artifact'); assert.deepEqual(node.artifact, { artifactId: 'artifact_1', versionId: 'version_1' });
});

test('source audit rejects scripts, resources, capabilities, and foreign JavaScript', () => {
  const source = compileSceneArtifactDraft(recipe('metric-story'), descriptor('metric-story')).source;
  for (const mutation of [
    { ...source, html: '<script>alert(1)</script>' }, { ...source, css: '@import "remote";' },
    { ...source, javascript: 'alert(1)' }, { ...source, requestedCapabilities: ['network.fetch'] },
  ]) assert.throws(() => auditSceneArtifactSource(mutation), (error) => error.code === 'UNSAFE_ARTIFACT_SOURCE');
});

test('hostile recipe text is escaped and never echoed by CLI failures', () => {
  const hostile = recipe('metric-story'); hostile.content.metrics[0].label = '<img src=x onerror=alert(1)>';
  const draft = compileSceneArtifactDraft(hostile, descriptor('metric-story'));
  assert.doesNotMatch(draft.source.html, /<img/); assert.match(draft.source.html, /&lt;img/);
  const canary = 'SECRET-CANARY-ARTIFACT'; hostile.content.metrics[0].label = canary.repeat(20);
  const result = spawnSync(process.execPath, [cli, 'compile'], { input: JSON.stringify(hostile), encoding: 'utf8' });
  assert.equal(result.status, 2); assert.doesNotMatch(result.stderr, new RegExp(canary));
});
