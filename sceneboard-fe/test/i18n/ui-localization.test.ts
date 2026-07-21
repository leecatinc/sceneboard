import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { formatMessage } from '../../lib/i18n/locale';

const workspace = resolve(import.meta.dirname, '../..');
const source = (path: string): string => readFileSync(resolve(workspace, path), 'utf8');

test('new public, HITL, and error interfaces use the localization system', () => {
  const hitlWorkspace = source('components/board/HitlDecisionWorkspace.tsx');
  const notFound = source('app/not-found.tsx');
  const globalError = source('app/global-error.tsx');

  assert.match(hitlWorkspace, /useI18n/);
  assert.match(hitlWorkspace, /hitl\.decisionWorkspace/);
  assert.doesNotMatch(hitlWorkspace, />Decision workspace</);
  assert.match(notFound, /LocalizedNotFound/);
  assert.match(globalError, /resolveClientLocale/);
  assert.doesNotMatch(globalError, />Something went wrong</);
});

test('new interface copy changes with the selected locale', () => {
  assert.equal(formatMessage('ko', 'landing.heroTitleBase'), 'Codex가 자유롭게 사용할 수 있는');
  assert.equal(formatMessage('ja', 'landing.navHumanControl'), '人によるコントロール');
  assert.equal(formatMessage('de', 'hitl.expand'), 'Erweitern');
  assert.equal(formatMessage('ru', 'error.pageNotFound'), 'Страница не найдена.');
});

test('the landing hero scales long localized headlines without changing their copy', () => {
  const landingPage = source('components/landing/LandingPage.tsx');
  const landingStyles = source('components/landing/LandingPage.module.css');

  assert.match(landingPage, /const \{ locale, t \} = useI18n\(\)/);
  assert.match(landingPage, /<h1 data-locale=\{locale\}>/);
  assert.match(landingStyles, /\.hero h1\[data-locale='ko'\]/);
  assert.match(landingStyles, /data-locale='de'/);
  assert.match(landingStyles, /data-locale='ru'/);
  assert.match(landingStyles, /\.valueSection \.sectionHeading\s*\{[^}]*max-width: 1100px/s);
});
