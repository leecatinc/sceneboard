import {
  canonicalizeSceneRecipeJson,
  deriveSceneRecipeNodeId,
  stringifyCanonicalSceneRecipeJson,
} from './scene-recipe-core.mjs';

export const SCENE_ARTIFACT_RECIPE_VERSION = 1;
export const SCENE_ARTIFACT_TEMPLATE_VERSION = 1;
export const SCENE_ARTIFACT_TEMPLATE_NAMES_V1 = Object.freeze([
  'animated-data-story',
  'architecture-map',
  'demo-showcase',
  'metric-story',
  'process-flow',
  'threejs-showcase',
  'timeline',
  'webgl-showcase',
]);
export const SCENE_ARTIFACT_MOTION_LEVELS_V1 = Object.freeze(['none', 'subtle', 'staged', 'focus']);

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};

export const SCENE_ARTIFACT_LIMITS_V1 = deepFreeze({
  json: { maxBytes: 65536, maxDepth: 16, maxContainerEntries: 512, maxUserTextScalars: 8192 },
  text: {
    commonMinScalars: 1,
    placementKeyMaxScalars: 200,
    titleMaxScalars: 200,
    fallbackTextMaxScalars: 200,
    metricLabelMaxScalars: 60,
    metricValueMaxScalars: 40,
    detailMaxScalars: 120,
    processLabelMaxScalars: 60,
    architectureKeyMaxScalars: 64,
    architectureLabelMaxScalars: 60,
    edgeLabelMaxScalars: 60,
    timelineDateMaxScalars: 32,
    timelineLabelMaxScalars: 60,
    seriesLabelMaxScalars: 60,
    unitMaxScalars: 20,
    pointLabelMaxScalars: 40,
  },
  size: { widthMin: 320, widthMax: 1920, heightMin: 240, heightMax: 1080 },
  collections: {
    metricsMin: 1,
    metricsMax: 6,
    stepsMin: 2,
    stepsMax: 10,
    activeStepsMax: 1,
    architectureNodesMin: 2,
    architectureNodesMax: 12,
    architectureEdgesMin: 0,
    architectureEdgesMax: 16,
    timelineEventsMin: 2,
    timelineEventsMax: 12,
    currentEventsMax: 1,
    dataPointsMin: 2,
    dataPointsMax: 12,
  },
  numbers: { dataValueMin: -1000000000, dataValueMax: 1000000000 },
  identifiers: {
    globalIdMinScalars: 1,
    globalIdMaxScalars: 128,
    nodeIdMinScalars: 1,
    nodeIdMaxScalars: 64,
  },
  source: {
    htmlMinBytes: 1,
    htmlMaxBytes: 262144,
    cssMinBytes: 1,
    cssMaxBytes: 65536,
    javascriptMinBytes: 1,
    javascriptMaxBytes: 32768,
    combinedMaxBytes: 360448,
  },
  sanitizer: {
    htmlNodesMax: 10000,
    htmlDepthMax: 64,
    attributesPerElementMax: 64,
    cssRulesMax: 1024,
    cssDeclarationsMax: 16384,
  },
  catalog: { descriptorCount: 8, descriptorMaxBytes: 4096 },
  motion: {
    subtleOpacityStart: 0.92,
    subtleDurationMs: 280,
    subtleTranslateMaxPx: 4,
    subtleIterations: 1,
    subtleDelayMs: 0,
    stagedDurationMs: 320,
    stagedDelayStepMs: 70,
    stagedTranslateMaxPx: 8,
    stagedIterations: 1,
    stagedItemsMax: 12,
    stagedCompletionMaxMs: 1090,
    focusDurationMs: 640,
    focusIterations: 2,
    focusScaleMin: 1,
    focusScaleMax: 1.04,
    focusDelayMs: 0,
    focusCompletionMaxMs: 1280,
  },
});

const MESSAGES = Object.freeze({
  INVALID_JSON: 'Artifact JSON is invalid.',
  INVALID_ARTIFACT_RECIPE: 'Artifact recipe is invalid.',
  UNSUPPORTED_ARTIFACT_RECIPE_VERSION: 'Artifact recipe version is unsupported.',
  UNKNOWN_FIELD: 'Artifact input contains an unknown field.',
  UNKNOWN_TEMPLATE: 'Artifact template is unsupported.',
  INVALID_TEMPLATE_DESCRIPTOR: 'Artifact template descriptor is invalid.',
  INVALID_VALUE: 'Artifact input value is invalid.',
  INVALID_RELATION: 'Artifact input relation is invalid.',
  LIMIT_EXCEEDED: 'Artifact input limit is exceeded.',
  PAYLOAD_TOO_LARGE: 'Artifact payload is too large.',
  UNSAFE_ARTIFACT_SOURCE: 'Artifact source is unsafe.',
  INVALID_PLACEMENT: 'Artifact placement input is invalid.',
});

export class SceneArtifactError extends Error {
  constructor(code, path = []) {
    super(MESSAGES[code] ?? MESSAGES.INVALID_ARTIFACT_RECIPE);
    this.name = 'SceneArtifactError';
    this.code = MESSAGES[code] ? code : 'INVALID_ARTIFACT_RECIPE';
    this.path = [...path];
  }
}

const fail = (code, path = []) => {
  throw new SceneArtifactError(code, path);
};
const object = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const closed = (value, fields, path, code = 'INVALID_ARTIFACT_RECIPE') => {
  if (!object(value)) fail(code, path);
  const keys = Object.keys(value);
  for (const key of keys) if (!fields.includes(key)) fail('UNKNOWN_FIELD', [...path, key]);
  for (const key of fields) if (!Object.hasOwn(value, key)) fail(code, [...path, key]);
};
const scalars = (value) => Array.from(value).length;
const text = (value, max, path, nullable = false) => {
  if (nullable && value === null) return;
  if (
    typeof value !== 'string' ||
    scalars(value) < 1 ||
    scalars(value) > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff]/u.test(value)
  )
    fail('INVALID_VALUE', path);
};
const array = (value, min, max, path) => {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    fail('LIMIT_EXCEEDED', path);
};
const escapeHtml = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export const stringifyCanonicalSceneArtifactJson = (value) => {
  try {
    return stringifyCanonicalSceneRecipeJson(value);
  } catch {
    fail('INVALID_VALUE', []);
  }
};

const parseJson = (bytes, placement) => {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : bytes instanceof Uint8Array
      ? Buffer.from(bytes)
      : null;
  if (!buffer) fail('INVALID_JSON', []);
  if (buffer.length > SCENE_ARTIFACT_LIMITS_V1.json.maxBytes) fail('PAYLOAD_TOO_LARGE', []);
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch {
    fail('INVALID_JSON', []);
  }
  return placement ? validatePlacement(value) : validateSceneArtifactRecipe(value);
};
export const parseSceneArtifactRecipeJson = (bytes) => parseJson(bytes, false);
export const parseSceneArtifactPlacementJson = (bytes) => parseJson(bytes, true);

export const validateSceneArtifactTemplateDescriptor = (value) => {
  closed(
    value,
    ['artifactTemplateVersion', 'name', 'renderer', 'defaultSize'],
    [],
    'INVALID_TEMPLATE_DESCRIPTOR',
  );
  if (
    value.artifactTemplateVersion !== 1 ||
    !SCENE_ARTIFACT_TEMPLATE_NAMES_V1.includes(value.name) ||
    value.renderer !== value.name
  )
    fail('INVALID_TEMPLATE_DESCRIPTOR', []);
  closed(value.defaultSize, ['width', 'height'], ['defaultSize'], 'INVALID_TEMPLATE_DESCRIPTOR');
  const { width, height } = value.defaultSize;
  if (
    !Number.isSafeInteger(width) ||
    width < 320 ||
    width > 1920 ||
    !Number.isSafeInteger(height) ||
    height < 240 ||
    height > 1080
  )
    fail('INVALID_TEMPLATE_DESCRIPTOR', ['defaultSize']);
  return canonicalizeSceneRecipeJson(value);
};

