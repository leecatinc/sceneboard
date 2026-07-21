import {
  BOARD_LIMITS_V1,
  BoardNodeParserV1,
  SceneParserV1,
  canonicalizeJsonV1,
  type BoardErrorV1,
  type BoardNodeV1,
  type BoardParseResultV1,
  type DrawingElementV1,
  type LocalFieldId,
  type NodeId,
  type SceneV1,
  type ShortText,
  type TabId,
} from '@sceneboard/board-schema';

export type ChildPlacementV1 =
  | { parentType: 'layout.split'; weight: number }
  | {
      parentType: 'layout.grid';
      column: number;
      row: number;
      columnSpan: number;
      rowSpan: number;
    }
  | { parentType: 'layout.tabs'; tabId: TabId; label: ShortText }
  | {
      parentType: 'layout.canvas';
      x: number;
      y: number;
      width: number;
      height: number;
      zIndex: number;
    };

export type SceneTransformOperationV1 =
  | { type: 'replace_root'; root: BoardNodeV1 | null }
  | { type: 'replace_node'; nodeId: NodeId; node: BoardNodeV1 }
  | { type: 'remove_node'; nodeId: NodeId }
  | {
      type: 'insert_child';
      parentNodeId: NodeId;
      index: number;
      node: BoardNodeV1;
      placement: ChildPlacementV1;
    }
  | {
      type: 'move_child';
      sourceParentNodeId: NodeId;
      destinationParentNodeId: NodeId;
      nodeId: NodeId;
      destinationIndex: number;
      placement: ChildPlacementV1;
    }
  | { type: 'set_split_weight'; splitNodeId: NodeId; childNodeId: NodeId; weight: number }
  | {
      type: 'set_grid_placement';
      gridNodeId: NodeId;
      childNodeId: NodeId;
      column: number;
      row: number;
      columnSpan: number;
      rowSpan: number;
    }
  | {
      type: 'set_canvas_rect';
      canvasNodeId: NodeId;
      childNodeId: NodeId;
      x: number;
      y: number;
      width: number;
      height: number;
      zIndex: number;
    }
  | { type: 'set_active_tab'; tabsNodeId: NodeId; tabId: TabId }
  | { type: 'upsert_drawing_element'; drawingNodeId: NodeId; element: DrawingElementV1 }
  | { type: 'remove_drawing_element'; drawingNodeId: NodeId; elementId: LocalFieldId };

type TransformResult = BoardParseResultV1<SceneV1>;
type LayoutNode = Extract<BoardNodeV1, { type: `layout.${string}` }>;
type NodeLocation = {
  node: BoardNodeV1;
  parent: LayoutNode | null;
  collection: 'children' | 'tabs' | null;
  index: number | null;
};

const LOCAL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const invalid = (operationIndex: number, field: string, issue: string): BoardErrorV1 => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'INVALID_PAYLOAD',
  message: 'Invalid payload',
  category: 'validation',
  retryable: false,
  httpStatusHint: 400,
  details: { path: ['operations', operationIndex, field], issue },
});

