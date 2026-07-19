import {
  canonicalizeSceneRecipeJson,
  deriveSceneRecipeNodeId,
  stringifyCanonicalSceneRecipeJson,
} from './scene-recipe-core.mjs';

export const SCENE_ARTIFACT_RECIPE_VERSION = 1;
export const SCENE_ARTIFACT_TEMPLATE_VERSION = 1;
export const SCENE_ARTIFACT_TEMPLATE_NAMES_V1 = Object.freeze(['animated-data-story', 'architecture-map', 'metric-story', 'process-flow', 'timeline']);
export const SCENE_ARTIFACT_MOTION_LEVELS_V1 = Object.freeze(['none', 'subtle', 'staged', 'focus']);

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); Object.values(value).forEach(deepFreeze);
  }
  return value;
};

export const SCENE_ARTIFACT_LIMITS_V1 = deepFreeze({
  json: { maxBytes: 65536, maxDepth: 16, maxContainerEntries: 512, maxUserTextScalars: 8192 },
  text: { commonMinScalars: 1, placementKeyMaxScalars: 200, titleMaxScalars: 200, fallbackTextMaxScalars: 200, metricLabelMaxScalars: 60, metricValueMaxScalars: 40, detailMaxScalars: 120, processLabelMaxScalars: 60, architectureKeyMaxScalars: 64, architectureLabelMaxScalars: 60, edgeLabelMaxScalars: 60, timelineDateMaxScalars: 32, timelineLabelMaxScalars: 60, seriesLabelMaxScalars: 60, unitMaxScalars: 20, pointLabelMaxScalars: 40 },
  size: { widthMin: 320, widthMax: 1920, heightMin: 240, heightMax: 1080 },
  collections: { metricsMin: 1, metricsMax: 6, stepsMin: 2, stepsMax: 10, activeStepsMax: 1, architectureNodesMin: 2, architectureNodesMax: 12, architectureEdgesMin: 0, architectureEdgesMax: 16, timelineEventsMin: 2, timelineEventsMax: 12, currentEventsMax: 1, dataPointsMin: 2, dataPointsMax: 12 },
  numbers: { dataValueMin: -1000000000, dataValueMax: 1000000000 },
  identifiers: { globalIdMinScalars: 1, globalIdMaxScalars: 128, nodeIdMinScalars: 1, nodeIdMaxScalars: 64 },
  source: { htmlMinBytes: 1, htmlMaxBytes: 262144, cssMinBytes: 1, cssMaxBytes: 65536, javascriptMinBytes: 1, javascriptMaxBytes: 32768, combinedMaxBytes: 360448 },
  sanitizer: { htmlNodesMax: 10000, htmlDepthMax: 64, attributesPerElementMax: 64, cssRulesMax: 1024, cssDeclarationsMax: 16384 },
  catalog: { descriptorCount: 5, descriptorMaxBytes: 4096 },
  motion: { subtleOpacityStart: 0.92, subtleDurationMs: 280, subtleTranslateMaxPx: 4, subtleIterations: 1, subtleDelayMs: 0, stagedDurationMs: 320, stagedDelayStepMs: 70, stagedTranslateMaxPx: 8, stagedIterations: 1, stagedItemsMax: 12, stagedCompletionMaxMs: 1090, focusDurationMs: 640, focusIterations: 2, focusScaleMin: 1, focusScaleMax: 1.04, focusDelayMs: 0, focusCompletionMaxMs: 1280 },
});

const MESSAGES = Object.freeze({
  INVALID_JSON: 'Artifact JSON is invalid.', INVALID_ARTIFACT_RECIPE: 'Artifact recipe is invalid.',
  UNSUPPORTED_ARTIFACT_RECIPE_VERSION: 'Artifact recipe version is unsupported.', UNKNOWN_FIELD: 'Artifact input contains an unknown field.',
  UNKNOWN_TEMPLATE: 'Artifact template is unsupported.', INVALID_TEMPLATE_DESCRIPTOR: 'Artifact template descriptor is invalid.',
  INVALID_VALUE: 'Artifact input value is invalid.', INVALID_RELATION: 'Artifact input relation is invalid.',
  LIMIT_EXCEEDED: 'Artifact input limit is exceeded.', PAYLOAD_TOO_LARGE: 'Artifact payload is too large.',
  UNSAFE_ARTIFACT_SOURCE: 'Artifact source is unsafe.', INVALID_PLACEMENT: 'Artifact placement input is invalid.',
});

