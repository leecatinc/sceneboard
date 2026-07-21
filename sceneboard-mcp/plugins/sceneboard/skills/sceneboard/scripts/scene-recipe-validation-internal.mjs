// Private validation helpers for the Scene Recipe core.
//
// Reproduces the frozen board-schema v1 plain-JSON kernel, canonical JSON
// serialization, scalar/identifier grammars, the 15 closed node types, and the
// relational rules. This module is a private implementation target: it is
// imported by the facade and the compiler engine only and is never re-exported
// as part of the public surface. No filesystem, network, or workspace imports.

export const LIMITS_V1 = Object.freeze({
  maxEnvelopeBytes: 1_048_576,
  maxSceneBytes: 786_432,
  maxSceneDepth: 12,
  maxSceneNodes: 500,
  maxJsonDepth: 64,
  maxJsonContainerEntries: 10_000,
  maxSplitChildren: 12,
  maxGridColumns: 24,
  maxGridRows: 100,
  maxGridItems: 200,
  maxTabs: 20,
  maxCanvasItems: 200,
  maxCanvasExtent: 100_000,
  maxTitleChars: 200,
  maxImageAltChars: 500,
  maxMarkdownChars: 100_000,
  maxCodeChars: 200_000,
  maxTableColumns: 50,
  maxTableRows: 500,
  maxTableCells: 10_000,
  maxChartSeries: 32,
  maxChartPoints: 10_000,
  maxMapFeatures: 5_000,
  maxDrawingElements: 5_000,
});

const LOCAL_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const GLOBAL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const COLOR = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;
const LANGUAGE = /^[A-Za-z0-9_+.#-]{1,64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]{1,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]+$/;

const hasLoneSurrogate = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
};

const scalarLength = (value) => Array.from(value).length;

const compareScalars = (left, right) => {
  const leftScalars = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightScalars = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  const count = Math.min(leftScalars.length, rightScalars.length);
  for (let index = 0; index < count; index += 1) {
    const difference = (leftScalars[index] ?? 0) - (rightScalars[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftScalars.length - rightScalars.length;
};

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// --- Plain-JSON kernel (reproduces parser-kernel validateJsonValueV1) ---------

export const validatePlainJson = (input) => {
  const active = new WeakSet();
  const stack = [{ value: input, path: [], depth: 1, exiting: false }];
  while (stack.length > 0) {
    const frame = stack.pop();
    const { value, path, depth } = frame;
    if (frame.exiting) {
      if (typeof value === 'object' && value !== null) active.delete(value);
      continue;
    }
    if (depth > LIMITS_V1.maxJsonDepth)
      return { code: 'LIMIT_EXCEEDED', path, limit: 'maxJsonDepth' };
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return { code: 'INVALID_JSON', path };
      continue;
    }
    if (typeof value === 'string') {
      if (hasLoneSurrogate(value)) return { code: 'INVALID_JSON', path };
      continue;
    }
    if (typeof value !== 'object') return { code: 'INVALID_JSON', path };
    if (active.has(value)) return { code: 'INVALID_JSON', path };
    if (Object.getOwnPropertySymbols(value).length > 0) return { code: 'INVALID_JSON', path };
    if (!Array.isArray(value) && !isPlainObject(value)) return { code: 'INVALID_JSON', path };
    const keys = Object.keys(value);
    const ownStringKeys = Object.getOwnPropertyNames(value).filter(
      (key) => !Array.isArray(value) || key !== 'length',
    );
    if (ownStringKeys.length !== keys.length) return { code: 'INVALID_JSON', path };
    if (keys.length > LIMITS_V1.maxJsonContainerEntries)
      return { code: 'LIMIT_EXCEEDED', path, limit: 'maxJsonContainerEntries' };
    if (Array.isArray(value) && keys.length !== value.length) return { code: 'INVALID_JSON', path };
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.get || descriptor.set)
        return { code: 'INVALID_JSON', path: [...path, key] };
      if (hasLoneSurrogate(key)) return { code: 'INVALID_JSON', path: [...path, key] };
    }
    active.add(value);
    stack.push({ ...frame, exiting: true });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key === undefined) continue;
      stack.push({
        value: value[key],
        path: [...path, Array.isArray(value) ? Number(key) : key],
        depth: depth + 1,
      });
    }
  }
  return null;
};

// --- Canonical JSON serialization (reproduces parser-kernel canonicalBytesV1) -

export const serializeCanonicalJson = (value) => {
  const output = [];
  const stack = [{ kind: 'value', value }];
  while (stack.length > 0) {
    const task = stack.pop();
    if (task.kind === 'token') {
      output.push(task.value);
      continue;
    }
    const current = task.value;
    if (current === null) output.push('null');
    else if (typeof current === 'boolean') output.push(current ? 'true' : 'false');
    else if (typeof current === 'number')
      output.push(Object.is(current, -0) ? '0' : JSON.stringify(current));
    else if (typeof current === 'string') output.push(JSON.stringify(current));
    else if (Array.isArray(current)) {
      stack.push({ kind: 'token', value: ']' });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: 'value', value: current[index] });
        if (index > 0) stack.push({ kind: 'token', value: ',' });
      }
      stack.push({ kind: 'token', value: '[' });
    } else {
      const keys = Object.keys(current).sort(compareScalars);
      stack.push({ kind: 'token', value: '}' });
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        stack.push({ kind: 'value', value: current[key] });
        stack.push({ kind: 'token', value: ':' });
        stack.push({ kind: 'token', value: JSON.stringify(key) });
        if (index > 0) stack.push({ kind: 'token', value: ',' });
      }
      stack.push({ kind: 'token', value: '{' });
    }
  }
  return output.join('');
};