const invalidLayout = (
  operationIndex: number,
  field: string,
  reason: 'bounds' | 'overlap' | 'reference' | 'geometry',
): BoardErrorV1 => ({
  protocolVersion: 1,
  type: 'board.error',
  code: 'INVALID_LAYOUT',
  message: 'Layout correlation is invalid',
  category: 'validation',
  retryable: false,
  httpStatusHint: 422,
  details: { path: ['operations', operationIndex, field], reason },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isBoardError = (
  value: BoardNodeV1 | BoardErrorV1 | Record<string, unknown>,
): value is BoardErrorV1 => value.type === 'board.error';

const isLayoutNode = (node: BoardNodeV1): node is LayoutNode => node.type.startsWith('layout.');

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isSafeIndex = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const isFinitePositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;
const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isLocalId = (value: unknown): value is string =>
  typeof value === 'string' && LOCAL_ID_PATTERN.test(value);
const scalarLength = (value: string): number => [...value].length;
const isShortText = (value: unknown): value is string =>
  typeof value === 'string' &&
  !/[\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, '')) &&
  scalarLength(value) >= 1 &&
  scalarLength(value) <= BOARD_LIMITS_V1.maxTitleChars;

const childrenOf = (node: BoardNodeV1): Array<{ node: BoardNodeV1 }> | null => {
  if (
    node.type === 'layout.split' ||
    node.type === 'layout.grid' ||
    node.type === 'layout.canvas'
  ) {
    return node.children;
  }
  if (node.type === 'layout.tabs') return node.tabs;
  return null;
};

const buildIndex = (root: BoardNodeV1 | null): Map<string, NodeLocation> => {
  const index = new Map<string, NodeLocation>();
  if (root === null) return index;
  const stack: NodeLocation[] = [{ node: root, parent: null, collection: null, index: null }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (index.has(current.node.id)) throw new Error('duplicate node ID');
    index.set(current.node.id, current);
    const children = childrenOf(current.node);
    if (children === null) continue;
    if (!isLayoutNode(current.node)) throw new Error('invalid layout node');
    const collection = current.node.type === 'layout.tabs' ? 'tabs' : 'children';
    for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
      const child = children[childIndex];
      if (child !== undefined) {
        stack.push({
          node: child.node,
          parent: current.node,
          collection,
          index: childIndex,
        });
      }
    }
  }
  return index;
};

const layoutEntries = (node: BoardNodeV1): Array<Record<string, unknown>> | null => {
  const children = childrenOf(node);
  return children === null ? null : (children as unknown as Array<Record<string, unknown>>);
};

const validateNode = (
  value: unknown,
  operationIndex: number,
  field: string,
): BoardNodeV1 | BoardErrorV1 => {
  const parsed = BoardNodeParserV1.parse(value);
  if (!parsed.ok) return prefixError(parsed.error, operationIndex, field);
  return parsed.data.value;
};

const prefixError = (error: BoardErrorV1, operationIndex: number, field: string): BoardErrorV1 => {
  if (
    error.code === 'INVALID_PAYLOAD' ||
    error.code === 'INVALID_LAYOUT' ||
    error.code === 'LIMIT_EXCEEDED'
  ) {
    return {
      ...error,
      details: {
        ...error.details,
        path: ['operations', operationIndex, field, ...error.details.path],
      },
    } as BoardErrorV1;
  }
  return error;
};

const validateParent = (parent: LayoutNode, operationIndex: number): BoardErrorV1 | null => {
  const parsed = BoardNodeParserV1.parse(parent);
  return parsed.ok ? null : prefixError(parsed.error, operationIndex, 'placement');
};

const placementEntry = (
  parent: LayoutNode,
  node: BoardNodeV1,
  placement: unknown,
  operationIndex: number,
): Record<string, unknown> | BoardErrorV1 => {
  if (!isRecord(placement) || placement.parentType !== parent.type) {
    return invalidLayout(operationIndex, 'placement', 'reference');
  }
  if (parent.type === 'layout.split') {
    if (!hasExactKeys(placement, ['parentType', 'weight']) || !isFinitePositive(placement.weight)) {
      return invalid(operationIndex, 'placement', 'invalid split placement');
    }
    return { node, weight: placement.weight };
  }
  if (parent.type === 'layout.grid') {
    const keys = ['parentType', 'column', 'row', 'columnSpan', 'rowSpan'];
    if (
      !hasExactKeys(placement, keys) ||
      !isSafeIndex(placement.column) ||
      placement.column < 1 ||
      !isSafeIndex(placement.row) ||
      placement.row < 1 ||
      !isSafeIndex(placement.columnSpan) ||
      placement.columnSpan < 1 ||
      !isSafeIndex(placement.rowSpan) ||
      placement.rowSpan < 1
    ) {
      return invalid(operationIndex, 'placement', 'invalid grid placement');
    }
    return {
      node,
      column: placement.column,
      row: placement.row,
      columnSpan: placement.columnSpan,
      rowSpan: placement.rowSpan,
    };
  }
  if (parent.type === 'layout.tabs') {
    if (
      !hasExactKeys(placement, ['parentType', 'tabId', 'label']) ||
      !isLocalId(placement.tabId) ||
      !isShortText(placement.label)
    ) {
      return invalid(operationIndex, 'placement', 'invalid tab placement');
    }
    return { node, tabId: placement.tabId, label: placement.label };
  }
  const keys = ['parentType', 'x', 'y', 'width', 'height', 'zIndex'];
  if (
    !hasExactKeys(placement, keys) ||
    !isFiniteNonNegative(placement.x) ||
    !isFiniteNonNegative(placement.y) ||
    !isFinitePositive(placement.width) ||
    !isFinitePositive(placement.height) ||
    !Number.isSafeInteger(placement.zIndex)
  ) {
    return invalid(operationIndex, 'placement', 'invalid canvas placement');
  }
  return {
    node,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    zIndex: placement.zIndex,
  };
};

