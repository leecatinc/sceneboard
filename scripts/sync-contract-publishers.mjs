import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publisherPaths = [
  'sceneboard-fe/test/contracts/certification-handoffs/d2-board-api-tuples.v1.json',
  'sceneboard-fe/test/contracts/certification-handoffs/d5-board-api-tuples.v1.json',
  'sceneboard-fe/test/contracts/certification-handoffs/d7-board-api-tuples.v1.json',
  'sceneboard-fe/test/contracts/certification-handoffs/d8-board-api-tuples.v1.json',
  'sceneboard-be/test/contracts/certification-handoffs/d3-application-seams.v1.json',
];

const canonicalize = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
    .join(',')}}`;
};

const extractMethodSignature = (source, methodName) => {
  const marker = `async ${methodName}(`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`contract publisher method is missing: ${methodName}`);
  let index = start + `async ${methodName}`.length;
  let depth = 0;
  let quote = null;
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
  if (index >= source.length) {
    throw new Error(`contract publisher method is unterminated: ${methodName}`);
  }
  return source.slice(start, index).replace(/\s+/gu, ' ').trim();
};

const synchronizePublisher = async (publisherPath) => {
  const absolutePath = resolve(root, publisherPath);
  const existing = await readFile(absolutePath, 'utf8');
  const publisher = JSON.parse(existing);
  const sourceCache = new Map();
  const selectors = [];
  for (const selector of publisher.selectors) {
    const sourcePath = selector.sourcePath ?? publisher.resourcePath;
    let source = sourceCache.get(sourcePath);
    if (source === undefined) {
      source = await readFile(resolve(root, sourcePath), 'utf8');
      sourceCache.set(sourcePath, source);
    }
    selectors.push({
      ...selector,
      signature: extractMethodSignature(source, selector.memberName),
    });
  }
  const synchronized = {
    ...publisher,
    selectors,
    tupleListSha256: createHash('sha256').update(canonicalize(selectors)).digest('hex'),
  };
  const expected = `${JSON.stringify(synchronized, null, 2)}\n`;
  return { absolutePath, existing, expected };
};

const check = process.argv.slice(2).includes('--check');
const results = await Promise.all(publisherPaths.map(synchronizePublisher));
const stale = results.filter(({ existing, expected }) => existing !== expected);
if (check) {
  if (stale.length > 0) {
    process.stderr.write(
      `${stale.map(({ absolutePath }) => absolutePath.slice(root.length + 1)).join('\n')}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({ status: 'PASS', publisherCount: results.length })}\n`);
  }
} else {
  await Promise.all(stale.map(({ absolutePath, expected }) => writeFile(absolutePath, expected)));
  process.stdout.write(
    `${JSON.stringify({ status: 'SYNCED', publisherCount: results.length, updatedCount: stale.length })}\n`,
  );
}