export class SceneArtifactError extends Error {
  constructor(code, path = []) { super(MESSAGES[code] ?? MESSAGES.INVALID_ARTIFACT_RECIPE); this.name = 'SceneArtifactError'; this.code = MESSAGES[code] ? code : 'INVALID_ARTIFACT_RECIPE'; this.path = [...path]; }
}

const fail = (code, path = []) => { throw new SceneArtifactError(code, path); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const closed = (value, fields, path, code = 'INVALID_ARTIFACT_RECIPE') => {
  if (!object(value)) fail(code, path);
  const keys = Object.keys(value);
  for (const key of keys) if (!fields.includes(key)) fail('UNKNOWN_FIELD', [...path, key]);
  for (const key of fields) if (!Object.hasOwn(value, key)) fail(code, [...path, key]);
};
const scalars = (value) => Array.from(value).length;
const text = (value, max, path, nullable = false) => {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || scalars(value) < 1 || scalars(value) > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff]/u.test(value)) fail('INVALID_VALUE', path);
};
const array = (value, min, max, path) => { if (!Array.isArray(value) || value.length < min || value.length > max) fail('LIMIT_EXCEEDED', path); };
const escapeHtml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export const stringifyCanonicalSceneArtifactJson = (value) => {
  try { return stringifyCanonicalSceneRecipeJson(value); } catch { fail('INVALID_VALUE', []); }
};

const parseJson = (bytes, placement) => {
  const buffer = Buffer.isBuffer(bytes) ? bytes : bytes instanceof Uint8Array ? Buffer.from(bytes) : null;
  if (!buffer) fail('INVALID_JSON', []);
  if (buffer.length > SCENE_ARTIFACT_LIMITS_V1.json.maxBytes) fail('PAYLOAD_TOO_LARGE', []);
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); } catch { fail('INVALID_JSON', []); }
  return placement ? validatePlacement(value) : validateSceneArtifactRecipe(value);
};
export const parseSceneArtifactRecipeJson = (bytes) => parseJson(bytes, false);
export const parseSceneArtifactPlacementJson = (bytes) => parseJson(bytes, true);

export const validateSceneArtifactTemplateDescriptor = (value) => {
  closed(value, ['artifactTemplateVersion', 'name', 'renderer', 'defaultSize'], [], 'INVALID_TEMPLATE_DESCRIPTOR');
  if (value.artifactTemplateVersion !== 1 || !SCENE_ARTIFACT_TEMPLATE_NAMES_V1.includes(value.name) || value.renderer !== value.name) fail('INVALID_TEMPLATE_DESCRIPTOR', []);
  closed(value.defaultSize, ['width', 'height'], ['defaultSize'], 'INVALID_TEMPLATE_DESCRIPTOR');
  const { width, height } = value.defaultSize;
  if (!Number.isSafeInteger(width) || width < 320 || width > 1920 || !Number.isSafeInteger(height) || height < 240 || height > 1080) fail('INVALID_TEMPLATE_DESCRIPTOR', ['defaultSize']);
  return canonicalizeSceneRecipeJson(value);
};