export const canonicalizeJsonValue = (value) => {
  if (value === null) return null;
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort(compareScalars))
      sorted[key] = canonicalizeJsonValue(value[key]);
    return sorted;
  }
  return value;
};

// --- Scalar / identifier predicates -------------------------------------------

export const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
export const isInteger = (value) => Number.isInteger(value);
export const isSafeInteger = (value) => Number.isSafeInteger(value);
export const isBoolean = (value) => typeof value === 'boolean';
export const isString = (value) => typeof value === 'string';

export const isLocalFieldId = (value) => typeof value === 'string' && LOCAL_ID.test(value);
export const isGlobalId = (value) => typeof value === 'string' && GLOBAL_ID.test(value);
export const isColor = (value) => typeof value === 'string' && COLOR.test(value);
export const isLanguage = (value) => typeof value === 'string' && LANGUAGE.test(value);
export const isDigest = (value) => typeof value === 'string' && DIGEST.test(value);
export const isMediaType = (value) => typeof value === 'string' && MEDIA_TYPE.test(value);

export const isTimestamp = (value) => {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return false;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return false;
  return new Date(instant).toISOString() === value;
};

export const isNormalizedArtifactPath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  !value.includes('\0') &&
  value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');

export const isIdempotencyKey = (value) =>
  typeof value === 'string' &&
  value.length >= 16 &&
  value.length <= 128 &&
  IDEMPOTENCY_KEY.test(value);

export const hasNoLoneSurrogate = (value) => typeof value === 'string' && !hasLoneSurrogate(value);

export const isShortText = (value) =>
  typeof value === 'string' &&
  !hasLoneSurrogate(value) &&
  scalarLength(value) >= 1 &&
  scalarLength(value) <= LIMITS_V1.maxTitleChars;

export const isContentText = (value) =>
  typeof value === 'string' &&
  !hasLoneSurrogate(value) &&
  scalarLength(value) <= LIMITS_V1.maxCodeChars;

export const isMarkdownText = (value) =>
  typeof value === 'string' &&
  !hasLoneSurrogate(value) &&
  scalarLength(value) <= LIMITS_V1.maxMarkdownChars;

export const isCodeText = (value) => isContentText(value);

export const isImageAltText = (value) =>
  typeof value === 'string' &&
  !hasLoneSurrogate(value) &&
  scalarLength(value) <= LIMITS_V1.maxImageAltChars;

// Recipe semantic key / page key scalar contract: 1..200 Unicode scalars, no lone surrogate.
export const isKeyScalar = (value) =>
  typeof value === 'string' &&
  !hasLoneSurrogate(value) &&
  scalarLength(value) >= 1 &&
  scalarLength(value) <= LIMITS_V1.maxTitleChars;

// --- GeoJSON helpers ----------------------------------------------------------

const isPosition = (value) =>
  Array.isArray(value) &&
  value.length === 2 &&
  isFiniteNumber(value[0]) &&
  value[0] >= -180 &&
  value[0] <= 180 &&
  isFiniteNumber(value[1]) &&
  value[1] >= -90 &&
  value[1] <= 90;

const isProperties = (value) => isPlainObject(value);

// --- Exact-node structural validators -----------------------------------------
// Each validator asserts the closed kind-specific fields and scalars and recurses
// into child nodes via checkNodeStructure. Returns null or { path } on failure.

const checkClosed = (value, allowed, path) => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return { path: [...path, key] };
  }
  return null;
};

const validateSplitStructure = (node, path, collected) => {
  const closed = checkClosed(
    node,
    new Set(['id', 'title', 'type', 'direction', 'gap', 'children']),
    path,
  );
  if (closed) return closed;
  if (node.direction !== 'horizontal' && node.direction !== 'vertical')
    return { path: [...path, 'direction'] };
  if (!isFiniteNumber(node.gap) || node.gap < 0 || node.gap > LIMITS_V1.maxCanvasExtent)
    return { path: [...path, 'gap'] };
  if (
    !Array.isArray(node.children) ||
    node.children.length < 2 ||
    node.children.length > LIMITS_V1.maxSplitChildren
  )
    return { path: [...path, 'children'] };
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    const childPath = [...path, 'children', index];
    if (!isPlainObject(child)) return { path: childPath };
    const childClosed = checkClosed(child, new Set(['node', 'weight']), childPath);
    if (childClosed) return childClosed;
    if (!isFiniteNumber(child.weight) || child.weight <= 0)
      return { path: [...childPath, 'weight'] };
    const inner = checkNodeStructure(child.node, [...childPath, 'node'], collected);
    if (inner) return inner;
  }
  return null;
};