const validateContent = (recipe) => {
  const { content, template } = recipe;
  if (template === 'metric-story') {
    closed(content, ['metrics'], ['content']);
    array(content.metrics, 1, 6, ['content', 'metrics']);
    content.metrics.forEach((item, index) => {
      const p = ['content', 'metrics', index];
      closed(item, ['label', 'value', 'detail', 'trend'], p);
      text(item.label, 60, [...p, 'label']);
      text(item.value, 40, [...p, 'value']);
      text(item.detail, 120, [...p, 'detail'], true);
      if (!['up', 'down', 'flat'].includes(item.trend)) fail('INVALID_VALUE', [...p, 'trend']);
    });
  } else if (template === 'process-flow') {
    closed(content, ['steps'], ['content']);
    array(content.steps, 2, 10, ['content', 'steps']);
    let active = 0;
    content.steps.forEach((item, index) => {
      const p = ['content', 'steps', index];
      closed(item, ['label', 'detail', 'status'], p);
      text(item.label, 60, [...p, 'label']);
      text(item.detail, 120, [...p, 'detail'], true);
      if (!['complete', 'active', 'pending', 'blocked'].includes(item.status))
        fail('INVALID_VALUE', [...p, 'status']);
      if (item.status === 'active') active += 1;
    });
    if (active > 1) fail('INVALID_RELATION', ['content', 'steps']);
  } else if (template === 'architecture-map') {
    closed(content, ['nodes', 'edges'], ['content']);
    array(content.nodes, 2, 12, ['content', 'nodes']);
    array(content.edges, 0, 16, ['content', 'edges']);
    const ids = new Set();
    content.nodes.forEach((item, index) => {
      const p = ['content', 'nodes', index];
      closed(item, ['key', 'label', 'role'], p);
      if (
        typeof item.key !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.key) ||
        ids.has(item.key)
      )
        fail('INVALID_RELATION', [...p, 'key']);
      ids.add(item.key);
      text(item.label, 60, [...p, 'label']);
      if (!['source', 'service', 'store', 'external'].includes(item.role))
        fail('INVALID_VALUE', [...p, 'role']);
    });
    const pairs = new Set();
    content.edges.forEach((item, index) => {
      const p = ['content', 'edges', index];
      closed(item, ['from', 'to', 'label'], p);
      text(item.label, 60, [...p, 'label'], true);
      const pair = `${item.from}\u0000${item.to}`;
      if (!ids.has(item.from) || !ids.has(item.to) || item.from === item.to || pairs.has(pair))
        fail('INVALID_RELATION', p);
      pairs.add(pair);
    });
  } else if (template === 'timeline') {
    closed(content, ['events'], ['content']);
    array(content.events, 2, 12, ['content', 'events']);
    let current = 0;
    content.events.forEach((item, index) => {
      const p = ['content', 'events', index];
      closed(item, ['date', 'label', 'detail', 'status'], p);
      text(item.date, 32, [...p, 'date']);
      text(item.label, 60, [...p, 'label']);
      text(item.detail, 120, [...p, 'detail'], true);
      if (!['past', 'current', 'future'].includes(item.status))
        fail('INVALID_VALUE', [...p, 'status']);
      if (item.status === 'current') current += 1;
    });
    if (current > 1) fail('INVALID_RELATION', ['content', 'events']);
  } else if (template === 'demo-showcase') {
    closed(content, ['kind', 'selection', 'phase'], ['content']);
    if (
      ![
        'illustration',
        'diorama',
        'prototype',
        'data-story',
        'incident',
        'mission-control',
        'code-review',
      ].includes(content.kind)
    )
      fail('INVALID_VALUE', ['content', 'kind']);
    text(content.selection, 64, ['content', 'selection']);
    text(content.phase, 32, ['content', 'phase']);
    const allowed = {
      illustration: {
        selection: ['sunny-garden', 'space-adventure', 'rainy-city'],
        phase: ['outline', 'color'],
      },
      diorama: {
        selection: ['golden-garden', 'space-observatory', 'neon-street'],
        phase: ['ready'],
      },
      prototype: {
        selection: ['calm-itinerary', 'visual-explorer', 'risk-checker'],
        phase: ['initial', 'improved'],
      },
      'data-story': { selection: ['support-week'], phase: ['ready'] },
      incident: {
        selection: ['cache-unavailable', 'pool-exhausted', 'queue-backlog'],
        phase: ['failure', 'recovery'],
      },
      'mission-control': { selection: ['launch-readiness'], phase: ['ready'] },
      'code-review': {
        selection: ['no-charge', 'checkout-speed', 'concurrent-inventory'],
        phase: ['review', 'final'],
      },
    }[content.kind];
    if (!allowed.selection.includes(content.selection))
      fail('INVALID_RELATION', ['content', 'selection']);
    if (!allowed.phase.includes(content.phase)) fail('INVALID_RELATION', ['content', 'phase']);
  } else if (template === 'webgl-showcase' || template === 'threejs-showcase') {
    closed(content, ['scene', 'camera'], ['content']);
    if (!['garden-cat', 'space-cat', 'neon-cat'].includes(content.scene))
      fail('INVALID_VALUE', ['content', 'scene']);
    if (!['orbit', 'still'].includes(content.camera)) fail('INVALID_VALUE', ['content', 'camera']);
  } else {
    closed(content, ['seriesLabel', 'unit', 'points'], ['content']);
    text(content.seriesLabel, 60, ['content', 'seriesLabel']);
    text(content.unit, 20, ['content', 'unit'], true);
    array(content.points, 2, 12, ['content', 'points']);
    content.points.forEach((item, index) => {
      const p = ['content', 'points', index];
      closed(item, ['label', 'value'], p);
      text(item.label, 40, [...p, 'label']);
      if (
        !Number.isFinite(item.value) ||
        Object.is(item.value, -0) ||
        item.value < -1e9 ||
        item.value > 1e9
      )
        fail('INVALID_VALUE', [...p, 'value']);
    });
  }
};

export const validateSceneArtifactRecipe = (value) => {
  closed(
    value,
    [
      'artifactRecipeVersion',
      'template',
      'placementKey',
      'title',
      'fallbackText',
      'theme',
      'size',
      'motion',
      'content',
    ],
    [],
  );
  if (value.artifactRecipeVersion !== 1)
    fail('UNSUPPORTED_ARTIFACT_RECIPE_VERSION', ['artifactRecipeVersion']);
  if (!SCENE_ARTIFACT_TEMPLATE_NAMES_V1.includes(value.template))
    fail('UNKNOWN_TEMPLATE', ['template']);
  text(value.placementKey, 200, ['placementKey']);
  text(value.title, 200, ['title']);
  text(value.fallbackText, 200, ['fallbackText']);
  if (!['light', 'dark', 'high-contrast'].includes(value.theme)) fail('INVALID_VALUE', ['theme']);
  closed(value.size, ['width', 'height'], ['size']);
  if (
    !Number.isSafeInteger(value.size.width) ||
    value.size.width < 320 ||
    value.size.width > 1920 ||
    !Number.isSafeInteger(value.size.height) ||
    value.size.height < 240 ||
    value.size.height > 1080
  )
    fail('INVALID_VALUE', ['size']);
  if (!SCENE_ARTIFACT_MOTION_LEVELS_V1.includes(value.motion)) fail('INVALID_VALUE', ['motion']);
  validateContent(value);
  return canonicalizeSceneRecipeJson(value);
};

const palette = (theme) =>
  theme === 'dark'
    ? ['#0f172a', '#f8fafc', '#2dd4bf', '#1e293b']
    : theme === 'high-contrast'
      ? ['#000000', '#ffffff', '#ffff00', '#222222']
      : ['#ffffff', '#0f172a', '#0f766e', '#f1f5f9'];
const motionCss = (motion) => {
  if (motion === 'none') return '';
  const body =
    motion === 'subtle'
      ? 'opacity:.92;transform:translateY(4px)'
      : motion === 'staged'
        ? 'opacity:0;transform:translateY(8px)'
        : 'opacity:.86;transform:scale(1)';
  const duration = motion === 'subtle' ? '280ms' : motion === 'staged' ? '320ms' : '640ms';
  const count = motion === 'focus' ? '2' : '1';
  return `.sb-artifact-v1-motion{animation:sb-artifact-v1-reveal ${duration} ease-out ${count}}@keyframes sb-artifact-v1-reveal{from{${body}}to{opacity:1;transform:none}}@media (prefers-reduced-motion: reduce){.sb-artifact-v1-motion{animation:none!important;transition:none!important;transform:none!important;opacity:1!important}}`;
};
const baseCss = (recipe) => {
  const [bg, fg, accent, panel] = palette(recipe.theme);
  return `.sb-artifact-v1-root{box-sizing:border-box;width:${recipe.size.width}px;min-height:${recipe.size.height}px;padding:32px;background:${bg};color:${fg};font-family:system-ui,sans-serif}.sb-artifact-v1-root *{box-sizing:border-box}.sb-artifact-v1-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}.sb-artifact-v1-card{padding:18px;border:2px solid ${accent};border-radius:14px;background:${panel}}.sb-artifact-v1-accent{color:${accent}}${motionCss(recipe.motion)}`;
};
const svg = (title, desc, inner) =>
  `<svg viewBox="0 0 800 300" role="img"><title>${escapeHtml(title)}</title><desc>${escapeHtml(desc)}</desc>${inner}</svg>`;

const CANVAS_PROGRAM = `(()=>{const r=document.querySelector('[data-sb-artifact-root="animated-data-story-v1"]');if(!r)return;const c=r.querySelector('[data-sb-artifact-canvas="animated-data-story-v1"]');if(!c)return;let v;try{v=JSON.parse(c.getAttribute('data-sb-artifact-values'));}catch{return}const m=c.getAttribute('data-sb-artifact-motion');if(!Array.isArray(v)||v.length<2||v.length>12||!v.every(n=>Number.isFinite(n)&&!Object.is(n,-0)&&n>=-1e9&&n<=1e9)||!['none','subtle','staged','focus'].includes(m))return;const x=c.getContext('2d');if(!x)return;let progress=m==='none'||matchMedia('(prefers-reduced-motion: reduce)').matches?1:0;const draw=()=>{const b=c.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2),w=Math.max(1,Math.round(b.width*d)),h=Math.max(1,Math.round(b.height*d));if(c.width!==w||c.height!==h){c.width=w;c.height=h}x.setTransform(d,0,0,d,0,0);x.clearRect(0,0,b.width,b.height);const a=Math.max(...v.map(Math.abs),1),base=b.height-20,max=Math.max(1,b.height-60),step=b.width/v.length;v.forEach((n,i)=>{const bh=Math.abs(n)/a*max*progress;x.fillStyle='#0f766e';x.fillRect(i*step+8,base-bh,Math.max(2,step-16),bh)})};new ResizeObserver(draw).observe(c);if(progress===1){draw();return}const d=m==='focus'?1280:m==='staged'?1090:280,s=performance.now();const tick=t=>{progress=Math.min(1,(t-s)/d);draw();if(progress<1)requestAnimationFrame(tick)};requestAnimationFrame(tick)})()`;

