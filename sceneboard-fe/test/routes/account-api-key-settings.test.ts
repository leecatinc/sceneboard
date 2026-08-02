import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), 'utf8');

test('API-key settings preserve pairing and default to the exact board-read scope', () => {
  const owner = source('app/settings/ai-connections/ai-connections-client.tsx');
  const form = source('app/settings/ai-connections/api-key-create-sheet.tsx');
  assert.match(owner, /<SkillInstallGuide \/>[\s\S]*<ApiKeyList \/>/u);
  assert.match(owner, /<PairingRequestList/u);
  assert.match(owner, /<GrantList/u);
  assert.ok(form.includes("useState<AccountApiKeyScopeV1[]>(['board:read'])"));
  assert.match(form, /scopes: selected/u);
});

test('API-key settings submit a closed duration without consulting the browser clock', () => {
  const form = source('app/settings/ai-connections/api-key-create-sheet.tsx');
  assert.match(form, /expiresInDays: Number\(days\)/u);
  assert.doesNotMatch(form, /Date\.now\(\)/u);
  assert.deepEqual(
    [...form.matchAll(/<option value="(30|90|365)">/gu)].map((match) => Number(match[1])),
    [30, 90, 365],
  );
});

test('one-time secret has every terminal cleanup and no persistence or diagnostic sink', () => {
  const list = source('app/settings/ai-connections/api-key-list.tsx');
  const adapter = source('lib/api/account-api-key-api.ts');
  assert.match(list, /const deadline = Date\.now\(\) \+ 60_000/u);
  assert.match(list, /document\.addEventListener\('visibilitychange'/u);
  assert.match(list, /useEffect\(\(\) => clearSecret, \[clearSecret, pathname\]\)/u);
  assert.match(list, /requestOwnership\.current\.abortAll\(\)/u);
  assert.match(
    list,
    /onCopied=\{\(\) => \{[\s\S]*setCopyStatus\('copied'\);[\s\S]*clearSecret\(\)/u,
  );
  assert.match(list, /window\.confirm\(t\('apiKey\.closeConfirm'\)\)/u);
  assert.match(
    list,
    /clearSecret\(\);[\s\S]*requestOwnership\.current\.begin\('mutation'[\s\S]*setBusy\(true\)/u,
  );
  assert.match(
    list,
    /result\.kind === 'ok'[\s\S]*value: result\.value\.apiKey[\s\S]*generationBinding: result\.value\.generationBinding/u,
  );
  assert.match(list, /subscribeGenerationInvalidation\(binding/u);
  assert.match(
    list,
    /scrubView = useCallback\([\s\S]*requestOwnership\.current\.abortAll\(\)[\s\S]*setSecret\(null\)[\s\S]*setBusy\(false\)/u,
  );
  for (const value of [
    'localStorage',
    'sessionStorage',
    'URLSearchParams',
    'console.',
    'analytics',
    'serviceWorker',
  ]) {
    assert.equal(list.includes(value), false, value);
    assert.equal(adapter.includes(value), false, value);
  }
});

test('API-key list exposes loading, error, empty, revoked, focus, and 320px states', () => {
  const list = source('app/settings/ai-connections/api-key-list.tsx');
  const styles = source('app/settings/ai-connections/api-key-management.module.css');
  assert.match(list, /'loading' \| 'ready' \| 'error'/u);
  assert.match(list, /role="alert"/u);
  assert.match(list, /items\.length === 0/u);
  assert.match(list, /item\.status === 'revoked'/u);
  assert.match(list, /triggerRef=\{trigger\}/u);
  assert.match(list, /aria-live="polite"/u);
  assert.match(list, /currentDialog\.showModal\(\)/u);
  assert.match(list, /<dialog/u);
  assert.match(list, /onCancel=\{\(event\) => \{[\s\S]*closeConfirm/u);
  assert.match(list, /autoFocus/u);
  assert.match(list, /nextCursor !== null/u);
  assert.match(list, /appendUniqueItems/u);
  assert.match(list, /loadPage\(nextCursor, true\)/u);
  assert.match(list, /loadPage\(null, false\)/u);
  assert.match(list, /apiKey\.refresh/u);
  assert.match(list, /authSessionClient\(\)\.reconcile\(\)/u);
  assert.match(list, /result\.kind === 'stale_attempt'/u);
  assert.match(list, /staleRecovery\.current\.recover/u);
  assert.match(list, /window\.location\.assign\('\/login'\)/u);
  assert.match(list, /apiKey\.retry/u);
  assert.match(styles, /@media \(max-width: 320px\)/u);
});

test('API-key list owns requests per operation and scrubs the view generation synchronously', () => {
  const list = source('app/settings/ai-connections/api-key-list.tsx');
  const adapter = source('lib/api/account-api-key-api.ts');
  assert.match(list, /requestOwnership\.current\.begin\('list'/u);
  assert.match(list, /requestOwnership\.current\.begin\('mutation'/u);
  assert.match(list, /requestOwnership\.current\.abortAll\(\)/u);
  assert.match(list, /bindCurrentGeneration\(\)/u);
  assert.match(list, /subscribeGenerationInvalidation\(binding/u);
  assert.match(
    list,
    /setItems\(\[\]\)[\s\S]*setNextCursor\(null\)[\s\S]*setSecret\(null\)[\s\S]*setBusy\(false\)[\s\S]*setContinuationState\('idle'\)/u,
  );
  assert.match(adapter, /dispatchSharedForGeneration\(binding/u);
  assert.match(adapter, /class AccountApiKeyStaleRecovery/u);
  assert.match(adapter, /callbacks\.scrub\(\)[\s\S]*this\.active !== null/u);
});