const validateContent = (recipe) => {
  const { content, template } = recipe;
  if (template === 'metric-story') {
    closed(content, ['metrics'], ['content']); array(content.metrics, 1, 6, ['content', 'metrics']);
    content.metrics.forEach((item, index) => { const p = ['content', 'metrics', index]; closed(item, ['label', 'value', 'detail', 'trend'], p); text(item.label, 60, [...p, 'label']); text(item.value, 40, [...p, 'value']); text(item.detail, 120, [...p, 'detail'], true); if (!['up', 'down', 'flat'].includes(item.trend)) fail('INVALID_VALUE', [...p, 'trend']); });
  } else if (template === 'process-flow') {
    closed(content, ['steps'], ['content']); array(content.steps, 2, 10, ['content', 'steps']); let active = 0;
    content.steps.forEach((item, index) => { const p = ['content', 'steps', index]; closed(item, ['label', 'detail', 'status'], p); text(item.label, 60, [...p, 'label']); text(item.detail, 120, [...p, 'detail'], true); if (!['complete', 'active', 'pending', 'blocked'].includes(item.status)) fail('INVALID_VALUE', [...p, 'status']); if (item.status === 'active') active += 1; }); if (active > 1) fail('INVALID_RELATION', ['content', 'steps']);
  } else if (template === 'architecture-map') {
    closed(content, ['nodes', 'edges'], ['content']); array(content.nodes, 2, 12, ['content', 'nodes']); array(content.edges, 0, 16, ['content', 'edges']); const ids = new Set();
    content.nodes.forEach((item, index) => { const p = ['content', 'nodes', index]; closed(item, ['key', 'label', 'role'], p); if (typeof item.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.key) || ids.has(item.key)) fail('INVALID_RELATION', [...p, 'key']); ids.add(item.key); text(item.label, 60, [...p, 'label']); if (!['source', 'service', 'store', 'external'].includes(item.role)) fail('INVALID_VALUE', [...p, 'role']); }); const pairs = new Set();
    content.edges.forEach((item, index) => { const p = ['content', 'edges', index]; closed(item, ['from', 'to', 'label'], p); text(item.label, 60, [...p, 'label'], true); const pair = `${item.from}\u0000${item.to}`; if (!ids.has(item.from) || !ids.has(item.to) || item.from === item.to || pairs.has(pair)) fail('INVALID_RELATION', p); pairs.add(pair); });
  } else if (template === 'timeline') {
    closed(content, ['events'], ['content']); array(content.events, 2, 12, ['content', 'events']); let current = 0;
    content.events.forEach((item, index) => { const p = ['content', 'events', index]; closed(item, ['date', 'label', 'detail', 'status'], p); text(item.date, 32, [...p, 'date']); text(item.label, 60, [...p, 'label']); text(item.detail, 120, [...p, 'detail'], true); if (!['past', 'current', 'future'].includes(item.status)) fail('INVALID_VALUE', [...p, 'status']); if (item.status === 'current') current += 1; }); if (current > 1) fail('INVALID_RELATION', ['content', 'events']);
  } else {
    closed(content, ['seriesLabel', 'unit', 'points'], ['content']); text(content.seriesLabel, 60, ['content', 'seriesLabel']); text(content.unit, 20, ['content', 'unit'], true); array(content.points, 2, 12, ['content', 'points']);
    content.points.forEach((item, index) => { const p = ['content', 'points', index]; closed(item, ['label', 'value'], p); text(item.label, 40, [...p, 'label']); if (!Number.isFinite(item.value) || Object.is(item.value, -0) || item.value < -1e9 || item.value > 1e9) fail('INVALID_VALUE', [...p, 'value']); });
  }
};

export const validateSceneArtifactRecipe = (value) => {
  closed(value, ['artifactRecipeVersion', 'template', 'placementKey', 'title', 'fallbackText', 'theme', 'size', 'motion', 'content'], []);
  if (value.artifactRecipeVersion !== 1) fail('UNSUPPORTED_ARTIFACT_RECIPE_VERSION', ['artifactRecipeVersion']);
  if (!SCENE_ARTIFACT_TEMPLATE_NAMES_V1.includes(value.template)) fail('UNKNOWN_TEMPLATE', ['template']);
  text(value.placementKey, 200, ['placementKey']); text(value.title, 200, ['title']); text(value.fallbackText, 200, ['fallbackText']);
  if (!['light', 'dark', 'high-contrast'].includes(value.theme)) fail('INVALID_VALUE', ['theme']);
  closed(value.size, ['width', 'height'], ['size']);
  if (!Number.isSafeInteger(value.size.width) || value.size.width < 320 || value.size.width > 1920 || !Number.isSafeInteger(value.size.height) || value.size.height < 240 || value.size.height > 1080) fail('INVALID_VALUE', ['size']);
  if (!SCENE_ARTIFACT_MOTION_LEVELS_V1.includes(value.motion)) fail('INVALID_VALUE', ['motion']);
  validateContent(value); return canonicalizeSceneRecipeJson(value);
};

const palette = (theme) => theme === 'dark' ? ['#0f172a', '#f8fafc', '#2dd4bf', '#1e293b'] : theme === 'high-contrast' ? ['#000000', '#ffffff', '#ffff00', '#222222'] : ['#ffffff', '#0f172a', '#0f766e', '#f1f5f9'];
const motionCss = (motion) => {
  if (motion === 'none') return '';
  const body = motion === 'subtle' ? 'opacity:.92;transform:translateY(4px)' : motion === 'staged' ? 'opacity:0;transform:translateY(8px)' : 'opacity:.86;transform:scale(1)';
  const duration = motion === 'subtle' ? '280ms' : motion === 'staged' ? '320ms' : '640ms';
  const count = motion === 'focus' ? '2' : '1';
  return `.sb-artifact-v1-motion{animation:sb-artifact-v1-reveal ${duration} ease-out ${count}}@keyframes sb-artifact-v1-reveal{from{${body}}to{opacity:1;transform:none}}@media (prefers-reduced-motion: reduce){.sb-artifact-v1-motion{animation:none!important;transition:none!important;transform:none!important;opacity:1!important}}`;
};
const baseCss = (recipe) => { const [bg, fg, accent, panel] = palette(recipe.theme); return `.sb-artifact-v1-root{box-sizing:border-box;width:${recipe.size.width}px;min-height:${recipe.size.height}px;padding:32px;background:${bg};color:${fg};font-family:system-ui,sans-serif}.sb-artifact-v1-root *{box-sizing:border-box}.sb-artifact-v1-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}.sb-artifact-v1-card{padding:18px;border:2px solid ${accent};border-radius:14px;background:${panel}}.sb-artifact-v1-accent{color:${accent}}${motionCss(recipe.motion)}`; };
const svg = (title, desc, inner) => `<svg viewBox="0 0 800 300" role="img"><title>${escapeHtml(title)}</title><desc>${escapeHtml(desc)}</desc>${inner}</svg>`;

