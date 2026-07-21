import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readRepositoryFile = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('agent entry points share one rule router and preserve nearest-rule precedence', async () => {
  const [agents, claude, gemini, rules] = await Promise.all([
    readRepositoryFile('AGENTS.md'),
    readRepositoryFile('CLAUDE.md'),
    readRepositoryFile('GEMINI.md'),
    readRepositoryFile('rules/RULES.md'),
  ]);

  assert.match(agents, /Start with `rules\/CRITICAL\.md`, then `rules\/RULES\.md`/u);
  assert.match(agents, /nearest `rules\/RULES\.md`/u);
  assert.match(agents, /A nearer rule tree overrides a broader rule tree/u);
  assert.match(rules, /A nearer rule wins conflicts with this tree/u);

  for (const entryPoint of [claude, gemini]) {
    assert.match(entryPoint, /Read and follow `AGENTS\.md` before starting work/u);
    assert.match(entryPoint, /prefer the nearest nested `rules\/RULES\.md`/u);
    assert.match(entryPoint, /`AGENTS\.md` and the routed `rules\/` tree are the source of truth/u);
  }
});
