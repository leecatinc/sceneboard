import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { retryUnavailablePasswordAdmission } from '../../app/s/[shareToken]/shared-board-password-retry.js';

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
  assert.match(actions, /retryUnavailablePasswordAdmission/u);
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

test('password admission retries one transient unavailable response', async () => {
  const outcomes = [
    { kind: 'unavailable', setCookies: [] as const },
    { kind: 'accepted', setCookies: [] as const },
  ] as const;
  let calls = 0;
  let waits = 0;

  const result = await retryUnavailablePasswordAdmission(
    async () => outcomes[calls++]!,
    async () => {
      waits += 1;
    },
  );

  assert.equal(result.kind, 'accepted');
  assert.equal(calls, 2);
  assert.equal(waits, 1);
});

test('password admission remains fail-closed after two unavailable responses', async () => {
  let calls = 0;

  const result = await retryUnavailablePasswordAdmission(
    async () => {
      calls += 1;
      return { kind: 'unavailable', setCookies: [] };
    },
    async () => undefined,
  );

  assert.equal(result.kind, 'unavailable');
  assert.equal(calls, 2);
});
