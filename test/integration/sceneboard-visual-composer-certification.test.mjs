import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { compileSceneRecipe } from '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/scene-recipe-core.mjs';
import {
  compileSceneArtifactDraft,
  validateSceneArtifactTemplateDescriptor,
} from '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/scene-artifact-core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workspaceRoot = join(root, '..');
const canonicalSkillRoot = join(workspaceRoot, 'skills/sceneboard');
const canonicalPluginRoot = join(root, 'sceneboard-mcp/plugins/sceneboard');
const releaseName = readFileSync(join(canonicalPluginRoot, '.sceneboard-current'), 'utf8').trim();
assert.match(releaseName, /^generation-[A-Za-z0-9-]+$/u);
const pluginRoot = canonicalPluginRoot;
const releaseStateNames = new Set([
  '.sceneboard-current',
  '.sceneboard-releases',
  '.sceneboard-leases',
  '.sceneboard-publication.lock',
  '.sceneboard-activated',
  '.sceneboard-publishing',
  '.sceneboard-retired',
]);
const activePluginRoot = join(pluginRoot, '.sceneboard-releases', releaseName);
const collect = (directory, prefix = '') =>
  readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    .flatMap((entry) =>
      releaseStateNames.has(`${prefix}${entry.name}`.split('/')[0])
        ? []
        : entry.isDirectory()
          ? collect(join(directory, entry.name), `${prefix}${entry.name}/`)
          : [`${prefix}${entry.name}`],
    );

const zipEntries = (archive) => {
  const entries = new Map();
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(endOffset, -1);
  let offset = archive.readUInt32LE(endOffset + 16);
  while (offset >= 0 && archive.readUInt32LE(offset) === 0x02014b50) {
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const mode = archive.readUInt32LE(offset + 38) >>> 16;
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    assert.equal(entries.has(name), false, name);
    entries.set(name, {
      mode,
      bytes: archive.subarray(dataOffset, dataOffset + compressedSize),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

test('canonical plugin skill and downloadable archives are synchronized', () => {
  const result = JSON.parse(
    execFileSync(process.execPath, [join(root, 'scripts/sync-sceneboard-skill.mjs'), '--check'], {
      encoding: 'utf8',
    }),
  );
  const canonicalFiles = collect(canonicalSkillRoot);
  assert.deepEqual(result, { status: 'PASS', fileCount: canonicalFiles.length });
  assert.deepEqual(collect(join(activePluginRoot, 'skills/sceneboard')), canonicalFiles);
  for (const name of ['sceneboard.zip', 'sceneboard-codex-plugin.zip']) {
    assert.equal(
      readFileSync(join(root, 'sceneboard-fe/public/downloads', name))
        .subarray(0, 4)
        .toString('hex'),
      '504b0304',
    );
  }
});

test('download archives preserve canonical bytes, entry types, and normalized modes', () => {
  for (const archiveCase of [
    {
      name: 'sceneboard.zip',
      sourceRoot: canonicalSkillRoot,
      expectedMode: () => 0o100644,
    },
    {
      name: 'sceneboard-codex-plugin.zip',
      sourceRoot: activePluginRoot,
      expectedMode: (path) =>
        new Map([
          ['scripts/launch-sceneboard-mcp.mjs', 0o100755],
          ['native/profile-lease-helper', 0o100500],
          ['native/linux-x64-gnu/local-export-helper', 0o100500],
        ]).get(path) ?? 0o100644,
    },
  ]) {
    const entries = zipEntries(
      readFileSync(join(root, 'sceneboard-fe/public/downloads', archiveCase.name)),
    );
    const canonicalPaths = collect(archiveCase.sourceRoot);
    assert.equal(entries.size, canonicalPaths.length);
    for (const path of canonicalPaths) {
      const entry = entries.get(`sceneboard/${path}`);
      assert(entry, path);
      assert.equal(entry.mode, archiveCase.expectedMode(path), path);
      assert.deepEqual(entry.bytes, readFileSync(join(archiveCase.sourceRoot, path)), path);
    }
  }
});

test('pointer-selected and downloadable runtimes contain the repaired export arbitration', () => {
  const activeRuntime = readFileSync(join(activePluginRoot, 'runtime/index.js'));
  assert.equal(activeRuntime.includes('EXPORT_PUBLICATION_SETTLEMENT_TIMEOUT_MS_V1'), true);
  assert.equal(activeRuntime.includes('awaitAfterAbort'), true);
  const archiveEntries = zipEntries(
    readFileSync(join(root, 'sceneboard-fe/public/downloads/sceneboard-codex-plugin.zip')),
  );
  const archiveRuntime = archiveEntries.get('sceneboard/runtime/index.js');
  const archivePointer = archiveEntries.get('sceneboard/.sceneboard-current');
  const archiveSelectedRuntime = archiveEntries.get(
    `sceneboard/.sceneboard-releases/${releaseName}/runtime/index.js`,
  );
  assert(archiveRuntime);
  assert.equal(archivePointer, undefined);
  assert.equal(archiveSelectedRuntime, undefined);
  assert.deepEqual(archiveRuntime.bytes, activeRuntime);
});

test('representative native and artifact compositions preserve their handoff boundaries', () => {
  const scene = compileSceneRecipe({
    recipeVersion: 1,
    root: {
      kind: 'presentation',
      activePageKey: 'summary',
      pages: [
        {
          key: 'summary',
          label: 'Summary',
          content: { kind: 'markdown', markdown: '# Summary\n\nThe outcome is explained here.' },
        },
      ],
    },
  });
  assert.equal(scene.root.type, 'layout.tabs');
  assert.equal(scene.root.tabs[0].node.type, 'content.markdown');
  const descriptor = validateSceneArtifactTemplateDescriptor(
    JSON.parse(
      readFileSync(
        join(
          root,
          'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/assets/artifact-templates/metric-story.json',
        ),
        'utf8',
      ),
    ),
  );
  const draft = compileSceneArtifactDraft(
    {
      artifactRecipeVersion: 1,
      template: 'metric-story',
      placementKey: 'summary-metric',
      title: 'Summary metric',
      fallbackText: 'Completion is seventy-five percent.',
      theme: 'light',
      size: { width: 960, height: 540 },
      motion: 'subtle',
      content: {
        metrics: [
          { label: 'Completion', value: '75%', detail: 'Three stages are complete.', trend: 'up' },
        ],
      },
    },
    descriptor,
  );
  assert.equal(draft.source.artifactId, null);
  assert.deepEqual(draft.source.requestedCapabilities, []);
  assert.equal(draft.placement.nodeId.startsWith('n_summary-metric_'), true);
});

test('composer distribution contains no symlink or unsupported entry', () => {
  const inspect = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      assert.equal(entry.isFile() || entry.isDirectory(), true);
      if (entry.isDirectory()) inspect(join(directory, entry.name));
    }
  };
  inspect(join(root, 'sceneboard-mcp/plugins/sceneboard/skills/sceneboard'));
});