const WEBGL_SHOWCASE_PROGRAM = `(()=>{const r=document.querySelector('[data-sb-webgl-showcase="v1"]'),c=r&&r.querySelector('canvas'),s=r&&r.querySelector('[data-webgl-status]');if(!r||!c)return;const gl=c.getContext('webgl',{alpha:false,antialias:true,depth:true,preserveDrawingBuffer:false});if(!gl){if(s)s.textContent='WebGL is unavailable in this browser. The scene description remains available.';return}const shader=(type,source)=>{const value=gl.createShader(type);gl.shaderSource(value,source);gl.compileShader(value);if(!gl.getShaderParameter(value,gl.COMPILE_STATUS))throw new Error('WebGL shader compilation failed');return value};let program;try{program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,'attribute vec3 p;attribute vec3 c;uniform mat4 m;varying vec3 v;void main(){gl_Position=m*vec4(p,1.);v=c;}'));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,'precision mediump float;varying vec3 v;void main(){gl_FragColor=vec4(v,1.);}'));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('WebGL program link failed')}catch{if(s)s.textContent='The 3D renderer stopped safely. The scene description remains available.';return}const scene=r.getAttribute('data-scene'),camera=r.getAttribute('data-camera'),reduce=matchMedia('(prefers-reduced-motion: reduce)').matches,colors=scene==='space-cat'?[[.06,.09,.2],[.35,.55,1],[.75,.82,1],[.95,.72,.25]]:scene==='neon-cat'?[[.04,.03,.12],[1,.15,.7],[.15,1,.8],[.55,.3,1]]:[[.65,.88,.55],[.95,.55,.2],[.18,.62,.3],[1,.82,.25]],data=[];const cube=(x,y,z,w,h,d,color)=>{const q=[[0,1,2,0,2,3],[4,6,5,4,7,6],[0,4,5,0,5,1],[3,2,6,3,6,7],[1,5,6,1,6,2],[0,3,7,0,7,4]],v=[[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1],[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]];q.flat().forEach(i=>data.push(x+v[i][0]*w,y+v[i][1]*h,z+v[i][2]*d,...color))};cube(0,-1.55,0,4.8,.12,3,colors[0]);cube(-.55,-.45,0,.78,1,.62,colors[1]);cube(-.55,.72,0,.72,.68,.68,colors[1]);cube(-1.02,1.38,0,.22,.42,.24,colors[1]);cube(-.08,1.38,0,.22,.42,.24,colors[1]);cube(.35,-.25,.15,.65,.18,.18,colors[1]);cube(1.05,-.18,.15,.18,.65,.18,colors[1]);cube(2.15,-.65,-.75,.28,.9,.28,[.45,.25,.12]);cube(2.15,.55,-.75,.9,.82,.72,colors[2]);cube(-2.65,1.75,-1.5,.42,.42,.3,colors[3]);for(let i=0;i<8;i++)cube(-3+i*.85,-1.25,-1.2,.08,.28,.08,colors[2]);const vertices=new Float32Array(data),buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.STATIC_DRAW);const p=gl.getAttribLocation(program,'p'),col=gl.getAttribLocation(program,'c'),matrix=gl.getUniformLocation(program,'m');gl.enableVertexAttribArray(p);gl.vertexAttribPointer(p,3,gl.FLOAT,false,24,0);gl.enableVertexAttribArray(col);gl.vertexAttribPointer(col,3,gl.FLOAT,false,24,12);gl.enable(gl.DEPTH_TEST);gl.enable(gl.CULL_FACE);const mul=(a,b)=>{const o=new Float32Array(16);for(let row=0;row<4;row++)for(let column=0;column<4;column++)for(let k=0;k<4;k++)o[column*4+row]+=a[k*4+row]*b[column*4+k];return o},perspective=(f,a,n,z)=>{const t=1/Math.tan(f/2),o=new Float32Array(16);o[0]=t/a;o[5]=t;o[10]=(z+n)/(n-z);o[11]=-1;o[14]=2*z*n/(n-z);return o},rotation=(x,y)=>{const cx=Math.cos(x),sx=Math.sin(x),cy=Math.cos(y),sy=Math.sin(y);return new Float32Array([cy,sx*sy,-cx*sy,0,0,cx,sx,0,sy,-sx*cy,cx*cy,0,0,0,-8,1])};let pointerX=0,pointerY=0;c.addEventListener('pointermove',e=>{const b=c.getBoundingClientRect();pointerX=(e.clientX-b.left)/b.width-.5;pointerY=(e.clientY-b.top)/b.height-.5});c.addEventListener('pointerleave',()=>{pointerX=0;pointerY=0});const resize=()=>{const b=c.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2),w=Math.max(1,Math.round(b.width*d)),h=Math.max(1,Math.round(b.height*d));if(c.width!==w||c.height!==h){c.width=w;c.height=h}gl.viewport(0,0,w,h)};new ResizeObserver(resize).observe(c);resize();let started=performance.now(),frame=0;const draw=now=>{const aspect=Math.max(1,c.width)/Math.max(1,c.height),orbit=!reduce&&camera==='orbit'?(now-started)*.00018:0,m=mul(perspective(Math.PI/4,aspect,.1,100),rotation(-.18-pointerY*.35,orbit+pointerX*.55));gl.clearColor(...colors[0],1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.useProgram(program);gl.uniformMatrix4fv(matrix,false,m);gl.drawArrays(gl.TRIANGLES,0,vertices.length/6);if((!reduce&&camera==='orbit')||frame++<2)requestAnimationFrame(draw)};requestAnimationFrame(draw);c.addEventListener('webglcontextlost',e=>{e.preventDefault();if(s)s.textContent='The 3D renderer paused safely because the graphics context was lost.'});if(s)s.textContent='Live WebGL · high-resolution rendering · move the pointer to change the camera';if(window.SceneBoardArtifact&&window.SceneBoardArtifact.requestResize)window.SceneBoardArtifact.requestResize(1920,1080)})()`;

const THREEJS_SHOWCASE_PROGRAM = `(()=>{const r=document.querySelector('[data-sb-threejs-showcase="v1"]'),c=r&&r.querySelector('canvas'),s=r&&r.querySelector('[data-threejs-status]'),T=globalThis.SceneBoardThree;if(!r||!c)return;if(!T){if(s)s.textContent='Three.js is unavailable. The scene description remains available.';return}const choice=r.getAttribute('data-scene'),cameraMode=r.getAttribute('data-camera'),reduce=matchMedia('(prefers-reduced-motion: reduce)').matches,palette=choice==='space-cat'?{bg:0x050816,fog:0x050816,cat:0x6ea8ff,accent:0xffd166,ground:0x111b3b,tree:0x91a7ff}:choice==='neon-cat'?{bg:0x080311,fog:0x080311,cat:0xff3cac,accent:0x2de2e6,ground:0x16062b,tree:0x7d4dff}:{bg:0xbfe9a8,fog:0xbfe9a8,cat:0xf78b2d,accent:0xffd65a,ground:0x67b85b,tree:0x27924b};let renderer;try{renderer=new T.WebGLRenderer({canvas:c,antialias:true,alpha:false,powerPreference:'high-performance',preserveDrawingBuffer:false})}catch{if(s)s.textContent='Three.js could not start WebGL safely. The scene description remains available.';return}renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.08;const scene=new T.Scene();scene.background=new T.Color(palette.bg);scene.fog=new T.Fog(palette.fog,13,28);const camera=new T.PerspectiveCamera(38,16/9,.1,60);camera.position.set(0,3.4,11);const world=new T.Group();scene.add(world);const material=(color,roughness=.7,metalness=.05)=>new T.MeshStandardMaterial({color,roughness,metalness});const add=(geometry,mat,x,y,z,cast=true,receive=true)=>{const mesh=new T.Mesh(geometry,mat);mesh.position.set(x,y,z);mesh.castShadow=cast;mesh.receiveShadow=receive;world.add(mesh);return mesh};const ground=add(new T.CylinderGeometry(6.5,7.2,.45,64),material(palette.ground,.92,0),0,-2.05,0,false,true);ground.scale.z=.72;const catMat=material(palette.cat,.62,.02),dark=material(0x182033,.8,0),accent=material(palette.accent,.5,.04);add(new T.SphereGeometry(1.35,48,32),catMat,-.8,-.45,.2);add(new T.SphereGeometry(1.08,48,32),catMat,-.8,1.08,.2);const ear=(x,rotation)=>{const value=add(new T.ConeGeometry(.5,1.05,4),catMat,x,2.08,.2);value.rotation.y=rotation;return value};ear(-1.62,.78);ear(.02,-.78);add(new T.SphereGeometry(.13,24,16),dark,-1.18,1.28,1.13);add(new T.SphereGeometry(.13,24,16),dark,-.42,1.28,1.13);const nose=add(new T.ConeGeometry(.13,.25,3),accent,-.8,.91,1.25);nose.rotation.z=Math.PI;const tail=add(new T.TorusGeometry(.75,.17,18,64,Math.PI*1.52),catMat,.6,-.35,.05);tail.rotation.x=Math.PI/2;tail.rotation.z=-.42;add(new T.CylinderGeometry(.3,.36,2.2,24),material(0x7b421d,.9,0),2.4,-.95,-.7);add(new T.SphereGeometry(1.28,32,24),material(palette.tree,.8,0),2.4,.45,-.7);add(new T.SphereGeometry(.85,32,24),material(palette.tree,.78,0),3.08,.82,-.8);const sun=add(new T.SphereGeometry(.55,32,24),accent,-3.7,3.25,-2,false,false);if(choice==='space-cat'){for(let i=0;i<42;i++){const star=add(new T.SphereGeometry(.025+(i%4)*.012,8,8),material(0xffffff,.2,.15),Math.sin(i*12.91)*5.7,Math.cos(i*7.17)*3.8,Math.sin(i*3.11)*-5-2,false,false);star.material.emissive=new T.Color(0xffffff);star.material.emissiveIntensity=1.5}}if(choice==='neon-cat'){catMat.emissive=new T.Color(0x5b062f);catMat.emissiveIntensity=.65;accent.emissive=new T.Color(palette.accent);accent.emissiveIntensity=1.3}scene.add(new T.HemisphereLight(0xffffff,palette.ground,2.25));const key=new T.DirectionalLight(0xffffff,3.2);key.position.set(-4,8,6);key.castShadow=true;key.shadow.mapSize.set(2048,2048);key.shadow.camera.near=.5;key.shadow.camera.far=30;key.shadow.camera.left=-8;key.shadow.camera.right=8;key.shadow.camera.top=8;key.shadow.camera.bottom=-8;scene.add(key);const rim=new T.PointLight(palette.accent,35,16,2);rim.position.copy(sun.position);scene.add(rim);let pointerX=0,pointerY=0,disposed=false;c.addEventListener('pointermove',event=>{const bounds=c.getBoundingClientRect();pointerX=(event.clientX-bounds.left)/bounds.width-.5;pointerY=(event.clientY-bounds.top)/bounds.height-.5});c.addEventListener('pointerleave',()=>{pointerX=0;pointerY=0});const resize=()=>{const bounds=c.getBoundingClientRect(),width=Math.max(1,Math.round(bounds.width)),height=Math.max(1,Math.round(bounds.height));renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix()};const observer=new ResizeObserver(resize);observer.observe(c);resize();const start=performance.now();const draw=now=>{if(disposed)return;const orbit=!reduce&&cameraMode==='orbit'?(now-start)*.00022:0;camera.position.x=Math.sin(orbit+pointerX*.7)*10.8;camera.position.z=Math.cos(orbit+pointerX*.7)*10.8;camera.position.y=3.4-pointerY*2.2;camera.lookAt(0,0,0);if(!reduce){world.rotation.y=Math.sin((now-start)*.00032)*.08;catMat.emissiveIntensity=choice==='neon-cat'?.55+.12*Math.sin((now-start)*.002):0}renderer.render(scene,camera)};renderer.setAnimationLoop(draw);c.addEventListener('webglcontextlost',event=>{event.preventDefault();if(s)s.textContent='The Three.js renderer paused safely because the graphics context was lost.'});window.addEventListener('pagehide',()=>{disposed=true;observer.disconnect();renderer.setAnimationLoop(null);renderer.dispose();world.traverse(value=>{if(value.geometry)value.geometry.dispose();if(value.material)value.material.dispose()})},{once:true});if(s){s.textContent='Three.js r'+T.REVISION+' · ACES color · soft shadows · move the pointer to orbit';s.setAttribute('data-three-revision',String(T.REVISION))}if(window.SceneBoardArtifact&&window.SceneBoardArtifact.requestResize)window.SceneBoardArtifact.requestResize(1920,1080)})()`;

