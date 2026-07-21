import type { BoardNodeV1, BoardSnapshotV1, HitlInteractionV1 } from '@sceneboard/board-schema';

const childrenOf = (node: BoardNodeV1): readonly BoardNodeV1[] => {
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

const placedHitlRequestIds = (root: BoardNodeV1 | null): ReadonlySet<string> => {
  const result = new Set<string>();
  const pending = root === null ? [] : [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (node.type === 'content.hitl') result.add(node.hitlRequestId);
    pending.push(...childrenOf(node));
  }
  return result;
};

export const selectUnplacedOpenHitlV1 = (
  snapshot: BoardSnapshotV1,
): readonly HitlInteractionV1[] => {
  const placed = placedHitlRequestIds(snapshot.scene.root);
  return snapshot.hitl.filter(
    (interaction) => interaction.state === 'open' && !placed.has(interaction.hitlRequestId),
  );
};
