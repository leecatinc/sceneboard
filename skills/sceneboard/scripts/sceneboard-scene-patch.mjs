import { SceneBoardApiError } from "./sceneboard-api-error.mjs";

const GLOBAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const LOCAL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const invalidInput = (field) => {
  throw new SceneBoardApiError(
    "INVALID_PAYLOAD",
    "Invalid SceneBoard API fallback input",
    {
      details: { field },
      exitCode: 2,
    },
  );
};

const assertExactInput = (input, keys) => {
  if (!isRecord(input)) invalidInput("input");
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalidInput("input");
  }
};

const globalId = (value, field) => {
  if (typeof value !== "string" || !GLOBAL_ID_PATTERN.test(value))
    invalidInput(field);
  return value;
};

const childrenOf = (node) => {
  if (!isRecord(node)) return null;
  if (
    ["layout.split", "layout.grid", "layout.canvas"].includes(node.type) &&
    Array.isArray(node.children)
  ) {
    return node.children;
  }
  if (node.type === "layout.tabs" && Array.isArray(node.tabs)) return node.tabs;
  return null;
};

const buildNodeIndex = (root) => {
  const index = new Map();
  if (root === null) return index;
  const stack = [{ node: root, parent: null, entryIndex: null }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (
      !isRecord(current.node) ||
      typeof current.node.id !== "string" ||
      index.has(current.node.id)
    ) {
      invalidInput("scene");
    }
    index.set(current.node.id, current);
    const children = childrenOf(current.node);
    if (children !== null) {
      for (
        let childIndex = children.length - 1;
        childIndex >= 0;
        childIndex -= 1
      ) {
        if (
          !isRecord(children[childIndex]) ||
          !isRecord(children[childIndex].node)
        ) {
          invalidInput("scene");
        }
        stack.push({
          node: children[childIndex].node,
          parent: current.node,
          entryIndex: childIndex,
        });
      }
    }
  }
  return index;
};

const placementEntry = (parent, node, placement) => {
  if (!isRecord(placement) || placement.parentType !== parent.type)
    invalidInput("placement");
  const entry = structuredClone(placement);
  delete entry.parentType;
  return { node, ...entry };
};

const directChild = (parent, childNodeId) =>
  (childrenOf(parent) ?? []).findIndex(
    (entry) => entry.node?.id === childNodeId,
  );

