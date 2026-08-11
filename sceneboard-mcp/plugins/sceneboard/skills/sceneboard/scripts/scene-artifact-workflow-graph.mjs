import {
  canonicalizeWorkflowSpec,
  validateWorkflowSpec,
} from "./workflow-spec-core.mjs";

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const WORKFLOW_GRAPH_RENDER_LIMITS = Object.freeze({ nodes: 32, edges: 64 });
const GRAPH_LAYOUT = Object.freeze({
  nodeWidth: 150,
  nodeHeight: 68,
  rankGap: 224,
  rowGap: 136,
  paddingX: 140,
  paddingY: 110,
});
const compareIds = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const flowRelationship = (flow, flows) => {
  const outgoing = flow.nodes
    .filter((node) => node.kind === "subflow")
    .map((node) => flows.find((candidate) => candidate.id === node.subflowId))
    .filter(Boolean);
  const parents = flows.filter((candidate) =>
    candidate.nodes.some(
      (node) => node.kind === "subflow" && node.subflowId === flow.id,
    ),
  );
  return { outgoing, parents };
};

const layoutFlow = (flow) => {
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const outgoing = new Map(flow.nodes.map((node) => [node.id, []]));
  for (const edge of flow.edges) outgoing.get(edge.fromNodeId).push(edge);
  for (const edges of outgoing.values())
    edges.sort((left, right) => compareIds(left.id, right.id));
  const ranks = new Map(flow.entryNodeIds.map((nodeId) => [nodeId, 0]));
  const queue = [...flow.entryNodeIds];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const edge of outgoing.get(current)) {
      if (ranks.has(edge.toNodeId)) continue;
      ranks.set(edge.toNodeId, ranks.get(current) + 1);
      queue.push(edge.toNodeId);
    }
  }
  const unreachable = [...nodes.keys()]
    .filter((nodeId) => !ranks.has(nodeId))
    .sort();
  const finalRank = Math.max(0, ...ranks.values()) + 1;
  unreachable.forEach((nodeId, index) =>
    ranks.set(nodeId, finalRank + Math.floor(index / 3)),
  );
  const groups = new Map();
  for (const node of [...flow.nodes].sort((left, right) =>
    compareIds(left.id, right.id),
  )) {
    const rank = ranks.get(node.id);
    const group = groups.get(rank) ?? [];
    group.push(node);
    groups.set(rank, group);
  }
  const positions = new Map();
  for (const [rank, group] of [...groups].sort(
    ([left], [right]) => left - right,
  ))
    group.forEach((node, index) =>
      positions.set(node.id, {
        x: GRAPH_LAYOUT.paddingX + rank * GRAPH_LAYOUT.rankGap,
        y: GRAPH_LAYOUT.paddingY + index * GRAPH_LAYOUT.rowGap,
      }),
    );
  const width = Math.max(
    640,
    GRAPH_LAYOUT.paddingX * 2 +
      Math.max(...ranks.values()) * GRAPH_LAYOUT.rankGap +
      GRAPH_LAYOUT.nodeWidth,
  );
  const height = Math.max(
    360,
    ...[...groups.values()].map(
      (group) =>
        GRAPH_LAYOUT.paddingY * 2 +
        (group.length - 1) * GRAPH_LAYOUT.rowGap +
        GRAPH_LAYOUT.nodeHeight,
    ),
  );
  return { positions, width, height, unreachable: new Set(unreachable) };
};

const edgeLabelText = (edge) => {
  const raw = String(edge.label ?? edge.condition?.text ?? "");
  const characters = Array.from(raw);
  return characters.length > 24 ? `${characters.slice(0, 23).join("")}…` : raw;
};

const edgeLabelWidth = (label) =>
  Math.min(
    176,
    Math.max(
      36,
      Array.from(label).reduce(
        (width, character) => width + (character.codePointAt(0) > 127 ? 12 : 7),
        18,
      ),
    ),
  );

const layoutEdges = (flow, layout) => {
  const pairGroups = new Map();
  for (const edge of flow.edges) {
    const pair = [edge.fromNodeId, edge.toNodeId].sort(compareIds);
    const key = pair.join("\u0000");
    const group = pairGroups.get(key) ?? { pair, edges: [] };
    group.edges.push(edge);
    pairGroups.set(key, group);
  }
  const geometries = new Map();
  for (const { pair, edges } of pairGroups.values()) {
    edges.sort((left, right) => compareIds(left.id, right.id));
    const first = layout.positions.get(pair[0]);
    const second = layout.positions.get(pair[1]);
    const canonicalDx = second.x - first.x;
    const canonicalDy = second.y - first.y;
    const canonicalLength = Math.hypot(canonicalDx, canonicalDy) || 1;
    const normal = {
      x: -canonicalDy / canonicalLength,
      y: canonicalDx / canonicalLength,
    };
    edges.forEach((edge, laneIndex) => {
      const from = layout.positions.get(edge.fromNodeId);
      const to = layout.positions.get(edge.toNodeId);
      const forward = to.x >= from.x;
      const start = {
        x: forward ? from.x + GRAPH_LAYOUT.nodeWidth : from.x,
        y: from.y + GRAPH_LAYOUT.nodeHeight / 2,
      };
      const end = {
        x: forward ? to.x : to.x + GRAPH_LAYOUT.nodeWidth,
        y: to.y + GRAPH_LAYOUT.nodeHeight / 2,
      };
      const laneOffset =
        edges.length === 1 ? 0 : (laneIndex - (edges.length - 1) / 2) * 104;
      const control = {
        x: (start.x + end.x) / 2 + normal.x * laneOffset,
        y: (start.y + end.y) / 2 + normal.y * laneOffset,
      };
      const midpoint = {
        x: (start.x + 2 * control.x + end.x) / 4,
        y: (start.y + 2 * control.y + end.y) / 4,
      };
      const label = edgeLabelText(edge);
      geometries.set(edge.id, {
        control,
        end,
        label,
        labelWidth: edgeLabelWidth(label),
        labelX: midpoint.x,
        labelY: midpoint.y - 15,
        start,
      });
    });
  }
  return geometries;
};

const evidenceMarkup = (evidence) => {
  if (!evidence) return "<p>No source evidence was recorded.</p>";
  const refs = evidence.sourceRefs
    .map(
      (item) =>
        `<li>${escapeHtml(item.sourceId)}${item.locator == null ? "" : ` · ${escapeHtml(item.locator)}`}${item.startLine == null ? "" : ` · lines ${item.startLine}–${item.endLine}`}</li>`,
    )
    .join("");
  return `<p><strong>${escapeHtml(evidence.basis)}</strong> · ${Math.round(evidence.confidence * 100)}% confidence</p>${refs === "" ? "<p>No source references were recorded.</p>" : `<ul>${refs}</ul>`}`;
};

