import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);

export interface CertificationSelectorV1 {
  projectionId: string;
  exportName: string;
  exportKind: 'class';
  memberName: string;
  memberKind: 'method';
  signature: string;
  selector: string;
  contractId: string;
}

export interface CertificationPublisherV1 {
  schemaVersion: 1;
  owner: string;
  resourcePath: string;
  publisherTestPath: string;
  contractIds: string[];
  selectors: CertificationSelectorV1[];
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

export const readPublisher = (name: string): CertificationPublisherV1 => JSON.parse(readFileSync(
  new URL(`test/contracts/certification-handoffs/${name}`, root),
  'utf8',
)) as CertificationPublisherV1;

export const assertPublisher = (input: {
  name: string;
  owner: string;
  publisherTestPath: string;
  contractIds: string[];
  memberNames: string[];
}): CertificationPublisherV1 => {
  const publisher = readPublisher(input.name);
  assert.deepEqual(Object.keys(publisher).sort(), [
    'contractIds', 'owner', 'publisherTestPath', 'resourcePath', 'schemaVersion', 'selectors', 'tupleListSha256',
  ]);
  assert.equal(publisher.schemaVersion, 1);
  assert.equal(publisher.owner, input.owner);
  assert.equal(publisher.resourcePath, 'leecat-board-nextjs/lib/api/board-api.ts');
  assert.equal(publisher.publisherTestPath, input.publisherTestPath);
  assert.deepEqual(publisher.contractIds, input.contractIds);
  assert.deepEqual(publisher.selectors.map(({ memberName }) => memberName), input.memberNames);
  assert.equal(new Set(publisher.contractIds).size, publisher.contractIds.length);
  assert.equal(new Set(publisher.selectors.map(({ projectionId }) => projectionId)).size, publisher.selectors.length);
  const source = readFileSync(new URL('lib/api/board-api.ts', root), 'utf8');
  for (const [index, selector] of publisher.selectors.entries()) {
    assert.deepEqual(Object.keys(selector).sort(), [
      'contractId', 'exportKind', 'exportName', 'memberKind', 'memberName', 'projectionId', 'selector', 'signature',
    ]);
    assert.equal(selector.contractId, publisher.contractIds[index]);
    assert.equal(selector.exportName, 'BoardApiClient');
    assert.equal(selector.exportKind, 'class');
    assert.equal(selector.memberKind, 'method');
    assert.equal(
      selector.selector,
      `ClassDeclaration[name=BoardApiClient]/MethodDeclaration[name=${selector.memberName}]`,
    );
    assert.equal(selector.signature, extractMethodSignature(source, selector.memberName));
  }
  assert.equal(
    publisher.tupleListSha256,
    createHash('sha256').update(canonicalize(publisher.selectors)).digest('hex'),
  );
  return publisher;
};
