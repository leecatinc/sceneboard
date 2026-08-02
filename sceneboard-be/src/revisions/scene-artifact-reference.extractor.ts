import {
  MAX_ARTIFACT_REFERENCE_OCCURRENCES,
  type BoardDocument,
  type BoardNodeV1,
  type SceneV1,
} from '@sceneboard/board-schema';

import { BoardPersistenceError } from '../common/errors/board-persistence.error.js';

export interface SceneArtifactReferenceRowV1 {
  artifactId: string;
  artifactVersionId: string;
  referenceCode: 'A' | 'I';
  occurrenceCount: number;
}

export type SceneArtifactPairV1 = {
  artifactId: string;
  artifactVersionId: string;
};

const compareAscii = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const compareArtifactReferences = (
  left: SceneArtifactReferenceRowV1,
  right: SceneArtifactReferenceRowV1,
): number =>
  compareAscii(left.artifactId, right.artifactId) ||
  compareAscii(left.artifactVersionId, right.artifactVersionId) ||
  compareAscii(left.referenceCode, right.referenceCode);

const childrenOf = (node: BoardNodeV1): BoardNodeV1[] => {
  if (
    node.type === 'layout.split' ||
    node.type === 'layout.grid' ||
    node.type === 'layout.canvas'
  ) {
    return node.children.map((child) => child.node);
  }
  if (node.type === 'layout.tabs') return node.tabs.map((tab) => tab.node);
  return [];
};

export const extractSceneArtifactReferences = (scene: SceneV1): SceneArtifactReferenceRowV1[] => {
  if (scene.root === null) return [];
  const counts = new Map<string, SceneArtifactReferenceRowV1>();
  const nodes: BoardNodeV1[] = [scene.root];
  while (nodes.length > 0) {
    const node = nodes.pop()!;
    nodes.push(...childrenOf(node));
    const reference =
      node.type === 'content.artifact'
        ? { ...node.artifact, referenceCode: 'A' as const }
        : node.type === 'content.image' && node.source.type === 'artifact.resource'
          ? { ...node.source.artifact, referenceCode: 'I' as const }
          : null;
    if (reference === null) continue;
    const key = `${reference.artifactId}\0${reference.versionId}\0${reference.referenceCode}`;
    const existing = counts.get(key);
    if (existing === undefined) {
      counts.set(key, {
        artifactId: reference.artifactId,
        artifactVersionId: reference.versionId,
        referenceCode: reference.referenceCode,
        occurrenceCount: 1,
      });
    } else {
      existing.occurrenceCount += 1;
      if (existing.occurrenceCount > MAX_ARTIFACT_REFERENCE_OCCURRENCES)
        throw new BoardPersistenceError('row_integrity');
    }
  }
  return [...counts.values()].sort(compareArtifactReferences);
};

export const extractDocumentArtifactReferences = (
  document: BoardDocument,
): SceneArtifactReferenceRowV1[] => {
  const counts = new Map<string, SceneArtifactReferenceRowV1>();
  for (const page of document.pages) {
    for (const reference of extractSceneArtifactReferences(page.scene)) {
      const key = `${reference.artifactId}\0${reference.artifactVersionId}\0${reference.referenceCode}`;
      const existing = counts.get(key);
      if (existing === undefined) counts.set(key, { ...reference });
      else {
        existing.occurrenceCount += reference.occurrenceCount;
        if (existing.occurrenceCount > MAX_ARTIFACT_REFERENCE_OCCURRENCES)
          throw new BoardPersistenceError('row_integrity');
      }
    }
  }
  return [...counts.values()].sort(compareArtifactReferences);
};

export const extractUniqueSceneArtifactPairs = (scene: SceneV1): SceneArtifactPairV1[] => {
  if (scene.root === null) return [];
  const pairs = new Map<string, SceneArtifactPairV1>();
  const nodes: BoardNodeV1[] = [scene.root];
  while (nodes.length > 0) {
    const node = nodes.pop();
    if (node === undefined) break;
    const children = childrenOf(node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) nodes.push(child);
    }
    const reference =
      node.type === 'content.artifact'
        ? node.artifact
        : node.type === 'content.image' && node.source.type === 'artifact.resource'
          ? node.source.artifact
          : null;
    if (reference === null) continue;
    const key = `${reference.artifactId}\0${reference.versionId}`;
    if (!pairs.has(key))
      pairs.set(key, {
        artifactId: reference.artifactId,
        artifactVersionId: reference.versionId,
      });
  }
  return [...pairs.values()];
};

export const extractUniqueDocumentArtifactPairs = (
  document: BoardDocument,
): SceneArtifactPairV1[] => {
  const pairs = new Map<string, SceneArtifactPairV1>();
  for (const page of document.pages) {
    for (const pair of extractUniqueSceneArtifactPairs(page.scene)) {
      const key = `${pair.artifactId}\0${pair.artifactVersionId}`;
      if (!pairs.has(key)) pairs.set(key, pair);
    }
  }
  return [...pairs.values()];
};
