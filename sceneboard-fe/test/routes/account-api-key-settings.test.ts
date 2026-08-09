import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { formatApiKeyNameTimestamp } from '../../app/settings/ai-connections/api-key-name';
import { buildApiKeyMcpJsonExample } from '../../app/settings/ai-connections/api-key-mcp-example';

const root = new URL('../../', import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), 'utf8');

test('API-key settings preserve pairing and default to minimum read-only authority', () => {
  const owner = source('app/settings/ai-connections/ai-connections-client.tsx');
  const form = source('app/settings/ai-connections/api-key-create-sheet.tsx');
  assert.match(
    owner,
    /<SkillInstallGuide \/>[\s\S]*<PairingRequestList[\s\S]*<GrantList[\s\S]*<ApiKeyList \/>/u,
  );
  assert.ok(
    form.includes("const DEFAULT_SCOPES: readonly AccountApiKeyScopeV1[] = ['board:read']"),
  );
  assert.ok(form.includes('useState<AccountApiKeyScopeV1[]>([...DEFAULT_SCOPES])'));
  assert.equal(form.includes('useState<AccountApiKeyScopeV1[]>([...ALL_SCOPES])'), false);
  assert.match(form, /scopes: selected/u);
  assert.match(form, /setSelected\(\[\.\.\.ALL_SCOPES\]\)/u);
  assert.match(form, /setSelected\(\[\]\)/u);
});

test('AI client and account API-key methods use equal independent surface groups', () => {
  const owner = source('app/settings/ai-connections/ai-connections-client.tsx');
  const apiKeys = source('app/settings/ai-connections/api-key-list.tsx');
  const groups = source('app/settings/ai-connections/connection-method-group.module.css');
  assert.match(
    owner,
    /groupStyles\.group[\s\S]*ai-client-connection-title[\s\S]*<PairingRequestList[\s\S]*<GrantList/u,
  );
  assert.match(apiKeys, /groupStyles\.group[\s\S]*api-key-title/u);
  assert.match(groups, /background: var\(--surface\)/u);
  assert.match(groups, /box-shadow: 0 14px 36px/u);
});

test('AI connection bootstrap reuses the authenticated route session', () => {
  const owner = source('app/settings/ai-connections/ai-connections-client.tsx');
  assert.match(owner, /auth\.snapshot\(\) === null/u);
  assert.doesNotMatch(owner, /auth\.reconcile\(\)/u);
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

test('blank API-key names receive a stable local timestamp name while entered names win', () => {
  const form = source('app/settings/ai-connections/api-key-create-sheet.tsx');
  assert.equal(formatApiKeyNameTimestamp(new Date(2026, 7, 4, 16, 5)), '2026-08-04 16:05');
  assert.match(form, /trimmedName\.length > 0[\s\S]*trimmedName[\s\S]*apiKey\.defaultName/u);
  assert.match(form, /formatApiKeyNameTimestamp\(new Date\(\)\)/u);
  assert.match(form, /apiKey\.nameAutoHint/u);
  assert.doesNotMatch(form, /\brequired\b|nameError|nameRequired/u);
});

test('one-time secret has every terminal cleanup and no persistence or diagnostic sink', () => {
  const list = source('app/settings/ai-connections/api-key-list.tsx');
  const adapter = source('lib/api/account-api-key-api.ts');
  assert.doesNotMatch(list, /60_000|visibilitychange/u);
  assert.match(list, /useEffect\(\(\) => clearSetupModal, \[clearSetupModal, pathname\]\)/u);
  assert.match(list, /requestOwnership\.current\.abortAll\(\)/u);
  assert.doesNotMatch(list, /onCopied=/u);
  assert.match(list, /value=\{secret\.value\}[\s\S]*onCopyFailed/u);
  assert.match(list, /window\.confirm\(t\('apiKey\.closeConfirm'\)\)/u);
  assert.match(
    list,
    /clearSetupModal\(\);[\s\S]*requestOwnership\.current\.begin\('mutation'[\s\S]*setBusy\(true\)/u,
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

test('API-key list exposes loading, error, empty, focus, and 320px states', () => {
  const list = source('app/settings/ai-connections/api-key-list.tsx');
  const styles = source('app/settings/ai-connections/api-key-management.module.css');
  assert.match(list, /'loading' \| 'ready' \| 'error'/u);
  assert.match(list, /role="alert"/u);
  assert.match(list, /items\.length === 0/u);
  assert.match(
    list,
    /setItems\(\(current\) =>[\s\S]*current\.filter\(\(value\) => value\.apiKeyId !== item\.apiKeyId\)/u,
  );
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

test('one-time secret modal builds a directly usable MCP example while legacy guides stay secret-free', () => {
  const list = source('app/settings/ai-connections/api-key-list.tsx');
  const example = source('app/settings/ai-connections/api-key-mcp-example.ts');
  const styles = source('app/settings/ai-connections/api-key-management.module.css');
  assert.match(list, /type SecretSetupTab = 'mcp' \| 'environment'/u);
  assert.match(list, /role="tablist"[\s\S]*role="tab"[\s\S]*role="tabpanel"/u);
  assert.match(list, /apiKey\.mcpTab[\s\S]*apiKey\.environmentTab/u);
  assert.match(example, /BOARD_CREDENTIAL_MODE[\s\S]*api_key/u);
  assert.match(example, /BOARD_ACCESS_TOKEN_REF[\s\S]*env:\/\/SCENEBOARD_API_KEY/u);
  assert.match(list, /buildApiKeyMcpJsonExample\(secret\?\.value \?\? null\)/u);
  assert.match(list, /POSIX_ENV_EXAMPLE[\s\S]*POWERSHELL_ENV_EXAMPLE/u);
  const issuedKey = 'sbk_v1.test-key-material';
  const inline = JSON.parse(buildApiKeyMcpJsonExample(issuedKey));
  assert.equal(inline.mcpServers.sceneboard.env.SCENEBOARD_API_KEY, issuedKey);
  assert.equal('env_vars' in inline.mcpServers.sceneboard, false);
  const reopened = JSON.parse(buildApiKeyMcpJsonExample(null));
  assert.equal(reopened.mcpServers.sceneboard.env.SCENEBOARD_API_KEY, undefined);
  assert.deepEqual(reopened.mcpServers.sceneboard.env_vars, ['SCENEBOARD_API_KEY']);
  assert.match(styles, /max-height: calc\(100dvh - 32px\)/u);
  assert.match(styles, /overflow-y: auto/u);
  assert.match(styles, /\.setupTab\[aria-selected='true'\]/u);
});

test('existing API-key items reopen the setup guide without exposing a raw key', () => {
  const list = source('app/settings/ai-connections/api-key-list.tsx');
  const styles = source('app/settings/ai-connections/api-key-management.module.css');
  assert.match(list, /const \[guideItem, setGuideItem\]/u);
  assert.match(list, /className=\{styles\.keyGuideButton\}[\s\S]*setGuideItem\(item\)/u);
  assert.match(list, /secret !== null \|\| guideItem !== null/u);
  assert.match(list, /apiKey\.guideTitle[\s\S]*apiKey\.guideDescription/u);
  assert.match(list, /guideItem\?\.name[\s\S]*guideItem\?\.prefix/u);
  assert.match(list, /secret !== null \?[\s\S]*secret\.value[\s\S]*guideKeySummary/u);
  assert.match(styles, /\.keyGuideButton:focus-visible/u);
  assert.match(styles, /\.guideKeySummary/u);
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