const THREEJS_SHOWCASE_PROGRAM_PREMIUM = `(()=>{
const root=document.querySelector('[data-sb-threejs-showcase="v1"]'),canvas=root&&root.querySelector('canvas'),status=root&&root.querySelector('[data-threejs-status]'),T=globalThis.SceneBoardThree;
if(!root||!canvas)return;
if(!T){if(status)status.textContent='Three.js is unavailable. The scene description remains available.';return}
const choice=root.getAttribute('data-scene'),cameraMode=root.getAttribute('data-camera'),reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
const palettes={
  'space-cat':{background:0x030712,fog:0x030712,coat:0x7c9cff,coatDark:0x374b9c,cream:0xe9eeff,accent:0xffd166,ground:0x111936,secondary:0xb79cff},
  'neon-cat':{background:0x08030f,fog:0x08030f,coat:0xff4da6,coatDark:0x7c164e,cream:0xffd6eb,accent:0x2de2e6,ground:0x170624,secondary:0x9d5cff},
  'garden-cat':{background:0x9dd9c1,fog:0x9dd9c1,coat:0xf48a3d,coatDark:0xb94e2b,cream:0xffe0ac,accent:0xffd15c,ground:0x3b9b69,secondary:0x75cf81}
};
const palette=palettes[choice]||palettes['garden-cat'];
let renderer;
try{renderer=new T.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance',preserveDrawingBuffer:false})}catch{if(status)status.textContent='Three.js could not start WebGL safely. The scene description remains available.';return}
renderer.setPixelRatio(Math.min(devicePixelRatio||1,2.5));renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.12;
const scene=new T.Scene();scene.background=new T.Color(palette.background);scene.fog=new T.FogExp2(palette.fog,.035);
const camera=new T.PerspectiveCamera(34,16/9,.1,80),world=new T.Group(),cat=new T.Group(),environment=new T.Group();scene.add(world);world.add(environment);world.add(cat);cat.position.x=.65;
const physical=(color,options={})=>new T.MeshPhysicalMaterial({color,roughness:.54,metalness:.02,clearcoat:.35,clearcoatRoughness:.38,sheen:.18,sheenColor:new T.Color(color),...options});
const standard=(color,options={})=>new T.MeshStandardMaterial({color,roughness:.72,metalness:.02,...options});
const coat=physical(palette.coat,{roughness:.6,clearcoat:.22}),coatDark=physical(palette.coatDark,{roughness:.58}),cream=physical(palette.cream,{roughness:.72,clearcoat:.12}),ink=physical(0x182238,{roughness:.48}),accent=physical(palette.accent,{roughness:.35,clearcoat:.65}),white=physical(0xffffff,{roughness:.3,clearcoat:.7});
const mesh=(geometry,material,parent=world,x=0,y=0,z=0,cast=true,receive=true)=>{const value=new T.Mesh(geometry,material);value.position.set(x,y,z);value.castShadow=cast;value.receiveShadow=receive;parent.add(value);return value};
const scaled=(geometry,material,parent,x,y,z,sx,sy,sz)=>{const value=mesh(geometry,material,parent,x,y,z);value.scale.set(sx,sy,sz);return value};
const lineBetween=(from,to,radius,material,parent=cat)=>{const direction=new T.Vector3().subVectors(to,from),value=mesh(new T.CylinderGeometry(radius,radius,direction.length(),10),material,parent);value.position.copy(from).add(to).multiplyScalar(.5);value.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),direction.clone().normalize());return value};
const ground=mesh(new T.CylinderGeometry(5.8,6.35,.48,96),physical(palette.ground,{roughness:.82,clearcoat:.08}),environment,0,-2.02,0,false,true);ground.scale.z=.72;
const groundInset=mesh(new T.CircleGeometry(5.3,96),standard(choice==='garden-cat'?0x8fd28a:0x182348,{roughness:.94}),environment,0,-1.77,0,false,true);groundInset.rotation.x=-Math.PI/2;groundInset.scale.y=.72;
scaled(new T.SphereGeometry(1,64,48),coat,cat,-.25,-.42,.1,1.28,1.48,1.02);
scaled(new T.SphereGeometry(1,64,48),coat,cat,-.25,1.12,.18,1.18,1.04,1.02);
scaled(new T.SphereGeometry(1,48,32),cream,cat,-.25,-.46,1.01,.72,.9,.09);
const leftEar=mesh(new T.ConeGeometry(.48,1.15,3),coat,cat,-1.02,2.02,.18),rightEar=mesh(new T.ConeGeometry(.48,1.15,3),coat,cat,.52,2.02,.18);leftEar.rotation.z=.08;rightEar.rotation.z=-.08;
const leftInner=mesh(new T.ConeGeometry(.25,.68,3),physical(0xff9d9f,{roughness:.68}),cat,-1.02,2.04,.63),rightInner=mesh(new T.ConeGeometry(.25,.68,3),physical(0xff9d9f,{roughness:.68}),cat,.52,2.04,.63);leftInner.rotation.z=.08;rightInner.rotation.z=-.08;
for(const eyeX of [-.68,.18]){scaled(new T.SphereGeometry(1,36,24),white,cat,eyeX,1.3,1.08,.25,.32,.12);scaled(new T.SphereGeometry(1,28,20),physical(0x4db99f,{roughness:.28}),cat,eyeX,1.29,1.2,.12,.2,.08);scaled(new T.SphereGeometry(1,20,16),ink,cat,eyeX,1.29,1.27,.055,.13,.035);scaled(new T.SphereGeometry(1,16,12),white,cat,eyeX-.04,1.4,1.31,.035,.045,.02)}
scaled(new T.SphereGeometry(1,36,24),cream,cat,-.52,.77,1.08,.42,.3,.12);scaled(new T.SphereGeometry(1,36,24),cream,cat,.02,.77,1.08,.42,.3,.12);
const nose=mesh(new T.ConeGeometry(.15,.26,3),physical(0xa84862,{roughness:.4}),cat,-.25,.89,1.33);nose.rotation.x=Math.PI/2;nose.rotation.z=Math.PI;
lineBetween(new T.Vector3(-.25,.76,1.31),new T.Vector3(-.25,.57,1.31),.025,ink);
lineBetween(new T.Vector3(-.25,.58,1.3),new T.Vector3(-.48,.49,1.26),.025,ink);lineBetween(new T.Vector3(-.25,.58,1.3),new T.Vector3(-.02,.49,1.26),.025,ink);
for(const side of [-1,1])for(let index=0;index<3;index++){const start=new T.Vector3(-.25+side*.48,.75-index*.12,1.19),end=new T.Vector3(-.25+side*(1.15+index*.08),.82-index*.18,1.08);lineBetween(start,end,.014,cream)}
for(const x of [-.84,.34])scaled(new T.SphereGeometry(1,36,24),cream,cat,x,-1.56,.68,.43,.25,.6);
const chest=scaled(new T.SphereGeometry(1,40,30),cream,cat,-.25,-.46,1.08,.54,.76,.1);chest.rotation.z=.04;
for(const offset of [-.5,0,.5]){const stripe=mesh(new T.CapsuleGeometry(.055,.35,4,10),coatDark,cat,-.25+offset,.38,1.15);stripe.rotation.z=offset*.55}
const tail=mesh(new T.TorusGeometry(.9,.2,24,96,Math.PI*1.62),coat,cat,1.04,-.55,.02);tail.rotation.x=Math.PI/2;tail.rotation.z=-.55;
const collar=mesh(new T.TorusGeometry(.63,.055,12,64),physical(choice==='space-cat'?0xffd166:0x2e8e86,{roughness:.4}),cat,-.25,.21,.28);collar.rotation.x=Math.PI/2;
const tag=mesh(new T.OctahedronGeometry(.12,0),accent,cat,-.25,.06,1.08);tag.rotation.z=Math.PI/4;
const disc=mesh(new T.CircleGeometry(.72,64),physical(palette.accent,{emissive:palette.accent,emissiveIntensity:.85,roughness:.4}),environment,-3.55,2.65,-2,false,false);disc.lookAt(camera.position);
const halo=mesh(new T.RingGeometry(.86,1.02,80),physical(palette.accent,{emissive:palette.accent,emissiveIntensity:1.4,roughness:.2}),environment,-3.55,2.65,-2,false,false);halo.lookAt(camera.position);
if(choice==='space-cat'){
  for(let index=0;index<72;index++){const starMaterial=physical(index%7===0?palette.accent:0xffffff,{emissive:index%7===0?palette.accent:0xffffff,emissiveIntensity:2,roughness:.2}),star=mesh(new T.IcosahedronGeometry(.025+(index%5)*.011,0),starMaterial,environment,Math.sin(index*12.91)*6,Math.cos(index*7.17)*4.1,Math.sin(index*3.11)*-5-2,false,false);star.rotation.z=index}
  const planet=mesh(new T.SphereGeometry(.76,48,32),physical(0x8c78e8,{roughness:.48,clearcoat:.4}),environment,3.15,.25,-1.25);const ring=mesh(new T.RingGeometry(.98,1.45,96),physical(0x88d8f7,{emissive:0x214f75,emissiveIntensity:.7,side:T.DoubleSide}),environment,3.15,.25,-1.25,false,false);ring.rotation.x=1.22;ring.rotation.z=.2;planet.rotation.z=.2;
  const dome=mesh(new T.SphereGeometry(.95,48,24,0,Math.PI*2,0,Math.PI/2),physical(0x33446f,{metalness:.42,roughness:.32,transparent:true,opacity:.8}),environment,2.45,-1.72,-1.1);dome.scale.y=.72;
}else if(choice==='neon-cat'){
  coat.emissive=new T.Color(0x63143f);coat.emissiveIntensity=.55;accent.emissive=new T.Color(palette.accent);accent.emissiveIntensity=1.5;
  for(const [x,height,color] of [[-3.3,2.8,0x2de2e6],[2.2,3.4,0xff3cac],[3.6,2.35,0x9d5cff]]){const tower=mesh(new T.BoxGeometry(.52,height,.52),physical(color,{emissive:color,emissiveIntensity:.8,metalness:.35,roughness:.24}),environment,x,-1.75+height/2,-1.6);tower.rotation.y=.18*x}
  for(let index=-5;index<=5;index++){const marker=mesh(new T.BoxGeometry(.06,.015,1.7),physical(index%2?0x2de2e6:0xff3cac,{emissive:index%2?0x2de2e6:0xff3cac,emissiveIntensity:1.8}),environment,index*.85,-1.72,1.3,false,false);marker.rotation.y=.08*index}
}else{
  const trunk=mesh(new T.CylinderGeometry(.28,.42,2.35,28),standard(0x7a432d),environment,2.75,-.7,-.95);trunk.rotation.z=-.05;
  for(const [x,y,scale] of [[2.25,.55,1.05],[2.92,.78,1.24],[3.5,.45,.92]])scaled(new T.SphereGeometry(1,40,28),physical(0x3da96b,{roughness:.78}),environment,x,y,-.95,scale,scale*.82,scale*.7);
  for(let index=0;index<7;index++){const x=-3.2+index*.78,stem=mesh(new T.CylinderGeometry(.025,.035,.62,10),standard(0x27875a),environment,x,-1.46,-.5);const flower=mesh(new T.SphereGeometry(.12,18,12),physical(index%2?0xff7997:0xffdf67,{clearcoat:.55}),environment,x,-1.1,-.5);flower.scale.y=.62;stem.rotation.z=(index-3)*.05}
}
scene.add(new T.HemisphereLight(choice==='space-cat'?0xbfd7ff:0xfff7e6,palette.ground,2.7));
const key=new T.DirectionalLight(0xfff3df,4.4);key.position.set(-4.5,7.5,6.5);key.castShadow=true;key.shadow.mapSize.set(4096,4096);key.shadow.camera.near=.5;key.shadow.camera.far=28;key.shadow.camera.left=-7;key.shadow.camera.right=7;key.shadow.camera.top=7;key.shadow.camera.bottom=-7;key.shadow.bias=-.00015;scene.add(key);
const fill=new T.PointLight(choice==='neon-cat'?0x2de2e6:0x87bfff,28,15,2);fill.position.set(4,2.5,4);scene.add(fill);const rim=new T.SpotLight(palette.accent,68,22,.65,.55,1.2);rim.position.set(-4,5,-3);rim.target=cat;scene.add(rim);scene.add(rim.target);
let pointerX=0,pointerY=0,disposed=false;
canvas.addEventListener('pointermove',event=>{const bounds=canvas.getBoundingClientRect();pointerX=(event.clientX-bounds.left)/bounds.width-.5;pointerY=(event.clientY-bounds.top)/bounds.height-.5});canvas.addEventListener('pointerleave',()=>{pointerX=0;pointerY=0});
const resize=()=>{const bounds=canvas.getBoundingClientRect(),width=Math.max(1,Math.round(bounds.width)),height=Math.max(1,Math.round(bounds.height));renderer.setPixelRatio(Math.min(devicePixelRatio||1,2.5));renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix()};const observer=new ResizeObserver(resize);observer.observe(canvas);resize();
const start=performance.now();const draw=now=>{if(disposed)return;const elapsed=now-start,orbit=!reduce&&cameraMode==='orbit'?elapsed*.00012:0,angle=orbit+pointerX*.5,radius=9.4;camera.position.x=.4+Math.sin(angle)*radius;camera.position.z=Math.cos(angle)*radius;camera.position.y=2.1-pointerY*1.5;camera.lookAt(.4,.05,0);if(!reduce){cat.position.y=Math.sin(elapsed*.0017)*.045;cat.rotation.y=Math.sin(elapsed*.00065)*.06;halo.rotation.z=elapsed*.00018;if(choice==='neon-cat')coat.emissiveIntensity=.48+.12*Math.sin(elapsed*.002)}renderer.render(scene,camera)};renderer.setAnimationLoop(draw);
canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();if(status)status.textContent='The Three.js renderer paused safely because the graphics context was lost.'});
window.addEventListener('pagehide',()=>{disposed=true;observer.disconnect();renderer.setAnimationLoop(null);renderer.dispose();world.traverse(value=>{if(value.geometry)value.geometry.dispose();if(value.material)value.material.dispose()})},{once:true});
if(status){status.textContent='Three.js r'+T.REVISION+' · physical materials · 4K soft shadows · pointer orbit';status.setAttribute('data-three-revision',String(T.REVISION))}if(window.SceneBoardArtifact&&window.SceneBoardArtifact.requestResize)window.SceneBoardArtifact.requestResize(1920,1080)
})()`;

