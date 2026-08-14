import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const skillInstructions = await readFile(resolve(root, 'SKILL.md'), 'utf8');

test('skill instructions stay within the progressive-disclosure budget', () => {
  const lineCount = skillInstructions.split(/\r?\n/u).length;
  const wordCount = skillInstructions.trim().split(/\s+/u).length;

  assert.equal(lineCount <= 500, true, `SKILL.md has ${lineCount} lines`);
  assert.equal(wordCount <= 5_000, true, `SKILL.md has ${wordCount} words`);
});

test('every reference is directly routable from the skill instructions', async () => {
  const referenceNames = (await readdir(resolve(root, 'references')))
    .filter((name) => name.endsWith('.md'))
    .sort();
  const directReferences = new Set(
    [...skillInstructions.matchAll(/\(references\/([^\s)#]+\.md)(?:#[^)]*)?\)/gu)].map(
      (match) => match[1],
    ),
  );
  const indirectReferences = referenceNames.filter((name) => !directReferences.has(name));

  assert.deepEqual(indirectReferences, []);
});
