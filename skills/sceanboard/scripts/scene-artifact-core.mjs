import {
  canonicalizeSceneRecipeJson,
  deriveSceneRecipeNodeId,
  stringifyCanonicalSceneRecipeJson,
} from './scene-recipe-core.mjs';

export const SCENE_ARTIFACT_RECIPE_VERSION = 1;
export const SCENE_ARTIFACT_TEMPLATE_VERSION = 1;
export const SCENE_ARTIFACT_TEMPLATE_NAMES_V1 = Object.freeze(['animated-data-story', 'architecture-map', 'demo-showcase', 'metric-story', 'process-flow', 'timeline']);
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
  catalog: { descriptorCount: 6, descriptorMaxBytes: 4096 },
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
  } else if (template === 'demo-showcase') {
    closed(content, ['kind', 'selection', 'phase'], ['content']);
    if (!['illustration', 'diorama', 'prototype', 'data-story', 'incident', 'mission-control', 'code-review'].includes(content.kind)) fail('INVALID_VALUE', ['content', 'kind']);
    text(content.selection, 64, ['content', 'selection']); text(content.phase, 32, ['content', 'phase']);
    const allowed = {
      illustration: { selection: ['sunny-garden', 'space-adventure', 'rainy-city'], phase: ['outline', 'color'] },
      diorama: { selection: ['golden-garden', 'space-observatory', 'neon-street'], phase: ['ready'] },
      prototype: { selection: ['calm-itinerary', 'visual-explorer', 'risk-checker'], phase: ['initial', 'improved'] },
      'data-story': { selection: ['support-week'], phase: ['ready'] },
      incident: { selection: ['cache-unavailable', 'pool-exhausted', 'queue-backlog'], phase: ['failure', 'recovery'] },
      'mission-control': { selection: ['launch-readiness'], phase: ['ready'] },
      'code-review': { selection: ['no-charge', 'checkout-speed', 'concurrent-inventory'], phase: ['review', 'final'] },
    }[content.kind];
    if (!allowed.selection.includes(content.selection)) fail('INVALID_RELATION', ['content', 'selection']);
    if (!allowed.phase.includes(content.phase)) fail('INVALID_RELATION', ['content', 'phase']);
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

const DEMO_SHOWCASE_PROGRAM = `(()=>{const r=document.querySelector('[data-sb-demo-showcase="v1"]');if(!r)return;const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;const stage=r.querySelector('[data-demo-stage]');if(stage&&!reduce){stage.addEventListener('pointermove',e=>{const b=stage.getBoundingClientRect(),x=(e.clientX-b.left)/b.width-.5,y=(e.clientY-b.top)/b.height-.5;stage.style.setProperty('--rx',(-y*7)+'deg');stage.style.setProperty('--ry',(x*9)+'deg')});stage.addEventListener('pointerleave',()=>{stage.style.setProperty('--rx','0deg');stage.style.setProperty('--ry','0deg')})}const log=r.querySelector('[data-demo-log]');const note=t=>{if(log)log.textContent=t};r.querySelectorAll('[data-demo-screen]').forEach(b=>b.addEventListener('click',()=>{const id=b.getAttribute('data-demo-screen');r.querySelectorAll('[data-phone-view]').forEach(v=>v.hidden=v.getAttribute('data-phone-view')!==id);note(b.getAttribute('data-demo-message')||'The prototype moved to another screen.')}));const reset=r.querySelector('[data-demo-reset]');if(reset)reset.addEventListener('click',()=>{r.querySelectorAll('[data-phone-view]').forEach(v=>v.hidden=v.getAttribute('data-phone-view')!=='home');note('The prototype returned to its starting screen.')});r.querySelectorAll('[data-incident-state]').forEach(b=>b.addEventListener('click',()=>{const s=b.getAttribute('data-incident-state');r.setAttribute('data-active-incident',s);note('The architecture view now shows the '+s+' state.')}));const toggle=r.querySelector('[data-review-toggle]');if(toggle)toggle.addEventListener('click',()=>{const on=toggle.getAttribute('aria-pressed')!=='true';toggle.setAttribute('aria-pressed',String(on));r.setAttribute('data-inventory-unavailable',String(on));note(on?'Unavailable inventory stops before payment.':'The successful request reaches confirmation.')});const play=r.querySelector('[data-review-play]');if(play)play.addEventListener('click',()=>{r.classList.remove('is-playing');void r.offsetWidth;r.classList.add('is-playing');note(r.getAttribute('data-inventory-unavailable')==='true'?'The new flow stopped before charging the card.':'Both illustrative requests completed.')});const replay=r.querySelector('[data-story-replay]');if(replay)replay.addEventListener('click',()=>{r.classList.remove('is-replaying');void r.offsetWidth;r.classList.add('is-replaying');note('The illustrative seven-day story is replaying.')});if(window.SceneBoardArtifact&&window.SceneBoardArtifact.requestResize)window.SceneBoardArtifact.requestResize(1200,675)})()`;

const demoShowcaseCss = `.sb-demo{position:relative;width:1200px;height:675px;overflow:hidden;padding:30px;background:linear-gradient(135deg,#f8fafc,#ecfeff);color:#102a2a;font-family:system-ui,sans-serif}.sb-demo *{box-sizing:border-box}.sb-demo h1{margin:0;font-size:36px;letter-spacing:-.03em}.sb-demo .eyebrow{margin:0 0 8px;color:#0f766e;font-weight:800;text-transform:uppercase;letter-spacing:.12em}.sb-demo .sub{margin:8px 0 18px;font-size:17px}.demo-grid{display:grid;gap:18px}.demo-card{border:2px solid #99f6e4;border-radius:18px;background:#fff;padding:18px;box-shadow:0 12px 30px #0f766e18}.demo-btn{border:2px solid #0f766e;border-radius:10px;background:#fff;color:#0f3d3a;padding:10px 16px;font-weight:800;cursor:pointer}.demo-btn:focus-visible{outline:4px solid #f59e0b;outline-offset:2px}.demo-btn.primary{background:#0f766e;color:#fff}.demo-log{position:absolute;left:30px;right:30px;bottom:18px;padding:10px 16px;border-radius:12px;background:#0f172a;color:#f8fafc;font-weight:700}.cat-stage{height:500px;border:3px solid #0f766e;border-radius:24px;background:#fffdf4;display:grid;place-items:center}.cat-stage svg{width:92%;height:92%}.sketch{fill:none;stroke:#172033;stroke-width:7;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:2200;stroke-dashoffset:2200;animation:draw 6s linear forwards}.cat-color{opacity:0;animation:paint 5s 1s ease forwards}.sb-demo[data-phase="outline"] .cat-color{display:none}@keyframes draw{to{stroke-dashoffset:0}}@keyframes paint{to{opacity:1}}.paper-scene{height:510px;perspective:900px;display:grid;place-items:center;background:#0f172a;border-radius:24px;overflow:hidden}.paper-world{position:relative;width:900px;height:430px;transform-style:preserve-3d;transform:rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg));transition:transform .25s ease}.paper-layer{position:absolute;inset:0;display:grid;place-items:center;transform-style:preserve-3d;transition:transform 3s ease}.paper-layer.atmosphere{transform:translateZ(-160px);background:radial-gradient(circle,#fde68a22,transparent 65%)}.paper-layer.back{transform:translateZ(-90px)}.paper-layer.middle{transform:translateZ(-30px)}.paper-layer.cat{transform:translateZ(70px);font-size:150px;filter:drop-shadow(0 24px 12px #0008);animation:breathe 3s ease-in-out infinite}.paper-layer.front{transform:translateZ(130px);font-size:60px}.paper-shape{font-size:92px;filter:drop-shadow(0 18px 10px #0007)}@keyframes breathe{50%{transform:translateZ(70px) translateY(-8px)}}.prototype-layout{grid-template-columns:410px 1fr;align-items:center;height:520px}.phone{width:300px;height:500px;margin:auto;padding:16px;border:12px solid #172033;border-radius:42px;background:#f8fafc;box-shadow:0 20px 40px #0003}.phone-top{display:flex;justify-content:space-between;font-weight:800}.phone-view{margin-top:24px}.phone-view[hidden]{display:none}.trip-item{margin:12px 0;padding:14px;border-radius:14px;background:#ccfbf1}.story{grid-template-columns:1.3fr .7fr;height:505px}.bars{display:flex;gap:18px;align-items:end;height:330px;padding:30px;border-radius:18px;background:#fff}.bar{flex:1;height:calc(var(--v)*1%);min-height:25px;background:#14b8a6;border-radius:10px 10px 0 0;animation:grow 2s ease both}.bar.spike{background:#f97316}.bar span{display:block;transform:translateY(-25px);text-align:center;font-weight:800}@keyframes grow{from{height:0}}.decision{display:grid;align-content:center;gap:14px}.incident-map{grid-template-columns:1fr 340px;height:500px}.system-line{display:flex;align-items:center;justify-content:center;gap:12px}.node{min-width:120px;padding:20px 12px;border:3px solid #0f766e;border-radius:16px;background:#d1fae5;text-align:center;font-weight:800}.arrow{font-size:28px}.sb-demo[data-active-incident="failure"] .node.affected{border-color:#dc2626;background:#fee2e2}.sb-demo[data-active-incident="recovery"] .node.affected{border-color:#d97706;background:#fef3c7}.incident-controls{display:flex;gap:8px;margin-top:25px}.mission{height:500px;grid-template-columns:1fr 1fr}.ring{width:260px;height:260px;margin:auto;border:28px solid #2dd4bf;border-right-color:#f59e0b;border-radius:50%;display:grid;place-items:center;font-size:52px;font-weight:900;animation:spin-in 2s ease}@keyframes spin-in{from{transform:rotate(-180deg);opacity:0}}.checks{display:grid;align-content:center;gap:14px}.check{padding:14px;border-left:8px solid #14b8a6;background:#fff}.review{grid-template-columns:1fr 1fr;height:460px}.flow{display:flex;flex-wrap:wrap;align-content:center;gap:10px}.step{padding:14px;border:2px solid #64748b;border-radius:12px;background:#fff;font-weight:800}.risk{border-color:#dc2626}.gate{border-color:#0f766e;background:#ccfbf1}.pulse{width:14px;height:14px;border-radius:50%;background:#f97316;opacity:0}.is-playing .pulse{animation:travel 2.5s ease}@keyframes travel{0%{opacity:1;transform:translateX(0)}100%{opacity:1;transform:translateX(480px)}}.sb-demo[data-inventory-unavailable="true"] .after-charge{opacity:.25}.sb-demo[data-inventory-unavailable="true"] .stop-note{display:block}.stop-note{display:none;padding:12px;background:#fef3c7;border:2px solid #d97706;border-radius:10px}.is-replaying .bar{animation:grow 2s ease both}@media (prefers-reduced-motion:reduce){.sb-demo *{animation:none!important;transition:none!important}.sketch{stroke-dashoffset:0}.cat-color{opacity:1}}`;

const renderDemoShowcase = (recipe) => {
  const h = escapeHtml; const { kind, selection, phase } = recipe.content;
  const shell = (eyebrow, inner) => `<main class="sb-demo" data-sb-demo-showcase="v1" data-kind="${h(kind)}" data-selection="${h(selection)}" data-phase="${h(phase)}"><p class="eyebrow">${h(eyebrow)}</p><h1>${h(recipe.title)}</h1><p class="sub">${h(recipe.fallbackText)}</p>${inner}<div class="demo-log" data-demo-log>Built live by Codex. Every interaction stays inside this demo.</div></main>`;
  if (kind === 'illustration') {
    const scenery = selection === 'sunny-garden' ? '<circle cx="1010" cy="95" r="55"/><path d="M930 470v-180m0 40-80-70m80 90 90-80"/><circle cx="850" cy="260" r="55"/><circle cx="1015" cy="270" r="58"/>' : selection === 'space-adventure' ? '<circle cx="1020" cy="120" r="62"/><path d="M900 250l45-80 45 80-45 35zM150 100l12 25 28 4-20 20 5 28-25-13-25 13 5-28-20-20 28-4z"/>' : '<path d="M80 380h1040M120 380V190h180v190m40 0V120h220v260m40 0V220h190v160m40 0V150h220v230M760 430q80-90 160 0M840 430v80"/><path d="M120 80l-20 40m130-40-20 40m130-40-20 40m130-40-20 40m130-40-20 40"/>';
    return shell('Human-guided illustration', `<section class="cat-stage"><svg viewBox="0 0 1200 520" role="img" aria-label="A childlike cat drawing in the selected ${h(selection)} setting"><g class="cat-color"><rect width="1200" height="520" fill="${selection === 'space-adventure' ? '#111827' : selection === 'rainy-city' ? '#bfdbfe' : '#dbeafe'}"/><ellipse cx="570" cy="470" rx="330" ry="36" fill="#86efac"/><ellipse cx="520" cy="290" rx="130" ry="115" fill="#fb923c"/><ellipse cx="520" cy="410" rx="115" ry="95" fill="#fdba74"/></g><g class="sketch"><path d="M390 245l18-125 90 68q35-20 75 0l92-68 12 130q20 105-145 115-165-10-142-120z"/><circle cx="475" cy="245" r="20"/><circle cx="585" cy="245" r="20"/><path d="M520 275l18 14-18 14-18-14zM520 303q-18 34-45 8m45-8q18 34 45 8M430 285l-100-20m100 40-105 10m280-30 105-20m-105 40 110 10M425 350q-50 75-20 140m230-140q45 75 15 140M405 490q115 35 245 0M650 420q120-90 160 5 25 70-70 70"/>${scenery}</g></svg></section>`);
  }
  if (kind === 'diorama') {
    const icons = selection === 'golden-garden' ? ['☀️','🌳 🌻 🦋','🌿','🐈','🌸 🌼'] : selection === 'space-observatory' ? ['✨','🌙 🪐','🚀','🐈‍⬛','⭐ ✦'] : ['🌧️','🏙️','☂️','🐈','💧 ✨'];
    return shell('Interactive 3D paper world', `<section class="paper-scene" data-demo-stage><div class="paper-world"><div class="paper-layer atmosphere">${icons[0]}</div><div class="paper-layer back"><span class="paper-shape">${icons[1]}</span></div><div class="paper-layer middle"><span class="paper-shape">${icons[2]}</span></div><div class="paper-layer cat">${icons[3]}</div><div class="paper-layer front">${icons[4]}</div></div></section><p class="sub">Move the pointer to explore the depth.</p>`);
  }
  if (kind === 'prototype') return shell('Clickable product prototype', `<section class="demo-grid prototype-layout"><div class="phone"><div class="phone-top"><span>Trip Calm</span><span>Day 2</span></div><div class="phone-view" data-phone-view="home"><h2>${selection === 'risk-checker' ? 'Booking confidence' : 'Today at a glance'}</h2><div class="trip-item">09:00 · Museum reservation</div><div class="trip-item">12:30 · Riverside lunch</div><button class="demo-btn primary" data-demo-screen="detail" data-demo-message="The traveler opened Tuesday’s plan.">${phase === 'improved' ? 'Review Tuesday plan' : 'Open plan'}</button></div><div class="phone-view" data-phone-view="detail" hidden><h2>Tuesday plan</h2><p>One timing warning needs attention.</p><button class="demo-btn primary" data-demo-screen="confirm" data-demo-message="The traveler opened the save confirmation.">Save calm plan</button></div><div class="phone-view" data-phone-view="confirm" hidden><h2>Plan saved</h2><p>Your day plan is ready offline.</p></div></div><div class="demo-card"><h2>A complex itinerary becomes one calm day.</h2><p>One primary action, visible timing risks, and plain language make the next step obvious.</p><button class="demo-btn" data-demo-reset>Reset demo</button><p><strong>Selected experience:</strong> ${h(selection)}</p></div></section>`);
  if (kind === 'data-story') return shell('Illustrative sample data', `<section class="demo-grid story"><div><div class="bars"><div class="bar" style="--v:50"><span>Mon<br>120</span></div><div class="bar" style="--v:61"><span>Tue<br>145</span></div><div class="bar spike" style="--v:88"><span>Wed<br>210</span></div><div class="bar spike" style="--v:100"><span>Thu<br>238</span></div><div class="bar" style="--v:77"><span>Fri<br>184</span></div><div class="bar" style="--v:41"><span>Sat<br>98</span></div><div class="bar" style="--v:35"><span>Sun<br>84</span></div></div><button class="demo-btn" data-story-replay>Replay story</button></div><div class="decision demo-card"><h2>Demand spike</h2><p>Demand peaked on Thursday.</p><p>Response time more than doubled from Sunday to Thursday.</p><p>Recovery began as the backlog cleared on Friday.</p><strong>Decision: add temporary coverage before the midweek peak.</strong></div></section>`);
  if (kind === 'incident') return shell('Fictional incident simulation', `<section class="demo-grid incident-map" data-active-incident="${h(phase)}"><div><div class="system-line"><div class="node">Browser</div><span class="arrow">→</span><div class="node">Gateway</div><span class="arrow">→</span><div class="node affected">Application API</div><span class="arrow">→</span><div class="node affected">${selection === 'cache-unavailable' ? 'Redis cache' : selection === 'pool-exhausted' ? 'MySQL pool' : 'Worker queue'}</div></div><div class="incident-controls"><button class="demo-btn" data-incident-state="healthy">Healthy</button><button class="demo-btn" data-incident-state="failure">Failure</button><button class="demo-btn" data-incident-state="recovery">Recovery</button></div></div><div class="demo-card"><h2>Customer impact</h2><p>Only affected request paths slow down; unaffected delivery remains healthy.</p><ol><li>Protect new traffic.</li><li>Reduce pressure safely.</li><li>Restore capacity gradually.</li></ol><strong>A person still authorizes the recovery.</strong></div></section>`);
  if (kind === 'mission-control') return shell('Every AI change preserved', `<section class="demo-grid mission"><div class="ring">92%</div><div class="checks"><div class="check">18 of 20 reliability checks passed</div><div class="check">Risk beacon: verify rendering in a real browser</div><div class="check">Decision gate: final rehearsal may begin</div></div></section>`);
  return shell('Illustrative code review', `<section class="demo-grid review"><article class="demo-card"><h2>Before</h2><div class="flow"><span class="step">Checkout</span><span>→</span><span class="step risk">Charge card</span><span>→</span><span class="step">Reserve inventory</span></div><p>Risk: payment can happen before availability is known.</p></article><article class="demo-card"><h2>After</h2><div class="flow"><span class="step">Checkout</span><span>→</span><span class="step gate">Validate inventory</span><span>→</span><span class="step after-charge">Charge card</span><span>→</span><span class="step after-charge">Confirmation</span><span class="pulse"></span></div><p class="stop-note">No charge made — ask the customer to retry.</p></article></section><button class="demo-btn primary" data-review-play>Play request</button> <button class="demo-btn" data-review-toggle aria-pressed="false">Simulate unavailable inventory</button><p><strong>Human review priority:</strong> ${h(selection)}</p>`);
};

const render = (recipe) => {
  const h = escapeHtml; const cls = `sb-artifact-v1-root${recipe.motion === 'none' ? '' : ' sb-artifact-v1-motion'}`;
  let body; let javascript = null;
  if (recipe.template === 'metric-story') body = `<div class="sb-artifact-v1-grid">${recipe.content.metrics.map((m) => `<article class="sb-artifact-v1-card"><h2>${h(m.label)}</h2><strong class="sb-artifact-v1-accent">${h(m.value)}</strong>${m.detail === null ? '' : `<p>${h(m.detail)}</p>`}<p>Trend: ${h(m.trend)}</p></article>`).join('')}</div>`;
  else if (recipe.template === 'process-flow') { const items = recipe.content.steps.map((s, i) => `<li><strong>${i + 1}. ${h(s.label)}</strong> — ${h(s.status)}${s.detail === null ? '' : `<p>${h(s.detail)}</p>`}</li>`).join(''); body = `${svg(recipe.title, recipe.fallbackText, recipe.content.steps.map((_, i) => `<circle cx="${80 + i * 70}" cy="120" r="22" fill="#0f766e"/>`).join(''))}<ol>${items}</ol>`; }
  else if (recipe.template === 'architecture-map') { const facts = recipe.content.nodes.map((n) => `<li>${h(n.label)} (${h(n.role)})</li>`).join('') + recipe.content.edges.map((e) => `<li>${h(e.from)} → ${h(e.to)}${e.label === null ? '' : `: ${h(e.label)}`}</li>`).join(''); body = `${svg(recipe.title, recipe.fallbackText, recipe.content.nodes.map((_, i) => `<rect x="${30 + (i % 4) * 190}" y="${30 + Math.floor(i / 4) * 90}" width="150" height="56" rx="8" fill="#ccfbf1" stroke="#0f766e"/>`).join(''))}<ul>${facts}</ul>`; }
  else if (recipe.template === 'timeline') { body = `${svg(recipe.title, recipe.fallbackText, '<line x1="40" y1="150" x2="760" y2="150" stroke="#0f766e" stroke-width="4"/>')}<ol>${recipe.content.events.map((e) => `<li><strong>${h(e.date)} — ${h(e.label)}</strong> (${h(e.status)})${e.detail === null ? '' : `<p>${h(e.detail)}</p>`}</li>`).join('')}</ol>`; }
  else if (recipe.template === 'demo-showcase') return { artifactId: null, html: renderDemoShowcase(recipe), css: `${demoShowcaseCss}.sb-demo{width:1000px;padding-right:30px}.demo-log{right:30px}.demo-card{min-width:0}.sb-demo h1{font-size:32px}.paper-world{width:760px}.node{min-width:105px}`, javascript: DEMO_SHOWCASE_PROGRAM, requestedCapabilities: [] };
  else { const values = stringifyCanonicalSceneArtifactJson(recipe.content.points.map((p) => p.value)); body = `<table><caption>${h(recipe.content.seriesLabel)}</caption><tbody>${recipe.content.points.map((p) => `<tr><th>${h(p.label)}</th><td>${p.value}${recipe.content.unit === null ? '' : ` ${h(recipe.content.unit)}`}</td></tr>`).join('')}</tbody></table><canvas width="800" height="240" role="img" aria-label="${h(recipe.fallbackText)}" data-sb-artifact-canvas="animated-data-story-v1" data-sb-artifact-values="${h(values)}" data-sb-artifact-motion="${recipe.motion}"></canvas>`; javascript = CANVAS_PROGRAM; }
  const marker = recipe.template === 'animated-data-story' ? ' data-sb-artifact-root="animated-data-story-v1"' : '';
  return { artifactId: null, html: `<main class="${cls}"${marker}><h1>${h(recipe.title)}</h1><p>${h(recipe.fallbackText)}</p>${body}</main>`, css: baseCss(recipe), javascript, requestedCapabilities: [] };
};

export const auditSceneArtifactSource = (source) => {
  closed(source, ['artifactId', 'html', 'css', 'javascript', 'requestedCapabilities'], ['source'], 'UNSAFE_ARTIFACT_SOURCE');
  if (source.artifactId !== null || !Array.isArray(source.requestedCapabilities) || source.requestedCapabilities.length !== 0) fail('UNSAFE_ARTIFACT_SOURCE', ['source']);
  const htmlBytes = Buffer.byteLength(source.html ?? ''), cssBytes = Buffer.byteLength(source.css ?? ''), jsBytes = source.javascript === null ? 0 : Buffer.byteLength(source.javascript ?? '');
  if (htmlBytes < 1 || htmlBytes > 262144 || cssBytes < 1 || cssBytes > 65536 || jsBytes > 32768 || htmlBytes + cssBytes + jsBytes > 360448) fail('PAYLOAD_TOO_LARGE', ['source']);
  if (typeof source.html !== 'string' || typeof source.css !== 'string' || (source.javascript !== null && source.javascript !== CANVAS_PROGRAM && source.javascript !== DEMO_SHOWCASE_PROGRAM)) fail('UNSAFE_ARTIFACT_SOURCE', ['source']);
  const tags = source.html.match(/<[^>]*>/g) ?? [];
  if (tags.some((tag) => /<\s*(script|iframe|object|embed|link|meta|img)\b/i.test(tag) || /\s(on[a-z]+|href|src|xlink:href)\s*=/i.test(tag)) || /(@import|@font-face|url\s*\(|image-set\s*\(|expression\s*\()/i.test(source.css)) fail('UNSAFE_ARTIFACT_SOURCE', ['source']);
  const hasCanvas = source.html.includes('data-sb-artifact-canvas="animated-data-story-v1"');
  if ((source.javascript === CANVAS_PROGRAM) !== hasCanvas) fail('UNSAFE_ARTIFACT_SOURCE', ['source', 'javascript']);
  const hasDemoShowcase = source.html.includes('data-sb-demo-showcase="v1"');
  if ((source.javascript === DEMO_SHOWCASE_PROGRAM) !== hasDemoShowcase) fail('UNSAFE_ARTIFACT_SOURCE', ['source', 'javascript']);
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