const validateGridStructure = (node, path, collected) => {
  const closed = checkClosed(
    node,
    new Set(['id', 'title', 'type', 'columns', 'rows', 'gap', 'children']),
    path,
  );
  if (closed) return closed;
  if (!isInteger(node.columns) || node.columns < 1 || node.columns > LIMITS_V1.maxGridColumns)
    return { path: [...path, 'columns'] };
  if (!isInteger(node.rows) || node.rows < 1 || node.rows > LIMITS_V1.maxGridRows)
    return { path: [...path, 'rows'] };
  if (!isFiniteNumber(node.gap) || node.gap < 0 || node.gap > LIMITS_V1.maxCanvasExtent)
    return { path: [...path, 'gap'] };
  if (
    !Array.isArray(node.children) ||
    node.children.length < 1 ||
    node.children.length > LIMITS_V1.maxGridItems
  )
    return { path: [...path, 'children'] };
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    const childPath = [...path, 'children', index];
    if (!isPlainObject(child)) return { path: childPath };
    const childClosed = checkClosed(
      child,
      new Set(['node', 'column', 'row', 'columnSpan', 'rowSpan']),
      childPath,
    );
    if (childClosed) return childClosed;
    if (!isInteger(child.column) || child.column < 1) return { path: [...childPath, 'column'] };
    if (!isInteger(child.row) || child.row < 1) return { path: [...childPath, 'row'] };
    if (!isInteger(child.columnSpan) || child.columnSpan < 1)
      return { path: [...childPath, 'columnSpan'] };
    if (!isInteger(child.rowSpan) || child.rowSpan < 1) return { path: [...childPath, 'rowSpan'] };
    const inner = checkNodeStructure(child.node, [...childPath, 'node'], collected);
    if (inner) return inner;
  }
  return null;
};

const validateTabsStructure = (node, path, collected) => {
  const closed = checkClosed(node, new Set(['id', 'title', 'type', 'activeTabId', 'tabs']), path);
  if (closed) return closed;
  if (!isLocalFieldId(node.activeTabId)) return { path: [...path, 'activeTabId'] };
  if (!Array.isArray(node.tabs) || node.tabs.length < 1 || node.tabs.length > LIMITS_V1.maxTabs)
    return { path: [...path, 'tabs'] };
  for (let index = 0; index < node.tabs.length; index += 1) {
    const tab = node.tabs[index];
    const tabPath = [...path, 'tabs', index];
    if (!isPlainObject(tab)) return { path: tabPath };
    const tabClosed = checkClosed(tab, new Set(['tabId', 'label', 'node']), tabPath);
    if (tabClosed) return tabClosed;
    if (!isLocalFieldId(tab.tabId)) return { path: [...tabPath, 'tabId'] };
    if (!isShortText(tab.label)) return { path: [...tabPath, 'label'] };
    const inner = checkNodeStructure(tab.node, [...tabPath, 'node'], collected);
    if (inner) return inner;
  }
  return null;
};

const validateCanvasStructure = (node, path, collected) => {
  const closed = checkClosed(
    node,
    new Set(['id', 'title', 'type', 'width', 'height', 'children']),
    path,
  );
  if (closed) return closed;
  if (!isFiniteNumber(node.width) || node.width <= 0 || node.width > LIMITS_V1.maxCanvasExtent)
    return { path: [...path, 'width'] };
  if (!isFiniteNumber(node.height) || node.height <= 0 || node.height > LIMITS_V1.maxCanvasExtent)
    return { path: [...path, 'height'] };
  if (
    !Array.isArray(node.children) ||
    node.children.length < 1 ||
    node.children.length > LIMITS_V1.maxCanvasItems
  )
    return { path: [...path, 'children'] };
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    const childPath = [...path, 'children', index];
    if (!isPlainObject(child)) return { path: childPath };
    const childClosed = checkClosed(
      child,
      new Set(['node', 'x', 'y', 'width', 'height', 'zIndex']),
      childPath,
    );
    if (childClosed) return childClosed;
    if (!isFiniteNumber(child.x) || child.x < 0) return { path: [...childPath, 'x'] };
    if (!isFiniteNumber(child.y) || child.y < 0) return { path: [...childPath, 'y'] };
    if (!isFiniteNumber(child.width) || child.width <= 0) return { path: [...childPath, 'width'] };
    if (!isFiniteNumber(child.height) || child.height <= 0)
      return { path: [...childPath, 'height'] };
    if (!isSafeInteger(child.zIndex)) return { path: [...childPath, 'zIndex'] };
    const inner = checkNodeStructure(child.node, [...childPath, 'node'], collected);
    if (inner) return inner;
  }
  return null;
};

const validateMarkdownStructure = (node, path) => {
  const closed = checkClosed(node, new Set(['id', 'title', 'type', 'markdown']), path);
  if (closed) return closed;
  if (!isMarkdownText(node.markdown)) return { path: [...path, 'markdown'] };
  return null;
};

const validateCodeStructure = (node, path) => {
  const closed = checkClosed(
    node,
    new Set(['id', 'title', 'type', 'language', 'code', 'showLineNumbers', 'wrap']),
    path,
  );
  if (closed) return closed;
  if (!isLanguage(node.language)) return { path: [...path, 'language'] };
  if (!isCodeText(node.code)) return { path: [...path, 'code'] };
  if (!isBoolean(node.showLineNumbers)) return { path: [...path, 'showLineNumbers'] };
  if (!isBoolean(node.wrap)) return { path: [...path, 'wrap'] };
  return null;
};

const validateTableColumn = (column, path) => {
  if (!isPlainObject(column)) return { path };
  const closed = checkClosed(column, new Set(['key', 'label', 'valueType']), path);
  if (closed) return closed;
  if (!isLocalFieldId(column.key)) return { path: [...path, 'key'] };
  if (!isShortText(column.label)) return { path: [...path, 'label'] };
  if (
    column.valueType !== 'string' &&
    column.valueType !== 'number' &&
    column.valueType !== 'boolean' &&
    column.valueType !== 'datetime'
  )
    return { path: [...path, 'valueType'] };
  return null;
};

