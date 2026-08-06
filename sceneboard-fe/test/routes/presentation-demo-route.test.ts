import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  resolvePresentationDemoLanguage,
  resolvePresentationDemoUrl,
} from '../../lib/landing/presentation-demo';

const workspace = resolve(import.meta.dirname, '../..');
const source = (path: string): string => readFileSync(resolve(workspace, path), 'utf8');
const locator = 'share_abcdefghijklmnopqrstuv_g7';

test('the presentation demo accepts only an approved persistent SceneBoard share locator', () => {
  for (const origin of ['https://sceneboard.leecat.co.kr', 'https://sceneboard.dev'])
    assert.equal(resolvePresentationDemoUrl(`${origin}/s/${locator}`), `${origin}/s/${locator}`);

  assert.equal(
    resolvePresentationDemoUrl(
      'https://sceneboard.leecat.co.kr/s/share_abcdefghijklmnopqrstuv_g9007199254740991',
    ),
    'https://sceneboard.leecat.co.kr/s/share_abcdefghijklmnopqrstuv_g9007199254740991',
  );
});

test('the presentation demo reserves Korean for ko and uses English for every other locale', () => {
  assert.equal(resolvePresentationDemoLanguage('ko'), 'ko');
  for (const locale of [undefined, 'en', 'ja', 'zh-CN', 'zh-TW', 'es', 'fr', 'de', 'pt-BR', 'ru'])
    assert.equal(resolvePresentationDemoLanguage(locale), 'en');
  assert.equal(resolvePresentationDemoLanguage(['ko']), 'en');
});

test('the presentation demo rejects every alternate or secret-bearing URL shape', () => {
  const denied = [
    undefined,
    '',
    ` ${`https://sceneboard.dev/s/${locator}`}`,
    `http://sceneboard.dev/s/${locator}`,
    `https://example.com/s/${locator}`,
    `https://user@sceneboard.dev/s/${locator}`,
    `https://sceneboard.dev/s/${locator}?next=https://example.com`,
    `https://sceneboard.dev/s/${locator}#fragment`,
    `https://sceneboard.dev/s/${locator}/extra`,
    'https://sceneboard.dev/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'https://sceneboard.dev/s/share_abcdefghijklmnopqrstuv_g0',
    'https://sceneboard.dev/s/share_abcdefghijklmnopqrstuv_g9007199254740992',
    'https://sceneboard.dev/boards/share_abcdefghijklmnopqrstuv_g1',
  ];

  for (const value of denied) assert.equal(resolvePresentationDemoUrl(value), null, String(value));
});

test('the server route selects private Korean and English environment values and fails closed', () => {
  const page = source('app/demo/presentation/page.tsx');

  assert.match(page, /resolvePresentationDemoLanguage\(\(await searchParams\)\.locale\)/u);
  assert.match(page, /process\.env\.SCENEBOARD_PRESENTATION_DEMO_URL_KO/u);
  assert.match(page, /process\.env\.SCENEBOARD_PRESENTATION_DEMO_URL_EN/u);
  assert.match(page, /process\.env\.SCENEBOARD_PRESENTATION_DEMO_URL/u);
  assert.match(page, /if \(destination === null\) notFound\(\)/u);
  assert.match(page, /redirect\(destination\)/u);
  assert.doesNotMatch(page, /NEXT_PUBLIC_/u);
});
