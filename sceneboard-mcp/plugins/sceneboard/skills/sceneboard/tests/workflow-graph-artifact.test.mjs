import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  compileSceneArtifactDraft,
  validateSceneArtifactTemplateDescriptor,
} from "../scripts/scene-artifact-core.mjs";

const root = resolve(import.meta.dirname, "..");
const workflowSpec = JSON.parse(
  await readFile(
    resolve(root, "assets/workflow-spec-examples/conditional-hitl.json"),
    "utf8",
  ),
);
const descriptor = validateSceneArtifactTemplateDescriptor(
  JSON.parse(
    await readFile(
      resolve(root, "assets/artifact-templates/workflow-graph.json"),
      "utf8",
    ),
  ),
);
const recipe = (copyMode, spec = workflowSpec) => ({
  artifactRecipeVersion: 1,
  template: "workflow-graph",
  placementKey: "approval-workflow",
  title: "Approval workflow",
  fallbackText: "Inspect the canonical WorkflowSpec JSON.",
  theme: "dark",
  size: { width: 1280, height: 800 },
  motion: "subtle",
  content: { workflowSpec: spec, copyMode },
});

test("workflow graph renders the closed WorkflowSpec v1 contract deterministically", () => {
  const first = compileSceneArtifactDraft(recipe("manual"), descriptor);
  const second = compileSceneArtifactDraft(recipe("manual"), descriptor);
  assert.deepEqual(first, second);
  assert.deepEqual(first.source.requestedCapabilities, []);
  assert.match(first.source.html, /data-sb-workflow-graph="v1"/u);
  assert.match(first.source.html, /data-workflow-open=/u);
  assert.doesNotMatch(first.source.html, /data-minimap/u);
  assert.doesNotMatch(first.source.html, /WorkflowSpec export/u);
  assert.doesNotMatch(first.source.html, /data-copy-manual/u);
  assert.doesNotMatch(first.source.html, /data-entry-port/u);
  assert.doesNotMatch(first.source.html, /data-exit-port/u);
  assert.match(
    first.source.html,
    /readonly hidden class="sb-graph-export-source"/u,
  );
  assert.match(first.source.html, /role="region"/u);
  assert.doesNotMatch(first.source.html, /aria-modal="true"/u);
  assert.match(
    first.source.css,
    /\.sb-graph-workspace\{position:relative;display:block;gap:0\}/u,
  );
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
  assert.match(
    first.source.css,
    /\.sb-graph-inspector-backdrop\{display:none\}/u,
  );
  assert.match(
    first.source.javascript,
    /Math\.min\(2,Math\.max\(\.1,next\)\)/u,
  );
  assert.match(first.source.javascript, /const measureGraphBounds=/u);
  assert.match(
    first.source.javascript,
    /querySelectorAll\('\.sb-graph-node,\.sb-graph-edge,\.sb-graph-subflow-link'\)/u,
  );
  assert.doesNotMatch(
    first.source.javascript,
    /querySelectorAll\([^)]*\.sb-graph-port/u,
  );
  assert.match(first.source.javascript, /svg\.getBBox\(\)/u);
  assert.match(
    first.source.javascript,
    /const widthScale=availableWidth\/bounds\.width,heightScale=availableHeight\/bounds\.height/u,
  );
  assert.match(first.source.javascript, /Math\.min\(widthScale,heightScale\)/u);
  assert.match(first.source.javascript, /let scale=1,panX=0,panY=0/u);
  assert.match(
    first.source.javascript,
    /canvas\.style\.transform='translate\('/u,
  );
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
  assert.doesNotMatch(
    first.source.html + first.source.css + first.source.javascript,
    /https?:\/\//u,
  );
});

test("workflow graph rendering is invariant to valid node and edge input order", () => {
  const reordered = structuredClone(workflowSpec);
  reordered.nodes.reverse();
  reordered.edges.reverse();
  assert.deepEqual(
    compileSceneArtifactDraft(recipe("manual", reordered), descriptor),
    compileSceneArtifactDraft(recipe("manual"), descriptor),
  );
});