const validateTableCellValue = (value, valueType) => {
  if (value === null) return true;
  if (valueType === 'string') return typeof value === 'string';
  if (valueType === 'number') return isFiniteNumber(value);
  if (valueType === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string' && isTimestamp(value);
};

const validateTableStructure = (node, path) => {
  const closed = checkClosed(node, new Set(['id', 'title', 'type', 'columns', 'rows']), path);
  if (closed) return closed;
  if (
    !Array.isArray(node.columns) ||
    node.columns.length < 1 ||
    node.columns.length > LIMITS_V1.maxTableColumns
  )
    return { path: [...path, 'columns'] };
  for (let index = 0; index < node.columns.length; index += 1) {
    const colErr = validateTableColumn(node.columns[index], [...path, 'columns', index]);
    if (colErr) return colErr;
  }
  if (!Array.isArray(node.rows) || node.rows.length > LIMITS_V1.maxTableRows)
    return { path: [...path, 'rows'] };
  for (let index = 0; index < node.rows.length; index += 1) {
    const row = node.rows[index];
    const rowPath = [...path, 'rows', index];
    if (!isPlainObject(row)) return { path: rowPath };
    const rowClosed = checkClosed(row, new Set(['id', 'cells']), rowPath);
    if (rowClosed) return rowClosed;
    if (!isLocalFieldId(row.id)) return { path: [...rowPath, 'id'] };
    if (!isPlainObject(row.cells)) return { path: [...rowPath, 'cells'] };
    for (const cellKey of Object.keys(row.cells)) {
      if (!isLocalFieldId(cellKey)) return { path: [...rowPath, 'cells', cellKey] };
    }
  }
  return null;
};

const validateChartStructure = (node, path) => {
  const closed = checkClosed(
    node,
    new Set(['id', 'title', 'type', 'chartType', 'xAxis', 'yAxis', 'series']),
    path,
  );
  if (closed) return closed;
  if (
    node.chartType !== 'line' &&
    node.chartType !== 'bar' &&
    node.chartType !== 'area' &&
    node.chartType !== 'pie' &&
    node.chartType !== 'scatter'
  )
    return { path: [...path, 'chartType'] };
  if (!isPlainObject(node.xAxis)) return { path: [...path, 'xAxis'] };
  const xAxisClosed = checkClosed(node.xAxis, new Set(['valueType', 'label']), [...path, 'xAxis']);
  if (xAxisClosed) return xAxisClosed;
  if (
    node.xAxis.valueType !== 'category' &&
    node.xAxis.valueType !== 'number' &&
    node.xAxis.valueType !== 'datetime'
  )
    return { path: [...path, 'xAxis', 'valueType'] };
  if (node.xAxis.label !== undefined && !isShortText(node.xAxis.label))
    return { path: [...path, 'xAxis', 'label'] };
  if (!isPlainObject(node.yAxis)) return { path: [...path, 'yAxis'] };
  const yAxisClosed = checkClosed(node.yAxis, new Set(['label', 'min', 'max']), [...path, 'yAxis']);
  if (yAxisClosed) return yAxisClosed;
  if (node.yAxis.label !== undefined && !isShortText(node.yAxis.label))
    return { path: [...path, 'yAxis', 'label'] };
  if (node.yAxis.min !== undefined && !isFiniteNumber(node.yAxis.min))
    return { path: [...path, 'yAxis', 'min'] };
  if (node.yAxis.max !== undefined && !isFiniteNumber(node.yAxis.max))
    return { path: [...path, 'yAxis', 'max'] };
  if (
    !Array.isArray(node.series) ||
    node.series.length < 1 ||
    node.series.length > LIMITS_V1.maxChartSeries
  )
    return { path: [...path, 'series'] };
  for (let index = 0; index < node.series.length; index += 1) {
    const series = node.series[index];
    const seriesPath = [...path, 'series', index];
    if (!isPlainObject(series)) return { path: seriesPath };
    const seriesClosed = checkClosed(series, new Set(['id', 'label', 'points']), seriesPath);
    if (seriesClosed) return seriesClosed;
    if (!isLocalFieldId(series.id)) return { path: [...seriesPath, 'id'] };
    if (!isShortText(series.label)) return { path: [...seriesPath, 'label'] };
    if (!Array.isArray(series.points) || series.points.length > LIMITS_V1.maxChartPoints)
      return { path: [...seriesPath, 'points'] };
    for (let pointIndex = 0; pointIndex < series.points.length; pointIndex += 1) {
      const point = series.points[pointIndex];
      const pointPath = [...seriesPath, 'points', pointIndex];
      if (!isPlainObject(point)) return { path: pointPath };
      const pointClosed = checkClosed(point, new Set(['x', 'y']), pointPath);
      if (pointClosed) return pointClosed;
      if (!(typeof point.x === 'string' || isFiniteNumber(point.x)))
        return { path: [...pointPath, 'x'] };
      if (point.y !== null && !isFiniteNumber(point.y)) return { path: [...pointPath, 'y'] };
    }
  }
  return null;
};

const validateMapStructure = (node, path) => {
  const closed = checkClosed(node, new Set(['id', 'title', 'type', 'viewport', 'data']), path);
  if (closed) return closed;
  if (!isPlainObject(node.viewport)) return { path: [...path, 'viewport'] };
  const viewportClosed = checkClosed(node.viewport, new Set(['longitude', 'latitude', 'zoom']), [
    ...path,
    'viewport',
  ]);
  if (viewportClosed) return viewportClosed;
  if (
    !isFiniteNumber(node.viewport.longitude) ||
    node.viewport.longitude < -180 ||
    node.viewport.longitude > 180
  )
    return { path: [...path, 'viewport', 'longitude'] };
  if (
    !isFiniteNumber(node.viewport.latitude) ||
    node.viewport.latitude < -90 ||
    node.viewport.latitude > 90
  )
    return { path: [...path, 'viewport', 'latitude'] };
  if (!isFiniteNumber(node.viewport.zoom) || node.viewport.zoom < 0 || node.viewport.zoom > 24)
    return { path: [...path, 'viewport', 'zoom'] };
  if (!isPlainObject(node.data)) return { path: [...path, 'data'] };
  const dataClosed = checkClosed(node.data, new Set(['type', 'features']), [...path, 'data']);
  if (dataClosed) return dataClosed;
  if (node.data.type !== 'FeatureCollection') return { path: [...path, 'data', 'type'] };
  if (!Array.isArray(node.data.features) || node.data.features.length > LIMITS_V1.maxMapFeatures)
    return { path: [...path, 'data', 'features'] };
  for (let index = 0; index < node.data.features.length; index += 1) {
    const feature = node.data.features[index];
    const featurePath = [...path, 'data', 'features', index];
    if (!isPlainObject(feature)) return { path: featurePath };
    const featureClosed = checkClosed(
      feature,
      new Set(['type', 'id', 'properties', 'geometry']),
      featurePath,
    );
    if (featureClosed) return featureClosed;
    if (feature.type !== 'Feature') return { path: [...featurePath, 'type'] };
    if (feature.id !== undefined && !(typeof feature.id === 'string' || isFiniteNumber(feature.id)))
      return { path: [...featurePath, 'id'] };
    if (!isProperties(feature.properties)) return { path: [...featurePath, 'properties'] };
    const geometryErr = validateGeometry(feature.geometry, [...featurePath, 'geometry']);
    if (geometryErr) return geometryErr;
  }
  return null;
};

const validateGeometry = (geometry, path) => {
  if (!isPlainObject(geometry)) return { path };
  const closed = checkClosed(geometry, new Set(['type', 'coordinates']), path);
  if (closed) return closed;
  if (geometry.type === 'Point') {
    if (!isPosition(geometry.coordinates)) return { path: [...path, 'coordinates'] };
    return null;
  }
  if (geometry.type === 'LineString') {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2)
      return { path: [...path, 'coordinates'] };
    for (let index = 0; index < geometry.coordinates.length; index += 1) {
      if (!isPosition(geometry.coordinates[index]))
        return { path: [...path, 'coordinates', index] };
    }
    return null;
  }
  if (geometry.type === 'Polygon') {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 1)
      return { path: [...path, 'coordinates'] };
    for (let ringIndex = 0; ringIndex < geometry.coordinates.length; ringIndex += 1) {
      const ring = geometry.coordinates[ringIndex];
      if (!Array.isArray(ring) || ring.length < 4)
        return { path: [...path, 'coordinates', ringIndex] };
      for (let index = 0; index < ring.length; index += 1) {
        if (!isPosition(ring[index])) return { path: [...path, 'coordinates', ringIndex, index] };
      }
    }
    return null;
  }
  return { path: [...path, 'type'] };
};

