import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  canonicalizeWorkflowSpec,
  validateWorkflowSpec,
} from '../../../skills/sceneboard/scripts/workflow-spec-core.mjs';

const sampleUrl = new URL(
  '../../sceneboard-fe/components/landing/graph-engineering-sample.json',
  import.meta.url,
);

test('landing workflow sample is valid canonical WorkflowSpec and stays inside preview limits', () => {
  const text = readFileSync(sampleUrl, 'utf8');
  const value = JSON.parse(text);
  assert.equal(validateWorkflowSpec(value).schemaVersion, '1.0');
  assert.equal(canonicalizeWorkflowSpec(value), text);
  assert.equal(value.nodes.length, 3);
  assert.equal(value.edges.length, 2);
  const flows = [value, ...value.subflows];
  assert.ok(Buffer.byteLength(text, 'utf8') <= 32_768);
  assert.ok(flows.reduce((total, flow) => total + flow.nodes.length, 0) <= 32);
  assert.ok(flows.reduce((total, flow) => total + flow.edges.length, 0) <= 64);
});
