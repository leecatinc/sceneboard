import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workspace = new URL('../../../', import.meta.url);

interface D3SelectorV1 {
  projectionId: string;
  sourcePath: string;
  exportName: string;
  exportKind: 'class';
  memberName: string;
  memberKind: 'method';
  signature: string;
  selector: string;
  contractIds: string[];
}

interface D3PublisherV1 {
  schemaVersion: 1;
  owner: 'D3';
  resourcePath: string;
  publisherTestPath: string;
  contractIds: string[];
  selectors: D3SelectorV1[];
  tupleListSha256: string;
}

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
    .join(',')}}`;
};

const extractMethodSignature = (source: string, methodName: string): string => {
  const marker = `async ${methodName}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${methodName}`);
  let index = start + `async ${methodName}`.length;
  let depth = 0;
  let quote: string | null = null;
  for (; index < source.length; index += 1) {
    const character = source[index];
    const previous = source[index - 1];
    if (quote !== null) {
      if (character === quote && previous !== '\\') quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(' || character === '<' || character === '[') depth += 1;
    if (character === ')' || character === '>' || character === ']') depth -= 1;
    if (character === '{' && depth === 0) break;
  }
  assert.ok(index < source.length, `unterminated ${methodName}`);
  return source.slice(start, index).replace(/\s+/gu, ' ').trim();
};

test('D3 publishes the exact segmented application, snapshot, and outbox seams', () => {
  const publisher = JSON.parse(readFileSync(
    new URL('leecat-board-nestjs/test/contracts/certification-handoffs/d3-application-seams.v1.json', workspace),
    'utf8',
  )) as D3PublisherV1;
  assert.deepEqual(Object.keys(publisher).sort(), [
    'contractIds', 'owner', 'publisherTestPath', 'resourcePath', 'schemaVersion', 'selectors', 'tupleListSha256',
  ]);
  assert.equal(publisher.schemaVersion, 1);
  assert.equal(publisher.owner, 'D3');
  assert.equal(publisher.resourcePath, 'leecat-board-nestjs/src');
  assert.equal(publisher.publisherTestPath, 'leecat-board-nestjs/test/contracts/d3-application-seams.contract.test.ts');
  assert.deepEqual(publisher.contractIds, [
    'board.list', 'board.get', 'board.create', 'board.archive', 'scene.replace', 'scene.clear', 'scene.restore',
    'history.list', 'history.get', 'snapshot.compose', 'outbox.delivery',
  ]);
  assert.equal(publisher.selectors.length, 17);
  assert.equal(new Set(publisher.selectors.map(({ projectionId }) => projectionId)).size, 17);
  const covered = new Set(publisher.selectors.flatMap(({ contractIds }) => contractIds));
  assert.deepEqual([...covered].sort(), [...publisher.contractIds].sort());
  for (const selector of publisher.selectors) {
    assert.deepEqual(Object.keys(selector).sort(), [
      'contractIds', 'exportKind', 'exportName', 'memberKind', 'memberName', 'projectionId',
      'selector', 'signature', 'sourcePath',
    ]);
    assert.ok(selector.sourcePath.startsWith('leecat-board-nestjs/src/'));
    const source = readFileSync(new URL(selector.sourcePath, workspace), 'utf8');
    assert.match(source, new RegExp(`export class ${selector.exportName}\\b`, 'u'));
    assert.equal(selector.signature, extractMethodSignature(source, selector.memberName));
    assert.equal(
      selector.selector,
      `ClassDeclaration[name=${selector.exportName}]/MethodDeclaration[name=${selector.memberName}]`,
    );
  }
  assert.equal(
    publisher.tupleListSha256,
    createHash('sha256').update(canonicalize(publisher.selectors)).digest('hex'),
  );
});