const validateDrawingStyle = (style, path) => {
  if (!isPlainObject(style)) return { path };
  const closed = checkClosed(style, new Set(['stroke', 'fill', 'strokeWidth', 'opacity']), path);
  if (closed) return closed;
  if (style.stroke !== undefined && !isColor(style.stroke)) return { path: [...path, 'stroke'] };
  if (style.fill !== undefined && !isColor(style.fill)) return { path: [...path, 'fill'] };
  if (
    style.strokeWidth !== undefined &&
    (!isFiniteNumber(style.strokeWidth) || style.strokeWidth <= 0)
  )
    return { path: [...path, 'strokeWidth'] };
  if (
    style.opacity !== undefined &&
    (!isFiniteNumber(style.opacity) || style.opacity < 0 || style.opacity > 1)
  )
    return { path: [...path, 'opacity'] };
  return null;
};

const validatePoint = (point, path) => {
  if (!isPlainObject(point)) return { path };
  const closed = checkClosed(point, new Set(['x', 'y']), path);
  if (closed) return closed;
  if (!isFiniteNumber(point.x)) return { path: [...path, 'x'] };
  if (!isFiniteNumber(point.y)) return { path: [...path, 'y'] };
  return null;
};

const validateDrawingStructure = (node, path) => {
  const closed = checkClosed(node, new Set(['id', 'title', 'type', 'viewBox', 'elements']), path);
  if (closed) return closed;
  if (!isPlainObject(node.viewBox)) return { path: [...path, 'viewBox'] };
  const viewBoxClosed = checkClosed(node.viewBox, new Set(['x', 'y', 'width', 'height']), [
    ...path,
    'viewBox',
  ]);
  if (viewBoxClosed) return viewBoxClosed;
  if (!isFiniteNumber(node.viewBox.x)) return { path: [...path, 'viewBox', 'x'] };
  if (!isFiniteNumber(node.viewBox.y)) return { path: [...path, 'viewBox', 'y'] };
  if (!isFiniteNumber(node.viewBox.width) || node.viewBox.width <= 0)
    return { path: [...path, 'viewBox', 'width'] };
  if (!isFiniteNumber(node.viewBox.height) || node.viewBox.height <= 0)
    return { path: [...path, 'viewBox', 'height'] };
  if (!Array.isArray(node.elements) || node.elements.length > LIMITS_V1.maxDrawingElements)
    return { path: [...path, 'elements'] };
  for (let index = 0; index < node.elements.length; index += 1) {
    const element = node.elements[index];
    const elementPath = [...path, 'elements', index];
    if (!isPlainObject(element)) return { path: elementPath };
    const elementErr = validateDrawingElement(element, elementPath);
    if (elementErr) return elementErr;
  }
  return null;
};