const DEMO_SHOWCASE_PROGRAM = `(()=>{const r=document.querySelector('[data-sb-demo-showcase="v1"]');if(!r)return;const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;const stage=r.querySelector('[data-demo-stage]');if(stage&&!reduce){stage.addEventListener('pointermove',e=>{const b=stage.getBoundingClientRect(),x=(e.clientX-b.left)/b.width-.5,y=(e.clientY-b.top)/b.height-.5;stage.style.setProperty('--rx',(-y*7)+'deg');stage.style.setProperty('--ry',(x*9)+'deg')});stage.addEventListener('pointerleave',()=>{stage.style.setProperty('--rx','0deg');stage.style.setProperty('--ry','0deg')})}const log=r.querySelector('[data-demo-log]');const note=t=>{if(log)log.textContent=t};r.querySelectorAll('[data-demo-screen]').forEach(b=>b.addEventListener('click',()=>{const id=b.getAttribute('data-demo-screen');r.querySelectorAll('[data-phone-view]').forEach(v=>v.hidden=v.getAttribute('data-phone-view')!==id);note(b.getAttribute('data-demo-message')||'The prototype moved to another screen.')}));const reset=r.querySelector('[data-demo-reset]');if(reset)reset.addEventListener('click',()=>{r.querySelectorAll('[data-phone-view]').forEach(v=>v.hidden=v.getAttribute('data-phone-view')!=='home');note('The prototype returned to its starting screen.')});r.querySelectorAll('[data-incident-state]').forEach(b=>b.addEventListener('click',()=>{const s=b.getAttribute('data-incident-state');r.setAttribute('data-active-incident',s);note('The architecture view now shows the '+s+' state.')}));const toggle=r.querySelector('[data-review-toggle]');if(toggle)toggle.addEventListener('click',()=>{const on=toggle.getAttribute('aria-pressed')!=='true';toggle.setAttribute('aria-pressed',String(on));r.setAttribute('data-inventory-unavailable',String(on));note(on?'Unavailable inventory stops before payment.':'The successful request reaches confirmation.')});const play=r.querySelector('[data-review-play]');if(play)play.addEventListener('click',()=>{r.classList.remove('is-playing');void r.offsetWidth;r.classList.add('is-playing');note(r.getAttribute('data-inventory-unavailable')==='true'?'The new flow stopped before charging the card.':'Both illustrative requests completed.')});const replay=r.querySelector('[data-story-replay]');if(replay)replay.addEventListener('click',()=>{r.classList.remove('is-replaying');void r.offsetWidth;r.classList.add('is-replaying');note('The illustrative seven-day story is replaying.')});if(window.SceneBoardArtifact&&window.SceneBoardArtifact.requestResize)window.SceneBoardArtifact.requestResize(1200,675)})()`;

const demoShowcaseCss = `.sb-demo{position:relative;box-sizing:border-box;width:1200px;height:675px;overflow:hidden;padding:30px;background:linear-gradient(135deg,#f8fafc,#ecfeff);color:#102a2a;font-family:system-ui,sans-serif}.sb-demo *{box-sizing:border-box}.sb-demo h1{margin:0;font-size:36px;letter-spacing:-.03em}.sb-demo .eyebrow{margin:0 0 8px;color:#0f766e;font-weight:800;text-transform:uppercase;letter-spacing:.12em}.sb-demo .sub{margin:8px 0 18px;font-size:17px}.demo-grid{display:grid;gap:18px}.demo-card{border:2px solid #99f6e4;border-radius:18px;background:#fff;padding:18px;box-shadow:0 12px 30px #0f766e18}.demo-btn{border:2px solid #0f766e;border-radius:10px;background:#fff;color:#0f3d3a;padding:10px 16px;font-weight:800;cursor:pointer}.demo-btn:focus-visible{outline:4px solid #f59e0b;outline-offset:2px}.demo-btn.primary{background:#0f766e;color:#fff}.demo-log{position:absolute;left:30px;right:30px;bottom:18px;padding:10px 16px;border-radius:12px;background:#0f172a;color:#f8fafc;font-weight:700}.sb-demo[data-kind="illustration"] .demo-log{display:none}.cat-stage{position:relative;height:500px;overflow:hidden;border:2px solid #0f766e;border-radius:24px;background:#fffdf4;display:grid;place-items:center;box-shadow:inset 0 0 0 10px #ffffffa6,0 22px 50px #0f3d3a1f}.cat-stage:after{position:absolute;inset:12px;pointer-events:none;border:1px solid #0f766e2f;border-radius:17px;content:""}.cat-stage svg{width:96%;height:96%;filter:drop-shadow(0 12px 14px #13304718)}.sketch{fill:none;stroke:#26374a;stroke-width:5;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:3000;stroke-dashoffset:3000;animation:draw 6s linear forwards}.cat-color{opacity:0;animation:paint 4.5s .8s ease forwards}.cat-detail{filter:drop-shadow(0 2px 1px #7a341522)}.garden-depth{filter:drop-shadow(0 9px 10px #145c3824)}.sb-demo[data-phase="outline"] .cat-color{display:none}@keyframes draw{to{stroke-dashoffset:0}}@keyframes paint{to{opacity:1}}.paper-scene{height:510px;perspective:900px;display:grid;place-items:center;background:#0f172a;border-radius:24px;overflow:hidden}.paper-world{position:relative;width:900px;height:430px;transform-style:preserve-3d;transform:rotateX(var(--rx,0deg)) rotateY(var(--ry,0deg));transition:transform .25s ease}.paper-layer{position:absolute;inset:0;display:grid;place-items:center;transform-style:preserve-3d;transition:transform 3s ease}.paper-layer.atmosphere{transform:translateZ(-160px);background:radial-gradient(circle,#fde68a22,transparent 65%)}.paper-layer.back{transform:translateZ(-90px)}.paper-layer.middle{transform:translateZ(-30px)}.paper-layer.cat{transform:translateZ(70px);font-size:150px;filter:drop-shadow(0 24px 12px #0008);animation:breathe 3s ease-in-out infinite}.paper-layer.front{transform:translateZ(130px);font-size:60px}.paper-shape{font-size:92px;filter:drop-shadow(0 18px 10px #0007)}@keyframes breathe{50%{transform:translateZ(70px) translateY(-8px)}}.prototype-layout{grid-template-columns:410px 1fr;align-items:center;height:520px}.phone{width:300px;height:500px;margin:auto;padding:16px;border:12px solid #172033;border-radius:42px;background:#f8fafc;box-shadow:0 20px 40px #0003}.phone-top{display:flex;justify-content:space-between;font-weight:800}.phone-view{margin-top:24px}.phone-view[hidden]{display:none}.trip-item{margin:12px 0;padding:14px;border-radius:14px;background:#ccfbf1}.story{grid-template-columns:1.3fr .7fr;height:505px}.bars{display:flex;gap:18px;align-items:end;height:330px;padding:30px;border-radius:18px;background:#fff}.bar{flex:1;height:calc(var(--v)*1%);min-height:25px;background:#14b8a6;border-radius:10px 10px 0 0;animation:grow 2s ease both}.bar.spike{background:#f97316}.bar span{display:block;transform:translateY(-25px);text-align:center;font-weight:800}@keyframes grow{from{height:0}}.decision{display:grid;align-content:center;gap:14px}.incident-map{grid-template-columns:1fr 340px;height:500px}.system-line{display:flex;align-items:center;justify-content:center;gap:12px}.node{min-width:120px;padding:20px 12px;border:3px solid #0f766e;border-radius:16px;background:#d1fae5;text-align:center;font-weight:800}.arrow{font-size:28px}.sb-demo[data-active-incident="failure"] .node.affected{border-color:#dc2626;background:#fee2e2}.sb-demo[data-active-incident="recovery"] .node.affected{border-color:#d97706;background:#fef3c7}.incident-controls{display:flex;gap:8px;margin-top:25px}.mission{height:500px;grid-template-columns:1fr 1fr}.ring{width:260px;height:260px;margin:auto;border:28px solid #2dd4bf;border-right-color:#f59e0b;border-radius:50%;display:grid;place-items:center;font-size:52px;font-weight:900;animation:spin-in 2s ease}@keyframes spin-in{from{transform:rotate(-180deg);opacity:0}}.checks{display:grid;align-content:center;gap:14px}.check{padding:14px;border-left:8px solid #14b8a6;background:#fff}.review{grid-template-columns:1fr 1fr;height:460px}.flow{display:flex;flex-wrap:wrap;align-content:center;gap:10px}.step{padding:14px;border:2px solid #64748b;border-radius:12px;background:#fff;font-weight:800}.risk{border-color:#dc2626}.gate{border-color:#0f766e;background:#ccfbf1}.pulse{width:14px;height:14px;border-radius:50%;background:#f97316;opacity:0}.is-playing .pulse{animation:travel 2.5s ease}@keyframes travel{0%{opacity:1;transform:translateX(0)}100%{opacity:1;transform:translateX(480px)}}.sb-demo[data-inventory-unavailable="true"] .after-charge{opacity:.25}.sb-demo[data-inventory-unavailable="true"] .stop-note{display:block}.stop-note{display:none;padding:12px;background:#fef3c7;border:2px solid #d97706;border-radius:10px}.is-replaying .bar{animation:grow 2s ease both}@media (prefers-reduced-motion:reduce){.sb-demo *{animation:none!important;transition:none!important}.sketch{stroke-dashoffset:0}.cat-color{opacity:1}}`;

