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
} from '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/scene-artifact-core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(
  root,
  'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/scene-artifact.mjs',
);
const descriptor = (name) =>
  validateSceneArtifactTemplateDescriptor(
    JSON.parse(
      readFileSync(
        join(
          root,
          'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/assets/artifact-templates',
          `${name}.json`,
        ),
        'utf8',
      ),
    ),
  );
const recipe = (template, motion = 'subtle') => ({
  artifactRecipeVersion: 1,
  template,
  placementKey: `${template}-visual`,
  title: 'Visual summary',
  fallbackText: 'The complete facts are listed in this visual.',
  theme: template === 'slide-deck' ? 'dark' : 'light',
  size: descriptor(template).defaultSize,
  motion,
  content:
    template === 'metric-story'
      ? {
          metrics: [
            {
              label: 'Completion',
              value: '75%',
              detail: 'Three stages are complete.',
              trend: 'up',
            },
          ],
        }
      : template === 'demo-showcase'
        ? { kind: 'illustration', selection: 'sunny-garden', phase: 'outline' }
        : template === 'slide-deck'
          ? {
              deckLabel: 'Visual summary',
              slides: [
                {
                  key: 'summary',
                  type: 'cover',
                  eyebrow: null,
                  title: 'Visual summary',
                  subtitle: 'The complete facts are listed in this visual.',
                  badges: ['PPT'],
                  highlights: [
                    {
                      label: 'Complete',
                      detail: 'The closed slide deck preserves accessible meaning.',
                    },
                  ],
                },
              ],
            }
          : template === 'webgl-showcase' || template === 'threejs-showcase'
            ? { scene: 'garden-cat', camera: 'orbit' }
            : template === 'process-flow'
              ? {
                  steps: [
                    { label: 'Prepare', detail: null, status: 'complete' },
                    { label: 'Review', detail: 'Check the evidence.', status: 'active' },
                  ],
                }
              : template === 'architecture-map'
                ? {
                    nodes: [
                      { key: 'source', label: 'Source', role: 'source' },
                      { key: 'service', label: 'Service', role: 'service' },
                    ],
                    edges: [{ from: 'source', to: 'service', label: 'Sends data' }],
                  }
                : template === 'timeline'
                  ? {
                      events: [
                        { date: 'First', label: 'Prepare', detail: null, status: 'past' },
                        { date: 'Next', label: 'Review', detail: null, status: 'current' },
                      ],
                    }
                  : {
                      seriesLabel: 'Completion',
                      unit: '%',
                      points: [
                        { label: 'First', value: 25 },
                        { label: 'Second', value: 75 },
                      ],
                    },
});

test('template catalog and motion catalog are exact', () => {
  assert.deepEqual(SCENE_ARTIFACT_TEMPLATE_NAMES_V1, [
    'animated-data-story',
    'architecture-map',
    'demo-showcase',
    'metric-story',
    'process-flow',
    'slide-deck',
    'threejs-showcase',
    'timeline',
    'webgl-showcase',
  ]);
  assert.deepEqual(SCENE_ARTIFACT_MOTION_LEVELS_V1, ['none', 'subtle', 'staged', 'focus']);
  assert.deepEqual(
    JSON.parse(execFileSync(process.execPath, [cli, 'template-list'], { encoding: 'utf8' }))
      .templates,
    SCENE_ARTIFACT_TEMPLATE_NAMES_V1,
  );
});

