import assert from 'node:assert/strict';
import test from 'node:test';

type Task = {
  owns: readonly string[];
  dependsOn: readonly string[];
  consumes: readonly string[];
};

const tasks: Readonly<Record<string, Task>> = {
  d1_root: {
    owns: ['src/index.ts'],
    dependsOn: [],
    consumes: [],
  },
  d4_leaf: {
    owns: ['src/events/index.ts', 'src/sse/index.ts'],
    dependsOn: ['d1_root'],
    consumes: ['src/index.ts'],
  },
  d6_leaf: {
    owns: ['src/http/index.ts', 'src/scene-transform/index.ts'],
    dependsOn: ['d1_root'],
    consumes: ['src/index.ts'],
  },
  sdk_manifest_checkpoint: {
    owns: ['package.json'],
    dependsOn: ['d4_leaf', 'd6_leaf'],
    consumes: [
      'src/events/index.ts',
      'src/sse/index.ts',
      'src/http/index.ts',
      'src/scene-transform/index.ts',
    ],
  },
  d6_core: {
    owns: ['leecat-board-mcp'],
    dependsOn: ['sdk_manifest_checkpoint'],
    consumes: ['package.json'],
  },
};

const transitiveDependencies = (taskName: string): Set<string> => {
  const result = new Set<string>();
  const pending = [...(tasks[taskName]?.dependsOn ?? [])];
  while (pending.length > 0) {
    const dependency = pending.pop();
    if (dependency === undefined || result.has(dependency)) continue;
    result.add(dependency);
    pending.push(...(tasks[dependency]?.dependsOn ?? []));
  }
  return result;
};

test('every consumed seam artifact is owned by a strict upstream task', () => {
  const ownerByArtifact = new Map<string, string>();
  for (const [taskName, task] of Object.entries(tasks)) {
    for (const artifact of task.owns) {
      assert.equal(ownerByArtifact.has(artifact), false, `duplicate owner for ${artifact}`);
      ownerByArtifact.set(artifact, taskName);
    }
  }
  for (const [taskName, task] of Object.entries(tasks)) {
    const upstream = transitiveDependencies(taskName);
    assert.equal(upstream.has(taskName), false, `${taskName} has a dependency cycle`);
    for (const artifact of task.consumes) {
      const owner = ownerByArtifact.get(artifact);
      assert.notEqual(owner, undefined, `missing owner for ${artifact}`);
      assert.notEqual(owner, taskName, `${taskName} consumes its own pass artifact ${artifact}`);
      assert.equal(upstream.has(owner ?? ''), true, `${artifact} is not owned upstream of ${taskName}`);
    }
  }
});