const validateDrawingElement = (element, path) => {
  if (element.type === 'path') {
    const closed = checkClosed(element, new Set(['id', 'type', 'points', 'closed', 'style']), path);
    if (closed) return closed;
    if (!isLocalFieldId(element.id)) return { path: [...path, 'id'] };
    if (!Array.isArray(element.points) || element.points.length < 2)
      return { path: [...path, 'points'] };
    for (let index = 0; index < element.points.length; index += 1) {
      const pointErr = validatePoint(element.points[index], [...path, 'points', index]);
      if (pointErr) return pointErr;
    }
    if (!isBoolean(element.closed)) return { path: [...path, 'closed'] };
    return validateDrawingStyle(element.style, [...path, 'style']);
  }
  if (element.type === 'rect') {
    const closed = checkClosed(
      element,
      new Set(['id', 'type', 'x', 'y', 'width', 'height', 'style']),
      path,
    );
    if (closed) return closed;
    if (!isLocalFieldId(element.id)) return { path: [...path, 'id'] };
    if (!isFiniteNumber(element.x)) return { path: [...path, 'x'] };
    if (!isFiniteNumber(element.y)) return { path: [...path, 'y'] };
    if (!isFiniteNumber(element.width) || element.width <= 0) return { path: [...path, 'width'] };
    if (!isFiniteNumber(element.height) || element.height <= 0)
      return { path: [...path, 'height'] };
    return validateDrawingStyle(element.style, [...path, 'style']);
  }
  if (element.type === 'ellipse') {
    const closed = checkClosed(
      element,
      new Set(['id', 'type', 'cx', 'cy', 'rx', 'ry', 'style']),
      path,
    );
    if (closed) return closed;
    if (!isLocalFieldId(element.id)) return { path: [...path, 'id'] };
    if (!isFiniteNumber(element.cx)) return { path: [...path, 'cx'] };
    if (!isFiniteNumber(element.cy)) return { path: [...path, 'cy'] };
    if (!isFiniteNumber(element.rx) || element.rx <= 0) return { path: [...path, 'rx'] };
    if (!isFiniteNumber(element.ry) || element.ry <= 0) return { path: [...path, 'ry'] };
    return validateDrawingStyle(element.style, [...path, 'style']);
  }
  if (element.type === 'line') {
    const closed = checkClosed(element, new Set(['id', 'type', 'from', 'to', 'style']), path);
    if (closed) return closed;
    if (!isLocalFieldId(element.id)) return { path: [...path, 'id'] };
    const fromErr = validatePoint(element.from, [...path, 'from']);
    if (fromErr) return fromErr;
    const toErr = validatePoint(element.to, [...path, 'to']);
    if (toErr) return toErr;
    return validateDrawingStyle(element.style, [...path, 'style']);
  }
  if (element.type === 'text') {
    const closed = checkClosed(element, new Set(['id', 'type', 'x', 'y', 'text', 'style']), path);
    if (closed) return closed;
    if (!isLocalFieldId(element.id)) return { path: [...path, 'id'] };
    if (!isFiniteNumber(element.x)) return { path: [...path, 'x'] };
    if (!isFiniteNumber(element.y)) return { path: [...path, 'y'] };
    if (!isShortText(element.text)) return { path: [...path, 'text'] };
    return validateDrawingStyle(element.style, [...path, 'style']);
  }
  return { path: [...path, 'type'] };
};

const validateStatusStructure = (node, path) => {
  const closed = checkClosed(
    node,
    new Set(['id', 'title', 'type', 'status', 'label', 'detail']),
    path,
  );
  if (closed) return closed;
  if (
    node.status !== 'neutral' &&
    node.status !== 'info' &&
    node.status !== 'success' &&
    node.status !== 'warning' &&
    node.status !== 'error'
  )
    return { path: [...path, 'status'] };
  if (!isShortText(node.label)) return { path: [...path, 'label'] };
  if (node.detail !== undefined && !isMarkdownText(node.detail))
    return { path: [...path, 'detail'] };
  return null;
};

const validateArtifactReference = (value, path) => {
  if (!isPlainObject(value)) return { path };
  const closed = checkClosed(value, new Set(['artifactId', 'versionId']), path);
  if (closed) return closed;
  if (!isGlobalId(value.artifactId)) return { path: [...path, 'artifactId'] };
  if (!isGlobalId(value.versionId)) return { path: [...path, 'versionId'] };
  return null;
};