test("host-copy failures stay out of the visible graph layout", () => {
  const compiled = compileSceneArtifactDraft(recipe("clipboard"), descriptor);
  assert.match(
    compiled.source.html,
    /readonly hidden class="sb-graph-export-source"/u,
  );
  assert.doesNotMatch(compiled.source.javascript, /source\.hidden=false/u);
  assert.doesNotMatch(compiled.source.javascript, /source\.select\(\)/u);
  assert.doesNotMatch(compiled.source.html, /WorkflowSpec export/u);
  assert.match(compiled.source.javascript, /No clipboard result arrived\./u);
});

test("root and subflows render as drill-down groups", async () => {
  const groupedSpec = JSON.parse(
    await readFile(
      resolve(root, "assets/workflow-spec-examples/parallel-retry.json"),
      "utf8",
    ),
  );
  const grouped = compileSceneArtifactDraft(
    recipe("manual", groupedSpec),
    descriptor,
  );
  const expectedGroups = 1 + groupedSpec.subflows.length;
  assert.equal(
    grouped.source.html.match(/data-workflow-flow=/gu)?.length,
    expectedGroups,
  );
  assert.match(grouped.source.html, /aria-label="Workflow groups"/u);
  assert.match(grouped.source.html, /aria-label="Breadcrumb"/u);
  assert.match(grouped.source.html, /data-parent-flow=/u);
  assert.match(grouped.source.html, /data-entry-port/u);
  assert.match(grouped.source.html, /data-exit-port/u);
  assert.match(
    grouped.source.html,
    /<\/div><\/div><span class="sb-graph-port sb-graph-port-entry"/u,
  );
});

test("valid specs beyond the 32-node preview envelope retain canonical source", () => {
  const large = structuredClone(workflowSpec);
  large.unresolvedQuestions = [];
  large.warnings = [];
  const evidence = structuredClone(large.nodes[0].evidence);
  const node = (index) => ({
    ...structuredClone(large.nodes[0]),
    id: `large_node_${String(index).padStart(2, "0")}`,
    kind: index === 0 ? "start" : index === 32 ? "end" : "action",
    label: `Node ${index}`,
    evidence,
  });
  large.entryNodeIds = ["large_node_00"];
  large.exitNodeIds = ["large_node_32"];
  large.nodes = Array.from({ length: 33 }, (_, index) => node(index));
  large.edges = Array.from({ length: 32 }, (_, index) => ({
    ...structuredClone(workflowSpec.edges[0]),
    id: `large_edge_${String(index).padStart(2, "0")}`,
    kind: "normal",
    fromNodeId: `large_node_${String(index).padStart(2, "0")}`,
    toNodeId: `large_node_${String(index + 1).padStart(2, "0")}`,
    condition: null,
    evidence,
  }));
  const compiled = compileSceneArtifactDraft(
    recipe("manual", large),
    descriptor,
  );
  assert.match(compiled.source.html, /data-render-limit-exceeded/u);
  assert.match(compiled.source.html, /33 nodes and 32 edges/u);
  assert.match(compiled.source.html, /data-workflow-json/u);
  assert.doesNotMatch(compiled.source.html, /data-workflow-flow=/u);
});

test("all host variants request clipboard only and manual mode requests nothing", () => {
  const manual = compileSceneArtifactDraft(recipe("manual"), descriptor);
  const clipboard = compileSceneArtifactDraft(recipe("clipboard"), descriptor);
  const exported = compileSceneArtifactDraft(recipe("export"), descriptor);
  assert.deepEqual(manual.source.requestedCapabilities, []);
  assert.deepEqual(clipboard.source.requestedCapabilities, ["clipboard.write"]);
  assert.deepEqual(exported.source.requestedCapabilities, ["clipboard.write"]);
  assert.doesNotMatch(manual.source.html, /data-copy-manual/u);
  assert.match(clipboard.source.html, /data-copy-host/u);
  assert.match(exported.source.html, /data-copy-host/u);
  assert.doesNotMatch(exported.source.html, /data-download-host/u);
  assert.doesNotMatch(
    exported.source.javascript,
    /requestCapability\(id,'download'/u,
  );
});

test("invalid copy modes and cross-flow references fail before rendering", () => {
  assert.throws(() =>
    compileSceneArtifactDraft(recipe("download"), descriptor),
  );
  const invalid = structuredClone(workflowSpec);
  invalid.edges[0].toNodeId = "missing_node";
  assert.throws(() =>
    compileSceneArtifactDraft(recipe("manual", invalid), descriptor),
  );
});
