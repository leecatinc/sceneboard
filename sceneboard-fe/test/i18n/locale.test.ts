import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MESSAGES, SUPPORTED_LOCALES, messageKeys } from '../../lib/i18n/catalog';
import { AI_CONNECTIONS_CATALOG } from '../../lib/i18n/catalogs/ai-connections';
import { AI_PAIRING_CATALOG } from '../../lib/i18n/catalogs/ai-pairing';
import { AUTH_CATALOG } from '../../lib/i18n/catalogs/auth';
import { BOARD_CATALOG } from '../../lib/i18n/catalogs/board';
import { BOARDS_CATALOG } from '../../lib/i18n/catalogs/boards';
import { CODEX_CATALOG } from '../../lib/i18n/catalogs/codex';
import { COMMON_CATALOG } from '../../lib/i18n/catalogs/common';
import { PRESENTATION_CATALOG } from '../../lib/i18n/catalogs/presentation';
import { SETTINGS_CATALOG } from '../../lib/i18n/catalogs/settings';
import { SHARING_CATALOG } from '../../lib/i18n/catalogs/sharing';
import {
  formatMessage,
  localeFromAcceptLanguage,
  normalizeLocale,
  resolveRequestLocale,
} from '../../lib/i18n/locale';

const catalogBaseline = JSON.parse(
  readFileSync(new URL('./catalog-baseline.v1.json', import.meta.url), 'utf8'),
) as {
  keyCount: number;
  keyOrderSha256: string;
  localeValueSha256: Record<string, string>;
  aiPairingKeys: string[];
  aiConnectionKeys: string[];
};

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('catalog baseline freezes ordered locale values and the AI topic partition', () => {
  const keys = messageKeys().filter(
    (key) => !key.startsWith('presentation.') && !key.startsWith('sharing.'),
  );
  assert.equal(keys.length, catalogBaseline.keyCount);
  assert.equal(digest(keys), catalogBaseline.keyOrderSha256);
  for (const locale of SUPPORTED_LOCALES)
    assert.equal(
      digest(keys.map((key) => MESSAGES[locale][key])),
      catalogBaseline.localeValueSha256[locale],
    );
  const aiKeys = keys.filter((key) => key.startsWith('ai.'));
  assert.deepEqual(
    aiKeys.filter((key) => catalogBaseline.aiPairingKeys.includes(key)),
    catalogBaseline.aiPairingKeys,
  );
  assert.deepEqual(
    aiKeys.filter((key) => catalogBaseline.aiConnectionKeys.includes(key)),
    catalogBaseline.aiConnectionKeys,
  );
  assert.deepEqual(
    [...catalogBaseline.aiPairingKeys, ...catalogBaseline.aiConnectionKeys].sort(),
    [...aiKeys].sort(),
  );
});

test('presentation messages are isolated from the frozen catalog baseline', () => {
  assert.deepEqual(
    messageKeys().filter((key) => key.startsWith('presentation.')),
    [
      'presentation.boardControls',
      'presentation.closeBoardControls',
      'presentation.movePage',
      'presentation.stopMoving',
      'presentation.enterPresentation',
      'presentation.exitPresentation',
      'presentation.presentationControls',
      'presentation.showControls',
      'presentation.displayMode',
      'presentation.fitPage',
      'presentation.fitWidth',
      'presentation.actualSize',
      'presentation.pageNavigation',
      'presentation.previousPage',
      'presentation.nextPage',
      'presentation.pageAnnouncement',
    ],
  );
});

test('topic catalogs have one owner per key and stay below the physical line cap', () => {
  const modules = [
    ['common', COMMON_CATALOG],
    ['auth', AUTH_CATALOG],
    ['board', BOARD_CATALOG],
    ['boards', BOARDS_CATALOG],
    ['settings', SETTINGS_CATALOG],
    ['ai-pairing', AI_PAIRING_CATALOG],
    ['ai-connections', AI_CONNECTIONS_CATALOG],
    ['codex', CODEX_CATALOG],
    ['presentation', PRESENTATION_CATALOG],
    ['sharing', SHARING_CATALOG],
  ] as const;
  const ownedKeys = modules.flatMap(([, rows]) => rows.map((row) => row[0]));
  assert.equal(new Set(ownedKeys).size, ownedKeys.length);
  assert.deepEqual(
    AI_PAIRING_CATALOG.map((row) => row[0]),
    catalogBaseline.aiPairingKeys,
  );
  assert.deepEqual(
    AI_CONNECTIONS_CATALOG.map((row) => row[0]),
    catalogBaseline.aiConnectionKeys,
  );
  for (const [name] of modules) {
    const lines = readFileSync(
      new URL(`../../lib/i18n/catalogs/${name}.ts`, import.meta.url),
      'utf8',
    ).split('\n').length;
    assert.ok(lines < 800, `${name}:${lines}`);
  }
  const aggregator = readFileSync(new URL('../../lib/i18n/catalog.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(aggregator, /\[\s*'[a-z-]+\.[^']+',\s*'(?![a-z-]+\.)/u);
});

test('SceneBoard exposes the ten selected locales with a complete non-empty catalog', () => {
  assert.deepEqual(SUPPORTED_LOCALES, [
    'ko',
    'en',
    'ja',
    'zh-CN',
    'zh-TW',
    'es',
    'fr',
    'de',
    'pt-BR',
    'ru',
  ]);
  const keys = messageKeys();
  assert.ok(keys.length >= 90);
  assert.equal(new Set(keys).size, keys.length);
  for (const locale of SUPPORTED_LOCALES) {
    assert.deepEqual(Object.keys(MESSAGES[locale]), keys);
    for (const key of keys) assert.ok(MESSAGES[locale][key].trim().length > 0, `${locale}:${key}`);
  }
});

test('browser language matching handles regional Chinese, Portuguese, and quality weights', () => {
  assert.equal(normalizeLocale('zh-Hant-HK'), 'zh-TW');
  assert.equal(normalizeLocale('zh-SG'), 'zh-CN');
  assert.equal(normalizeLocale('pt-PT'), 'pt-BR');
  assert.equal(localeFromAcceptLanguage('fr-CA;q=0.8,ko-KR;q=0.9,en;q=0.7'), 'ko');
  assert.equal(localeFromAcceptLanguage('nl-NL,ru-RU;q=0.6'), 'ru');
});

test('saved locale wins over browser language and interpolation stays localized', () => {
  assert.equal(resolveRequestLocale('de', 'ko-KR'), 'de');
  assert.equal(resolveRequestLocale('unsupported', 'ja-JP'), 'ja');
  assert.equal(formatMessage('ko', 'boards.revision', { number: 7 }), '리비전 7');
});