const applyPatchOperation = (scene, operation) => {
  if (!isRecord(operation) || typeof operation.type !== "string")
    invalidInput("operations");
  const index = buildNodeIndex(scene.root);
  if (operation.type === "replace_root") {
    assertExactInput(operation, ["type", "root"]);
    scene.root = structuredClone(operation.root);
    return;
  }
  if (operation.type === "replace_node") {
    assertExactInput(operation, ["type", "nodeId", "node"]);
    const location = index.get(globalId(operation.nodeId, "nodeId"));
    if (
      location === undefined ||
      !isRecord(operation.node) ||
      operation.node.id !== operation.nodeId
    ) {
      invalidInput("node");
    }
    if (location.parent === null) scene.root = structuredClone(operation.node);
    else
      childrenOf(location.parent)[location.entryIndex].node = structuredClone(
        operation.node,
      );
    return;
  }
  if (operation.type === "remove_node") {
    assertExactInput(operation, ["type", "nodeId"]);
    const location = index.get(globalId(operation.nodeId, "nodeId"));
    if (location === undefined || location.parent === null)
      invalidInput("nodeId");
    childrenOf(location.parent).splice(location.entryIndex, 1);
    return;
  }
  if (operation.type === "insert_child") {
    assertExactInput(operation, [
      "type",
      "parentNodeId",
      "index",
      "node",
      "placement",
    ]);
    const parent = index.get(
      globalId(operation.parentNodeId, "parentNodeId"),
    )?.node;
    const children = childrenOf(parent);
    if (
      children === null ||
      !Number.isSafeInteger(operation.index) ||
      operation.index < 0 ||
      operation.index > children.length ||
      !isRecord(operation.node) ||
      index.has(operation.node.id)
    ) {
      invalidInput("index");
    }
    children.splice(
      operation.index,
      0,
      placementEntry(
        parent,
        structuredClone(operation.node),
        operation.placement,
      ),
    );
    return;
  }
  if (operation.type === "move_child") {
    assertExactInput(operation, [
      "type",
      "sourceParentNodeId",
      "destinationParentNodeId",
      "nodeId",
      "destinationIndex",
      "placement",
    ]);
    const source = index.get(
      globalId(operation.sourceParentNodeId, "sourceParentNodeId"),
    )?.node;
    const destination = index.get(
      globalId(operation.destinationParentNodeId, "destinationParentNodeId"),
    )?.node;
    const sourceChildren = childrenOf(source);
    const destinationChildren = childrenOf(destination);
    const sourceIndex = directChild(
      source,
      globalId(operation.nodeId, "nodeId"),
    );
    if (
      sourceChildren === null ||
      destinationChildren === null ||
      sourceIndex < 0 ||
      !Number.isSafeInteger(operation.destinationIndex) ||
      operation.destinationIndex < 0
    ) {
      invalidInput("destinationIndex");
    }
    let ancestor = index.get(destination.id);
    while (ancestor !== undefined) {
      if (ancestor.node.id === operation.nodeId)
        invalidInput("destinationParentNodeId");
      ancestor =
        ancestor.parent === null ? undefined : index.get(ancestor.parent.id);
    }
    const [entry] = sourceChildren.splice(sourceIndex, 1);
    if (operation.destinationIndex > destinationChildren.length)
      invalidInput("destinationIndex");
    destinationChildren.splice(
      operation.destinationIndex,
      0,
      placementEntry(destination, entry.node, operation.placement),
    );
    return;
  }
  const layoutChange = {
    set_split_weight: ["splitNodeId", "layout.split", "weight", ["weight"]],
    set_grid_placement: [
      "gridNodeId",
      "layout.grid",
      "column",
      ["column", "row", "columnSpan", "rowSpan"],
    ],
    set_canvas_rect: [
      "canvasNodeId",
      "layout.canvas",
      "x",
      ["x", "y", "width", "height", "zIndex"],
    ],
  }[operation.type];
  if (layoutChange !== undefined) {
    const [parentField, parentType, firstValue, valueFields] = layoutChange;
    assertExactInput(operation, [
      "type",
      parentField,
      "childNodeId",
      ...valueFields,
    ]);
    const parent = index.get(
      globalId(operation[parentField], parentField),
    )?.node;
    const childIndex = directChild(
      parent,
      globalId(operation.childNodeId, "childNodeId"),
    );
    if (
      parent?.type !== parentType ||
      childIndex < 0 ||
      valueFields.some(
        (field) =>
          typeof operation[field] !== "number" ||
          !Number.isFinite(operation[field]),
      )
    ) {
      invalidInput(firstValue);
    }
    Object.assign(
      childrenOf(parent)[childIndex],
      Object.fromEntries(valueFields.map((field) => [field, operation[field]])),
    );
    return;
  }
  if (operation.type === "set_active_tab") {
    assertExactInput(operation, ["type", "tabsNodeId", "tabId"]);
    const parent = index.get(
      globalId(operation.tabsNodeId, "tabsNodeId"),
    )?.node;
    if (
      parent?.type !== "layout.tabs" ||
      !Array.isArray(parent.tabs) ||
      !LOCAL_ID_PATTERN.test(operation.tabId) ||
      !parent.tabs.some((tab) => tab.tabId === operation.tabId)
    ) {
      invalidInput("tabId");
    }
    parent.activeTabId = operation.tabId;
    return;
  }
  if (operation.type === "upsert_drawing_element") {
    assertExactInput(operation, ["type", "drawingNodeId", "element"]);
    const node = index.get(
      globalId(operation.drawingNodeId, "drawingNodeId"),
    )?.node;
    if (
      node?.type !== "content.drawing" ||
      !Array.isArray(node.elements) ||
      !isRecord(operation.element) ||
      typeof operation.element.id !== "string" ||
      !LOCAL_ID_PATTERN.test(operation.element.id)
    ) {
      invalidInput("element");
    }
    const elementIndex = node.elements.findIndex(
      (element) => element.id === operation.element.id,
    );
    if (elementIndex < 0)
      node.elements.push(structuredClone(operation.element));
    else node.elements[elementIndex] = structuredClone(operation.element);
    return;
  }
  if (operation.type === "remove_drawing_element") {
    assertExactInput(operation, ["type", "drawingNodeId", "elementId"]);
    const node = index.get(
      globalId(operation.drawingNodeId, "drawingNodeId"),
    )?.node;
    const elementIndex =
      node?.type === "content.drawing" && Array.isArray(node.elements)
        ? node.elements.findIndex(
            (element) => element.id === operation.elementId,
          )
        : -1;
    if (elementIndex < 0) invalidInput("elementId");
    node.elements.splice(elementIndex, 1);
    return;
  }
  invalidInput("operations");
};

export const applyScenePatch = (scene, operations) => {
  if (
    !isRecord(scene) ||
    scene.protocolVersion !== 1 ||
    scene.type !== "scene" ||
    !("root" in scene) ||
    !Array.isArray(operations) ||
    operations.length < 1 ||
    operations.length > 1_000
  ) {
    invalidInput("operations");
  }
  const working = structuredClone(scene);
  for (const operation of operations) applyPatchOperation(working, operation);
  buildNodeIndex(working.root);
  return working;
};