const directChildIndex = (parent: LayoutNode, childNodeId: unknown): number => {
  if (!isLocalId(childNodeId)) return -1;
  return (childrenOf(parent) ?? []).findIndex((entry) => entry.node.id === childNodeId);
};

const removeLocatedNode = (location: NodeLocation): void => {
  if (location.parent === null || location.index === null) throw new Error('cannot remove root');
  const entries = layoutEntries(location.parent);
  if (entries === null) throw new Error('invalid parent');
  entries.splice(location.index, 1);
};

const errorResult = (error: BoardErrorV1): TransformResult => ({ ok: false, error });

const applyOperation = (
  scene: SceneV1,
  operation: unknown,
  operationIndex: number,
): BoardErrorV1 | null => {
  if (!isRecord(operation) || typeof operation.type !== 'string') {
    return invalid(operationIndex, 'type', 'operation must be a strict object');
  }
  let index: Map<string, NodeLocation>;
  try {
    index = buildIndex(scene.root);
  } catch {
    return invalid(operationIndex, 'nodeId', 'scene contains duplicate node IDs');
  }

  if (operation.type === 'replace_root') {
    if (!hasExactKeys(operation, ['type', 'root']))
      return invalid(operationIndex, 'type', 'unknown operation field');
    if (operation.root === null) {
      scene.root = null;
      return null;
    }
    const node = validateNode(operation.root, operationIndex, 'root');
    if (isBoardError(node)) return node;
    scene.root = structuredClone(node);
    return null;
  }

  if (operation.type === 'replace_node') {
    if (!hasExactKeys(operation, ['type', 'nodeId', 'node']) || !isLocalId(operation.nodeId)) {
      return invalid(operationIndex, 'nodeId', 'invalid replace_node operation');
    }
    const location = index.get(operation.nodeId);
    if (location === undefined) return invalid(operationIndex, 'nodeId', 'node was not found');
    const node = validateNode(operation.node, operationIndex, 'node');
    if (isBoardError(node)) return node;
    if (node.id !== operation.nodeId) return invalidLayout(operationIndex, 'node', 'reference');
    const replacement = structuredClone(node);
    if (location.parent === null) scene.root = replacement;
    else {
      const entries = layoutEntries(location.parent);
      if (entries === null || location.index === null)
        return invalidLayout(operationIndex, 'nodeId', 'reference');
      entries[location.index] = { ...entries[location.index], node: replacement };
      const parentError = validateParent(location.parent, operationIndex);
      if (parentError !== null) return parentError;
    }
    return null;
  }

  if (operation.type === 'remove_node') {
    if (!hasExactKeys(operation, ['type', 'nodeId']) || !isLocalId(operation.nodeId)) {
      return invalid(operationIndex, 'nodeId', 'invalid remove_node operation');
    }
    const location = index.get(operation.nodeId);
    if (location === undefined) return invalid(operationIndex, 'nodeId', 'node was not found');
    if (location.parent === null) return invalidLayout(operationIndex, 'nodeId', 'reference');
    removeLocatedNode(location);
    return validateParent(location.parent, operationIndex);
  }

  if (operation.type === 'insert_child') {
    if (
      !hasExactKeys(operation, ['type', 'parentNodeId', 'index', 'node', 'placement']) ||
      !isLocalId(operation.parentNodeId) ||
      !isSafeIndex(operation.index)
    ) {
      return invalid(operationIndex, 'index', 'invalid insert_child operation');
    }
    const parentLocation = index.get(operation.parentNodeId);
    if (parentLocation === undefined)
      return invalid(operationIndex, 'parentNodeId', 'parent was not found');
    const entries = layoutEntries(parentLocation.node);
    if (entries === null || operation.index > entries.length)
      return invalidLayout(operationIndex, 'index', 'bounds');
    const node = validateNode(operation.node, operationIndex, 'node');
    if (isBoardError(node)) return node;
    if (index.has(node.id)) return invalid(operationIndex, 'node', 'node ID already exists');
    if (!isLayoutNode(parentLocation.node))
      return invalidLayout(operationIndex, 'parentNodeId', 'reference');
    const entry = placementEntry(
      parentLocation.node,
      structuredClone(node),
      operation.placement,
      operationIndex,
    );
    if (isBoardError(entry)) return entry;
    entries.splice(operation.index, 0, entry);
    return validateParent(parentLocation.node, operationIndex);
  }

  if (operation.type === 'move_child') {
    const keys = [
      'type',
      'sourceParentNodeId',
      'destinationParentNodeId',
      'nodeId',
      'destinationIndex',
      'placement',
    ];
    if (
      !hasExactKeys(operation, keys) ||
      !isLocalId(operation.sourceParentNodeId) ||
      !isLocalId(operation.destinationParentNodeId) ||
      !isLocalId(operation.nodeId) ||
      !isSafeIndex(operation.destinationIndex)
    ) {
      return invalid(operationIndex, 'nodeId', 'invalid move_child operation');
    }
    const source = index.get(operation.sourceParentNodeId)?.node;
    const destination = index.get(operation.destinationParentNodeId)?.node;
    const moved = index.get(operation.nodeId);
    if (source === undefined || destination === undefined || moved === undefined) {
      return invalid(operationIndex, 'nodeId', 'move target was not found');
    }
    const sourceEntries = layoutEntries(source);
    const destinationEntries = layoutEntries(destination);
    const sourceIndex = source.type.startsWith('layout.')
      ? directChildIndex(source as LayoutNode, operation.nodeId)
      : -1;
    if (sourceEntries === null || destinationEntries === null || sourceIndex < 0) {
      return invalidLayout(operationIndex, 'sourceParentNodeId', 'reference');
    }
    let ancestor = index.get(operation.destinationParentNodeId);
    while (ancestor !== undefined) {
      if (ancestor.node.id === operation.nodeId)
        return invalidLayout(operationIndex, 'destinationParentNodeId', 'reference');
      ancestor = ancestor.parent === null ? undefined : index.get(ancestor.parent.id);
    }
    const movedNode = sourceEntries[sourceIndex]?.node as BoardNodeV1 | undefined;
    if (movedNode === undefined) return invalidLayout(operationIndex, 'nodeId', 'reference');
    sourceEntries.splice(sourceIndex, 1);
    const maximumDestination = destinationEntries.length;
    if (operation.destinationIndex > maximumDestination)
      return invalidLayout(operationIndex, 'destinationIndex', 'bounds');
    if (!isLayoutNode(source) || !isLayoutNode(destination)) {
      return invalidLayout(operationIndex, 'destinationParentNodeId', 'reference');
    }
    const entry = placementEntry(destination, movedNode, operation.placement, operationIndex);
    if (isBoardError(entry)) return entry;
    destinationEntries.splice(operation.destinationIndex, 0, entry);
    const sourceError = validateParent(source, operationIndex);
    if (sourceError !== null) return sourceError;
    if (source !== destination) return validateParent(destination, operationIndex);
    return null;
  }

  if (operation.type === 'set_split_weight') {
    const keys = ['type', 'splitNodeId', 'childNodeId', 'weight'];
    if (
      !hasExactKeys(operation, keys) ||
      !isLocalId(operation.splitNodeId) ||
      !isLocalId(operation.childNodeId) ||
      !isFinitePositive(operation.weight)
    ) {
      return invalid(operationIndex, 'weight', 'invalid split weight operation');
    }
    const node = index.get(operation.splitNodeId)?.node;
    if (node?.type !== 'layout.split')
      return invalidLayout(operationIndex, 'splitNodeId', 'reference');
    const childIndex = directChildIndex(node, operation.childNodeId);
    if (childIndex < 0 || node.children[childIndex] === undefined)
      return invalidLayout(operationIndex, 'childNodeId', 'reference');
    node.children[childIndex].weight = operation.weight;
    return validateParent(node, operationIndex);
  }

  if (operation.type === 'set_grid_placement') {
    const keys = ['type', 'gridNodeId', 'childNodeId', 'column', 'row', 'columnSpan', 'rowSpan'];
    if (
      !hasExactKeys(operation, keys) ||
      !isLocalId(operation.gridNodeId) ||
      !isLocalId(operation.childNodeId) ||
      !isSafeIndex(operation.column) ||
      operation.column < 1 ||
      !isSafeIndex(operation.row) ||
      operation.row < 1 ||
      !isSafeIndex(operation.columnSpan) ||
      operation.columnSpan < 1 ||
      !isSafeIndex(operation.rowSpan) ||
      operation.rowSpan < 1
    ) {
      return invalid(operationIndex, 'column', 'invalid grid placement operation');
    }
    const node = index.get(operation.gridNodeId)?.node;
    if (node?.type !== 'layout.grid')
      return invalidLayout(operationIndex, 'gridNodeId', 'reference');
    const childIndex = directChildIndex(node, operation.childNodeId);
    const child = node.children[childIndex];
    if (childIndex < 0 || child === undefined)
      return invalidLayout(operationIndex, 'childNodeId', 'reference');
    Object.assign(child, {
      column: operation.column,
      row: operation.row,
      columnSpan: operation.columnSpan,
      rowSpan: operation.rowSpan,
    });
    return validateParent(node, operationIndex);
  }

  if (operation.type === 'set_canvas_rect') {
    const keys = ['type', 'canvasNodeId', 'childNodeId', 'x', 'y', 'width', 'height', 'zIndex'];
    if (
      !hasExactKeys(operation, keys) ||
      !isLocalId(operation.canvasNodeId) ||
      !isLocalId(operation.childNodeId) ||
      !isFiniteNonNegative(operation.x) ||
      !isFiniteNonNegative(operation.y) ||
      !isFinitePositive(operation.width) ||
      !isFinitePositive(operation.height) ||
      !Number.isSafeInteger(operation.zIndex)
    ) {
      return invalid(operationIndex, 'x', 'invalid canvas rectangle operation');
    }
    const node = index.get(operation.canvasNodeId)?.node;
    if (node?.type !== 'layout.canvas')
      return invalidLayout(operationIndex, 'canvasNodeId', 'reference');
    const childIndex = directChildIndex(node, operation.childNodeId);
    const child = node.children[childIndex];
    if (childIndex < 0 || child === undefined)
      return invalidLayout(operationIndex, 'childNodeId', 'reference');
    Object.assign(child, {
      x: operation.x,
      y: operation.y,
      width: operation.width,
      height: operation.height,
      zIndex: operation.zIndex,
    });
    return validateParent(node, operationIndex);
  }

  if (operation.type === 'set_active_tab') {
    if (
      !hasExactKeys(operation, ['type', 'tabsNodeId', 'tabId']) ||
      !isLocalId(operation.tabsNodeId) ||
      !isLocalId(operation.tabId)
    ) {
      return invalid(operationIndex, 'tabId', 'invalid active-tab operation');
    }
    const node = index.get(operation.tabsNodeId)?.node;
    if (node?.type !== 'layout.tabs' || !node.tabs.some((tab) => tab.tabId === operation.tabId)) {
      return invalidLayout(operationIndex, 'tabId', 'reference');
    }
    node.activeTabId = operation.tabId as TabId;
    return validateParent(node, operationIndex);
  }

  if (operation.type === 'upsert_drawing_element') {
    if (
      !hasExactKeys(operation, ['type', 'drawingNodeId', 'element']) ||
      !isLocalId(operation.drawingNodeId)
    ) {
      return invalid(operationIndex, 'drawingNodeId', 'invalid drawing element operation');
    }
    const node = index.get(operation.drawingNodeId)?.node;
    const elementCandidate = operation.element;
    if (
      node?.type !== 'content.drawing' ||
      !isRecord(elementCandidate) ||
      !isLocalId(elementCandidate.id)
    ) {
      return invalidLayout(operationIndex, 'drawingNodeId', 'reference');
    }
    const elementIndex = node.elements.findIndex((element) => element.id === elementCandidate.id);
    const element = structuredClone(elementCandidate) as DrawingElementV1;
    if (elementIndex < 0) node.elements.push(element);
    else node.elements[elementIndex] = element;
    const parsed = BoardNodeParserV1.parse(node);
    return parsed.ok ? null : prefixError(parsed.error, operationIndex, 'element');
  }

  if (operation.type === 'remove_drawing_element') {
    if (
      !hasExactKeys(operation, ['type', 'drawingNodeId', 'elementId']) ||
      !isLocalId(operation.drawingNodeId) ||
      !isLocalId(operation.elementId)
    ) {
      return invalid(operationIndex, 'elementId', 'invalid drawing element removal');
    }
    const node = index.get(operation.drawingNodeId)?.node;
    if (node?.type !== 'content.drawing')
      return invalidLayout(operationIndex, 'drawingNodeId', 'reference');
    const elementIndex = node.elements.findIndex((element) => element.id === operation.elementId);
    if (elementIndex < 0)
      return invalid(operationIndex, 'elementId', 'drawing element was not found');
    node.elements.splice(elementIndex, 1);
    return null;
  }

  return invalid(operationIndex, 'type', 'unknown scene transform operation');
};