const webglShowcaseCss = `.sb-webgl{position:relative;box-sizing:border-box;width:1920px;height:1080px;overflow:hidden;background:#07111f;color:#f8fafc;font-family:system-ui,sans-serif}.sb-webgl *{box-sizing:border-box}.sb-webgl canvas{display:block;width:100%;height:100%;touch-action:none}.webgl-copy{position:absolute;z-index:2;top:54px;left:64px;max-width:620px;padding:26px 30px;border:1px solid #ffffff35;border-radius:22px;background:#07111fcc;box-shadow:0 24px 70px #0008;backdrop-filter:blur(12px)}.webgl-copy .eyebrow{margin:0 0 10px;color:#5eead4;font-size:18px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}.webgl-copy h1{margin:0;font-size:56px;line-height:1.03;letter-spacing:-.04em}.webgl-copy p{margin:14px 0 0;font-size:21px;line-height:1.5}.webgl-status{position:absolute;z-index:2;right:42px;bottom:34px;padding:12px 18px;border-radius:999px;background:#07111fdd;color:#ccfbf1;font-size:17px;font-weight:700}`;

const threejsShowcaseCss = `.sb-threejs{position:relative;box-sizing:border-box;width:1920px;height:1080px;overflow:hidden;background:#07111f;color:#f8fafc;font-family:system-ui,sans-serif}.sb-threejs *{box-sizing:border-box}.sb-threejs:after{position:absolute;inset:0;pointer-events:none;content:"";background:radial-gradient(circle at 52% 48%,transparent 35%,#02061778 100%)}.sb-threejs canvas{display:block;width:100%;height:100%;touch-action:none}.threejs-copy{position:absolute;z-index:2;top:54px;left:64px;max-width:650px;padding:28px 32px;border:1px solid #ffffff35;border-radius:24px;background:linear-gradient(145deg,#07111fe8,#0f1d34c9);box-shadow:0 28px 80px #0009,inset 0 1px #ffffff28;backdrop-filter:blur(18px)}.threejs-copy .eyebrow{margin:0 0 10px;color:#5eead4;font-size:18px;font-weight:850;letter-spacing:.14em;text-transform:uppercase}.threejs-copy h1{margin:0;font-size:58px;line-height:1.02;letter-spacing:-.045em;text-wrap:balance}.threejs-copy p{margin:14px 0 0;color:#dbeafe;font-size:21px;line-height:1.5}.threejs-status{position:absolute;z-index:2;right:42px;bottom:34px;padding:12px 18px;border:1px solid #5eead455;border-radius:999px;background:#07111fe8;color:#ccfbf1;font-size:17px;font-weight:750;box-shadow:0 14px 36px #0007}`;

const renderWebglShowcase = (recipe) =>
  `<main class="sb-webgl" data-sb-webgl-showcase="v1" data-scene="${escapeHtml(recipe.content.scene)}" data-camera="${escapeHtml(recipe.content.camera)}"><section class="webgl-copy"><p class="eyebrow">Live WebGL scene</p><h1>${escapeHtml(recipe.title)}</h1><p>${escapeHtml(recipe.fallbackText)}</p></section><canvas role="img" aria-label="${escapeHtml(recipe.fallbackText)}"></canvas><p class="webgl-status" data-webgl-status aria-live="polite">Preparing the high-resolution 3D scene…</p></main>`;

const renderThreejsShowcase = (recipe) =>
  `<main class="sb-threejs" data-sb-threejs-showcase="v1" data-scene="${escapeHtml(recipe.content.scene)}" data-camera="${escapeHtml(recipe.content.camera)}"><section class="threejs-copy"><p class="eyebrow">Live Three.js scene</p><h1>${escapeHtml(recipe.title)}</h1><p>${escapeHtml(recipe.fallbackText)}</p></section><canvas role="img" aria-label="${escapeHtml(recipe.fallbackText)}"></canvas><p class="threejs-status" data-threejs-status aria-live="polite">Preparing the high-quality Three.js scene…</p></main>`;

const illustrationDefs = `<defs><linearGradient id="sky-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bfe4ff"/><stop offset="1" stop-color="#f5fbff"/></linearGradient><linearGradient id="cat-coat-gradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb347"/><stop offset=".52" stop-color="#f68a35"/><stop offset="1" stop-color="#dd642f"/></linearGradient><linearGradient id="cat-cream-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff6df"/><stop offset="1" stop-color="#ffd7a0"/></linearGradient><linearGradient id="leaf-gradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7bdc8b"/><stop offset="1" stop-color="#218f61"/></linearGradient><radialGradient id="sun-gradient"><stop offset="0" stop-color="#fff7ad"/><stop offset=".6" stop-color="#ffd85a"/><stop offset="1" stop-color="#ffae35"/></radialGradient></defs>`;

const coloredCat = `<ellipse cx="520" cy="492" rx="176" ry="20" fill="#163044" opacity=".18"/><path d="M642 410c88-79 184-51 191 24 5 54-44 79-94 54 51-8 58-45 34-65-28-23-74 2-116 46z" fill="url(#cat-coat-gradient)"/><path d="M418 338c-32 31-45 91-25 143 37 22 84 30 132 29 49 1 95-8 130-31 18-53 2-112-32-143z" fill="url(#cat-coat-gradient)"/><ellipse cx="520" cy="420" rx="75" ry="75" fill="url(#cat-cream-gradient)"/><path d="M383 247l21-132 96 68c25-11 51-11 77 0l95-68 15 137c12 89-54 139-152 139-101 0-166-51-152-144z" fill="url(#cat-coat-gradient)"/><path d="M412 157l66 48-58 25zM651 157l-61 49 53 23z" fill="#ef8290"/><path d="M437 223c25-22 53-27 81-10-34-4-57 6-74 28zM552 214c29-18 59-12 80 10l-8 18c-18-21-41-30-72-28z" fill="#d45f2d" opacity=".72"/><g class="cat-detail"><ellipse cx="474" cy="272" rx="34" ry="41" fill="#fff8e8"/><ellipse cx="590" cy="272" rx="34" ry="41" fill="#fff8e8"/><ellipse cx="478" cy="273" rx="14" ry="22" fill="#24745f"/><ellipse cx="586" cy="273" rx="14" ry="22" fill="#24745f"/><ellipse cx="480" cy="277" rx="7" ry="15" fill="#132438"/><ellipse cx="584" cy="277" rx="7" ry="15" fill="#132438"/><circle cx="474" cy="265" r="5" fill="#fff"/><circle cx="578" cy="265" r="5" fill="#fff"/><ellipse cx="493" cy="326" rx="45" ry="31" fill="#fff1d5"/><ellipse cx="567" cy="326" rx="45" ry="31" fill="#fff1d5"/><path d="M531 307l20 13-20 17-20-17z" fill="#9e4760"/><path d="M531 337c-2 23-19 31-37 28m37-28c2 23 19 31 37 28" fill="none" stroke="#26374a" stroke-width="6" stroke-linecap="round"/><path d="M445 330l-112-20m113 42-120 8m288-30 112-20m-113 42 120 8" fill="none" stroke="#26374a" stroke-width="5" stroke-linecap="round"/><path d="M455 190l28 14m-37 9 30 10m137-34-29 15m39 8-31 11" fill="none" stroke="#b84f2e" stroke-width="8" stroke-linecap="round"/><path d="M469 374c37 25 86 25 123 0" fill="none" stroke="#d86935" stroke-width="9" stroke-linecap="round"/><ellipse cx="420" cy="492" rx="48" ry="24" fill="#fff0d1"/><ellipse cx="624" cy="492" rx="48" ry="24" fill="#fff0d1"/><path d="M482 397c-16 31-17 68-5 92m88-92c16 31 17 68 5 92" fill="none" stroke="#ed914b" stroke-width="8" stroke-linecap="round"/></g>`;