const CANVAS_PROGRAM = `(()=>{const r=document.querySelector('[data-sb-artifact-root="animated-data-story-v1"]');if(!r)return;const c=r.querySelector('[data-sb-artifact-canvas="animated-data-story-v1"]');if(!c)return;let v;try{v=JSON.parse(c.getAttribute('data-sb-artifact-values'));}catch{return}const m=c.getAttribute('data-sb-artifact-motion');if(!Array.isArray(v)||v.length<2||v.length>12||!v.every(n=>Number.isFinite(n)&&!Object.is(n,-0)&&n>=-1e9&&n<=1e9)||!['none','subtle','staged','focus'].includes(m))return;const x=c.getContext('2d');if(!x)return;const draw=p=>{x.clearRect(0,0,c.width,c.height);const a=Math.max(...v.map(Math.abs),1);v.forEach((n,i)=>{const h=Math.abs(n)/a*180*p;x.fillStyle='#0f766e';x.fillRect(i*(c.width/v.length)+8,220-h,c.width/v.length-16,h)})};if(m==='none'||matchMedia('(prefers-reduced-motion: reduce)').matches){draw(1);return}const d=m==='focus'?1280:m==='staged'?1090:280,s=performance.now();const tick=t=>{const p=Math.min(1,(t-s)/d);draw(p);if(p<1)requestAnimationFrame(tick)};requestAnimationFrame(tick)})()`;

const render = (recipe) => {
  const h = escapeHtml; const cls = `sb-artifact-v1-root${recipe.motion === 'none' ? '' : ' sb-artifact-v1-motion'}`;
  let body; let javascript = null;
  if (recipe.template === 'metric-story') body = `<div class="sb-artifact-v1-grid">${recipe.content.metrics.map((m) => `<article class="sb-artifact-v1-card"><h2>${h(m.label)}</h2><strong class="sb-artifact-v1-accent">${h(m.value)}</strong>${m.detail === null ? '' : `<p>${h(m.detail)}</p>`}<p>Trend: ${h(m.trend)}</p></article>`).join('')}</div>`;
  else if (recipe.template === 'process-flow') { const items = recipe.content.steps.map((s, i) => `<li><strong>${i + 1}. ${h(s.label)}</strong> — ${h(s.status)}${s.detail === null ? '' : `<p>${h(s.detail)}</p>`}</li>`).join(''); body = `${svg(recipe.title, recipe.fallbackText, recipe.content.steps.map((_, i) => `<circle cx="${80 + i * 70}" cy="120" r="22" fill="#0f766e"/>`).join(''))}<ol>${items}</ol>`; }
  else if (recipe.template === 'architecture-map') { const facts = recipe.content.nodes.map((n) => `<li>${h(n.label)} (${h(n.role)})</li>`).join('') + recipe.content.edges.map((e) => `<li>${h(e.from)} → ${h(e.to)}${e.label === null ? '' : `: ${h(e.label)}`}</li>`).join(''); body = `${svg(recipe.title, recipe.fallbackText, recipe.content.nodes.map((_, i) => `<rect x="${30 + (i % 4) * 190}" y="${30 + Math.floor(i / 4) * 90}" width="150" height="56" rx="8" fill="#ccfbf1" stroke="#0f766e"/>`).join(''))}<ul>${facts}</ul>`; }
  else if (recipe.template === 'timeline') { body = `${svg(recipe.title, recipe.fallbackText, '<line x1="40" y1="150" x2="760" y2="150" stroke="#0f766e" stroke-width="4"/>')}<ol>${recipe.content.events.map((e) => `<li><strong>${h(e.date)} — ${h(e.label)}</strong> (${h(e.status)})${e.detail === null ? '' : `<p>${h(e.detail)}</p>`}</li>`).join('')}</ol>`; }
  else { const values = stringifyCanonicalSceneArtifactJson(recipe.content.points.map((p) => p.value)); body = `<table><caption>${h(recipe.content.seriesLabel)}</caption><tbody>${recipe.content.points.map((p) => `<tr><th>${h(p.label)}</th><td>${p.value}${recipe.content.unit === null ? '' : ` ${h(recipe.content.unit)}`}</td></tr>`).join('')}</tbody></table><canvas width="800" height="240" role="img" aria-label="${h(recipe.fallbackText)}" data-sb-artifact-canvas="animated-data-story-v1" data-sb-artifact-values="${h(values)}" data-sb-artifact-motion="${recipe.motion}"></canvas>`; javascript = CANVAS_PROGRAM; }
  const marker = recipe.template === 'animated-data-story' ? ' data-sb-artifact-root="animated-data-story-v1"' : '';
  return { artifactId: null, html: `<main class="${cls}"${marker}><h1>${h(recipe.title)}</h1><p>${h(recipe.fallbackText)}</p>${body}</main>`, css: baseCss(recipe), javascript, requestedCapabilities: [] };
};

