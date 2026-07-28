import test from 'node:test';
import { assertOwnerProjection } from '../contracts/schema-projections/schema-projection.test-helper.js';

test('D2, D3, D7, D8, and D9 schema owners publish source-bound projections', () => {
  for (const owner of ['D2', 'D3', 'D7', 'D8', 'D9'] as const) assertOwnerProjection(owner);
});