const validateImageStructure = (node, path) => {
  const closed = checkClosed(
    node,
    new Set(['id', 'title', 'type', 'source', 'alt', 'caption', 'fit']),
    path,
  );
  if (closed) return closed;
  if (!isPlainObject(node.source)) return { path: [...path, 'source'] };
  const sourceClosed = checkClosed(node.source, new Set(['type', 'artifact', 'path', 'sha256']), [
    ...path,
    'source',
  ]);
  if (sourceClosed) return sourceClosed;
  if (node.source.type !== 'artifact.resource') return { path: [...path, 'source', 'type'] };
  const artifactErr = validateArtifactReference(node.source.artifact, [
    ...path,
    'source',
    'artifact',
  ]);
  if (artifactErr) return artifactErr;
  if (!isNormalizedArtifactPath(node.source.path)) return { path: [...path, 'source', 'path'] };
  if (!isDigest(node.source.sha256)) return { path: [...path, 'source', 'sha256'] };
  if (!isImageAltText(node.alt)) return { path: [...path, 'alt'] };
  if (node.caption !== undefined && !isShortText(node.caption))
    return { path: [...path, 'caption'] };
  if (node.fit !== 'contain' && node.fit !== 'cover' && node.fit !== 'fill' && node.fit !== 'none')
    return { path: [...path, 'fit'] };
  return null;
};

const validateProgressStructure = (node, path) => {
  const closed = checkClosed(
    node,
    new Set(['id', 'title', 'type', 'state', 'value', 'label', 'detail']),
    path,
  );
  if (closed) return closed;
  if (
    node.state !== 'active' &&
    node.state !== 'paused' &&
    node.state !== 'complete' &&
    node.state !== 'failed'
  )
    return { path: [...path, 'state'] };
  if (node.value !== null && !isFiniteNumber(node.value)) return { path: [...path, 'value'] };
  if (node.value !== null && (node.value < 0 || node.value > 1))
    return { path: [...path, 'value'] };
  if (!isShortText(node.label)) return { path: [...path, 'label'] };
  if (node.detail !== undefined && !isShortText(node.detail)) return { path: [...path, 'detail'] };
  return null;
};

const validateHitlStructure = (node, path) => {
  const closed = checkClosed(node, new Set(['id', 'title', 'type', 'hitlRequestId']), path);
  if (closed) return closed;
  if (!isGlobalId(node.hitlRequestId)) return { path: [...path, 'hitlRequestId'] };
  return null;
};

const validateArtifactNodeStructure = (node, path) => {
  const closed = checkClosed(
    node,
    new Set(['id', 'title', 'type', 'artifact', 'fallbackText']),
    path,
  );
  if (closed) return closed;
  const artifactErr = validateArtifactReference(node.artifact, [...path, 'artifact']);
  if (artifactErr) return artifactErr;
  if (!isShortText(node.fallbackText)) return { path: [...path, 'fallbackText'] };
  return null;
};

const NODE_STRUCTURE_VALIDATORS = {
  'layout.split': validateSplitStructure,
  'layout.grid': validateGridStructure,
  'layout.tabs': validateTabsStructure,
  'layout.canvas': validateCanvasStructure,
  'content.markdown': validateMarkdownStructure,
  'content.code': validateCodeStructure,
  'content.table': validateTableStructure,
  'content.chart': validateChartStructure,
  'content.map': validateMapStructure,
  'content.drawing': validateDrawingStructure,
  'content.status': validateStatusStructure,
  'content.image': validateImageStructure,
  'content.progress': validateProgressStructure,
  'content.hitl': validateHitlStructure,
  'content.artifact': validateArtifactNodeStructure,
};

export const NODE_TYPES_V1 = Object.freeze(Object.keys(NODE_STRUCTURE_VALIDATORS));

// Recursive structural validation. Collects every visited node so the caller can
// run relation checks over the full subtree. Returns null or { path }.
export const checkNodeStructure = (node, path, collected) => {
  if (!isPlainObject(node)) return { path };
  if (typeof node.type !== 'string') return { path: [...path, 'type'] };
  if (!isLocalFieldId(node.id)) return { path: [...path, 'id'] };
  if (node.title !== undefined && !isShortText(node.title)) return { path: [...path, 'title'] };
  collected.push({ node, path });
  const validator = NODE_STRUCTURE_VALIDATORS[node.type];
  if (!validator) return { path: [...path, 'type'] };
  return validator(node, path, collected);
};

