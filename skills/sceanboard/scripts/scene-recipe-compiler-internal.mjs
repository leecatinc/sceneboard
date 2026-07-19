// Private Scene Recipe v1 validator/compiler. The public facade injects SHA-256.

import {
  LIMITS_V1,
  isBoolean,
  isCodeText,
  isFiniteNumber,
  isGlobalId,
  isIdempotencyKey,
  isInteger,
  isKeyScalar,
  isLanguage,
  isMarkdownText,
  isShortText,
  validateExactNode,
} from './scene-recipe-validation-internal.mjs';

const KINDS = Object.freeze([
  'architecture', 'chart', 'code', 'dashboard', 'drawing', 'exact-node',
  'map', 'markdown', 'presentation', 'progress', 'status', 'table',
].sort());

const own = (value, key) => Object.hasOwn(value, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = (value, allowed, fail, path) => {
  if (!object(value)) fail('INVALID_RECIPE', path);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('UNKNOWN_FIELD', [...path, key]);
};

const copy = (value) => {
  if (Array.isArray(value)) return value.map(copy);
  if (object(value)) return Object.fromEntries(Object.keys(value).map((key) => [key, copy(value[key])]));
  return value;
};

const nodeTypeFor = (kind) => ({
  architecture: 'layout.canvas', chart: 'content.chart', code: 'content.code',
  dashboard: 'layout.grid', drawing: 'content.drawing', map: 'content.map',
  markdown: 'content.markdown', presentation: 'layout.tabs',
  progress: 'content.progress', status: 'content.status', table: 'content.table',
}[kind]);

export const SCENE_RECIPE_BLOCK_KINDS_INTERNAL = KINDS;

export const createSceneRecipeCompiler = ({ digest, slugify, canonicalPath, ErrorType }) => {
  const fail = (code, path = []) => { throw new ErrorType(code, path); };

  const requireValue = (condition, path) => { if (!condition) fail('INVALID_VALUE', path); };
  const requireArray = (value, min, max, path) => {
    requireValue(Array.isArray(value), path);
    if (value.length < min || value.length > max) fail('LIMIT_EXCEEDED', path);
  };

  const common = (block, fields, path) => {
    closed(block, ['kind', 'key', 'title', ...fields], fail, path);
    requireValue(typeof block.kind === 'string', [...path, 'kind']);
    if (block.key !== undefined) requireValue(isKeyScalar(block.key), [...path, 'key']);
    if (block.title !== undefined) requireValue(isShortText(block.title), [...path, 'title']);
  };

  const validateFriendly = (block, path, keys) => {
    if (!object(block)) fail('INVALID_RECIPE', path);
    if (!KINDS.includes(block.kind)) fail('UNKNOWN_BLOCK_KIND', [...path, 'kind']);
    if (block.kind === 'exact-node') {
      closed(block, ['kind', 'node'], fail, path);
      if (!own(block, 'node')) fail('INVALID_EXACT_NODE', [...path, 'node']);
      const error = validateExactNode(block.node, [...path, 'node']);
      if (error) fail('INVALID_EXACT_NODE', error.path);
      return;
    }
    const registerKey = () => {
      if (block.key === undefined) return;
      if (keys.has(block.key)) fail('DUPLICATE_SEMANTIC_IDENTITY', [...path, 'key']);
      keys.add(block.key);
    };
    if (block.kind === 'presentation') {
      common(block, ['activePageKey', 'pages'], path);
      registerKey();
      requireValue(isKeyScalar(block.activePageKey), [...path, 'activePageKey']);
      requireArray(block.pages, 1, LIMITS_V1.maxTabs, [...path, 'pages']);
      const pageKeys = new Set();
      block.pages.forEach((page, index) => {
        const pagePath = [...path, 'pages', index];
        closed(page, ['key', 'label', 'content'], fail, pagePath);
        requireValue(isKeyScalar(page.key), [...pagePath, 'key']);
        if (pageKeys.has(page.key)) fail('DUPLICATE_SEMANTIC_IDENTITY', [...pagePath, 'key']);
        pageKeys.add(page.key);
        requireValue(isShortText(page.label), [...pagePath, 'label']);
        validateFriendly(page.content, [...pagePath, 'content'], keys);
      });
      if (!pageKeys.has(block.activePageKey)) fail('INVALID_LAYOUT', [...path, 'activePageKey']);
      return;
    }
    if (block.kind === 'dashboard') {
      common(block, ['columns', 'rows', 'gap', 'items'], path); registerKey();
      requireValue(isInteger(block.columns) && block.columns >= 1 && block.columns <= LIMITS_V1.maxGridColumns, [...path, 'columns']);
      requireValue(isInteger(block.rows) && block.rows >= 1 && block.rows <= LIMITS_V1.maxGridRows, [...path, 'rows']);
      requireValue(isFiniteNumber(block.gap) && block.gap >= 0, [...path, 'gap']);
      requireArray(block.items, 1, LIMITS_V1.maxGridItems, [...path, 'items']);
      block.items.forEach((item, index) => {
        const itemPath = [...path, 'items', index];
        closed(item, ['content', 'column', 'row', 'columnSpan', 'rowSpan'], fail, itemPath);
        for (const field of ['column', 'row', 'columnSpan', 'rowSpan']) requireValue(isInteger(item[field]) && item[field] >= 1, [...itemPath, field]);
        validateFriendly(item.content, [...itemPath, 'content'], keys);
      });
      return;
    }
    if (block.kind === 'architecture') {
      common(block, ['width', 'height', 'items'], path); registerKey();
      requireValue(isFiniteNumber(block.width) && block.width > 0 && block.width <= LIMITS_V1.maxCanvasExtent, [...path, 'width']);
      requireValue(isFiniteNumber(block.height) && block.height > 0 && block.height <= LIMITS_V1.maxCanvasExtent, [...path, 'height']);
      requireArray(block.items, 1, LIMITS_V1.maxCanvasItems, [...path, 'items']);
      block.items.forEach((item, index) => {
        const itemPath = [...path, 'items', index];
        closed(item, ['content', 'x', 'y', 'width', 'height', 'zIndex'], fail, itemPath);
        requireValue(isFiniteNumber(item.x) && item.x >= 0, [...itemPath, 'x']);
        requireValue(isFiniteNumber(item.y) && item.y >= 0, [...itemPath, 'y']);
        requireValue(isFiniteNumber(item.width) && item.width > 0, [...itemPath, 'width']);
        requireValue(isFiniteNumber(item.height) && item.height > 0, [...itemPath, 'height']);
        requireValue(Number.isSafeInteger(item.zIndex), [...itemPath, 'zIndex']);
        validateFriendly(item.content, [...itemPath, 'content'], keys);
      });
      return;
    }
    const fields = {
      markdown: ['markdown'], code: ['language', 'code', 'showLineNumbers', 'wrap'],
      table: ['columns', 'rows'], chart: ['chartType', 'xAxis', 'yAxis', 'series'],
      map: ['viewport', 'data'], drawing: ['viewBox', 'elements'],
      status: ['status', 'label', 'detail'], progress: ['state', 'value', 'label', 'detail'],
    }[block.kind];
    common(block, fields, path); registerKey();
    const probe = { id: 'n_probe_000000000000', type: nodeTypeFor(block.kind) };
    if (block.title !== undefined) probe.title = block.title;
    for (const field of fields) if (own(block, field)) probe[field] = copy(block[field]);
    const error = validateExactNode(probe, path);
    if (error) fail('INVALID_VALUE', error.path);
  };

  const validate = (input) => {
    closed(input, ['recipeVersion', 'root'], fail, []);
    if (input.recipeVersion !== 1) fail('UNSUPPORTED_RECIPE_VERSION', ['recipeVersion']);
    if (!own(input, 'root')) fail('INVALID_RECIPE', ['root']);
    if (input.root !== null) validateFriendly(input.root, ['root'], new Set());
    return input;
  };

  const compile = (input) => {
    validate(input);
    const ids = new Map();
    const generated = new Map();
    const registerNode = (id, path, identity = null) => {
      if (ids.has(id)) fail(identity && generated.has(id) && generated.get(id) !== identity ? 'NODE_ID_COLLISION' : 'DUPLICATE_NODE_ID', [...path, 'id']);
      ids.set(id, true); if (identity) generated.set(id, identity);
    };
    const derive = (path, type, key) => {
      const identity = `${canonicalPath(path)}\n${type}\n${key ?? ''}`;
      const id = `n_${slugify(key ?? type)}_${digest(`recipe-v1\n${identity}`).slice(0, 12)}`;
      registerNode(id, path, identity); return id;
    };
    const tabId = (path, key) => `t_${slugify(key)}_${digest(`recipe-v1\n${canonicalPath(path)}\ntab\n${key}`).slice(0, 12)}`;
    const registerExact = (node, path) => {
      registerNode(node.id, path);
      if (node.type === 'layout.split' || node.type === 'layout.grid' || node.type === 'layout.canvas') node.children.forEach((child, index) => registerExact(child.node, [...path, 'children', index, 'node']));
      if (node.type === 'layout.tabs') node.tabs.forEach((tab, index) => registerExact(tab.node, [...path, 'tabs', index, 'node']));
    };
    const walk = (block, path) => {
      if (block.kind === 'exact-node') { const node = copy(block.node); registerExact(node, [...path, 'node']); return node; }
      const type = nodeTypeFor(block.kind);
      const node = { id: derive(path, type, block.key), type };
      if (block.title !== undefined) node.title = block.title;
      if (block.kind === 'presentation') {
        node.tabs = block.pages.map((page, index) => ({ tabId: tabId([...path, 'pages', index], page.key), label: page.label, node: walk(page.content, [...path, 'pages', index, 'content']) }));
        const activeIndex = block.pages.findIndex((page) => page.key === block.activePageKey);
        node.activeTabId = node.tabs[activeIndex].tabId;
      } else if (block.kind === 'dashboard') {
        Object.assign(node, { columns: block.columns, rows: block.rows, gap: block.gap, children: block.items.map((item, index) => ({ node: walk(item.content, [...path, 'items', index, 'content']), column: item.column, row: item.row, columnSpan: item.columnSpan, rowSpan: item.rowSpan })) });
      } else if (block.kind === 'architecture') {
        Object.assign(node, { width: block.width, height: block.height, children: block.items.map((item, index) => ({ node: walk(item.content, [...path, 'items', index, 'content']), x: item.x, y: item.y, width: item.width, height: item.height, zIndex: item.zIndex })) });
      } else {
        const skip = new Set(['kind', 'key', 'title']);
        for (const key of Object.keys(block)) if (!skip.has(key)) node[key] = copy(block[key]);
      }
      return node;
    };
    const root = input.root === null ? null : walk(input.root, ['root']);
    if (root !== null) {
      const error = validateExactNode(root, ['root']);
      if (error) fail('INVALID_LAYOUT', error.path);
    }
    const scene = { protocolVersion: 1, type: 'scene', root };
    const bytes = Buffer.byteLength(JSON.stringify(scene));
    if (bytes > LIMITS_V1.maxSceneBytes) fail('PAYLOAD_TOO_LARGE', []);
    if (ids.size > LIMITS_V1.maxSceneNodes) fail('LIMIT_EXCEEDED', ['root']);
    return scene;
  };

  const replaceInput = (input, binding) => {
    closed(binding, ['boardId', 'expectedRevisionId', 'idempotencyKey'], fail, []);
    requireValue(isGlobalId(binding.boardId), ['boardId']);
    requireValue(isGlobalId(binding.expectedRevisionId), ['expectedRevisionId']);
    requireValue(isIdempotencyKey(binding.idempotencyKey), ['idempotencyKey']);
    return { boardId: binding.boardId, expectedRevisionId: binding.expectedRevisionId, idempotencyKey: binding.idempotencyKey, scene: compile(input) };
  };

  return Object.freeze({ validate, compile, replaceInput });
};
