export const WORKFLOW_SPEC_VERSION = '1.0';
export const WORKFLOW_SPEC_LIMITS_V1 = Object.freeze({
  inputBytes: 49_152,
  jsonDepth: 24,
  containerEntries: 4_096,
  sources: 32,
  subflows: 8,
  totalNodes: 48,
  totalEdges: 96,
  flowEntries: 8,
  flowExits: 8,
  instructions: 32,
  stateItems: 32,
  tools: 16,
  skills: 16,
  questions: 128,
  warnings: 256,
  sourceRefs: 16,
  elementRefs: 32,
});
export const WORKFLOW_SPEC_LIMITS = WORKFLOW_SPEC_LIMITS_V1;

export const WORKFLOW_SPEC_VALIDATION_CODES_V1 = Object.freeze([
  'INVALID_JSON',
  'INVALID_UTF8',
  'DUPLICATE_MEMBER',
  'UNKNOWN_KEY',
  'FORBIDDEN_KEY',
  'INVALID_TYPE',
  'INVALID_VALUE',
  'LIMIT_EXCEEDED',
  'DUPLICATE_ID',
  'DANGLING_REFERENCE',
  'CROSS_FLOW_REFERENCE',
  'INVALID_KIND_COMBINATION',
  'RECURSIVE_SUBFLOW',
]);

export const WORKFLOW_SPEC_WARNING_CODES_V1 = Object.freeze([
  'UNREACHABLE_NODE',
  'NON_RETRY_CYCLE',
  'UNKNOWN_CONDITION',
  'DECISION_ROUTE_MISSING',
  'PARALLEL_JOIN_MISMATCH',
  'UNCERTAIN_ROUTE',
]);