// --- Node self-relations (reproduces validateNodeRelationsV1 per-node rules) --
// Returns null or { code, path }. code is INVALID_LAYOUT or LIMIT_EXCEEDED.
export const validateNodeSelfRelations = (node, path) => {
  if (node.type === 'layout.tabs') {
    const tabs = node.tabs;
    const tabIds = tabs.map((tab) => tab.tabId);
    if (new Set(tabIds).size !== tabIds.length)
      return { code: 'INVALID_LAYOUT', path: [...path, 'tabs'] };
    if (!tabs.some((tab) => tab.tabId === node.activeTabId))
      return { code: 'INVALID_LAYOUT', path: [...path, 'activeTabId'] };
    return null;
  }
  if (node.type === 'layout.grid') {
    const occupied = new Set();
    for (let index = 0; index < node.children.length; index += 1) {
      const placement = node.children[index];
      const childPath = [...path, 'children', index];
      if (
        placement.column + placement.columnSpan - 1 > node.columns ||
        placement.row + placement.rowSpan - 1 > node.rows
      )
        return { code: 'INVALID_LAYOUT', path: childPath };
      for (let row = placement.row; row < placement.row + placement.rowSpan; row += 1) {
        for (
          let column = placement.column;
          column < placement.column + placement.columnSpan;
          column += 1
        ) {
          const key = `${row}:${column}`;
          if (occupied.has(key)) return { code: 'INVALID_LAYOUT', path: childPath };
          occupied.add(key);
        }
      }
    }
    return null;
  }
  if (node.type === 'layout.canvas') {
    for (let index = 0; index < node.children.length; index += 1) {
      const placement = node.children[index];
      if (
        placement.x + placement.width > node.width ||
        placement.y + placement.height > node.height
      )
        return { code: 'INVALID_LAYOUT', path: [...path, 'children', index] };
    }
    return null;
  }
  if (node.type === 'content.table') {
    const columns = node.columns;
    const rows = node.rows;
    const keys = columns.map((column) => column.key);
    if (new Set(keys).size !== keys.length)
      return { code: 'INVALID_LAYOUT', path: [...path, 'columns'] };
    const rowIds = rows.map((row) => row.id);
    if (new Set(rowIds).size !== rowIds.length)
      return { code: 'INVALID_LAYOUT', path: [...path, 'rows'] };
    if (columns.length * rows.length > LIMITS_V1.maxTableCells)
      return { code: 'LIMIT_EXCEEDED', path: [...path, 'rows'], limit: 'maxTableCells' };
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const cellsPath = [...path, 'rows', rowIndex, 'cells'];
      if (
        Object.keys(row.cells).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(row.cells, key))
      )
        return { code: 'INVALID_LAYOUT', path: cellsPath };
      for (const column of columns) {
        const value = row.cells[column.key];
        if (value === null) continue;
        if (!validateTableCellValue(value, column.valueType))
          return { code: 'INVALID_LAYOUT', path: [...cellsPath, column.key] };
      }
    }
    return null;
  }
  if (node.type === 'content.chart') {
    if (
      node.yAxis.min !== undefined &&
      node.yAxis.max !== undefined &&
      node.yAxis.min > node.yAxis.max
    )
      return { code: 'INVALID_LAYOUT', path: [...path, 'yAxis', 'max'] };
    const totalPoints = node.series.reduce((total, series) => total + series.points.length, 0);
    if (totalPoints > LIMITS_V1.maxChartPoints)
      return { code: 'LIMIT_EXCEEDED', path: [...path, 'series'], limit: 'maxChartPoints' };
    if (node.chartType === 'pie') {
      const first = node.series[0];
      const invalid =
        node.series.length !== 1 ||
        node.xAxis.valueType !== 'category' ||
        (first && first.points.some((point) => point.y === null || point.y < 0));
      if (invalid) return { code: 'INVALID_LAYOUT', path: [...path, 'series'] };
    }
    if (node.chartType === 'scatter' && node.xAxis.valueType !== 'number')
      return { code: 'INVALID_LAYOUT', path: [...path, 'xAxis', 'valueType'] };
    for (let seriesIndex = 0; seriesIndex < node.series.length; seriesIndex += 1) {
      const series = node.series[seriesIndex];
      for (let pointIndex = 0; pointIndex < series.points.length; pointIndex += 1) {
        const point = series.points[pointIndex];
        const validX =
          node.xAxis.valueType === 'number'
            ? typeof point.x === 'number'
            : node.xAxis.valueType === 'datetime'
              ? typeof point.x === 'string' && isTimestamp(point.x)
              : typeof point.x === 'string';
        if (!validX)
          return {
            code: 'INVALID_LAYOUT',
            path: [...path, 'series', seriesIndex, 'points', pointIndex, 'x'],
          };
      }
    }
    return null;
  }
  if (node.type === 'content.map') {
    const features = node.data.features;
    for (let featureIndex = 0; featureIndex < features.length; featureIndex += 1) {
      const feature = features[featureIndex];
      if (feature.geometry.type === 'Polygon') {
        for (let ringIndex = 0; ringIndex < feature.geometry.coordinates.length; ringIndex += 1) {
          const ring = feature.geometry.coordinates[ringIndex];
          const first = ring[0];
          const last = ring[ring.length - 1];
          if (!first || !last || first[0] !== last[0] || first[1] !== last[1])
            return {
              code: 'INVALID_LAYOUT',
              path: [
                ...path,
                'data',
                'features',
                featureIndex,
                'geometry',
                'coordinates',
                ringIndex,
              ],
            };
        }
      }
    }
    return null;
  }
  if (node.type === 'content.progress') {
    const state = node.state;
    const value = node.value;
    const invalid =
      state === 'complete'
        ? value !== 1
        : state !== 'active' && state !== 'paused' && value === null;
    if (invalid) return { code: 'INVALID_LAYOUT', path: [...path, 'value'] };
    return null;
  }
  return null;
};

// Full exact-node validation: recursive structure + duplicate IDs within subtree
// + per-node relations. Returns null or { path } (the inner failing path). The
// compiler wraps any failure into INVALID_EXACT_NODE at the exact-node's path.
export const validateExactNode = (root, rootPath) => {
  const collected = [];
  const structErr = checkNodeStructure(root, rootPath, collected);
  if (structErr) return structErr;
  const ids = new Map();
  for (const item of collected) {
    if (ids.has(item.node.id)) return { path: [...item.path, 'id'] };
    ids.set(item.node.id, true);
  }
  for (const item of collected) {
    const relErr = validateNodeSelfRelations(item.node, item.path);
    if (relErr) return { path: relErr.path };
  }
  return null;
};