const illustrationColorLayers = (selection) => {
  if (selection === 'sunny-garden')
    return `${illustrationDefs}<rect width="1200" height="520" fill="url(#sky-gradient)"/><g fill="#fff" opacity=".72"><ellipse cx="188" cy="104" rx="76" ry="26"/><ellipse cx="244" cy="95" rx="52" ry="34"/><ellipse cx="815" cy="112" rx="72" ry="25"/><ellipse cx="866" cy="101" rx="42" ry="31"/></g><circle cx="1032" cy="92" r="72" fill="url(#sun-gradient)"/><g class="garden-depth"><path d="M0 346c191-77 345-70 510 0 175 73 356 60 690-28v202H0z" fill="#a7e6a0"/><path d="M0 408c250-70 430-35 604 18 197 60 392 38 596-20v114H0z" fill="#54bd78"/><path d="M852 484V267" stroke="#74442e" stroke-width="42" stroke-linecap="round"/><g fill="url(#leaf-gradient)"><circle cx="785" cy="250" r="72"/><circle cx="895" cy="205" r="91"/><circle cx="996" cy="260" r="78"/><circle cx="903" cy="286" r="76"/></g><path d="M93 469c72-78 139-64 187 5M985 473c67-70 133-54 181 4" fill="none" stroke="#238a59" stroke-width="13" stroke-linecap="round"/><g fill="#fff4a8" stroke="#ef8a50" stroke-width="4"><circle cx="138" cy="441" r="16"/><circle cx="216" cy="462" r="13"/><circle cx="1050" cy="443" r="16"/><circle cx="1124" cy="469" r="13"/></g><g fill="#ff7d9c"><circle cx="138" cy="441" r="6"/><circle cx="216" cy="462" r="5"/><circle cx="1050" cy="443" r="6"/><circle cx="1124" cy="469" r="5"/></g><path d="M105 197c34-24 64 22 32 49-35-22-46-37-32-49zm47 0c-34-24-64 22-32 49 35-22 46-37 32-49z" fill="#ffe36e" stroke="#cf7745" stroke-width="3"/></g>${coloredCat}`;
  if (selection === 'space-adventure')
    return `${illustrationDefs}<rect width="1200" height="520" fill="#101936"/><circle cx="1020" cy="120" r="69" fill="#dce7f5"/><circle cx="995" cy="98" r="19" fill="#fff" opacity=".8"/><circle cx="930" cy="320" r="86" fill="#8b6fe8"/><path d="M839 324q90-38 180 0" fill="none" stroke="#f6d365" stroke-width="18"/><g fill="#ffd166"><circle cx="150" cy="125" r="10"/><circle cx="260" cy="78" r="7"/><circle cx="760" cy="115" r="8"/><circle cx="1090" cy="235" r="7"/><circle cx="820" cy="72" r="5"/></g><path d="M870 268l52-92 52 92-52 31z" fill="#ef5b5b"/><path d="M922 190v96" stroke="#f8fafc" stroke-width="13"/><ellipse cx="520" cy="485" rx="330" ry="31" fill="#26345f"/>${coloredCat}`;
  return `${illustrationDefs}<rect width="1200" height="520" fill="#9fb8d0"/><rect y="382" width="1200" height="138" fill="#60778d"/><rect x="120" y="190" width="180" height="192" fill="#56738c"/><rect x="340" y="120" width="220" height="262" fill="#3e607d"/><rect x="600" y="220" width="190" height="162" fill="#6d8296"/><rect x="830" y="150" width="220" height="232" fill="#405b75"/><g fill="#ffd166"><rect x="155" y="230" width="28" height="34"/><rect x="225" y="290" width="28" height="34"/><rect x="382" y="166" width="28" height="34"/><rect x="475" y="244" width="28" height="34"/><rect x="654" y="260" width="28" height="34"/><rect x="874" y="205" width="28" height="34"/><rect x="964" y="280" width="28" height="34"/></g><path d="M760 430q80-92 160 0z" fill="#ffd84d"/><rect x="835" y="430" width="10" height="77" rx="5" fill="#172033"/><ellipse cx="240" cy="455" rx="110" ry="24" fill="#b8e5f7" opacity=".78"/><ellipse cx="970" cy="472" rx="130" ry="25" fill="#b8e5f7" opacity=".78"/>${coloredCat}`;
};

const illustrationSketch = (selection) => {
  const scenery =
    selection === 'sunny-garden'
      ? '<circle cx="1010" cy="95" r="55"/><path d="M930 470v-180m0 40-80-70m80 90 90-80"/><circle cx="850" cy="260" r="55"/><circle cx="1015" cy="270" r="58"/>'
      : selection === 'space-adventure'
        ? '<circle cx="1020" cy="120" r="62"/><path d="M900 250l45-80 45 80-45 35zM150 100l12 25 28 4-20 20 5 28-25-13-25 13 5-28-20-20 28-4z"/>'
        : '<path d="M80 380h1040M120 380V190h180v190m40 0V120h220v260m40 0V220h190v160m40 0V150h220v230M760 430q80-90 160 0M840 430v80"/><path d="M120 80l-20 40m130-40-20 40m130-40-20 40m130-40-20 40m130-40-20 40"/>';
  return `<g class="sketch"><path d="M383 247l21-132 96 68q38-17 77 0l95-68 15 137q12 89-152 139-166-51-152-144z"/><ellipse cx="474" cy="272" rx="34" ry="41"/><ellipse cx="590" cy="272" rx="34" ry="41"/><path d="M531 307l20 13-20 17-20-17zM531 337c-2 23-19 31-37 28m37-28c2 23 19 31 37 28M445 330l-112-20m113 42-120 8m288-30 112-20m-113 42 120 8M418 338c-32 31-45 91-25 143 78 40 187 38 262-2 18-53 2-112-32-143M482 397c-16 31-17 68-5 92m88-92c16 31 17 68 5 92M642 410c88-79 184-51 191 24 5 54-44 79-94 54 51-8 58-45 34-65-28-23-74 2-116 46M455 190l28 14m-37 9 30 10m137-34-29 15m39 8-31 11"/><ellipse cx="420" cy="492" rx="48" ry="24"/><ellipse cx="624" cy="492" rx="48" ry="24"/>${scenery}</g>`;
};

const renderDemoShowcase = (recipe) => {
  const h = escapeHtml;
  const { kind, selection, phase } = recipe.content;
  const shell = (eyebrow, inner) =>
    `<main class="sb-demo" data-sb-demo-showcase="v1" data-kind="${h(kind)}" data-selection="${h(selection)}" data-phase="${h(phase)}"><p class="eyebrow">${h(eyebrow)}</p><h1>${h(recipe.title)}</h1><p class="sub">${h(recipe.fallbackText)}</p>${inner}<div class="demo-log" data-demo-log>Built live by Codex. Every interaction stays inside this demo.</div></main>`;
  if (kind === 'illustration') {
    return shell(
      'Human-guided illustration',
      `<section class="cat-stage"><svg viewBox="0 0 1200 520" role="img" aria-label="A polished editorial cat illustration in the selected ${h(selection)} setting"><g class="cat-color">${illustrationColorLayers(selection)}</g>${illustrationSketch(selection)}</svg></section>`,
    );
  }
  if (kind === 'diorama') {
    const icons =
      selection === 'golden-garden'
        ? ['☀️', '🌳 🌻 🦋', '🌿', '🐈', '🌸 🌼']
        : selection === 'space-observatory'
          ? ['✨', '🌙 🪐', '🚀', '🐈‍⬛', '⭐ ✦']
          : ['🌧️', '🏙️', '☂️', '🐈', '💧 ✨'];
    return shell(
      'Interactive 3D paper world',
      `<section class="paper-scene" data-demo-stage><div class="paper-world"><div class="paper-layer atmosphere">${icons[0]}</div><div class="paper-layer back"><span class="paper-shape">${icons[1]}</span></div><div class="paper-layer middle"><span class="paper-shape">${icons[2]}</span></div><div class="paper-layer cat">${icons[3]}</div><div class="paper-layer front">${icons[4]}</div></div></section><p class="sub">Move the pointer to explore the depth.</p>`,
    );
  }
  if (kind === 'prototype')
    return shell(
      'Clickable product prototype',
      `<section class="demo-grid prototype-layout"><div class="phone"><div class="phone-top"><span>Trip Calm</span><span>Day 2</span></div><div class="phone-view" data-phone-view="home"><h2>${selection === 'risk-checker' ? 'Booking confidence' : 'Today at a glance'}</h2><div class="trip-item">09:00 · Museum reservation</div><div class="trip-item">12:30 · Riverside lunch</div><button class="demo-btn primary" data-demo-screen="detail" data-demo-message="The traveler opened Tuesday’s plan.">${phase === 'improved' ? 'Review Tuesday plan' : 'Open plan'}</button></div><div class="phone-view" data-phone-view="detail" hidden><h2>Tuesday plan</h2><p>One timing warning needs attention.</p><button class="demo-btn primary" data-demo-screen="confirm" data-demo-message="The traveler opened the save confirmation.">Save calm plan</button></div><div class="phone-view" data-phone-view="confirm" hidden><h2>Plan saved</h2><p>Your day plan is ready offline.</p></div></div><div class="demo-card"><h2>A complex itinerary becomes one calm day.</h2><p>One primary action, visible timing risks, and plain language make the next step obvious.</p><button class="demo-btn" data-demo-reset>Reset demo</button><p><strong>Selected experience:</strong> ${h(selection)}</p></div></section>`,
    );
  if (kind === 'data-story')
    return shell(
      'Illustrative sample data',
      `<section class="demo-grid story"><div><div class="bars"><div class="bar" style="--v:50"><span>Mon<br>120</span></div><div class="bar" style="--v:61"><span>Tue<br>145</span></div><div class="bar spike" style="--v:88"><span>Wed<br>210</span></div><div class="bar spike" style="--v:100"><span>Thu<br>238</span></div><div class="bar" style="--v:77"><span>Fri<br>184</span></div><div class="bar" style="--v:41"><span>Sat<br>98</span></div><div class="bar" style="--v:35"><span>Sun<br>84</span></div></div><button class="demo-btn" data-story-replay>Replay story</button></div><div class="decision demo-card"><h2>Demand spike</h2><p>Demand peaked on Thursday.</p><p>Response time more than doubled from Sunday to Thursday.</p><p>Recovery began as the backlog cleared on Friday.</p><strong>Decision: add temporary coverage before the midweek peak.</strong></div></section>`,
    );
  if (kind === 'incident')
    return shell(
      'Fictional incident simulation',
      `<section class="demo-grid incident-map" data-active-incident="${h(phase)}"><div><div class="system-line"><div class="node">Browser</div><span class="arrow">→</span><div class="node">Gateway</div><span class="arrow">→</span><div class="node affected">Application API</div><span class="arrow">→</span><div class="node affected">${selection === 'cache-unavailable' ? 'Redis cache' : selection === 'pool-exhausted' ? 'MySQL pool' : 'Worker queue'}</div></div><div class="incident-controls"><button class="demo-btn" data-incident-state="healthy">Healthy</button><button class="demo-btn" data-incident-state="failure">Failure</button><button class="demo-btn" data-incident-state="recovery">Recovery</button></div></div><div class="demo-card"><h2>Customer impact</h2><p>Only affected request paths slow down; unaffected delivery remains healthy.</p><ol><li>Protect new traffic.</li><li>Reduce pressure safely.</li><li>Restore capacity gradually.</li></ol><strong>A person still authorizes the recovery.</strong></div></section>`,
    );
  if (kind === 'mission-control')
    return shell(
      'Every AI change preserved',
      `<section class="demo-grid mission"><div class="ring">92%</div><div class="checks"><div class="check">18 of 20 reliability checks passed</div><div class="check">Risk beacon: verify rendering in a real browser</div><div class="check">Decision gate: final rehearsal may begin</div></div></section>`,
    );
  return shell(
    'Illustrative code review',
    `<section class="demo-grid review"><article class="demo-card"><h2>Before</h2><div class="flow"><span class="step">Checkout</span><span>→</span><span class="step risk">Charge card</span><span>→</span><span class="step">Reserve inventory</span></div><p>Risk: payment can happen before availability is known.</p></article><article class="demo-card"><h2>After</h2><div class="flow"><span class="step">Checkout</span><span>→</span><span class="step gate">Validate inventory</span><span>→</span><span class="step after-charge">Charge card</span><span>→</span><span class="step after-charge">Confirmation</span><span class="pulse"></span></div><p class="stop-note">No charge made — ask the customer to retry.</p></article></section><button class="demo-btn primary" data-review-play>Play request</button> <button class="demo-btn" data-review-toggle aria-pressed="false">Simulate unavailable inventory</button><p><strong>Human review priority:</strong> ${h(selection)}</p>`,
  );
};