test('every closed template compiles with accessible static meaning', () => {
  for (const template of SCENE_ARTIFACT_TEMPLATE_NAMES_V1)
    for (const motion of SCENE_ARTIFACT_MOTION_LEVELS_V1) {
      const draft = compileSceneArtifactDraft(recipe(template, motion), descriptor(template));
      assert.equal(draft.source.artifactId, null);
      assert.deepEqual(draft.source.requestedCapabilities, []);
      if (template === 'slide-deck')
        assert.match(draft.source.html, /<h1 id="sb-slide-title-1">Visual summary<\/h1>/);
      else assert.match(draft.source.html, /<h1>Visual summary<\/h1>/);
      assert.match(draft.source.html, /complete facts/);
      if (template === 'demo-showcase') assert.match(draft.source.css, /prefers-reduced-motion/);
      else if (template === 'slide-deck') {
        assert.match(draft.source.html, /data-sb-slide-deck="v1"/);
        assert.match(draft.source.javascript, /ArrowRight/);
        assert.match(draft.source.javascript, /ResizeObserver/);
        assert.match(draft.source.css, /prefers-reduced-motion/);
      } else if (template === 'threejs-showcase') {
        assert.match(draft.source.html, /data-sb-threejs-showcase="v1"/);
        assert.match(draft.source.javascript, /SceneBoardThree/);
        assert.match(draft.source.javascript, /WebGLRenderer/);
        assert.match(draft.source.javascript, /ACESFilmicToneMapping/);
        assert.match(draft.source.javascript, /PCFSoftShadowMap/);
        assert.match(draft.source.javascript, /MeshPhysicalMaterial/);
        assert.match(draft.source.javascript, /shadow\.mapSize\.set\(4096,4096\)/);
      } else if (template === 'webgl-showcase') {
        assert.match(draft.source.html, /data-sb-webgl-showcase="v1"/);
        assert.match(draft.source.javascript, /getContext\('webgl'/);
        assert.match(draft.source.javascript, /Math\.min\(devicePixelRatio\|\|1,2\)/);
        assert.match(draft.source.javascript, /ResizeObserver/);
      } else if (motion === 'none') assert.doesNotMatch(draft.source.css, /prefers-reduced-motion/);
      else assert.match(draft.source.css, /prefers-reduced-motion/);
    }
});

test('WebGL showcase compiles every closed scene without external resources', () => {
  for (const scene of ['garden-cat', 'space-cat', 'neon-cat'])
    for (const camera of ['orbit', 'still']) {
      const input = recipe('webgl-showcase', 'focus');
      input.content = { scene, camera };
      const draft = compileSceneArtifactDraft(input, descriptor('webgl-showcase'));
      assert.doesNotThrow(() => new Function(draft.source.javascript));
      assert.doesNotMatch(
        `${draft.source.html}${draft.source.css}${draft.source.javascript}`,
        /https?:\/\/|cdn/i,
      );
      assert.deepEqual(draft.source.requestedCapabilities, []);
    }
});

test('Three.js showcase compiles every closed scene without authored external resources', () => {
  for (const scene of ['garden-cat', 'space-cat', 'neon-cat'])
    for (const camera of ['orbit', 'still']) {
      const input = recipe('threejs-showcase', 'focus');
      input.content = { scene, camera };
      const draft = compileSceneArtifactDraft(input, descriptor('threejs-showcase'));
      assert.doesNotThrow(() => new Function(draft.source.javascript));
      assert.doesNotMatch(
        `${draft.source.html}${draft.source.css}${draft.source.javascript}`,
        /https?:\/\/|cdn/i,
      );
      assert.match(draft.source.javascript, /T\.REVISION/);
      assert.deepEqual(draft.source.requestedCapabilities, []);
    }
});

test('demo showcase variants compile to one audited local interaction program', () => {
  const variants = [
    ['illustration', 'sunny-garden', 'outline'],
    ['illustration', 'space-adventure', 'color'],
    ['diorama', 'space-observatory', 'ready'],
    ['prototype', 'risk-checker', 'improved'],
    ['data-story', 'support-week', 'ready'],
    ['incident', 'cache-unavailable', 'failure'],
    ['mission-control', 'launch-readiness', 'ready'],
    ['code-review', 'no-charge', 'final'],
  ];
  for (const [kind, selection, phase] of variants) {
    const input = recipe('demo-showcase', 'staged');
    input.content = { kind, selection, phase };
    const draft = compileSceneArtifactDraft(input, descriptor('demo-showcase'));
    assert.match(draft.source.html, /data-sb-demo-showcase="v1"/);
    assert.equal(typeof draft.source.javascript, 'string');
    assert.doesNotThrow(() => new Function(draft.source.javascript));
    assert.deepEqual(draft.source.requestedCapabilities, []);
  }
});

test('showcase illustration and Three.js scenes preserve premium visual detail', () => {
  const illustration = recipe('demo-showcase', 'focus');
  illustration.content = { kind: 'illustration', selection: 'sunny-garden', phase: 'color' };
  const illustrationDraft = compileSceneArtifactDraft(illustration, descriptor('demo-showcase'));
  assert.match(illustrationDraft.source.html, /id="cat-coat-gradient"/);
  assert.match(illustrationDraft.source.html, /class="cat-detail"/);
  assert.match(illustrationDraft.source.html, /class="garden-depth"/);

  const three = recipe('threejs-showcase', 'focus');
  three.content = { scene: 'space-cat', camera: 'orbit' };
  const threeDraft = compileSceneArtifactDraft(three, descriptor('threejs-showcase'));
  assert.match(threeDraft.source.javascript, /MeshPhysicalMaterial/);
  assert.match(threeDraft.source.javascript, /RingGeometry/);
  assert.match(threeDraft.source.javascript, /CircleGeometry/);
  assert.match(threeDraft.source.javascript, /shadow\.mapSize\.set\(4096,4096\)/);
});

test('publication placement is a separate immutable boundary', () => {
  const draft = compileSceneArtifactDraft(recipe('metric-story'), descriptor('metric-story'));
  assert.throws(
    () => createSceneArtifactPlacement(draft),
    (error) => error instanceof SceneArtifactError && error.code === 'UNKNOWN_FIELD',
  );
  const node = createSceneArtifactPlacement({
    artifact: { artifactId: 'artifact_1', versionId: 'version_1' },
    placement: draft.placement,
  });
  assert.equal(node.type, 'content.artifact');
  assert.deepEqual(node.artifact, { artifactId: 'artifact_1', versionId: 'version_1' });
});

test('source audit rejects scripts, resources, capabilities, and foreign JavaScript', () => {
  const source = compileSceneArtifactDraft(
    recipe('metric-story'),
    descriptor('metric-story'),
  ).source;
  for (const mutation of [
    { ...source, html: '<script>alert(1)</script>' },
    { ...source, css: '@import "remote";' },
    { ...source, javascript: 'alert(1)' },
    { ...source, requestedCapabilities: ['network.fetch'] },
  ])
    assert.throws(
      () => auditSceneArtifactSource(mutation),
      (error) => error.code === 'UNSAFE_ARTIFACT_SOURCE',
    );
});

test('hostile recipe text is escaped and never echoed by CLI failures', () => {
  const hostile = recipe('metric-story');
  hostile.content.metrics[0].label = '<img src=x onerror=alert(1)>';
  const draft = compileSceneArtifactDraft(hostile, descriptor('metric-story'));
  assert.doesNotMatch(draft.source.html, /<img/);
  assert.match(draft.source.html, /&lt;img/);
  const canary = 'SECRET-CANARY-ARTIFACT';
  hostile.content.metrics[0].label = canary.repeat(20);
  const result = spawnSync(process.execPath, [cli, 'compile'], {
    input: JSON.stringify(hostile),
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stderr, new RegExp(canary));
});
