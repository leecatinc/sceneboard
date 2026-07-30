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

test('one-time secret has every terminal cleanup and no persistence or diagnostic sink', () => {
  const list = source('app/settings/ai-connections/api-key-list.tsx');
  const adapter = source('lib/api/account-api-key-api.ts');
  assert.match(list, /window\.setTimeout\(clearSecret, 60_000\)/u);
  assert.match(list, /useEffect\(\(\) => clearSecret, \[clearSecret, pathname\]\)/u);
  assert.match(list, /activeRequest\.current\?\.abort\(\)/u);
  assert.match(
    list,
    /onCopied=\{\(\) => \{[\s\S]*clearSecret\(\);[\s\S]*trigger\.current\?\.focus\(\)/u,
  );
  assert.match(list, /window\.confirm\(t\('apiKey\.closeConfirm'\)\)/u);
  assert.match(
    list,
    /clearSecret\(\);[\s\S]*const controller = beginRequest\(\);[\s\S]*setBusy\(true\)/u,
  );
  assert.match(list, /result\?\.kind === 'ok'[\s\S]*setSecret\(result\.value\.apiKey\)/u);
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
  assert.match(styles, /@media \(max-width: 320px\)/u);
});
