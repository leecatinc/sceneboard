import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  canonicalizeWorkflowSpec,
  validateWorkflowSpec,
} from '../../../skills/sceneboard/scripts/workflow-spec-core.mjs';

const root = new URL('../../../skills/sceneboard/', import.meta.url);
const source = (relative) => readFileSync(new URL(relative, root), 'utf8');

test('SceneBoard routes framework-neutral workflow review before presentation composition', () => {
  const skill = source('SKILL.md');
  const graph = source('references/graph-engineering.md');
  const graphRoute = skill.indexOf('When the primary intent is to inspect, design, visualize');
  const slideRoute = skill.indexOf("If and only if the user's request contains");

  assert.ok(graphRoute >= 0 && slideRoute > graphRoute);
  for (const kind of ['LangGraph-like code', 'Markdown', '`SKILL.md`', 'rules', 'prose'])
    assert.match(graph, new RegExp(kind.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(graph, /finish graph review first and ask before generating presentation/u);
  assert.match(graph, /explicit`, `inferred`, or `unknown`/u);
});

test('conversational edit fixture is valid and already canonical', () => {
  const text = source('assets/workflow-spec-examples/conversational-edit.json');
  const value = JSON.parse(text);
  assert.equal(validateWorkflowSpec(value).schemaVersion, '1.0');
  assert.equal(canonicalizeWorkflowSpec(value), text);
  const change = value.sources.find(({ id }) => id === 'source_conversation');
  assert.ok(change);
  for (const id of ['node_review', 'node_end', 'edge_start_review', 'edge_review_end']) {
    const elements = [...value.nodes, ...value.edges];
    assert.ok(
      elements
        .find((element) => element.id === id)
        ?.evidence.sourceRefs.some(({ sourceId }) => sourceId === change.id),
      `${id} must retain conversational provenance`,
    );
  }
});

test('graph publication route keeps a manual fallback and one exact denial retry', () => {
  const graph = source('references/graph-engineering.md');
  const fallback = source('references/fallback.md');
  assert.match(graph, /copyMode:`?"clipboard"/u);
  assert.match(graph, /copyMode:`?"manual"/u);
  assert.match(graph, /same transport[\s\S]*capability allowed→absent/u);
  assert.match(fallback, /one narrow lower-capability exception/u);
  assert.match(graph, /Any ambiguity or\s+second failure stops/u);
  assert.match(graph, /Do not generate a special target-specific prompt/u);
});
