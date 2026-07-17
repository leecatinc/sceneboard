import {
  BOARD_LIMITS_V1,
  type BoardNodeV1,
} from '@leecat-board/board-schema';

export type RenderBudgetResultV1 =
  | { ok: true; nodes: number; maximumDepth: number }
  | { ok: false; reason: 'depth' | 'nodes' | 'duplicate_id' };

export const inspectRenderBudgetV1 = (root: BoardNodeV1 | null): RenderBudgetResultV1 => {
  if (root === null) return { ok: true, nodes: 0, maximumDepth: 0 };
  const stack: Array<{ node: BoardNodeV1; depth: number }> = [{ node: root, depth: 1 }];
  const ids = new Set<string>();
  let nodes = 0;
  let maximumDepth = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    nodes += 1;
    maximumDepth = Math.max(maximumDepth, current.depth);
    if (nodes > BOARD_LIMITS_V1.maxSceneNodes) return { ok: false, reason: 'nodes' };
    if (current.depth > BOARD_LIMITS_V1.maxSceneDepth) return { ok: false, reason: 'depth' };
    if (ids.has(current.node.id)) return { ok: false, reason: 'duplicate_id' };
    ids.add(current.node.id);
    if (current.node.type === 'layout.tabs') {
      for (let index = current.node.tabs.length - 1; index >= 0; index -= 1) {
        const tab = current.node.tabs[index];
        if (tab !== undefined) stack.push({ node: tab.node, depth: current.depth + 1 });
      }
    } else if (current.node.type === 'layout.split'
      || current.node.type === 'layout.grid'
      || current.node.type === 'layout.canvas') {
      for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
        const child = current.node.children[index];
        if (child !== undefined) stack.push({ node: child.node, depth: current.depth + 1 });
      }
    }
  }
  return { ok: true, nodes, maximumDepth };
};