export const auditSceneArtifactSource = (source) => {
  closed(source, ['artifactId', 'html', 'css', 'javascript', 'requestedCapabilities'], ['source'], 'UNSAFE_ARTIFACT_SOURCE');
  if (source.artifactId !== null || !Array.isArray(source.requestedCapabilities) || source.requestedCapabilities.length !== 0) fail('UNSAFE_ARTIFACT_SOURCE', ['source']);
  const htmlBytes = Buffer.byteLength(source.html ?? ''), cssBytes = Buffer.byteLength(source.css ?? ''), jsBytes = source.javascript === null ? 0 : Buffer.byteLength(source.javascript ?? '');
  if (htmlBytes < 1 || htmlBytes > 262144 || cssBytes < 1 || cssBytes > 65536 || jsBytes > 32768 || htmlBytes + cssBytes + jsBytes > 360448) fail('PAYLOAD_TOO_LARGE', ['source']);
  if (typeof source.html !== 'string' || typeof source.css !== 'string' || (source.javascript !== null && source.javascript !== CANVAS_PROGRAM)) fail('UNSAFE_ARTIFACT_SOURCE', ['source']);
  const tags = source.html.match(/<[^>]*>/g) ?? [];
  if (tags.some((tag) => /<\s*(script|iframe|object|embed|link|meta|img)\b/i.test(tag) || /\s(on[a-z]+|href|src|xlink:href)\s*=/i.test(tag)) || /(@import|@font-face|url\s*\(|image-set\s*\(|expression\s*\()/i.test(source.css)) fail('UNSAFE_ARTIFACT_SOURCE', ['source']);
  const hasCanvas = source.html.includes('data-sb-artifact-canvas="animated-data-story-v1"');
  if ((source.javascript === CANVAS_PROGRAM) !== hasCanvas) fail('UNSAFE_ARTIFACT_SOURCE', ['source', 'javascript']);
  return canonicalizeSceneRecipeJson(source);
};

export const compileSceneArtifactDraft = (input, descriptor) => {
  const recipe = validateSceneArtifactRecipe(input); const template = validateSceneArtifactTemplateDescriptor(descriptor);
  if (template.name !== recipe.template) fail('INVALID_RELATION', ['template']);
  const source = auditSceneArtifactSource(render(recipe));
  return { artifactRecipeVersion: 1, type: 'artifact-draft', template: recipe.template, motion: recipe.motion, source, placement: { nodeId: deriveSceneRecipeNodeId({ path: ['root'], nodeKind: 'content.artifact', key: recipe.placementKey }), title: recipe.title, fallbackText: recipe.fallbackText } };
};

const validatePlacement = (input) => {
  closed(input, ['artifact', 'placement'], [], 'INVALID_PLACEMENT'); closed(input.artifact, ['artifactId', 'versionId'], ['artifact'], 'INVALID_PLACEMENT'); closed(input.placement, ['nodeId', 'title', 'fallbackText'], ['placement'], 'INVALID_PLACEMENT');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.artifact.artifactId) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.artifact.versionId) || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(input.placement.nodeId)) fail('INVALID_PLACEMENT', []);
  text(input.placement.title, 200, ['placement', 'title']); text(input.placement.fallbackText, 200, ['placement', 'fallbackText']); return canonicalizeSceneRecipeJson(input);
};
export const createSceneArtifactPlacement = (input) => { const value = validatePlacement(input); return { id: value.placement.nodeId, type: 'content.artifact', title: value.placement.title, artifact: value.artifact, fallbackText: value.placement.fallbackText }; };