const detailSection = (kind, element) => {
  const rows = Object.entries(element)
    .filter(([key]) => !["id", "evidence"].includes(key))
    .map(([key, value]) => {
      const rendered = Array.isArray(value)
        ? value.join("\n")
        : typeof value === "object"
          ? JSON.stringify(value)
          : value;
      return `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(rendered ?? "—")}</dd>`;
    })
    .join("");
  return `<section id="workflow-detail-${escapeHtml(element.id)}" data-workflow-detail hidden><p class="sb-graph-kind">${escapeHtml(kind)}</p><h3>${escapeHtml(element.label ?? element.title ?? element.id)}</h3><dl>${rows}</dl><h4>Evidence</h4>${evidenceMarkup(element.evidence ?? [])}</section>`;
};

const renderFlow = (flow, index, flows, hasMultipleFlows, exportControls) => {
  const layout = layoutFlow(flow);
  const relationship = flowRelationship(flow, flows);
  const edgeGeometries = layoutEdges(flow, layout);
  const edgeLines = flow.edges
    .map((edge) => {
      const geometry = edgeGeometries.get(edge.id);
      const label = geometry.label
        ? `<g class="sb-graph-edge-label"><rect x="${Math.round(geometry.labelX - geometry.labelWidth / 2)}" y="${Math.round(geometry.labelY - 12)}" width="${geometry.labelWidth}" height="24" rx="7"/><text x="${Math.round(geometry.labelX)}" y="${Math.round(geometry.labelY)}">${escapeHtml(geometry.label)}</text></g>`
        : "";
      return `<path class="sb-graph-path" d="M ${Math.round(geometry.start.x)} ${Math.round(geometry.start.y)} Q ${Math.round(geometry.control.x)} ${Math.round(geometry.control.y)} ${Math.round(geometry.end.x)} ${Math.round(geometry.end.y)}" marker-end="url(#workflow-arrow)"/>${label}`;
    })
    .join("");
  const edgeButtons = flow.edges
    .map((edge) => {
      const geometry = edgeGeometries.get(edge.id);
      const hitWidth = Math.max(44, geometry.labelWidth);
      const left = Math.round(geometry.labelX - hitWidth / 2);
      const top = Math.round(geometry.labelY) - 15;
      return `<button type="button" class="sb-graph-edge" style="left:${left}px;top:${top}px;width:${hitWidth}px" data-element-id="${escapeHtml(edge.id)}" data-workflow-open="workflow-detail-${escapeHtml(edge.id)}" aria-label="Open edge details: ${escapeHtml(edge.label ?? edge.id)}"></button>`;
    })
    .join("");
  const nodeButtons = flow.nodes
    .map((node) => {
      const position = layout.positions.get(node.id);
      const state = layout.unreachable.has(node.id)
        ? ' data-unreachable="true"'
        : "";
      return `<button type="button" class="sb-graph-node" style="left:${position.x}px;top:${position.y}px" data-kind="${escapeHtml(node.kind)}" data-element-id="${escapeHtml(node.id)}" data-workflow-open="workflow-detail-${escapeHtml(node.id)}"${state}><strong>${escapeHtml(node.label)}</strong><span>${escapeHtml(node.kind)} · ${Math.round(node.evidence.confidence * 100)}%</span></button>`;
    })
    .join("");
  const details = [
    ...flow.nodes.map((node) => detailSection("Node", node)),
    ...flow.edges.map((edge) => detailSection("Edge", edge)),
  ].join("");
  const entryContext =
    relationship.parents.length === 0
      ? "Workflow start"
      : `From ${relationship.parents.map((parent) => parent.title).join(", ")}`;
  const exitContext =
    relationship.parents.length === 0
      ? "Workflow completion"
      : `Return to ${relationship.parents.map((parent) => parent.title).join(", ")}`;
  const subflowLinks = flow.nodes
    .filter((node) => node.kind === "subflow")
    .map((node, linkIndex) => {
      const targetIndex = flows.findIndex(
        (candidate) => candidate.id === node.subflowId,
      );
      return targetIndex < 0
        ? ""
        : `<button type="button" class="sb-graph-subflow-link" style="top:${14 + linkIndex * 42}px" data-flow-target="${targetIndex}" data-parent-flow="${index}">Open ${escapeHtml(node.label)}</button>`;
    })
    .join("");
  const breadcrumb = hasMultipleFlows
    ? `<nav aria-label="Breadcrumb"><button type="button" data-flow-overview>Entire flow</button><span aria-hidden="true">/</span><span>${escapeHtml(flow.title)}</span></nav>`
    : "";
  const flowPorts = hasMultipleFlows
    ? `<span class="sb-graph-port sb-graph-port-entry" data-entry-port>${escapeHtml(entryContext)} · ${escapeHtml(flow.entryNodeIds.join(", "))}</span><span class="sb-graph-port sb-graph-port-exit" data-exit-port>${escapeHtml(exitContext)} · ${escapeHtml(flow.exitNodeIds.join(", "))}</span>`
    : "";
  return `<section class="sb-graph-flow" data-workflow-flow="${index}" data-flow-id="${escapeHtml(flow.id)}" data-flow-title="${escapeHtml(flow.title)}"${index === 0 ? "" : " hidden"} aria-labelledby="workflow-flow-${index}"><header>${breadcrumb}<div class="sb-graph-title"><div><p>Flow ${index + 1}</p><h2 id="workflow-flow-${index}" tabindex="-1">${escapeHtml(flow.title)}</h2></div><div class="sb-graph-view-actions" aria-label="Graph viewport controls"><button type="button" data-zoom-out aria-label="Zoom out" aria-keyshortcuts="-">−</button><output data-zoom-output>100%</output><button type="button" data-zoom-in aria-label="Zoom in" aria-keyshortcuts="+">+</button><button type="button" data-reset-zoom aria-keyshortcuts="0">100%</button><button type="button" data-fit aria-keyshortcuts="F">Fit</button><button type="button" data-focus-selected aria-keyshortcuts="S">Selected</button>${exportControls}</div></div><p class="sb-graph-shortcuts">Shortcuts: +/− zoom · 0 reset · F fit · S selected</p></header><div class="sb-graph-workspace"><div class="sb-graph-stage-wrap"><div class="sb-graph-scroll" tabindex="0" aria-label="Interactive workflow graph; use viewport controls, touch, middle drag, or Space plus drag"><div class="sb-graph-scale-box" style="width:${layout.width}px;height:${layout.height}px" data-base-width="${layout.width}" data-base-height="${layout.height}"><div class="sb-graph-canvas" style="width:${layout.width}px;height:${layout.height}px"><svg viewBox="0 0 ${layout.width} ${layout.height}" aria-hidden="true"><defs><marker id="workflow-arrow-${index}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>${edgeLines.replaceAll("url(#workflow-arrow)", `url(#workflow-arrow-${index})`)}</svg>${edgeButtons}${nodeButtons}${subflowLinks}</div></div>${flowPorts}</div></div><button type="button" class="sb-graph-inspector-backdrop" data-detail-backdrop hidden aria-label="Close details"></button><aside class="sb-graph-inspector" data-detail-panel hidden role="region" aria-labelledby="workflow-inspector-title-${index}"><button type="button" class="sb-graph-sheet-handle" data-sheet-handle aria-label="Drag down or activate to close details"><span></span></button><header><h2 id="workflow-inspector-title-${index}">Details</h2><button type="button" data-detail-close aria-label="Close details">Close</button></header><div data-detail-body></div></aside></div>${details}</section>`;
};

export const WORKFLOW_GRAPH_PROGRAM = `(()=>{const root=document.querySelector('[data-sb-workflow-graph="v1"]');if(!root)return;const status=root.querySelector('[data-copy-status]'),source=root.querySelector('[data-workflow-json]'),manual=root.querySelector('[data-copy-manual]'),hostCopy=root.querySelector('[data-copy-host]'),overview=root.querySelector('[data-flow-overview-list]');if(!source||!manual||!overview)return;let opener=null,pending=null,timer=null,unsubscribe=null;const select=message=>{source.focus();source.select();if(status)status.textContent=message};const showFlow=index=>{root.querySelectorAll('[data-workflow-flow]').forEach(flow=>flow.hidden=flow.getAttribute('data-workflow-flow')!==index);const flow=root.querySelector('[data-workflow-flow="'+CSS.escape(index)+'"]');if(flow){flow.querySelector('h2')?.focus?.();flow.scrollIntoView({block:'start'})}};root.querySelectorAll('[data-flow-target]').forEach(button=>button.addEventListener('click',()=>showFlow(button.getAttribute('data-flow-target')||'0')));root.querySelectorAll('[data-flow-overview]').forEach(button=>button.addEventListener('click',()=>{overview.scrollIntoView({block:'start'});overview.querySelector('button')?.focus()}));const closePanel=panel=>{panel.hidden=true;panel.querySelector('[data-detail-body]').replaceChildren();if(opener){opener.focus();opener=null}};root.querySelectorAll('[data-workflow-flow]').forEach(flow=>{const panel=flow.querySelector('[data-detail-panel]'),body=flow.querySelector('[data-detail-body]'),close=flow.querySelector('[data-detail-close]'),scroll=flow.querySelector('.sb-graph-scroll'),box=flow.querySelector('.sb-graph-scale-box'),canvas=flow.querySelector('.sb-graph-canvas'),output=flow.querySelector('[data-zoom-output]'),viewport=flow.querySelector('[data-minimap-viewport]'),minimap=flow.querySelector('[data-minimap]');if(!panel||!body||!close||!scroll||!box||!canvas||!output||!viewport||!minimap)return;let scale=1;const width=Number(box.dataset.baseWidth),height=Number(box.dataset.baseHeight);const syncMini=()=>{const x=scroll.scrollWidth<=scroll.clientWidth?0:scroll.scrollLeft/scroll.scrollWidth*100,y=scroll.scrollHeight<=scroll.clientHeight?0:scroll.scrollTop/scroll.scrollHeight*100,w=Math.min(100,scroll.clientWidth/scroll.scrollWidth*100),h=Math.min(100,scroll.clientHeight/scroll.scrollHeight*100);Object.assign(viewport.style,{left:x+'%',top:y+'%',width:w+'%',height:h+'%'})};const apply=next=>{scale=Math.min(2,Math.max(.5,next));canvas.style.transform='scale('+scale+')';box.style.width=Math.round(width*scale)+'px';box.style.height=Math.round(height*scale)+'px';output.textContent=Math.round(scale*100)+'%';syncMini()};flow.querySelector('[data-zoom-out]').addEventListener('click',()=>apply(scale-.1));flow.querySelector('[data-zoom-in]').addEventListener('click',()=>apply(scale+.1));flow.querySelector('[data-fit]').addEventListener('click',()=>{apply(Math.min(1,scroll.clientWidth/width,scroll.clientHeight/height));scroll.scrollTo({left:0,top:0})});scroll.addEventListener('scroll',syncMini,{passive:true});minimap.addEventListener('click',event=>{const rect=minimap.getBoundingClientRect();scroll.scrollTo({left:Math.max(0,(event.clientX-rect.left)/rect.width*scroll.scrollWidth-scroll.clientWidth/2),top:Math.max(0,(event.clientY-rect.top)/rect.height*scroll.scrollHeight-scroll.clientHeight/2),behavior:'smooth'})});flow.querySelectorAll('[data-workflow-open]').forEach(button=>button.addEventListener('click',()=>{const target=flow.querySelector('#'+CSS.escape(button.getAttribute('data-workflow-open')||''));if(!target)return;opener=button;body.replaceChildren(target.cloneNode(true));body.firstElementChild.hidden=false;panel.hidden=false;close.focus()}));close.addEventListener('click',()=>closePanel(panel));flow.addEventListener('keydown',event=>{if(event.key==='Escape'&&!panel.hidden){event.preventDefault();closePanel(panel)}});apply(1)});manual.addEventListener('click',()=>select('Canonical WorkflowSpec JSON selected.'));if(hostCopy)hostCopy.addEventListener('click',()=>{const api=window.SceneBoardArtifact;if(!api||!api.userAction||!api.requestCapability||!api.onHostMessage){select('Host copy is unavailable. Canonical JSON selected.');return}const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);const id=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');pending=id;if(unsubscribe)unsubscribe();unsubscribe=api.onHostMessage(message=>{if(message.type!=='host.capability.result'||message.requestId!==pending||message.capability!=='clipboard.write')return;pending=null;if(timer)clearTimeout(timer);if(unsubscribe)unsubscribe();unsubscribe=null;if(message.ok){if(status)status.textContent='Canonical WorkflowSpec JSON copied.'}else select('Copy was denied or unavailable. Canonical JSON selected.')});api.userAction(id,'clipboard.write');api.requestCapability(id,'clipboard.write',{text:source.value});timer=setTimeout(()=>{if(pending===id){pending=null;if(unsubscribe)unsubscribe();unsubscribe=null;select('No copy result arrived. Canonical JSON selected.')}},5500)});if(window.SceneBoardArtifact&&window.SceneBoardArtifact.requestResize)window.SceneBoardArtifact.requestResize(1280,800)})()`;

export const WORKFLOW_GRAPH_PROGRAM_V2 = `(()=>{
  const root=document.querySelector('[data-sb-workflow-graph="v1"]');
  if(!root)return;
  const status=root.querySelector('[data-copy-status]');
  const source=root.querySelector('[data-workflow-json]');
  const hostCopy=[...root.querySelectorAll('[data-copy-host]')];
  const overview=root.querySelector('[data-flow-overview-list]');
  if(!source)return;
  let opener=null,pending=null,timer=null,unsubscribe=null,currentFlow=null;
  const controllers=new Map(),viewState=new Map();
  const reportCopyFailure=message=>{if(status)status.textContent=message};
  const snapshotCurrent=()=>{if(currentFlow!==null)controllers.get(currentFlow)?.snapshot()};
  const showFlow=index=>{
    snapshotCurrent();
    root.querySelectorAll('[data-workflow-flow]').forEach(flow=>flow.hidden=true);
    if(overview)overview.hidden=true;
    const flow=root.querySelector('[data-workflow-flow="'+CSS.escape(index)+'"]');
    if(!flow)return;
    flow.hidden=false;currentFlow=index;
    controllers.get(index)?.restore();
    flow.querySelector('h2')?.focus?.();
    flow.scrollIntoView({block:'start'});
  };
  const showOverview=()=>{
    snapshotCurrent();currentFlow=null;
    root.querySelectorAll('[data-workflow-flow]').forEach(flow=>flow.hidden=true);
    if(overview){overview.hidden=false;overview.scrollIntoView({block:'start'});overview.querySelector('button')?.focus()}
  };
  root.querySelectorAll('[data-flow-target]').forEach(button=>button.addEventListener('click',()=>showFlow(button.getAttribute('data-flow-target')||'0')));
  root.querySelectorAll('[data-flow-overview]').forEach(button=>button.addEventListener('click',showOverview));
  const closePanel=(panel,backdrop,returnFocus=true)=>{
    panel.hidden=true;backdrop.hidden=true;panel.style.transform='';
    const flow=panel.closest('[data-workflow-flow]');
    flow?.querySelectorAll('[data-selected="true"]').forEach(element=>delete element.dataset.selected);
    panel.querySelector('[data-detail-body]').replaceChildren();
    if(returnFocus&&opener){opener.focus();opener=null}
  };
  root.querySelectorAll('[data-workflow-flow]').forEach(flow=>{
    const index=flow.getAttribute('data-workflow-flow')||'0';
    const key=flow.getAttribute('data-flow-id')||index;
    const panel=flow.querySelector('[data-detail-panel]');
    const body=flow.querySelector('[data-detail-body]');
    const close=flow.querySelector('[data-detail-close]');
    const backdrop=flow.querySelector('[data-detail-backdrop]');
    const handle=flow.querySelector('[data-sheet-handle]');
    const scroll=flow.querySelector('.sb-graph-scroll');
    const box=flow.querySelector('.sb-graph-scale-box');
    const canvas=flow.querySelector('.sb-graph-canvas');
    const output=flow.querySelector('[data-zoom-output]');
    const shortcutHelp=flow.querySelector('.sb-graph-shortcuts');
    if(!panel||!body||!close||!backdrop||!scroll||!box||!canvas||!output)return;
    if(shortcutHelp)shortcutHelp.textContent='Ctrl/⌘ + wheel zoom · Shift + wheel or horizontal touchpad pan · Touch, middle drag, or Space + drag pan · Shift+1 fit · Shift+2 selected';
    flow.querySelector('[data-fit]')?.setAttribute('aria-keyshortcuts','Shift+1 F');
    flow.querySelector('[data-focus-selected]')?.setAttribute('aria-keyshortcuts','Shift+2 S');
    let scale=1,panX=0,panY=0,selected=null,spacePan=false;
    const width=Number(box.dataset.baseWidth),height=Number(box.dataset.baseHeight);
    const graphPadding=48;
    const measureGraphBounds=()=>{
      let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
      const include=(nextLeft,nextTop,nextRight,nextBottom)=>{
        if(![nextLeft,nextTop,nextRight,nextBottom].every(Number.isFinite))return;
        left=Math.min(left,nextLeft);top=Math.min(top,nextTop);right=Math.max(right,nextRight);bottom=Math.max(bottom,nextBottom)
      };
      canvas.querySelectorAll('.sb-graph-node,.sb-graph-edge,.sb-graph-subflow-link').forEach(element=>include(element.offsetLeft,element.offsetTop,element.offsetLeft+element.offsetWidth,element.offsetTop+element.offsetHeight));
      const svg=canvas.querySelector('svg');
      if(svg)try{const bounds=svg.getBBox();include(bounds.x,bounds.y,bounds.x+bounds.width,bounds.y+bounds.height)}catch{}
      return left===Infinity?{left:0,top:0,width,height}:{left,top,width:Math.max(1,right-left),height:Math.max(1,bottom-top)}
    };
    const syncGrid=()=>{
      const step=24*scale;
      const rootRect=root.getBoundingClientRect(),scrollRect=scroll.getBoundingClientRect();
      root.style.backgroundSize=step+'px '+step+'px';
      root.style.backgroundPosition=((scrollRect.left-rootRect.left+panX)%step)+'px '+((scrollRect.top-rootRect.top+panY)%step)+'px'
    };
    const renderTransform=()=>{
      canvas.style.zoom='';
      canvas.style.transform='translate('+panX+'px,'+panY+'px) scale('+scale+')';
      output.textContent=Math.round(scale*100)+'%';syncGrid()
    };
    const viewportCenter=()=>({x:scroll.clientWidth/2,y:scroll.clientHeight/2});
    const apply=(next,anchor=viewportCenter())=>{
      const previous=scale;
      const bounded=Math.min(2,Math.max(.1,next));
      const ratio=bounded/previous;
      panX=anchor.x-(anchor.x-panX)*ratio;
      panY=anchor.y-(anchor.y-panY)*ratio;
      scale=bounded;renderTransform()
    };
    const focusSelected=()=>{if(!selected)return;panX=scroll.clientWidth/2-(selected.offsetLeft+selected.offsetWidth/2)*scale;panY=scroll.clientHeight/2-(selected.offsetTop+selected.offsetHeight/2)*scale;renderTransform()};
    const fit=()=>{
      const bounds=measureGraphBounds();
      const availableWidth=Math.max(1,scroll.clientWidth-graphPadding*2),availableHeight=Math.max(1,scroll.clientHeight-graphPadding*2);
      const widthScale=availableWidth/bounds.width,heightScale=availableHeight/bounds.height;
      scale=Math.min(2,Math.max(.1,Math.min(widthScale,heightScale)));
      panX=(scroll.clientWidth-bounds.width*scale)/2-bounds.left*scale;
      panY=(scroll.clientHeight-bounds.height*scale)/2-bounds.top*scale;
      renderTransform()
    };
    let initialFitActive=false,initialFitFrame=0,initialFitTimeout=0,initialFitObserver=null;
    const scheduleInitialFit=()=>{
      if(!initialFitActive||flow.hidden)return;
      cancelAnimationFrame(initialFitFrame);
      initialFitFrame=requestAnimationFrame(()=>{
        if(initialFitActive&&!flow.hidden&&scroll.clientWidth>0&&scroll.clientHeight>0)fit()
      })
    };
    const stopInitialFit=()=>{
      if(!initialFitActive)return;
      initialFitActive=false;cancelAnimationFrame(initialFitFrame);clearTimeout(initialFitTimeout);
      initialFitObserver?.disconnect();initialFitObserver=null;
      window.removeEventListener('resize',scheduleInitialFit)
    };
    const startInitialFit=()=>{
      if(initialFitActive){scheduleInitialFit();return}
      initialFitActive=true;
      if(typeof ResizeObserver!=='undefined'){initialFitObserver=new ResizeObserver(scheduleInitialFit);initialFitObserver.observe(scroll)}
      window.addEventListener('resize',scheduleInitialFit);
      document.fonts?.ready?.then(scheduleInitialFit);
      scheduleInitialFit();initialFitTimeout=setTimeout(stopInitialFit,5000)
    };
    flow.querySelector('[data-zoom-out]').addEventListener('click',()=>{stopInitialFit();apply(scale-.1)});
    flow.querySelector('[data-zoom-in]').addEventListener('click',()=>{stopInitialFit();apply(scale+.1)});
    flow.querySelector('[data-reset-zoom]').addEventListener('click',()=>{stopInitialFit();apply(1)});
    flow.querySelector('[data-fit]').addEventListener('click',()=>{stopInitialFit();fit()});
    flow.querySelector('[data-focus-selected]').addEventListener('click',()=>{stopInitialFit();focusSelected()});
    const shouldCaptureWheel=event=>event.ctrlKey||event.metaKey||event.shiftKey||Math.abs(event.deltaX)>Math.abs(event.deltaY);
    scroll.addEventListener('wheel',event=>{
      if(!shouldCaptureWheel(event))return;
      event.preventDefault();stopInitialFit();
      if(event.ctrlKey||event.metaKey){
        const rect=scroll.getBoundingClientRect();
        apply(scale*Math.exp(-event.deltaY*.002),{x:event.clientX-rect.left,y:event.clientY-rect.top});return
      }
      if(event.shiftKey&&event.deltaX===0)panX-=event.deltaY;
      else{panX-=event.deltaX;panY-=event.deltaY}
      renderTransform()
    },{passive:false});
    let pan=null;
    scroll.addEventListener('pointerdown',event=>{
      const middle=event.button===1;
      const spaceDrag=event.button===0&&spacePan;
      const touchDrag=event.pointerType==='touch'&&event.button===0&&!event.target.closest('button');
      if(!middle&&!spaceDrag&&!touchDrag)return;
      if(spaceDrag&&event.target.closest('button'))return;
      event.preventDefault();stopInitialFit();scroll.focus({preventScroll:true});
      pan={id:event.pointerId,x:event.clientX,y:event.clientY,panX,panY};
      scroll.setPointerCapture(event.pointerId);scroll.dataset.panning='true'
    });
    scroll.addEventListener('pointermove',event=>{if(!pan||pan.id!==event.pointerId)return;panX=pan.panX+event.clientX-pan.x;panY=pan.panY+event.clientY-pan.y;renderTransform()});
    const endPan=event=>{if(!pan||pan.id!==event.pointerId)return;pan=null;delete scroll.dataset.panning};
    scroll.addEventListener('pointerup',endPan);scroll.addEventListener('pointercancel',endPan);
    scroll.addEventListener('auxclick',event=>{if(event.button===1)event.preventDefault()});
    const openDetail=button=>{
      const target=flow.querySelector('#'+CSS.escape(button.getAttribute('data-workflow-open')||''));if(!target)return;
      opener=button;selected=button;
      flow.querySelectorAll('[data-selected="true"]').forEach(element=>delete element.dataset.selected);
      button.dataset.selected='true';
      const elementId=button.getAttribute('data-element-id');
      body.replaceChildren(target.cloneNode(true));body.firstElementChild.hidden=false;backdrop.hidden=false;panel.hidden=false;
      requestAnimationFrame(()=>close.focus())
    };
    flow.querySelectorAll('[data-workflow-open]').forEach(button=>button.addEventListener('click',()=>openDetail(button)));
    close.addEventListener('click',()=>closePanel(panel,backdrop));
    backdrop.addEventListener('click',()=>closePanel(panel,backdrop));
    if(handle){
      let sheet=null,suppressSheetClick=false;
      handle.addEventListener('click',()=>{if(suppressSheetClick){suppressSheetClick=false;return}closePanel(panel,backdrop)});
      handle.addEventListener('pointerdown',event=>{sheet={id:event.pointerId,y:event.clientY,delta:0};handle.setPointerCapture(event.pointerId)});
      handle.addEventListener('pointermove',event=>{if(!sheet||sheet.id!==event.pointerId)return;sheet.delta=Math.max(0,event.clientY-sheet.y);panel.style.transform='translateY('+sheet.delta+'px)'});
      const endSheet=event=>{if(!sheet||sheet.id!==event.pointerId)return;const dismiss=sheet.delta>80;suppressSheetClick=sheet.delta>4;sheet=null;panel.style.transform='';if(dismiss)closePanel(panel,backdrop)};
      handle.addEventListener('pointerup',endSheet);handle.addEventListener('pointercancel',endSheet)
    }
    flow.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&!panel.hidden){event.preventDefault();closePanel(panel,backdrop);return}
      if(event.target.matches('textarea,input,select'))return;
      if(event.code==='Space'){event.preventDefault();stopInitialFit();spacePan=true;scroll.dataset.panReady='true';return}
      if(event.shiftKey&&event.code==='Digit1'){event.preventDefault();stopInitialFit();fit()}
      else if(event.shiftKey&&event.code==='Digit2'){event.preventDefault();stopInitialFit();focusSelected()}
      else if(event.key==='ArrowLeft'){event.preventDefault();stopInitialFit();panX+=48;renderTransform()}
      else if(event.key==='ArrowRight'){event.preventDefault();stopInitialFit();panX-=48;renderTransform()}
      else if(event.key==='ArrowUp'){event.preventDefault();stopInitialFit();panY+=48;renderTransform()}
      else if(event.key==='ArrowDown'){event.preventDefault();stopInitialFit();panY-=48;renderTransform()}
      else if(event.key==='+'||event.key==='='){event.preventDefault();stopInitialFit();apply(scale+.1)}
      else if(event.key==='-'){event.preventDefault();stopInitialFit();apply(scale-.1)}
      else if(event.key==='0'){event.preventDefault();stopInitialFit();apply(1)}
      else if(event.key.toLowerCase()==='f'){event.preventDefault();stopInitialFit();fit()}
      else if(event.key.toLowerCase()==='s'){event.preventDefault();stopInitialFit();focusSelected()}
    });
    const endSpacePan=event=>{if(event.code!=='Space')return;spacePan=false;delete scroll.dataset.panReady};
    flow.addEventListener('keyup',endSpacePan);
    window.addEventListener('blur',()=>{spacePan=false;delete scroll.dataset.panReady});
    controllers.set(index,{
      fit,
      startInitialFit,
      snapshot(){viewState.set(key,{scale,panX,panY,selectedId:selected?.getAttribute('data-element-id')??null,panelOpen:!panel.hidden})},
      restore(){const saved=viewState.get(key);if(!saved){startInitialFit();return}stopInitialFit();scale=saved.scale;panX=saved.panX;panY=saved.panY;renderTransform();requestAnimationFrame(()=>{if(saved.selectedId){selected=flow.querySelector('[data-element-id="'+CSS.escape(saved.selectedId)+'"]');if(saved.panelOpen&&selected)openDetail(selected)}})}
    });
    apply(1)
  });
  if(overview)showOverview();
  else controllers.get('0')?.startInitialFit();
  hostCopy.forEach(button=>button.addEventListener('click',()=>{
    const api=window.SceneBoardArtifact;
    if(!api||!api.userAction||!api.requestCapability||!api.onHostMessage){reportCopyFailure('Clipboard copy is unavailable.');return}
    const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);
    const id=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');pending=id;
    if(unsubscribe)unsubscribe();
    unsubscribe=api.onHostMessage(message=>{
      if(message.type!=='host.capability.result'||message.requestId!==pending||message.capability!=='clipboard.write')return;
      pending=null;if(timer)clearTimeout(timer);if(unsubscribe)unsubscribe();unsubscribe=null;
      if(message.ok){if(status)status.textContent='Canonical WorkflowSpec JSON copied.'}else reportCopyFailure('Clipboard copy was denied or unavailable.')
    });
    api.userAction(id,'clipboard.write');api.requestCapability(id,'clipboard.write',{text:source.value});
    timer=setTimeout(()=>{if(pending===id){pending=null;if(unsubscribe)unsubscribe();unsubscribe=null;reportCopyFailure('No clipboard result arrived.')}},5500)
  }));
  if(window.SceneBoardArtifact&&window.SceneBoardArtifact.requestResize)window.SceneBoardArtifact.requestResize(1280,800)
})()`;

const WORKFLOW_GRAPH_CSS = `.sb-workflow-graph{box-sizing:border-box;min-height:100vh;padding:28px;background:radial-gradient(circle at 85% 0,#0f766e38,transparent 34%),#07131d;color:#e6fffb;font:16px/1.5 ui-sans-serif,system-ui,sans-serif}.sb-workflow-graph *{box-sizing:border-box}.sb-graph-head{display:flex;align-items:end;justify-content:space-between;gap:24px;max-width:1220px;margin:0 auto 22px}.sb-graph-head h1{margin:0;font-size:36px;line-height:1.05}.sb-graph-head p{margin:8px 0 0;color:#99f6e4}.sb-graph-actions,.sb-graph-view-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.sb-workflow-graph button{border:1px solid #5eead4;border-radius:10px;background:#0f766e;color:white;padding:8px 12px;font:inherit;font-weight:750;cursor:pointer}.sb-graph-overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;max-width:1220px;margin:0 auto 20px}.sb-graph-overview button{text-align:left;background:#0b1d27}.sb-graph-overview strong,.sb-graph-overview span{display:block}.sb-graph-overview span{color:#99f6e4;font-size:12px}.sb-graph-flow{max-width:1220px;margin:18px auto;padding:18px;border:1px solid #2dd4bf42;border-radius:20px;background:#0b1d27e8}.sb-graph-flow nav{display:flex;gap:8px;align-items:center;color:#99f6e4}.sb-graph-flow nav button{border:0;background:transparent;padding:0;color:#5eead4}.sb-graph-title{display:flex;justify-content:space-between;align-items:end;gap:16px}.sb-graph-flow header p{margin:0;color:#5eead4;font-size:12px;font-weight:800;text-transform:uppercase}.sb-graph-flow h2{margin:2px 0 14px}.sb-graph-workspace{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,34%);gap:14px;align-items:start}.sb-graph-stage-wrap{position:relative;min-width:0}.sb-graph-scroll{height:min(62vh,620px);min-height:300px;overflow:auto;border-radius:14px;background:#07151f}.sb-graph-scale-box{position:relative}.sb-graph-canvas{position:absolute;left:0;top:0;transform-origin:0 0;background-image:linear-gradient(#ffffff08 1px,transparent 1px),linear-gradient(90deg,#ffffff08 1px,transparent 1px);background-size:24px 24px}.sb-graph-canvas svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}.sb-graph-canvas line{stroke:#5eead4;stroke-width:2}.sb-graph-canvas path{fill:#5eead4}.sb-graph-canvas text{fill:#99f6e4;font-size:11px;text-anchor:middle}.sb-graph-node{position:absolute;width:150px;min-height:68px;border:1px solid #5eead4;border-radius:14px;background:#102a35;color:#f0fdfa;padding:10px;text-align:left;box-shadow:0 12px 30px #0005}.sb-graph-node strong,.sb-graph-node span{display:block}.sb-graph-node span{margin-top:5px;color:#99f6e4;font-size:11px}.sb-graph-node[data-kind="decision"],.sb-graph-node[data-kind="hitl"]{border-color:#fbbf24}.sb-graph-node[data-unreachable="true"]{border-style:dashed;opacity:.72}.sb-graph-edge{position:absolute;display:grid;place-items:center;width:36px;height:36px;border:2px solid #07131d;border-radius:50%;background:#5eead4;color:#062b2b;font-weight:900}.sb-graph-minimap{position:absolute;right:12px;bottom:12px;width:180px;height:105px;padding:0;overflow:hidden;background:#041017cc}.sb-graph-minimap svg{width:100%;height:100%}.sb-graph-minimap rect{fill:#2dd4bf88}.sb-graph-minimap span{position:absolute;border:2px solid #fbbf24;background:#fbbf2422;pointer-events:none}.sb-graph-inspector{position:sticky;top:12px;max-height:62vh;overflow:auto;border:1px solid #5eead4;border-radius:16px;background:#07151f;padding:16px;box-shadow:0 18px 50px #0008}.sb-graph-inspector>header{display:flex;justify-content:space-between;align-items:center}.sb-graph-inspector dl{display:grid;grid-template-columns:minmax(90px,auto) 1fr;gap:6px 12px}.sb-graph-inspector dt{color:#5eead4;font-weight:800}.sb-graph-inspector dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.sb-graph-node:focus-visible,.sb-graph-edge:focus-visible,.sb-workflow-graph button:focus-visible,.sb-graph-scroll:focus-visible,textarea:focus-visible{outline:4px solid #fbbf24;outline-offset:3px}.sb-graph-export{max-width:1220px;margin:20px auto}.sb-graph-export textarea{width:100%;min-height:170px;border:1px solid #2dd4bf42;border-radius:14px;background:#041017;color:#c7f9f0;padding:14px;font:12px/1.5 ui-monospace,monospace;resize:vertical}.sb-graph-kind{color:#5eead4;font-size:12px;font-weight:800;text-transform:uppercase}@media(max-width:760px){.sb-workflow-graph{padding:14px}.sb-graph-head,.sb-graph-title{align-items:stretch;flex-direction:column}.sb-graph-head h1{font-size:28px}.sb-graph-workspace{display:block}.sb-graph-inspector{position:fixed;z-index:20;left:8px;right:8px;bottom:8px;top:auto;max-height:55vh;border-radius:20px 20px 12px 12px}.sb-graph-minimap{width:132px;height:82px}}@media(prefers-reduced-motion:reduce){.sb-workflow-graph *{scroll-behavior:auto!important;animation:none!important;transition:none!important}}`;

const WORKFLOW_GRAPH_CSS_V2 = `${WORKFLOW_GRAPH_CSS}.sb-graph-shortcuts{color:#99f6e4!important;text-transform:none!important}.sb-graph-scroll{cursor:grab;touch-action:none}.sb-graph-scroll[data-panning="true"]{cursor:grabbing;user-select:none}.sb-graph-node[data-selected="true"],.sb-graph-edge[data-selected="true"]{outline:4px solid #fbbf24;outline-offset:3px}.sb-graph-minimap rect[data-selected="true"]{fill:#fbbf24}.sb-graph-port{position:absolute;z-index:6;max-width:min(180px,calc(50% - 20px));border:1px dashed #67e8f9;border-radius:999px;background:#083344;color:#cffafe;padding:4px 8px;font-size:10px;pointer-events:none}.sb-graph-port-entry{left:8px;top:14px}.sb-graph-port-exit{right:8px;bottom:14px}.sb-graph-subflow-link{position:absolute;right:14px;top:14px;z-index:3;font-size:11px}.sb-graph-sheet-handle{display:none}.sb-graph-render-limit{max-width:1220px;margin:0 auto 20px;border:1px solid #fbbf24;border-radius:16px;background:#422006;color:#fef3c7;padding:18px}.sb-graph-render-limit h2{margin-top:0}@media(max-width:760px){.sb-graph-sheet-handle{display:grid;width:100%;place-items:center;border:0;background:transparent;padding:2px;touch-action:none}.sb-graph-sheet-handle span{width:48px;height:5px;border-radius:999px;background:#5eead4}.sb-graph-inspector{transition:transform .15s ease-out}}`;

const WORKFLOW_GRAPH_CSS_V3 = `${WORKFLOW_GRAPH_CSS_V2}.sb-graph-overview[hidden]{display:none}.sb-graph-flow{max-width:none;width:100%;margin:18px 0}.sb-graph-workspace{display:block}.sb-graph-stage-wrap{width:100%}.sb-graph-inspector-backdrop{position:fixed;z-index:29;inset:0;border:0!important;border-radius:0!important;background:#02061799!important;padding:0!important}.sb-graph-inspector{position:fixed;z-index:30;top:0;right:0;bottom:0;left:auto;width:min(440px,92vw);max-height:none;border-radius:20px 0 0 20px;padding:22px}.sb-graph-export-source{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}.sb-graph-action-status{min-height:1.5em;margin:0;color:#99f6e4;font-size:12px}@media(max-width:760px){.sb-graph-inspector{top:auto;right:8px;bottom:8px;left:8px;width:auto;max-height:70vh;border-radius:20px 20px 12px 12px}}`;

const WORKFLOW_GRAPH_CSS_V4 = `${WORKFLOW_GRAPH_CSS_V3}.sb-graph-scroll{cursor:default;scrollbar-width:none;-ms-overflow-style:none}.sb-graph-scroll::-webkit-scrollbar{display:none;width:0;height:0}.sb-graph-scroll[data-pan-ready="true"]{cursor:grab}.sb-graph-scroll[data-panning="true"]{cursor:grabbing}`;

const WORKFLOW_GRAPH_CSS_V5 = `${WORKFLOW_GRAPH_CSS_V4}.sb-graph-action-status{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}`;

const WORKFLOW_GRAPH_CSS_V6 = `${WORKFLOW_GRAPH_CSS_V5}.sb-workflow-graph{height:100vh;min-height:0;padding:0;overflow:hidden}.sb-graph-flow{display:flex;flex-direction:column;height:100vh;min-height:0;margin:0;padding:0;border:0;border-radius:0}.sb-graph-flow[hidden]{display:none}.sb-graph-flow>header{flex:0 0 auto;padding:18px 20px 0}.sb-graph-workspace{flex:1;min-height:0}.sb-graph-stage-wrap,.sb-graph-scroll{height:100%;min-height:0}.sb-graph-scroll{border-radius:0}.sb-graph-overview{height:100vh;max-width:none;margin:0;padding:20px;overflow:auto}`;

const WORKFLOW_GRAPH_CSS_V7 = `${WORKFLOW_GRAPH_CSS_V6}.sb-graph-scroll{background-color:#07151f;background-image:linear-gradient(#ffffff08 1px,transparent 1px),linear-gradient(90deg,#ffffff08 1px,transparent 1px);background-size:24px 24px}.sb-graph-canvas{background-image:none}`;

const WORKFLOW_GRAPH_CSS_V8 = `${WORKFLOW_GRAPH_CSS_V7}.sb-graph-scroll{overflow:hidden}.sb-graph-scale-box{width:100%!important;height:100%!important}.sb-graph-canvas{will-change:transform}`;

const WORKFLOW_GRAPH_CSS_V9 = `${WORKFLOW_GRAPH_CSS_V8}.sb-graph-edge{width:44px;height:30px;border:0;border-radius:8px;background:transparent;color:transparent;padding:0;box-shadow:none}.sb-graph-edge[data-selected="true"],.sb-graph-edge:focus-visible{background:#fbbf2414;outline:2px dashed #fbbf24;outline-offset:1px}`;

const WORKFLOW_GRAPH_CSS_V10 = `${WORKFLOW_GRAPH_CSS_V9}.sb-graph-scale-box{transform-origin:0 0}.sb-graph-canvas{will-change:auto}`;

const WORKFLOW_GRAPH_CSS_V11 = `${WORKFLOW_GRAPH_CSS_V10}.sb-workflow-graph .sb-graph-edge{appearance:none;width:44px;height:30px;border:0;border-radius:0;background:transparent;color:transparent;padding:0;box-shadow:none;outline:0}.sb-workflow-graph .sb-graph-edge[data-selected="true"]{background:transparent;outline:0}.sb-workflow-graph .sb-graph-edge:focus-visible{border-radius:8px;background:#fbbf2414;outline:2px dashed #fbbf24;outline-offset:1px}`;

const WORKFLOW_GRAPH_CSS_V12 = `${WORKFLOW_GRAPH_CSS_V11}.sb-graph-canvas .sb-graph-path{fill:none;stroke:#5eead4;stroke-width:2}.sb-graph-edge-label{pointer-events:none}.sb-graph-edge-label rect{fill:#07151ff2;stroke:#2dd4bf66;stroke-width:1}.sb-graph-edge-label text{fill:#ccfbf1;font-size:11px;dominant-baseline:middle}`;

const WORKFLOW_GRAPH_CSS_V13 = `${WORKFLOW_GRAPH_CSS_V12}.sb-graph-canvas svg{z-index:4;pointer-events:none}.sb-graph-node{z-index:2}.sb-workflow-graph .sb-graph-edge{z-index:5}.sb-graph-edge-label rect{fill:rgba(7,21,31,.6);stroke:#2dd4bf66}`;

const WORKFLOW_GRAPH_CSS_V14 = `${WORKFLOW_GRAPH_CSS_V13}.sb-workflow-graph{height:100vh;overflow:auto}.sb-graph-workspace{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,34%);gap:14px}.sb-graph-scroll{overflow:auto;scrollbar-width:auto}.sb-graph-scroll::-webkit-scrollbar{display:block;width:auto;height:auto}.sb-graph-scale-box{width:auto;height:auto}.sb-graph-inspector{position:sticky;z-index:10;top:12px;right:auto;bottom:auto;left:auto;width:auto;max-height:calc(100vh - 24px);border-radius:16px}.sb-graph-inspector-backdrop{display:none}.sb-graph-subflow-link{right:14px}.sb-graph-minimap{z-index:8}.sb-graph-export-fallback{display:block;width:min(1220px,calc(100% - 28px));min-height:170px;margin:20px auto;border:1px solid #2dd4bf42;border-radius:14px;background:#041017;color:#c7f9f0;padding:14px;font:12px/1.5 ui-monospace,monospace;resize:vertical}@media(max-width:760px){.sb-graph-workspace{display:block}.sb-graph-inspector-backdrop:not([hidden]){display:block}.sb-graph-inspector{position:fixed;z-index:30;top:auto;right:8px;bottom:8px;left:8px;width:auto;max-height:70vh;border-radius:20px 20px 12px 12px}}`;

const WORKFLOW_GRAPH_CSS_V15 = `${WORKFLOW_GRAPH_CSS_V14}.sb-workflow-graph{overflow:hidden}.sb-graph-workspace{position:relative;display:block;gap:0}.sb-graph-stage-wrap{width:100%}.sb-graph-inspector{position:absolute;z-index:30;top:0;right:0;bottom:0;left:auto;width:min(440px,92vw);max-height:none;border-radius:20px 0 0 20px}.sb-graph-inspector-backdrop{display:none}@media(max-width:760px){.sb-graph-inspector-backdrop:not([hidden]){position:absolute;display:block}.sb-graph-inspector{position:absolute;top:auto;right:8px;bottom:8px;left:8px;width:auto;max-height:70%;border-radius:20px 20px 12px 12px}}`;

const WORKFLOW_GRAPH_CSS_V16 = `${WORKFLOW_GRAPH_CSS_V15}.sb-workflow-graph{background-color:#07151f;background-image:linear-gradient(#ffffff08 1px,transparent 1px),linear-gradient(90deg,#ffffff08 1px,transparent 1px);background-size:24px 24px}.sb-graph-flow,.sb-graph-scroll{background:transparent}.sb-graph-scroll{position:relative;overflow:hidden;scrollbar-width:none;-ms-overflow-style:none}.sb-graph-scroll::-webkit-scrollbar{display:none;width:0;height:0}.sb-graph-scale-box{position:absolute;inset:0;width:100%!important;height:100%!important}.sb-graph-canvas{transform-origin:0 0;will-change:transform}`;

export const renderWorkflowGraph = (content, title, fallbackText) => {
  const workflowSpec = validateWorkflowSpec(content.workflowSpec);
  const canonical = canonicalizeWorkflowSpec(workflowSpec);
  const canonicalWorkflowSpec = JSON.parse(canonical);
  const flows = [
    {
      id: canonicalWorkflowSpec.workflow.id,
      title: canonicalWorkflowSpec.workflow.title,
      entryNodeIds: canonicalWorkflowSpec.entryNodeIds,
      exitNodeIds: canonicalWorkflowSpec.exitNodeIds,
      nodes: canonicalWorkflowSpec.nodes,
      edges: canonicalWorkflowSpec.edges,
      evidence: canonicalWorkflowSpec.workflow.evidence,
    },
    ...canonicalWorkflowSpec.subflows,
  ];
  const hasMultipleFlows = flows.length > 1;
  const totals = flows.reduce(
    (sum, flow) => ({
      nodes: sum.nodes + flow.nodes.length,
      edges: sum.edges + flow.edges.length,
    }),
    { nodes: 0, edges: 0 },
  );
  const renderable =
    totals.nodes <= WORKFLOW_GRAPH_RENDER_LIMITS.nodes &&
    totals.edges <= WORKFLOW_GRAPH_RENDER_LIMITS.edges;
  const capability = content.copyMode === "manual" ? [] : ["clipboard.write"];
  const copyButton =
    content.copyMode === "manual"
      ? ""
      : '<button type="button" data-copy-host>클립보드 복사</button>';
  const exportControls = copyButton;
  const exportSource = `<textarea readonly hidden class="sb-graph-export-source" data-workflow-json aria-label="Canonical WorkflowSpec JSON">${escapeHtml(canonical)}</textarea>`;
  const renderLimitGuidance =
    content.copyMode === "manual"
      ? "The graph is not reported as fully rendered. Retry from a clipboard-enabled board to copy the complete JSON."
      : "Use the copy control to retrieve the complete JSON; the graph is not reported as fully rendered.";
  return {
    artifactId: null,
    html: `<main class="sb-workflow-graph" data-sb-workflow-graph="v1" aria-label="${escapeHtml(title ?? workflowSpec.workflow.title)}">${
      renderable
        ? `${
            hasMultipleFlows
              ? `<nav class="sb-graph-overview" data-flow-overview-list aria-label="Workflow groups">${flows
                  .map((flow, index) => {
                    const relationship = flowRelationship(flow, flows);
                    return `<button type="button" data-flow-target="${index}"><strong>${escapeHtml(flow.title)}</strong><span>${flow.nodes.length} nodes · ${flow.edges.length} edges</span><span>Entry: ${escapeHtml(flow.entryNodeIds.join(", "))} · Subflows: ${relationship.outgoing.length} · Parents: ${relationship.parents.length}</span></button>`;
                  })
                  .join("")}</nav>`
              : ""
          }${flows.map((flow, index) => renderFlow(flow, index, flows, hasMultipleFlows, exportControls)).join("")}`
        : `<section class="sb-graph-render-limit" data-render-limit-exceeded role="status"><div class="sb-graph-actions">${exportControls}</div><h2>Graph preview limit exceeded</h2><p>${escapeHtml(fallbackText ?? "The workflow is valid but too large for the interactive preview.")}</p><p>This valid WorkflowSpec contains ${totals.nodes} nodes and ${totals.edges} edges. ${renderLimitGuidance} The preview limit is ${WORKFLOW_GRAPH_RENDER_LIMITS.nodes} nodes and ${WORKFLOW_GRAPH_RENDER_LIMITS.edges} edges.</p></section>`
    }${exportSource}<p class="sb-graph-action-status" data-copy-status role="status" aria-live="polite"></p></main>`,
    css: WORKFLOW_GRAPH_CSS_V16,
    javascript: WORKFLOW_GRAPH_PROGRAM_V2,
    requestedCapabilities: capability,
  };
};
