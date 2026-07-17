import type { BoardNodeV1, HitlRequestId, SceneV1 } from '@leecat-board/board-schema';

const childrenOf = (node: BoardNodeV1): BoardNodeV1[] => {
  if (node.type === 'layout.split' || node.type === 'layout.grid' || node.type === 'layout.canvas') {
    return node.children.map((child) => child.node);
  }
  if (node.type === 'layout.tabs') return node.tabs.map((tab) => tab.node);
  return [];
};

export const extractUniqueSceneHitlRequestIds = (scene: SceneV1): HitlRequestId[] => {
  if (scene.root === null) return [];
  const result = new Map<string, HitlRequestId>();
  const nodes: BoardNodeV1[] = [scene.root];
  while (nodes.length > 0) {
    const node = nodes.pop();
    if (node === undefined) break;
    const children = childrenOf(node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) nodes.push(child);
    }
    if (node.type === 'content.hitl' && !result.has(node.hitlRequestId)) {
      result.set(node.hitlRequestId, node.hitlRequestId);
    }
  }
  return [...result.values()];
};
