import assert from 'node:assert/strict';
import test from 'node:test';

import { MESSAGES, SUPPORTED_LOCALES, messageKeys } from '../../lib/i18n/catalog';
import {
  formatMessage,
  localeFromAcceptLanguage,
  normalizeLocale,
  resolveRequestLocale,
} from '../../lib/i18n/locale';

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