export class WorkflowSpecError extends Error {
  constructor(code, path = '') {
    super(code);
    this.name = 'WorkflowSpecError';
    this.code = code;
    this.path = path;
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const SOURCE_KINDS = new Set(['langgraph', 'markdown', 'skill', 'rules', 'code', 'prose', 'other']);
const NODE_KINDS = new Set([
  'start',
  'action',
  'decision',
  'parallel',
  'join',
  'human',
  'subflow',
  'end',
]);
const EDGE_KINDS = new Set([
  'normal',
  'conditional',
  'parallel',
  'join',
  'retry',
  'fallback',
  'human',
]);
const STATE_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array', 'null', 'unknown']);
const BASIS = new Set(['explicit', 'inferred', 'unknown']);
const RETRY_BACKOFF = new Set(['none', 'fixed', 'linear', 'exponential']);
const RETRY_ON = new Set([
  'timeout',
  'rate_limit',
  'transient',
  'validation',
  'tool_error',
  'unknown',
]);
const CONDITION_LANGUAGES = new Set(['natural', 'cel', 'javascript', 'python', 'other', 'unknown']);

const fail = (code, path = '') => {
  throw new WorkflowSpecError(code, path);
};
const pointer = (base, key) => `${base}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
const record = (value, path) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_TYPE', path);
  return value;
};
const exactKeys = (value, keys, path) => {
  record(value, path);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) fail('FORBIDDEN_KEY', pointer(path, key));
    if (!expected.has(key)) fail('UNKNOWN_KEY', pointer(path, key));
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) fail('INVALID_TYPE', pointer(path, key));
};
const array = (value, minimum, maximum, path) => {
  if (!Array.isArray(value)) fail('INVALID_TYPE', path);
  if (value.length < minimum || value.length > maximum) fail('LIMIT_EXCEEDED', path);
  return value;
};
const text = (value, minimum, maximum, path, nullable = false) => {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') fail('INVALID_TYPE', path);
  const length = [...value].length;
  if (length < minimum || length > maximum) fail('LIMIT_EXCEEDED', path);
  if (
    [...value].some((character) => {
      const point = character.codePointAt(0);
      return (
        (point >= 0xd800 && point <= 0xdfff) ||
        (point < 0x20 && ![0x09, 0x0a, 0x0d].includes(point))
      );
    })
  )
    fail('INVALID_VALUE', path);
  return value;
};
const id = (value, path) => {
  text(value, 1, 64, path);
  if (!ID_PATTERN.test(value)) fail('INVALID_VALUE', path);
  return value;
};
const token = (value, path) => {
  text(value, 1, 128, path);
  if (!TOKEN_PATTERN.test(value)) fail('INVALID_VALUE', path);
  return value;
};
const enumeration = (value, allowed, path) => {
  if (typeof value !== 'string') fail('INVALID_TYPE', path);
  if (!allowed.has(value)) fail('INVALID_VALUE', path);
  return value;
};
const integer = (value, minimum, maximum, path, nullable = false) => {
  if (nullable && value === null) return null;
  if (!Number.isInteger(value)) fail('INVALID_TYPE', path);
  if (value < minimum || value > maximum) fail('INVALID_VALUE', path);
  return value;
};
const unique = (values, key, path) => {
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const identity = key(values[index]);
    if (seen.has(identity)) fail('DUPLICATE_ID', pointer(path, index));
    seen.add(identity);
  }
  return seen;
};

const validateStructureLimits = (value) => {
  let entries = 0;
  const active = new WeakSet();
  const visit = (item, depth) => {
    if (depth > WORKFLOW_SPEC_LIMITS_V1.jsonDepth) fail('LIMIT_EXCEEDED', '');
    if (item === null || typeof item !== 'object') return;
    if (active.has(item)) fail('INVALID_VALUE', '');
    active.add(item);
    const values = Array.isArray(item) ? item : Object.values(item);
    entries += values.length;
    if (entries > WORKFLOW_SPEC_LIMITS_V1.containerEntries) fail('LIMIT_EXCEEDED', '');
    values.forEach((nested) => visit(nested, depth + 1));
    active.delete(item);
  };
  visit(value, 1);
};

const validateSourceRef = (value, sourceIds, path) => {
  exactKeys(value, ['sourceId', 'startLine', 'endLine', 'locator'], path);
  id(value.sourceId, pointer(path, 'sourceId'));
  if (!sourceIds.has(value.sourceId)) fail('DANGLING_REFERENCE', pointer(path, 'sourceId'));
  integer(value.startLine, 1, 10_000_000, pointer(path, 'startLine'), true);
  integer(value.endLine, 1, 10_000_000, pointer(path, 'endLine'), true);
  if (
    (value.startLine === null) !== (value.endLine === null) ||
    (value.startLine !== null && value.endLine < value.startLine)
  )
    fail('INVALID_VALUE', pointer(path, 'endLine'));
  text(value.locator, 1, 2_000, pointer(path, 'locator'), true);
};

const validateEvidence = (value, sourceIds, path) => {
  exactKeys(value, ['basis', 'confidence', 'sourceRefs'], path);
  enumeration(value.basis, BASIS, pointer(path, 'basis'));
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence))
    fail('INVALID_TYPE', pointer(path, 'confidence'));
  if (value.confidence < 0 || value.confidence > 1)
    fail('INVALID_VALUE', pointer(path, 'confidence'));
  const refs = array(
    value.sourceRefs,
    value.basis === "explicit" ? 1 : 0,
    WORKFLOW_SPEC_LIMITS_V1.sourceRefs,
    pointer(path, 'sourceRefs'),
  );
  refs.forEach((ref, index) =>
    validateSourceRef(ref, sourceIds, pointer(pointer(path, 'sourceRefs'), index)),
  );
  unique(
    refs,
    (ref) => `${ref.sourceId}\0${ref.startLine}\0${ref.endLine}\0${ref.locator}`,
    pointer(path, 'sourceRefs'),
  );
};

const validateStateItem = (value, path) => {
  exactKeys(value, ['key', 'type', 'required', 'description'], path);
  token(value.key, pointer(path, 'key'));
  enumeration(value.type, STATE_TYPES, pointer(path, 'type'));
  if (typeof value.required !== 'boolean') fail('INVALID_TYPE', pointer(path, 'required'));
  text(value.description, 1, 2_000, pointer(path, 'description'), true);
};

const validateRetryPolicy = (value, path) => {
  if (value === null) return;
  exactKeys(value, ['maxAttempts', 'backoff', 'initialDelayMs', 'maxDelayMs', 'retryOn'], path);
  integer(value.maxAttempts, 1, 10, pointer(path, 'maxAttempts'));
  enumeration(value.backoff, RETRY_BACKOFF, pointer(path, 'backoff'));
  integer(value.initialDelayMs, 0, 300_000, pointer(path, 'initialDelayMs'));
  integer(value.maxDelayMs, 0, 300_000, pointer(path, 'maxDelayMs'));
  if (value.maxDelayMs < value.initialDelayMs) fail('INVALID_VALUE', pointer(path, 'maxDelayMs'));
  const retryOn = array(value.retryOn, 0, 8, pointer(path, 'retryOn'));
  retryOn.forEach((item, index) =>
    enumeration(item, RETRY_ON, pointer(pointer(path, 'retryOn'), index)),
  );
  unique(retryOn, (item) => item, pointer(path, 'retryOn'));
};

const validateErrorPolicy = (value, path) => {
  if (value === null) return;
  exactKeys(value, ['onExhaustedEdgeId', 'emitsStateKeys'], path);
  if (value.onExhaustedEdgeId !== null)
    id(value.onExhaustedEdgeId, pointer(path, 'onExhaustedEdgeId'));
  const keys = array(value.emitsStateKeys, 0, 32, pointer(path, 'emitsStateKeys'));
  keys.forEach((item, index) => token(item, pointer(pointer(path, 'emitsStateKeys'), index)));
  unique(keys, (item) => item, pointer(path, 'emitsStateKeys'));
};

const validateControl = (value, kind, path) => {
  if (value === null) {
    if (['parallel', 'join', 'human'].includes(kind)) fail('INVALID_KIND_COMBINATION', path);
    return;
  }
  if (kind === 'parallel') {
    exactKeys(value, ['mode', 'branchEdgeIds'], path);
    enumeration(value.mode, new Set(['all', 'any']), pointer(path, 'mode'));
    const ids = array(value.branchEdgeIds, 2, 32, pointer(path, 'branchEdgeIds'));
    ids.forEach((item, index) => id(item, pointer(pointer(path, 'branchEdgeIds'), index)));
    unique(ids, (item) => item, pointer(path, 'branchEdgeIds'));
    return;
  }
  if (kind === 'join') {
    exactKeys(value, ['mode', 'incomingEdgeIds'], path);
    enumeration(value.mode, new Set(['all', 'any']), pointer(path, 'mode'));
    const ids = array(value.incomingEdgeIds, 2, 32, pointer(path, 'incomingEdgeIds'));
    ids.forEach((item, index) => id(item, pointer(pointer(path, 'incomingEdgeIds'), index)));
    unique(ids, (item) => item, pointer(path, 'incomingEdgeIds'));
    return;
  }
  if (kind === 'human') {
    exactKeys(value, ['interaction', 'blocking'], path);
    enumeration(
      value.interaction,
      new Set(['info', 'choice', 'form', 'confirmation']),
      pointer(path, 'interaction'),
    );
    if (typeof value.blocking !== 'boolean') fail('INVALID_TYPE', pointer(path, 'blocking'));
    return;
  }
  fail('INVALID_KIND_COMBINATION', path);
};

const validateNode = (value, sourceIds, path) => {
  exactKeys(
    value,
    [
      'id',
      'kind',
      'label',
      'purpose',
      'instructions',
      'stateInputs',
      'stateOutputs',
      'tools',
      'skills',
      'retryPolicy',
      'errorPolicy',
      'subflowId',
      'control',
      'evidence',
    ],
    path,
  );
  id(value.id, pointer(path, 'id'));
  enumeration(value.kind, NODE_KINDS, pointer(path, 'kind'));
  text(value.label, 1, 120, pointer(path, 'label'));
  text(value.purpose, 1, 2_000, pointer(path, 'purpose'), true);
  const instructions = array(value.instructions, 0, 32, pointer(path, 'instructions'));
  instructions.forEach((item, index) =>
    text(item, 1, 1_000, pointer(pointer(path, 'instructions'), index)),
  );
  for (const key of ['stateInputs', 'stateOutputs']) {
    const items = array(value[key], 0, 32, pointer(path, key));
    items.forEach((item, index) => validateStateItem(item, pointer(pointer(path, key), index)));
    unique(items, (item) => item.key, pointer(path, key));
  }
  for (const [key, maximum] of [
    ['tools', 16],
    ['skills', 16],
  ]) {
    const items = array(value[key], 0, maximum, pointer(path, key));
    items.forEach((item, index) => token(item, pointer(pointer(path, key), index)));
    unique(items, (item) => item, pointer(path, key));
  }
  validateRetryPolicy(value.retryPolicy, pointer(path, 'retryPolicy'));
  validateErrorPolicy(value.errorPolicy, pointer(path, 'errorPolicy'));
  if (
    !['action', 'human', 'subflow'].includes(value.kind) &&
    (value.retryPolicy !== null || value.errorPolicy !== null)
  )
    fail('INVALID_KIND_COMBINATION', path);
  if (value.kind === 'subflow') id(value.subflowId, pointer(path, 'subflowId'));
  else if (value.subflowId !== null) fail('INVALID_KIND_COMBINATION', pointer(path, 'subflowId'));
  validateControl(value.control, value.kind, pointer(path, 'control'));
  validateEvidence(value.evidence, sourceIds, pointer(path, 'evidence'));
};

const validateEdge = (value, sourceIds, path) => {
  exactKeys(
    value,
    [
      'id',
      'kind',
      'fromNodeId',
      'toNodeId',
      'label',
      'condition',
      'priority',
      'stateKeys',
      'evidence',
    ],
    path,
  );
  id(value.id, pointer(path, 'id'));
  enumeration(value.kind, EDGE_KINDS, pointer(path, 'kind'));
  id(value.fromNodeId, pointer(path, 'fromNodeId'));
  id(value.toNodeId, pointer(path, 'toNodeId'));
  text(value.label, 1, 120, pointer(path, 'label'), true);
  if (value.condition !== null) {
    exactKeys(value.condition, ['text', 'language'], pointer(path, 'condition'));
    text(value.condition.text, 1, 2_000, pointer(pointer(path, 'condition'), 'text'));
    enumeration(
      value.condition.language,
      CONDITION_LANGUAGES,
      pointer(pointer(path, 'condition'), 'language'),
    );
  }
  integer(value.priority, 0, 1_000, pointer(path, 'priority'), true);
  const keys = array(value.stateKeys, 0, 32, pointer(path, 'stateKeys'));
  keys.forEach((item, index) => token(item, pointer(pointer(path, 'stateKeys'), index)));
  unique(keys, (item) => item, pointer(path, 'stateKeys'));
  validateEvidence(value.evidence, sourceIds, pointer(path, 'evidence'));
  if (value.kind === 'conditional') {
    if (value.condition === null && value.evidence.basis !== 'unknown')
      fail('INVALID_KIND_COMBINATION', pointer(path, 'condition'));
  } else if (value.condition !== null) fail('INVALID_KIND_COMBINATION', pointer(path, 'condition'));
};

const validateFlow = (flow, sourceIds, path, isRoot) => {
  const flowKeys = isRoot
    ? ['entryNodeIds', 'exitNodeIds', 'nodes', 'edges']
    : ['id', 'title', 'entryNodeIds', 'exitNodeIds', 'nodes', 'edges', 'evidence'];
  exactKeys(flow, flowKeys, path);
  if (!isRoot) {
    id(flow.id, pointer(path, 'id'));
    text(flow.title, 1, 200, pointer(path, 'title'));
    validateEvidence(flow.evidence, sourceIds, pointer(path, 'evidence'));
  }
  const entries = array(flow.entryNodeIds, 1, 8, pointer(path, 'entryNodeIds'));
  const exits = array(flow.exitNodeIds, 1, 8, pointer(path, 'exitNodeIds'));
  entries.forEach((item, index) => id(item, pointer(pointer(path, 'entryNodeIds'), index)));
  exits.forEach((item, index) => id(item, pointer(pointer(path, 'exitNodeIds'), index)));
  unique(entries, (item) => item, pointer(path, 'entryNodeIds'));
  unique(exits, (item) => item, pointer(path, 'exitNodeIds'));
  const nodes = array(flow.nodes, 2, 48, pointer(path, 'nodes'));
  const edges = array(flow.edges, 0, 96, pointer(path, 'edges'));
  nodes.forEach((node, index) =>
    validateNode(node, sourceIds, pointer(pointer(path, 'nodes'), index)),
  );
  edges.forEach((edge, index) =>
    validateEdge(edge, sourceIds, pointer(pointer(path, 'edges'), index)),
  );
  const nodeIds = unique(nodes, (node) => node.id, pointer(path, 'nodes'));
  const edgeIds = unique(edges, (edge) => edge.id, pointer(path, 'edges'));
  const declaredStateKeys = new Set(
    nodes.flatMap((node) => [...node.stateInputs, ...node.stateOutputs].map(({ key }) => key)),
  );
  for (const entry of entries)
    if (!nodeIds.has(entry) || nodes.find(({ id: nodeId }) => nodeId === entry)?.kind !== 'start')
      fail('DANGLING_REFERENCE', pointer(path, 'entryNodeIds'));
  for (const exit of exits)
    if (!nodeIds.has(exit) || nodes.find(({ id: nodeId }) => nodeId === exit)?.kind !== 'end')
      fail('DANGLING_REFERENCE', pointer(path, 'exitNodeIds'));
  if (
    nodes.some((node) => node.kind === 'start' && !entries.includes(node.id)) ||
    nodes.some((node) => node.kind === 'end' && !exits.includes(node.id))
  )
    fail('INVALID_KIND_COMBINATION', path);
  for (const edge of edges) {
    if (edge.stateKeys.some((key) => !declaredStateKeys.has(key)))
      fail('DANGLING_REFERENCE', pointer(path, 'edges'));
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId))
      fail('CROSS_FLOW_REFERENCE', pointer(path, 'edges'));
    const from = nodes.find(({ id: nodeId }) => nodeId === edge.fromNodeId);
    const to = nodes.find(({ id: nodeId }) => nodeId === edge.toNodeId);
    if (from.kind === 'end' || to.kind === 'start')
      fail('INVALID_KIND_COMBINATION', pointer(path, 'edges'));
    if (edge.kind === 'conditional' && from.kind !== 'decision')
      fail('INVALID_KIND_COMBINATION', pointer(path, 'edges'));
    if (edge.kind === 'parallel' && from.kind !== 'parallel')
      fail('INVALID_KIND_COMBINATION', pointer(path, 'edges'));
    if (edge.kind === 'join' && to.kind !== 'join')
      fail('INVALID_KIND_COMBINATION', pointer(path, 'edges'));
    if (
      edge.kind === 'retry' &&
      (!['action', 'human', 'subflow'].includes(from.kind) ||
        !['action', 'human', 'subflow'].includes(to.kind))
    )
      fail('INVALID_KIND_COMBINATION', pointer(path, 'edges'));
    if (edge.kind === 'human' && (from.kind === 'human') === (to.kind === 'human'))
      fail('INVALID_KIND_COMBINATION', pointer(path, 'edges'));
    if (
      edge.kind === 'normal' &&
      !['start', 'action', 'join', 'human', 'subflow'].includes(from.kind)
    )
      fail('INVALID_KIND_COMBINATION', pointer(path, 'edges'));
    if (edge.kind === 'fallback' && !['action', 'decision', 'human', 'subflow'].includes(from.kind))
      fail('INVALID_KIND_COMBINATION', pointer(path, 'edges'));
  }
  for (const [nodeIndex, node] of nodes.entries()) {
    const nodePath = pointer(pointer(path, 'nodes'), nodeIndex);
    const stateKeys = new Set([...node.stateInputs, ...node.stateOutputs].map(({ key }) => key));
    if (node.errorPolicy !== null) {
      if (
        node.errorPolicy.onExhaustedEdgeId !== null &&
        !edgeIds.has(node.errorPolicy.onExhaustedEdgeId)
      )
        fail('DANGLING_REFERENCE', pointer(pointer(nodePath, 'errorPolicy'), 'onExhaustedEdgeId'));
      if (node.errorPolicy.emitsStateKeys.some((key) => !stateKeys.has(key)))
        fail('DANGLING_REFERENCE', pointer(pointer(nodePath, 'errorPolicy'), 'emitsStateKeys'));
    }
    const controlIds =
      node.kind === 'parallel'
        ? node.control.branchEdgeIds
        : node.kind === 'join'
          ? node.control.incomingEdgeIds
          : [];
    if (controlIds.some((edgeId) => !edgeIds.has(edgeId)))
      fail(
        'DANGLING_REFERENCE',
        pointer(
          pointer(nodePath, 'control'),
          node.kind === 'parallel' ? 'branchEdgeIds' : 'incomingEdgeIds',
        ),
      );
    if (node.kind === 'parallel') {
      const outbound = edges
        .filter((edge) => edge.fromNodeId === node.id && edge.kind === 'parallel')
        .map((edge) => edge.id)
        .sort();
      if (JSON.stringify(outbound) !== JSON.stringify([...controlIds].sort()))
        fail('INVALID_KIND_COMBINATION', pointer(pointer(nodePath, 'control'), 'branchEdgeIds'));
    }
    if (node.kind === 'join') {
      const incoming = edges
        .filter((edge) => edge.toNodeId === node.id && edge.kind === 'join')
        .map((edge) => edge.id)
        .sort();
      if (JSON.stringify(incoming) !== JSON.stringify([...controlIds].sort()))
        fail('INVALID_KIND_COMBINATION', pointer(pointer(nodePath, 'control'), 'incomingEdgeIds'));
    }
  }
  return { nodeIds, edgeIds };
};

export const validateWorkflowSpec = (input) => {
  validateStructureLimits(input);
  const value = record(input, '');
  exactKeys(
    value,
    [
      'schemaVersion',
      'workflow',
      'sources',
      'entryNodeIds',
      'exitNodeIds',
      'nodes',
      'edges',
      'subflows',
      'unresolvedQuestions',
      'warnings',
    ],
    '',
  );
  if (value.schemaVersion !== WORKFLOW_SPEC_VERSION) fail('INVALID_VALUE', '/schemaVersion');
  exactKeys(value.workflow, ['id', 'title', 'summary', 'evidence'], '/workflow');
  id(value.workflow.id, '/workflow/id');
  text(value.workflow.title, 1, 200, '/workflow/title');
  text(value.workflow.summary, 1, 2_000, '/workflow/summary', true);
  const sources = array(value.sources, 1, 32, '/sources');
  sources.forEach((source, index) => {
    const path = `/sources/${index}`;
    exactKeys(source, ['id', 'kind', 'label', 'digest'], path);
    id(source.id, `${path}/id`);
    enumeration(source.kind, SOURCE_KINDS, `${path}/kind`);
    text(source.label, 1, 120, `${path}/label`);
    if (
      source.digest !== null &&
      (typeof source.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(source.digest))
    )
      fail('INVALID_VALUE', `${path}/digest`);
  });
  const sourceIds = unique(sources, (source) => source.id, '/sources');
  validateEvidence(value.workflow.evidence, sourceIds, '/workflow/evidence');
  const root = {
    entryNodeIds: value.entryNodeIds,
    exitNodeIds: value.exitNodeIds,
    nodes: value.nodes,
    edges: value.edges,
  };
  const rootResult = validateFlow(root, sourceIds, '', true);
  const subflows = array(value.subflows, 0, 8, '/subflows');
  subflows.forEach((flow, index) => validateFlow(flow, sourceIds, `/subflows/${index}`, false));
  const subflowIds = unique(subflows, (flow) => flow.id, '/subflows');
  const globalElementIds = new Set();
  const admitElementId = (identity, path) => {
    if (globalElementIds.has(identity)) fail('DUPLICATE_ID', path);
    globalElementIds.add(identity);
  };
  admitElementId(value.workflow.id, '/workflow/id');
  subflows.forEach((flow, flowIndex) => admitElementId(flow.id, `/subflows/${flowIndex}/id`));
  for (const [flowIndex, flow] of [root, ...subflows].entries()) {
    const flowPath = flowIndex === 0 ? '' : `/subflows/${flowIndex - 1}`;
    flow.nodes.forEach((node, nodeIndex) =>
      admitElementId(node.id, `${flowPath}/nodes/${nodeIndex}/id`),
    );
    flow.edges.forEach((edge, edgeIndex) =>
      admitElementId(edge.id, `${flowPath}/edges/${edgeIndex}/id`),
    );
  }
  const nodeIds = new Set(rootResult.nodeIds);
  const edgeIds = new Set(rootResult.edgeIds);
  for (const [flowIndex, flow] of subflows.entries()) {
    for (const [nodeIndex, node] of flow.nodes.entries()) {
      if (nodeIds.has(node.id))
        fail('DUPLICATE_ID', `/subflows/${flowIndex}/nodes/${nodeIndex}/id`);
      nodeIds.add(node.id);
    }
    for (const [edgeIndex, edge] of flow.edges.entries()) {
      if (edgeIds.has(edge.id))
        fail('DUPLICATE_ID', `/subflows/${flowIndex}/edges/${edgeIndex}/id`);
      edgeIds.add(edge.id);
    }
  }
  if (nodeIds.size > 48 || edgeIds.size > 96) fail('LIMIT_EXCEEDED', '');
  for (const [flowIndex, flow] of [root, ...subflows].entries())
    for (const [nodeIndex, node] of flow.nodes.entries())
      if (node.kind === 'subflow' && !subflowIds.has(node.subflowId))
        fail(
          'DANGLING_REFERENCE',
          flowIndex === 0
            ? `/nodes/${nodeIndex}/subflowId`
            : `/subflows/${flowIndex - 1}/nodes/${nodeIndex}/subflowId`,
        );
  const subflowById = new Map(subflows.map((flow) => [flow.id, flow]));
  const subflowIndexById = new Map(subflows.map((flow, index) => [flow.id, index]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (flowId, referencePath = `/subflows/${subflowIndexById.get(flowId)}`) => {
    if (visiting.has(flowId)) fail('RECURSIVE_SUBFLOW', referencePath);
    if (visited.has(flowId)) return;
    visiting.add(flowId);
    const flowIndex = subflowIndexById.get(flowId);
    for (const [nodeIndex, node] of subflowById.get(flowId).nodes.entries())
      if (node.kind === 'subflow')
        visit(node.subflowId, `/subflows/${flowIndex}/nodes/${nodeIndex}/subflowId`);
    visiting.delete(flowId);
    visited.add(flowId);
  };
  for (const flowId of subflowIds) visit(flowId);
  const elementIds = { node: nodeIds, edge: edgeIds, subflow: subflowIds };
  const questions = array(value.unresolvedQuestions, 0, 128, '/unresolvedQuestions');
  questions.forEach((question, index) => {
    const path = `/unresolvedQuestions/${index}`;
    exactKeys(question, ['id', 'prompt', 'relatedElements', 'evidence'], path);
    id(question.id, `${path}/id`);
    text(question.prompt, 1, 2_000, `${path}/prompt`);
    const refs = array(question.relatedElements, 1, 32, `${path}/relatedElements`);
    refs.forEach((ref, refIndex) => {
      const refPath = `${path}/relatedElements/${refIndex}`;
      exactKeys(ref, ['kind', 'id'], refPath);
      enumeration(ref.kind, new Set(['node', 'edge', 'subflow']), `${refPath}/kind`);
      id(ref.id, `${refPath}/id`);
      if (!elementIds[ref.kind].has(ref.id)) fail('DANGLING_REFERENCE', refPath);
    });
    unique(refs, (ref) => `${ref.kind}\0${ref.id}`, `${path}/relatedElements`);
    validateEvidence(question.evidence, sourceIds, `${path}/evidence`);
  });
  unique(questions, (question) => question.id, '/unresolvedQuestions');
  const warnings = array(value.warnings, 0, 256, '/warnings');
  warnings.forEach((warning, index) => {
    const path = `/warnings/${index}`;
    exactKeys(warning, ['id', 'code', 'elementType', 'elementId', 'message', 'evidence'], path);
    id(warning.id, `${path}/id`);
    enumeration(warning.code, new Set(WORKFLOW_SPEC_WARNING_CODES_V1), `${path}/code`);
    enumeration(
      warning.elementType,
      new Set(['workflow', 'node', 'edge', 'subflow']),
      `${path}/elementType`,
    );
    if (warning.elementType === 'workflow') {
      if (warning.elementId !== null) fail('INVALID_VALUE', `${path}/elementId`);
    } else {
      id(warning.elementId, `${path}/elementId`);
      if (!elementIds[warning.elementType].has(warning.elementId))
        fail('DANGLING_REFERENCE', `${path}/elementId`);
    }
    text(warning.message, 1, 2_000, `${path}/message`);
    validateEvidence(warning.evidence, sourceIds, `${path}/evidence`);
  });
  unique(warnings, (warning) => warning.id, '/warnings');
  const warnedUnknownConditions = new Set(
    warnings
      .filter((warning) => warning.code === 'UNKNOWN_CONDITION' && warning.elementType === 'edge')
      .map((warning) => warning.elementId),
  );
  for (const flow of [value, ...value.subflows])
    for (const edge of flow.edges)
      if (
        edge.kind === 'conditional' &&
        edge.condition === null &&
        !warnedUnknownConditions.has(edge.id)
      )
        fail('DANGLING_REFERENCE', '/warnings');
  return value;
};

class JsonReader {
  constructor(value) {
    this.valueText = value;
    this.index = 0;
    this.entries = 0;
  }
  whitespace() {
    while (/\s/u.test(this.valueText[this.index] ?? '')) this.index += 1;
  }
  count(depth, path) {
    if (depth > 24) fail('LIMIT_EXCEEDED', path);
  }
  value(depth = 1, path = '') {
    this.whitespace();
    this.count(depth, path);
    const character = this.valueText[this.index];
    if (character === '{') return this.object(depth, path);
    if (character === '[') return this.array(depth, path);
    if (character === '"') return this.string(path);
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u.exec(
      this.valueText.slice(this.index),
    );
    if (!match) fail('INVALID_JSON', path);
    this.index += match[0].length;
    const parsed = JSON.parse(match[0]);
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) fail('INVALID_JSON', path);
    return parsed;
  }
  string(path) {
    const start = this.index++;
    let escaped = false;
    while (this.index < this.valueText.length) {
      const character = this.valueText[this.index++];
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') {
        try {
          return JSON.parse(this.valueText.slice(start, this.index));
        } catch {
          fail('INVALID_JSON', path);
        }
      } else if (character.codePointAt(0) < 0x20) fail('INVALID_JSON', path);
    }
    fail('INVALID_JSON', path);
  }
  object(depth, path) {
    const result = Object.create(null);
    const keys = new Set();
    this.index += 1;
    this.whitespace();
    if (this.valueText[this.index] === '}') {
      this.index += 1;
      return result;
    }
    while (true) {
      this.whitespace();
      if (this.valueText[this.index] !== '"') fail('INVALID_JSON', path);
      const key = this.string(path);
      this.entries += 1;
      if (this.entries > 4_096) fail('LIMIT_EXCEEDED', path);
      const memberPath = pointer(path, key);
      if (keys.has(key)) fail('DUPLICATE_MEMBER', memberPath);
      if (FORBIDDEN_KEYS.has(key)) fail('FORBIDDEN_KEY', memberPath);
      keys.add(key);
      this.whitespace();
      if (this.valueText[this.index++] !== ':') fail('INVALID_JSON', memberPath);
      result[key] = this.value(depth + 1, memberPath);
      this.whitespace();
      const separator = this.valueText[this.index++];
      if (separator === '}') return result;
      if (separator !== ',') fail('INVALID_JSON', path);
    }
  }
  array(depth, path) {
    const result = [];
    this.index += 1;
    this.whitespace();
    if (this.valueText[this.index] === ']') {
      this.index += 1;
      return result;
    }
    while (true) {
      this.entries += 1;
      const itemPath = pointer(path, result.length);
      if (this.entries > 4_096) fail('LIMIT_EXCEEDED', itemPath);
      result.push(this.value(depth + 1, itemPath));
      this.whitespace();
      const separator = this.valueText[this.index++];
      if (separator === ']') return result;
      if (separator !== ',') fail('INVALID_JSON', path);
    }
  }
}

export const parseWorkflowSpec = (value) => {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 49_152)
    fail('LIMIT_EXCEEDED', '');
  const reader = new JsonReader(value);
  const parsed = reader.value();
  reader.whitespace();
  if (reader.index !== value.length) fail('INVALID_JSON', '');
  return validateWorkflowSpec(parsed);
};

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const compareNullable = (left, right, comparator = compare) => {
  if (left === null) return right === null ? 0 : -1;
  if (right === null) return 1;
  return comparator(left, right);
};
const SORTED_ARRAY_KEYS = new Set([
  'sources',
  'subflows',
  'nodes',
  'edges',
  'entryNodeIds',
  'exitNodeIds',
  'stateInputs',
  'stateOutputs',
  'tools',
  'skills',
  'retryOn',
  'emitsStateKeys',
  'branchEdgeIds',
  'incomingEdgeIds',
  'stateKeys',
  'sourceRefs',
  'relatedElements',
]);
const normalize = (value, key = '') => {
  if (Array.isArray(value)) {
    const items = value.map((item) => normalize(item));
    if (!SORTED_ARRAY_KEYS.has(key)) return items;
    return items.sort((left, right) => {
      if (typeof left === 'string') return compare(left, right);
      if (key === 'sourceRefs') {
        const sourceOrder = compare(left.sourceId, right.sourceId);
        if (sourceOrder !== 0) return sourceOrder;
        const startOrder = compareNullable(
          left.startLine,
          right.startLine,
          (leftLine, rightLine) => leftLine - rightLine,
        );
        if (startOrder !== 0) return startOrder;
        const endOrder = compareNullable(
          left.endLine,
          right.endLine,
          (leftLine, rightLine) => leftLine - rightLine,
        );
        return endOrder !== 0 ? endOrder : compareNullable(left.locator, right.locator);
      }
      if (key === 'relatedElements')
        return compare(`${left.kind}\0${left.id}`, `${right.kind}\0${right.id}`);
      return compare(left.id ?? left.key, right.id ?? right.key);
    });
  }
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort(compare)
        .map((nestedKey) => [nestedKey, normalize(value[nestedKey], nestedKey)]),
    );
  return value;
};

export const canonicalizeWorkflowSpec = (input) => {
  const canonical = `${JSON.stringify(normalize(validateWorkflowSpec(input)))}\n`;
  if (Buffer.byteLength(canonical, 'utf8') > 49_152) fail('LIMIT_EXCEEDED', '');
  return canonical;
};

export const analyzeWorkflowSpec = (input) => {
  const value = validateWorkflowSpec(input);
  const findings = [];
  const messages = Object.freeze({
    UNREACHABLE_NODE: 'The node is not reachable from a declared entry node.',
    NON_RETRY_CYCLE: 'The flow contains a cycle that is not expressed with retry edges.',
    UNKNOWN_CONDITION: 'The conditional route has no known condition.',
    DECISION_ROUTE_MISSING: 'The decision does not declare at least two conditional routes.',
    PARALLEL_JOIN_MISMATCH: 'The parallel branches do not converge on one compatible join.',
    UNCERTAIN_ROUTE: 'The conditional route is based on unknown evidence or language.',
  });
  const add = (code, elementType, element) =>
    findings.push({
      code,
      elementType,
      elementId: element?.id ?? null,
      message: messages[code],
      evidence:
        element?.evidence ?? Object.freeze({ basis: 'inferred', confidence: 1, sourceRefs: [] }),
    });
  const flows = [
    {
      id: value.workflow.id,
      entryNodeIds: value.entryNodeIds,
      nodes: value.nodes,
      edges: value.edges,
    },
    ...value.subflows,
  ];
  for (const flow of flows) {
    const nodes = [...flow.nodes].sort((left, right) => compare(left.id, right.id));
    const edges = [...flow.edges].sort((left, right) => compare(left.id, right.id));
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const outbound = new Map(nodes.map((node) => [node.id, []]));
    for (const edge of edges) outbound.get(edge.fromNodeId).push(edge);
    const reachable = new Set(flow.entryNodeIds);
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges)
        if (reachable.has(edge.fromNodeId) && !reachable.has(edge.toNodeId)) {
          reachable.add(edge.toNodeId);
          changed = true;
        }
    }
    for (const node of nodes) if (!reachable.has(node.id)) add('UNREACHABLE_NODE', 'node', node);

    const nonRetryReachable = (startId) => {
      const result = new Set();
      const pending = (outbound.get(startId) ?? [])
        .filter(({ kind }) => kind !== 'retry')
        .map(({ toNodeId }) => toNodeId);
      while (pending.length > 0) {
        const nodeId = pending.pop();
        if (result.has(nodeId)) continue;
        result.add(nodeId);
        for (const edge of outbound.get(nodeId) ?? [])
          if (edge.kind !== 'retry') pending.push(edge.toNodeId);
      }
      return result;
    };
    const closure = new Map(nodes.map((node) => [node.id, nonRetryReachable(node.id)]));
    const reportedCycles = new Set();
    for (const node of nodes) {
      if (!closure.get(node.id).has(node.id)) continue;
      const members = nodes
        .filter(
          (candidate) =>
            closure.get(node.id).has(candidate.id) && closure.get(candidate.id).has(node.id),
        )
        .map(({ id: nodeId }) => nodeId)
        .sort(compare);
      const identity = members.join('\0');
      if (reportedCycles.has(identity)) continue;
      reportedCycles.add(identity);
      add('NON_RETRY_CYCLE', 'node', nodeById.get(members[0]));
    }

    for (const node of nodes) {
      if (node.kind === 'decision') {
        const routes = (outbound.get(node.id) ?? []).filter(({ kind }) => kind === 'conditional');
        if (routes.length < 2) add('DECISION_ROUTE_MISSING', 'node', node);
      }
      if (node.kind === 'parallel') {
        const branches = node.control.branchEdgeIds
          .map((edgeId) => edges.find(({ id: candidateId }) => candidateId === edgeId))
          .filter(Boolean);
        const joinSets = branches.map((branch) => {
          const reachableNodes = new Set([branch.toNodeId, ...closure.get(branch.toNodeId)]);
          return new Set(
            nodes
              .filter((candidate) => candidate.kind === 'join' && reachableNodes.has(candidate.id))
              .map(({ id: nodeId }) => nodeId),
          );
        });
        const commonJoins = [...(joinSets[0] ?? [])].filter((joinId) =>
          joinSets.every((joinSet) => joinSet.has(joinId)),
        );
        if (
          commonJoins.length === 0 ||
          commonJoins.every((joinId) => nodeById.get(joinId).control.mode !== node.control.mode)
        )
          add('PARALLEL_JOIN_MISMATCH', 'node', node);
      }
    }
    for (const edge of edges) {
      if (edge.kind !== 'conditional') continue;
      if (edge.condition === null) add('UNKNOWN_CONDITION', 'edge', edge);
      else if (edge.condition.language === 'unknown' || edge.evidence.basis === 'unknown')
        add('UNCERTAIN_ROUTE', 'edge', edge);
    }
  }
  const codeOrder = new Map(WORKFLOW_SPEC_WARNING_CODES_V1.map((code, index) => [code, index]));
  findings.sort(
    (left, right) =>
      codeOrder.get(left.code) - codeOrder.get(right.code) ||
      compare(left.elementType, right.elementType) ||
      compare(left.elementId ?? '', right.elementId ?? ''),
  );
  const warnings = findings.map((warning, index) =>
    Object.freeze({
      id: `analysis_warning_${String(index + 1).padStart(3, '0')}`,
      ...warning,
    }),
  );
  return Object.freeze({ warnings: Object.freeze(warnings) });
};