const render = (recipe) => {
  const h = escapeHtml;
  const cls = `sb-artifact-v1-root${recipe.motion === 'none' ? '' : ' sb-artifact-v1-motion'}`;
  let body;
  let javascript = null;
  if (recipe.template === 'metric-story')
    body = `<div class="sb-artifact-v1-grid">${recipe.content.metrics.map((m) => `<article class="sb-artifact-v1-card"><h2>${h(m.label)}</h2><strong class="sb-artifact-v1-accent">${h(m.value)}</strong>${m.detail === null ? '' : `<p>${h(m.detail)}</p>`}<p>Trend: ${h(m.trend)}</p></article>`).join('')}</div>`;
  else if (recipe.template === 'process-flow') {
    const items = recipe.content.steps
      .map(
        (s, i) =>
          `<li><strong>${i + 1}. ${h(s.label)}</strong> — ${h(s.status)}${s.detail === null ? '' : `<p>${h(s.detail)}</p>`}</li>`,
      )
      .join('');
    body = `${svg(recipe.title, recipe.fallbackText, recipe.content.steps.map((_, i) => `<circle cx="${80 + i * 70}" cy="120" r="22" fill="#0f766e"/>`).join(''))}<ol>${items}</ol>`;
  } else if (recipe.template === 'architecture-map') {
    const facts =
      recipe.content.nodes.map((n) => `<li>${h(n.label)} (${h(n.role)})</li>`).join('') +
      recipe.content.edges
        .map(
          (e) => `<li>${h(e.from)} → ${h(e.to)}${e.label === null ? '' : `: ${h(e.label)}`}</li>`,
        )
        .join('');
    body = `${svg(recipe.title, recipe.fallbackText, recipe.content.nodes.map((_, i) => `<rect x="${30 + (i % 4) * 190}" y="${30 + Math.floor(i / 4) * 90}" width="150" height="56" rx="8" fill="#ccfbf1" stroke="#0f766e"/>`).join(''))}<ul>${facts}</ul>`;
  } else if (recipe.template === 'timeline') {
    body = `${svg(recipe.title, recipe.fallbackText, '<line x1="40" y1="150" x2="760" y2="150" stroke="#0f766e" stroke-width="4"/>')}<ol>${recipe.content.events.map((e) => `<li><strong>${h(e.date)} — ${h(e.label)}</strong> (${h(e.status)})${e.detail === null ? '' : `<p>${h(e.detail)}</p>`}</li>`).join('')}</ol>`;
  } else if (recipe.template === 'demo-showcase')
    return {
      artifactId: null,
      html: renderDemoShowcase(recipe),
      css: `${demoShowcaseCss}.sb-demo{width:1000px;padding-right:30px}.demo-log{right:30px}.demo-card{min-width:0}.sb-demo h1{font-size:32px}.paper-world{width:760px}.node{min-width:105px}`,
      javascript: DEMO_SHOWCASE_PROGRAM,
      requestedCapabilities: [],
    };
  else if (recipe.template === 'threejs-showcase')
    return {
      artifactId: null,
      html: renderThreejsShowcase(recipe),
      css: threejsShowcaseCss,
      javascript: THREEJS_SHOWCASE_PROGRAM_PREMIUM,
      requestedCapabilities: [],
    };
  else if (recipe.template === 'webgl-showcase')
    return {
      artifactId: null,
      html: renderWebglShowcase(recipe),
      css: webglShowcaseCss,
      javascript: WEBGL_SHOWCASE_PROGRAM,
      requestedCapabilities: [],
    };
  else {
    const values = stringifyCanonicalSceneArtifactJson(recipe.content.points.map((p) => p.value));
    body = `<table><caption>${h(recipe.content.seriesLabel)}</caption><tbody>${recipe.content.points.map((p) => `<tr><th>${h(p.label)}</th><td>${p.value}${recipe.content.unit === null ? '' : ` ${h(recipe.content.unit)}`}</td></tr>`).join('')}</tbody></table><canvas width="800" height="240" role="img" aria-label="${h(recipe.fallbackText)}" data-sb-artifact-canvas="animated-data-story-v1" data-sb-artifact-values="${h(values)}" data-sb-artifact-motion="${recipe.motion}"></canvas>`;
    javascript = CANVAS_PROGRAM;
  }
  const marker =
    recipe.template === 'animated-data-story'
      ? ' data-sb-artifact-root="animated-data-story-v1"'
      : '';
  return {
    artifactId: null,
    html: `<main class="${cls}"${marker}><h1>${h(recipe.title)}</h1><p>${h(recipe.fallbackText)}</p>${body}</main>`,
    css: baseCss(recipe),
    javascript,
    requestedCapabilities: [],
  };
};

export const auditSceneArtifactSource = (source) => {
  closed(
    source,
    ['artifactId', 'html', 'css', 'javascript', 'requestedCapabilities'],
    ['source'],
    'UNSAFE_ARTIFACT_SOURCE',
  );
  if (
    source.artifactId !== null ||
    !Array.isArray(source.requestedCapabilities) ||
    source.requestedCapabilities.length !== 0
  )
    fail('UNSAFE_ARTIFACT_SOURCE', ['source']);
  const htmlBytes = Buffer.byteLength(source.html ?? ''),
    cssBytes = Buffer.byteLength(source.css ?? ''),
    jsBytes = source.javascript === null ? 0 : Buffer.byteLength(source.javascript ?? '');
  if (
    htmlBytes < 1 ||
    htmlBytes > 262144 ||
    cssBytes < 1 ||
    cssBytes > 65536 ||
    jsBytes > 32768 ||
    htmlBytes + cssBytes + jsBytes > 360448
  )
    fail('PAYLOAD_TOO_LARGE', ['source']);
  if (
    typeof source.html !== 'string' ||
    typeof source.css !== 'string' ||
    (source.javascript !== null &&
      source.javascript !== CANVAS_PROGRAM &&
      source.javascript !== DEMO_SHOWCASE_PROGRAM &&
      source.javascript !== THREEJS_SHOWCASE_PROGRAM &&
      source.javascript !== THREEJS_SHOWCASE_PROGRAM_PREMIUM &&
      source.javascript !== WEBGL_SHOWCASE_PROGRAM)
  )
    fail('UNSAFE_ARTIFACT_SOURCE', ['source']);
  const tags = source.html.match(/<[^>]*>/g) ?? [];
  if (
    tags.some(
      (tag) =>
        /<\s*(script|iframe|object|embed|link|meta|img)\b/i.test(tag) ||
        /\s(on[a-z]+|href|src|xlink:href)\s*=/i.test(tag),
    ) ||
    /(@import|@font-face|url\s*\(|image-set\s*\(|expression\s*\()/i.test(source.css)
  )
    fail('UNSAFE_ARTIFACT_SOURCE', ['source']);
  const hasCanvas = source.html.includes('data-sb-artifact-canvas="animated-data-story-v1"');
  if ((source.javascript === CANVAS_PROGRAM) !== hasCanvas)
    fail('UNSAFE_ARTIFACT_SOURCE', ['source', 'javascript']);
  const hasDemoShowcase = source.html.includes('data-sb-demo-showcase="v1"');
  if ((source.javascript === DEMO_SHOWCASE_PROGRAM) !== hasDemoShowcase)
    fail('UNSAFE_ARTIFACT_SOURCE', ['source', 'javascript']);
  const hasWebglShowcase = source.html.includes('data-sb-webgl-showcase="v1"');
  if ((source.javascript === WEBGL_SHOWCASE_PROGRAM) !== hasWebglShowcase)
    fail('UNSAFE_ARTIFACT_SOURCE', ['source', 'javascript']);
  const hasThreejsShowcase = source.html.includes('data-sb-threejs-showcase="v1"');
  if (
    (source.javascript === THREEJS_SHOWCASE_PROGRAM ||
      source.javascript === THREEJS_SHOWCASE_PROGRAM_PREMIUM) !== hasThreejsShowcase
  )
    fail('UNSAFE_ARTIFACT_SOURCE', ['source', 'javascript']);
  return canonicalizeSceneRecipeJson(source);
};

export const compileSceneArtifactDraft = (input, descriptor) => {
  const recipe = validateSceneArtifactRecipe(input);
  const template = validateSceneArtifactTemplateDescriptor(descriptor);
  if (template.name !== recipe.template) fail('INVALID_RELATION', ['template']);
  const source = auditSceneArtifactSource(render(recipe));
  return {
    artifactRecipeVersion: 1,
    type: 'artifact-draft',
    template: recipe.template,
    motion: recipe.motion,
    source,
    placement: {
      nodeId: deriveSceneRecipeNodeId({
        path: ['root'],
        nodeKind: 'content.artifact',
        key: recipe.placementKey,
      }),
      title: recipe.title,
      fallbackText: recipe.fallbackText,
    },
  };
};

const validatePlacement = (input) => {
  closed(input, ['artifact', 'placement'], [], 'INVALID_PLACEMENT');
  closed(input.artifact, ['artifactId', 'versionId'], ['artifact'], 'INVALID_PLACEMENT');
  closed(input.placement, ['nodeId', 'title', 'fallbackText'], ['placement'], 'INVALID_PLACEMENT');
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.artifact.artifactId) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.artifact.versionId) ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(input.placement.nodeId)
  )
    fail('INVALID_PLACEMENT', []);
  text(input.placement.title, 200, ['placement', 'title']);
  text(input.placement.fallbackText, 200, ['placement', 'fallbackText']);
  return canonicalizeSceneRecipeJson(input);
};
export const createSceneArtifactPlacement = (input) => {
  const value = validatePlacement(input);
  return {
    id: value.placement.nodeId,
    type: 'content.artifact',
    title: value.placement.title,
    artifact: value.artifact,
    fallbackText: value.placement.fallbackText,
  };
};
