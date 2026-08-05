import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const workspace = resolve(import.meta.dirname, '../..');

const source = (path: string): string => readFileSync(resolve(workspace, path), 'utf8');

test('the root route is a public product landing page while authentication remains on /login', () => {
  const rootPage = source('app/page.tsx');
  const loginPage = source('app/(auth)/login/page.tsx');

  assert.doesNotMatch(rootPage, /redirect\(['"]\/boards['"]\)/);
  assert.match(rootPage, /<LandingPage/);
  assert.match(loginPage, /<LoginForm \/>/);
});

test('the landing page leads with presentations and preserves the product story and auth routes', () => {
  const landingPage = source('components/landing/LandingPage.tsx');
  const landingStyles = source('components/landing/LandingPage.module.css');
  const languageSelect = source('components/landing/LandingLanguageSelect.tsx');
  const sessionActions = source('components/landing/LandingSessionActions.tsx');
  const demoVideo = source('components/landing/DemoVideo.tsx');
  const interfaceCatalog = source('lib/i18n/interface-catalog.ts');

  assert.match(landingPage, /useI18n/);
  assert.match(landingPage, /presentation\.landingTitleLead/);
  assert.match(landingPage, /presentation\.landingPublicTitle/);
  assert.match(landingPage, /presentation\.landingPresentTitle/);
  assert.match(landingPage, /presentation\.landingExportTitle/);
  assert.match(landingPage, /className=\{styles\.presentationPreview\}/);
  assert.match(landingPage, /href="\/demo\/presentation"/);
  assert.match(landingPage, /target="_blank"/);
  assert.match(landingPage, /rel="noopener noreferrer"/);
  assert.match(landingStyles, /\.hero h1\[data-locale='ko'\][\s\S]*?word-break: keep-all;/);
  assert.match(
    landingStyles,
    /grid-template-columns: minmax\(0, 1\.02fr\) minmax\(540px, 0\.98fr\)/,
  );
  assert.match(
    landingStyles,
    /\.page\s*\{[^}]*height:\s*100dvh;[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);[^}]*overflow:\s*hidden;/su,
  );
  assert.match(landingStyles, /\.scrollArea\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/su);
  assert.ok(
    landingPage.indexOf('presentation.landingTitleLead') <
      landingPage.indexOf('landing.heroTitleLead'),
  );
  assert.match(landingPage, /landing\.decisionTitle/);
  assert.match(landingPage, /landing\.visualTitle/);
  assert.match(interfaceCatalog, /Apache-2\.0/);
  assert.match(landingPage, /href="\/login"/);
  assert.match(landingPage, /href="\/signup"/);
  assert.match(landingPage, /<LandingLanguageSelect \/>/);
  assert.match(languageSelect, /SUPPORTED_LOCALES\.map/);
  assert.match(languageSelect, /setLocale\(event\.target\.value as Locale\)/);
  assert.match(languageSelect, /aria-label=\{t\('settings\.languageTitle'\)\}/);
  assert.match(sessionActions, /href="\/boards"/);
  assert.match(sessionActions, /useI18n/);
  assert.match(sessionActions, /landing\.openSceneBoard/);
  assert.match(demoVideo, /NEXT_PUBLIC_SCENEBOARD_DEMO_VIDEO_URL/);
  assert.match(demoVideo, /media\.sceneboard\.dev\/demo\/sceneboard-demo-3min\.mp4/);
  assert.match(demoVideo, /preload="metadata"/);
  assert.match(demoVideo, /playsInline/);
  assert.match(demoVideo, /landing\.videoUnavailableTitle/);
  assert.equal(landingPage.match(/https:\/\/github\.com\/leecatinc\/sceneboard/g)?.length, 2);
  assert.doesNotMatch(landingPage, />Why SceneBoard</);
  assert.doesNotMatch(sessionActions, />Get started</);
  assert.doesNotMatch(demoVideo, /product film is being prepared/);
});
