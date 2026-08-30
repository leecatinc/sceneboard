import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  compileSceneArtifactDraft,
  parseSceneArtifactRecipeJson,
  validateSceneArtifactTemplateDescriptor,
} from '../scripts/scene-artifact-core.mjs';
import { canonicalizeWorkflowSpec } from '../scripts/workflow-spec-core.mjs';

const root = resolve(import.meta.dirname, '..');
const workflowSpec = JSON.parse(
  await readFile(resolve(root, 'assets/workflow-spec-examples/conditional-hitl.json'), 'utf8'),
);
const descriptor = validateSceneArtifactTemplateDescriptor(
  JSON.parse(
    await readFile(resolve(root, 'assets/artifact-templates/workflow-graph.json'), 'utf8'),
  ),
);
const recipe = (copyMode, spec = workflowSpec) => ({
  artifactRecipeVersion: 1,
  template: 'workflow-graph',
  placementKey: 'approval-workflow',
  title: 'Approval workflow',
  fallbackText: 'Inspect the canonical WorkflowSpec JSON.',
  theme: 'dark',
  size: { width: 1280, height: 800 },
  motion: 'subtle',
  content: { workflowSpec: spec, copyMode },
});

test('workflow graph renders the closed WorkflowSpec v1 contract deterministically', () => {
  const first = compileSceneArtifactDraft(recipe('manual'), descriptor);
  const second = compileSceneArtifactDraft(recipe('manual'), descriptor);
  assert.deepEqual(first, second);
  assert.deepEqual(first.source.requestedCapabilities, []);
  assert.match(first.source.html, /data-sb-workflow-graph="v1"/u);
  assert.match(first.source.html, /data-workflow-open=/u);
  assert.match(first.source.html, /<span>start<\/span>/u);
  assert.doesNotMatch(
    first.source.html,
    /<span>(?:start|action|decision|parallel|join|human|subflow|end) · \d+%<\/span>/u,
  );
  assert.doesNotMatch(first.source.html, /\d+% confidence/u);
  assert.match(first.source.html, /<h4>Evidence<\/h4><p><strong>explicit<\/strong><\/p>/u);
  assert.doesNotMatch(first.source.html, /data-minimap/u);
  assert.doesNotMatch(first.source.html, /data-copy-manual/u);
  assert.doesNotMatch(first.source.html, /data-entry-port/u);
  assert.doesNotMatch(first.source.html, /data-exit-port/u);
  assert.match(
    first.source.html,
    /data-focus-selected[^>]*>Selected<\/button><button type="button" data-json-export>JSON export<\/button>/u,
  );
  assert.match(first.source.html, /data-json-modal hidden role="dialog"/u);
  assert.match(first.source.html, /aria-modal="true"/u);
  assert.match(first.source.html, /WorkflowSpec JSON export/u);
  assert.match(first.source.html, /conversion to LangGraph/u);
  assert.match(
    first.source.html,
    /<textarea readonly class="sb-graph-json-source" data-workflow-json/u,
  );
  assert.match(first.source.html, /data-json-select>Select all<\/button>/u);
  assert.doesNotMatch(first.source.html, /data-copy-host/u);
  assert.match(first.source.html, /role="region"/u);
  assert.match(first.source.css, /\.sb-graph-workspace\{position:relative;display:block;gap:0\}/u);
  assert.match(first.source.css, /\.sb-workflow-graph\{overflow:hidden\}/u);
  assert.match(
    first.source.css,
    /\.sb-graph-inspector\{position:absolute;z-index:30;top:0;right:0;bottom:0/u,
  );
  assert.match(
    first.source.css,
    /\.sb-graph-scroll\{position:relative;overflow:hidden;scrollbar-width:none/u,
  );
  assert.match(
    first.source.css,
    /\.sb-workflow-graph\{background-color:#07151f;background-image:/u,
  );
  assert.match(first.source.css, /\.sb-graph-inspector-backdrop\{display:none\}/u);
  assert.match(first.source.javascript, /Math\.min\(2,Math\.max\(\.1,next\)\)/u);
  assert.match(first.source.javascript, /const measureGraphBounds=/u);
  assert.match(
    first.source.javascript,
    /querySelectorAll\('\.sb-graph-node,\.sb-graph-edge,\.sb-graph-subflow-link'\)/u,
  );
  assert.doesNotMatch(first.source.javascript, /querySelectorAll\([^)]*\.sb-graph-port/u);
  assert.match(
    first.source.javascript,
    /querySelectorAll\('\.sb-graph-edge-layer,\.sb-graph-label-layer'\)/u,
  );
  assert.match(first.source.javascript, /svg\.getBBox\(\)/u);
  assert.match(
    first.source.javascript,
    /const widthScale=availableWidth\/bounds\.width,heightScale=availableHeight\/bounds\.height/u,
  );
  assert.match(first.source.javascript, /Math\.min\(widthScale,heightScale\)/u);
  assert.match(first.source.javascript, /let scale=1,panX=0,panY=0/u);
  assert.match(first.source.javascript, /canvas\.style\.transform='translate\('/u);
  assert.doesNotMatch(first.source.javascript, /scroll\.scrollLeft/u);
  assert.doesNotMatch(first.source.javascript, /syncMini/u);
  assert.match(first.source.javascript, /setPointerCapture/u);
  assert.match(first.source.javascript, /event\.pointerType==='touch'/u);
  assert.match(
    first.source.javascript,
    /const shouldCaptureWheel=event=>event\.ctrlKey\|\|event\.metaKey\|\|event\.shiftKey\|\|Math\.abs\(event\.deltaX\)>Math\.abs\(event\.deltaY\)/u,
  );
  assert.match(
    first.source.javascript,
    /if\(!shouldCaptureWheel\(event\)\)return;\s*event\.preventDefault\(\)/u,
  );
  assert.match(first.source.javascript, /new ResizeObserver/u);
  assert.match(first.source.html, /data-edge-label data-element-id=/u);
  const edgeLayer =
    first.source.html.match(/<svg class="sb-graph-edge-layer"[\s\S]*?<\/svg>/u)?.[0] ?? '';
  const labelLayer =
    first.source.html.match(/<svg class="sb-graph-label-layer"[\s\S]*?<\/svg>/u)?.[0] ?? '';
  assert.match(edgeLayer, /class="sb-graph-path sb-graph-edge-color-0"/u);
  assert.doesNotMatch(edgeLayer, /class="sb-graph-edge-label"/u);
  assert.match(
    labelLayer,
    /class="sb-graph-edge-label sb-graph-edge-color-1"[^>]*data-element-id="approval_edge_direct"/u,
  );
  assert.match(
    labelLayer,
    /class="sb-graph-edge-label sb-graph-edge-color-2"[^>]*data-element-id="approval_edge_human"/u,
  );
  assert.doesNotMatch(labelLayer, /class="sb-graph-path"/u);
  assert.match(
    edgeLayer,
    /class="sb-graph-path sb-graph-edge-color-0" data-element-id="approval_edge_complete"[^>]* d="M 663 238 Q 663 212 663 186"[^>]*marker-end="url\(#workflow-arrow-0-0\)"/u,
  );
  assert.match(
    edgeLayer,
    /class="sb-graph-path sb-graph-edge-color-3" data-element-id="approval_edge_start"[^>]* d="M 298 144 Q 327 144 356 144"[^>]*marker-end="url\(#workflow-arrow-0-3\)"/u,
  );
  assert.equal(edgeLayer.match(/class="sb-graph-marker sb-graph-edge-color-\d"/gu)?.length, 6);
  assert.match(
    first.source.css,
    /\.sb-graph-canvas \.sb-graph-path\{stroke:currentColor\}\.sb-graph-canvas \.sb-graph-marker\{fill:currentColor\}/u,
  );
  assert.match(
    first.source.css,
    /\.sb-graph-canvas \.sb-graph-edge-label rect\{stroke:currentColor\}/u,
  );
  for (const [index, color] of [
    [0, '#5eead4'],
    [1, '#7dd3fc'],
    [2, '#fcd34d'],
    [3, '#c4b5fd'],
    [4, '#fda4af'],
    [5, '#bef264'],
  ])
    assert.match(
      first.source.css,
      new RegExp(`\\.sb-graph-edge-color-${index}\\{color:${color}\\}`, 'u'),
    );
  assert.match(
    first.source.css,
    /\.sb-graph-canvas \.sb-graph-edge-layer\{z-index:1;pointer-events:none\}\.sb-graph-node\{z-index:2\}\.sb-graph-canvas \.sb-graph-label-layer\{z-index:3;pointer-events:none\}\.sb-workflow-graph \.sb-graph-edge\{z-index:4\}/u,
  );
  assert.doesNotMatch(first.source.css, /\.sb-graph-canvas svg\{z-index:/u);
  assert.match(first.source.css, /\.sb-graph-edge-label rect\{fill:#07151f;stroke:#2dd4bf66/u);
  assert.doesNotMatch(
    first.source.css,
    /\.sb-graph-edge-label rect\{fill:(?:rgba\([^}]+|#[0-9a-f]{8})/u,
  );
  assert.match(first.source.javascript, /const positionEdgeLabels=/u);
  assert.match(first.source.javascript, /node\.offsetTop\+node\.offsetHeight/u);
  assert.match(first.source.javascript, /nodeCollision\*1000\+labelCollision\*100/u);
  assert.match(
    first.source.javascript,
    /hitTarget\.style\.top=Math\.round\(bestY-hitTarget\.offsetHeight\/2\)/u,
  );
  assert.match(
    first.source.javascript,
    /document\.fonts\?\.ready\?\.then\(\(\)=>\{positionEdgePaths\(\);positionEdgeLabels\(\);scheduleInitialFit\(\)\}\)/u,
  );
  assert.match(first.source.javascript, /const positionEdgePaths=/u);
  assert.match(first.source.javascript, /from\.height\+gap/u);
  assert.match(first.source.javascript, /to\.height\+gap/u);
  assert.match(first.source.javascript, /const openJsonModal=/u);
  assert.match(first.source.javascript, /const closeJsonModal=/u);
  assert.match(first.source.javascript, /source\.focus\(\);source\.select\(\)/u);
  assert.match(first.source.javascript, /event\.key==='Escape'/u);
  assert.match(first.source.javascript, /event\.key!=='Tab'/u);
  assert.match(
    first.source.javascript,
    /event\.target\.closest\('input,textarea,select,option,\[contenteditable\]:not\(\[contenteditable="false"\]\),\.sb-graph-inspector'\)/u,
  );
  assert.match(
    first.source.javascript,
    /if\(event\.code==='Space'\)\{if\(event\.target\.closest\('button,a,summary,/u,
  );
  assert.doesNotMatch(first.source.javascript, /!event\.target\.closest\('\.sb-graph-scroll'\)/u);
  assert.doesNotMatch(first.source.javascript, /if\(event\.target\.closest\('button,a,input,/u);
  assert.doesNotMatch(
    first.source.html + first.source.css + first.source.javascript,
    /https?:\/\//u,
  );
});

test('workflow graph rendering is invariant to valid node and edge input order', () => {
  const reordered = structuredClone(workflowSpec);
  reordered.nodes.reverse();
  reordered.edges.reverse();
  assert.deepEqual(
    compileSceneArtifactDraft(recipe('manual', reordered), descriptor),
    compileSceneArtifactDraft(recipe('manual'), descriptor),
  );
});

test('host-copy failures keep the JSON modal open and select the canonical source', () => {
  const compiled = compileSceneArtifactDraft(recipe('clipboard'), descriptor);
  assert.match(
    compiled.source.html,
    /<textarea readonly class="sb-graph-json-source" data-workflow-json/u,
  );
  assert.match(compiled.source.html, /data-copy-host>Copy JSON<\/button>/u);
  assert.match(compiled.source.javascript, /source\.select\(\)/u);
  assert.match(
    compiled.source.javascript,
    /Clipboard copy was denied or unavailable\. Canonical JSON selected\./u,
  );
  assert.match(compiled.source.javascript, /No clipboard result arrived\./u);
});

test('root and subflows render as drill-down groups', async () => {
  const groupedSpec = JSON.parse(
    await readFile(resolve(root, 'assets/workflow-spec-examples/parallel-retry.json'), 'utf8'),
  );
  const grouped = compileSceneArtifactDraft(recipe('manual', groupedSpec), descriptor);
  const expectedGroups = 1 + groupedSpec.subflows.length;
  const overview =
    grouped.source.html.match(/<nav class="sb-graph-overview"[\s\S]*?<\/nav>/u)?.[0] ?? '';
  assert.equal(grouped.source.html.match(/data-workflow-flow=/gu)?.length, expectedGroups);
  assert.equal(overview.match(/data-flow-target=/gu)?.length, expectedGroups);
  assert.match(grouped.source.html, /aria-label="Workflow groups"/u);
  assert.match(
    grouped.source.css,
    /\.sb-graph-overview\{height:100vh;max-width:none;margin:0;padding:20px;overflow:auto;align-content:start;grid-auto-rows:max-content\}/u,
  );
  assert.match(grouped.source.html, /aria-label="Breadcrumb"/u);
  assert.match(grouped.source.html, /data-parent-flow=/u);
  assert.match(grouped.source.html, /data-entry-port/u);
  assert.match(grouped.source.html, /data-exit-port/u);
  assert.match(
    grouped.source.html,
    /<\/div><\/div><span class="sb-graph-port sb-graph-port-entry"/u,
  );
});

test('valid specs beyond the 32-node preview envelope retain canonical source', () => {
  const large = structuredClone(workflowSpec);
  large.unresolvedQuestions = [];
  large.warnings = [];
  const evidence = structuredClone(large.nodes[0].evidence);
  const node = (index) => ({
    ...structuredClone(large.nodes[0]),
    id: `large_node_${String(index).padStart(2, '0')}`,
    kind: index === 0 ? 'start' : index === 32 ? 'end' : 'action',
    label: `Node ${index}`,
    evidence,
  });
  large.entryNodeIds = ['large_node_00'];
  large.exitNodeIds = ['large_node_32'];
  large.nodes = Array.from({ length: 33 }, (_, index) => node(index));
  large.edges = Array.from({ length: 32 }, (_, index) => ({
    ...structuredClone(workflowSpec.edges[0]),
    id: `large_edge_${String(index).padStart(2, '0')}`,
    kind: 'normal',
    fromNodeId: `large_node_${String(index).padStart(2, '0')}`,
    toNodeId: `large_node_${String(index + 1).padStart(2, '0')}`,
    condition: null,
    evidence,
  }));
  const compiled = compileSceneArtifactDraft(recipe('manual', large), descriptor);
  assert.match(compiled.source.html, /data-render-limit-exceeded/u);
  assert.match(compiled.source.html, /33 nodes, 32 edges/u);
  assert.match(compiled.source.html, /data-workflow-json/u);
  assert.doesNotMatch(compiled.source.html, /data-workflow-flow=/u);
});

test('canonical byte limits select interactive rendering without rejecting valid export', () => {
  const padded = (minimumBytes) => {
    const value = structuredClone(workflowSpec);
    let index = 0;
    while (Buffer.byteLength(canonicalizeWorkflowSpec(value), 'utf8') < minimumBytes) {
      const target = value.nodes[index % value.nodes.length];
      target.instructions.push(`instruction-${index}-${'x'.repeat(700)}`);
      index += 1;
    }
    return value;
  };
  const below = padded(31_500);
  const above = padded(33_000);
  assert.ok(Buffer.byteLength(canonicalizeWorkflowSpec(below), 'utf8') <= 32_768);
  assert.ok(Buffer.byteLength(canonicalizeWorkflowSpec(above), 'utf8') > 32_768);
  const rendered = compileSceneArtifactDraft(recipe('manual', below), descriptor);
  const exported = compileSceneArtifactDraft(recipe('manual', above), descriptor);
  assert.doesNotMatch(rendered.source.html, /data-render-limit-exceeded/u);
  assert.match(exported.source.html, /data-render-limit-exceeded/u);
  assert.match(exported.source.html, /32768 canonical bytes/u);
  assert.match(exported.source.html, /data-workflow-json/u);
});

test('parallel self-retry edges receive distinct deterministic loop geometry', () => {
  const selfRetry = structuredClone(workflowSpec);
  const human = selfRetry.nodes.find(({ kind }) => kind === 'human');
  const evidence = structuredClone(selfRetry.edges[0].evidence);
  selfRetry.edges.push(
    {
      id: 'approval_retry_first',
      kind: 'retry',
      fromNodeId: human.id,
      toNodeId: human.id,
      label: 'retry one',
      condition: null,
      priority: null,
      stateKeys: [],
      evidence,
    },
    {
      id: 'approval_retry_second',
      kind: 'retry',
      fromNodeId: human.id,
      toNodeId: human.id,
      label: 'retry two',
      condition: null,
      priority: null,
      stateKeys: [],
      evidence,
    },
  );
  const compiled = compileSceneArtifactDraft(recipe('manual', selfRetry), descriptor);
  const paths = [
    ...compiled.source.html.matchAll(
      /data-element-id="approval_retry_(?:first|second)"[^>]*data-lane-offset="(\d+)" d="([^"]+)"/gu,
    ),
  ];
  assert.equal(paths.length, 2);
  assert.deepEqual(
    paths.map((match) => Number(match[1])),
    [64, 100],
  );
  assert.notEqual(paths[0][2], paths[1][2]);
  assert.match(compiled.source.javascript, /if\(fromId===toId\)/u);
});

test('artifact parser rejects duplicate members inside embedded WorkflowSpec', () => {
  const canonical = JSON.stringify(recipe('manual'));
  const duplicated = canonical.replace(
    '"summary":"Request human approval when required."',
    '"summary":"Request human approval when required.","summary":"duplicate"',
  );
  assert.throws(() => parseSceneArtifactRecipeJson(Buffer.from(duplicated)));
});

test('all host variants request clipboard only and manual mode requests nothing', () => {
  const manual = compileSceneArtifactDraft(recipe('manual'), descriptor);
  const clipboard = compileSceneArtifactDraft(recipe('clipboard'), descriptor);
  const exported = compileSceneArtifactDraft(recipe('export'), descriptor);
  assert.deepEqual(manual.source.requestedCapabilities, []);
  assert.deepEqual(clipboard.source.requestedCapabilities, ['clipboard.write']);
  assert.deepEqual(exported.source.requestedCapabilities, ['clipboard.write']);
  assert.doesNotMatch(manual.source.html, /data-copy-manual/u);
  assert.match(manual.source.html, /data-json-export>JSON export<\/button>/u);
  assert.match(manual.source.html, /data-json-select>Select all<\/button>/u);
  assert.doesNotMatch(manual.source.html, /data-copy-host/u);
  assert.match(clipboard.source.html, /data-copy-host/u);
  assert.match(exported.source.html, /data-copy-host/u);
  assert.doesNotMatch(exported.source.html, /data-download-host/u);
  assert.doesNotMatch(exported.source.javascript, /requestCapability\(id,'download'/u);
});

test('invalid copy modes and cross-flow references fail before rendering', () => {
  assert.throws(() => compileSceneArtifactDraft(recipe('download'), descriptor));
  const invalid = structuredClone(workflowSpec);
  invalid.edges[0].toNodeId = 'missing_node';
  assert.throws(() => compileSceneArtifactDraft(recipe('manual', invalid), descriptor));
});
