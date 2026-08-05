import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const actions = readFileSync(
  new URL('../../app/s/[shareToken]/shared-board-actions.ts', import.meta.url),
  'utf8',
);

test('password action applies admitted cookies only on the server and confirms ambiguous denial', () => {
  assert.match(actions, /'use server'/u);
  assert.match(actions, /await applySetCookies\(result\.setCookies\)/u);
  assert.match(actions, /const confirmed = await bootstrap\(shareToken\)/u);
  assert.match(actions, /result\.kind === 'not-admitted'/u);
  assert.match(actions, /confirmed\.state === 'password-required'/u);
  assert.match(actions, /state: 'password-invalid'/u);
});

test('password action result vocabulary contains no transport secret or denial cause', () => {
  const resultType = actions.slice(
    actions.indexOf('export type SharedBoardActionState'),
    actions.indexOf('const requestContext'),
  );
  assert.doesNotMatch(resultType, /password:|cookie|shareToken|reason|code|message/u);
  assert.match(resultType, /password-invalid/u);
  assert.match(resultType, /PublicShareClientState/u);
});

test('public bootstrap retries one transient unavailable response before failing closed', () => {
  assert.match(actions, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/u);
  assert.match(actions, /state\.state !== 'unavailable' \|\| attempt === 1/u);
  assert.match(actions, /setTimeout\(resolve, 1_000\)/u);
});