export const applySceneTransformV1 = (
  scene: SceneV1,
  operations: readonly SceneTransformOperationV1[],
): TransformResult => {
  const source = SceneParserV1.parse(scene);
  if (!source.ok) return source;
  if (!Array.isArray(operations) || operations.length < 1) {
    return errorResult(invalid(0, 'type', 'at least one operation is required'));
  }
  if (operations.length > BOARD_LIMITS_V1.maxJsonContainerEntries) {
    return errorResult({
      protocolVersion: 1,
      type: 'board.error',
      code: 'LIMIT_EXCEEDED',
      message: 'Contract limit exceeded',
      category: 'validation',
      retryable: false,
      httpStatusHint: 422,
      details: {
        limit: 'maxJsonContainerEntries',
        actual: operations.length,
        maximum: BOARD_LIMITS_V1.maxJsonContainerEntries,
        path: ['operations'],
      },
    });
  }
  const canonicalOperations = canonicalizeJsonV1({ operations });
  if (!canonicalOperations.ok) return canonicalOperations as TransformResult;
  if (canonicalOperations.data.canonicalBytes.byteLength > BOARD_LIMITS_V1.maxEnvelopeBytes) {
    return errorResult({
      protocolVersion: 1,
      type: 'board.error',
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Payload is too large',
      category: 'validation',
      retryable: false,
      httpStatusHint: 413,
      details: {
        scope: 'envelope',
        actualBytes: canonicalOperations.data.canonicalBytes.byteLength,
        maximumBytes: BOARD_LIMITS_V1.maxEnvelopeBytes,
      },
    });
  }
  let working: SceneV1;
  try {
    working = structuredClone(source.data.value);
  } catch {
    return errorResult(invalid(0, 'type', 'scene cannot be cloned'));
  }
  for (let operationIndex = 0; operationIndex < operations.length; operationIndex += 1) {
    const error = applyOperation(working, operations[operationIndex], operationIndex);
    if (error !== null) return errorResult(error);
  }
  return SceneParserV1.parse(working);
};
