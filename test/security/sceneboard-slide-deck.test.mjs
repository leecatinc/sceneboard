import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  SceneArtifactError,
  compileSceneArtifactDraft,
  stringifyCanonicalSceneArtifactJson,
  validateSceneArtifactTemplateDescriptor,
} from '../../sceneboard-mcp/plugins/sceneboard/skills/sceneboard/scripts/scene-artifact-core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = JSON.parse(
  readFileSync(join(root, 'test/fixtures/kitcathub-slide-deck.json'), 'utf8'),
);
const descriptor = validateSceneArtifactTemplateDescriptor(
  JSON.parse(
    readFileSync(
      join(
        root,
        'sceneboard-mcp/plugins/sceneboard/skills/sceneboard/assets/artifact-templates/slide-deck.json',
      ),
      'utf8',
    ),
  ),
);

const compile = (recipe = fixture) => compileSceneArtifactDraft(recipe, descriptor);
const reject = (recipe, code, path) =>
  assert.throws(
    () => compile(recipe),
    (error) =>
      error instanceof SceneArtifactError &&
      error.code === code &&
      (path === undefined || JSON.stringify(error.path) === JSON.stringify(path)),
  );

test('KitCatHub seven-slide deck compiles deterministically with no capabilities or resources', () => {
  const first = compile();
  const second = compile(structuredClone(fixture));
  assert.equal(
    stringifyCanonicalSceneArtifactJson(first),
    stringifyCanonicalSceneArtifactJson(second),
  );
  assert.equal(first.template, 'slide-deck');
  assert.deepEqual(first.source.requestedCapabilities, []);
  assert.match(first.source.html, /data-sb-slide-deck="v1"/);
  assert.equal((first.source.html.match(/data-deck-slide=/g) ?? []).length, 7);
  assert.match(first.source.html, /1 \/ 7/);
  assert.match(first.source.html, /aria-roledescription="slide"/);
  assert.match(first.source.html, /hidden aria-hidden="true" inert/);
  assert.match(first.source.javascript, /ArrowLeft/);
  assert.match(first.source.javascript, /ArrowRight/);
  assert.match(first.source.javascript, /Math\.max\(0,Math\.min/);
  assert.match(first.source.javascript, /ResizeObserver/);
  assert.match(first.source.javascript, /requestResize\(1920,1080\)/);
  assert.match(first.source.css, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(
    `${first.source.html}${first.source.css}${first.source.javascript}`,
    /https?:\/\/|@import|@font-face|cdn/i,
  );
  assert.doesNotThrow(() => new Function(first.source.javascript));
});

test('slide-deck initializes and navigates when ResizeObserver is unavailable', () => {
  const listeners = () => new Map();
  const element = () => ({
    attributes: new Map(),
    listeners: listeners(),
    style: {
      values: new Map(),
      setProperty(name, value) {
        this.values.set(name, value);
      },
    },
    hidden: false,
    disabled: false,
    textContent: '',
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    },
  });
  const stage = element();
  const slides = Array.from({ length: 7 }, element);
  const previous = element();
  const next = element();
  const current = element();
  const bar = element();
  let focused = 0;
  let hostResizeRequests = 0;
  const root = {
    ...element(),
    clientWidth: 960,
    clientHeight: 540,
    focus() {
      focused += 1;
    },
    querySelector(selector) {
      return new Map([
        ['[data-deck-stage]', stage],
        ['[data-deck-previous]', previous],
        ['[data-deck-next]', next],
        ['[data-deck-current]', current],
        ['[data-deck-progress]', bar],
      ]).get(selector);
    },
    querySelectorAll(selector) {
      return selector === '[data-deck-slide]' ? slides : [];
    },
  };

  assert.doesNotThrow(() =>
    runInNewContext(compile().source.javascript, {
      document: { querySelector: () => root },
      window: {
        SceneBoardArtifact: {
          requestResize(width, height) {
            assert.deepEqual([width, height], [1920, 1080]);
            hostResizeRequests += 1;
          },
        },
      },
      requestAnimationFrame(callback) {
        callback();
      },
    }),
  );
  assert.equal(slides.filter((slide) => !slide.hidden).length, 1);
  assert.equal(slides[0].attributes.get('aria-hidden'), 'false');
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, false);
  assert.equal(current.textContent, '1 / 7');
  assert.equal(stage.style.transform, 'scale(0.5)');
  assert.equal(focused, 1);
  assert.equal(hostResizeRequests, 1);

  next.listeners.get('click')();
  assert.equal(slides.filter((slide) => !slide.hidden).length, 1);
  assert.equal(current.textContent, '2 / 7');
  assert.equal(bar.attributes.get('aria-valuenow'), '2');
  assert.equal(bar.style.values.get('--sb-deck-progress'), `${(2 / 7) * 100}%`);
});

test('slide-deck rejects duplicate keys, empty titles, unknown types, and non-16:9 recipes', () => {
  const duplicate = structuredClone(fixture);
  duplicate.content.slides[1].key = duplicate.content.slides[0].key;
  reject(duplicate, 'INVALID_RELATION', ['content', 'slides', 1, 'key']);

  const emptyTitle = structuredClone(fixture);
  emptyTitle.content.slides[0].title = '';
  reject(emptyTitle, 'INVALID_VALUE', ['content', 'slides', 0, 'title']);

  const unknownType = structuredClone(fixture);
  unknownType.content.slides[0].type = 'generic';
  reject(unknownType, 'INVALID_VALUE', ['content', 'slides', 0, 'type']);

  const wrongSize = structuredClone(fixture);
  wrongSize.size.width = 1280;
  reject(wrongSize, 'INVALID_RELATION', ['size']);
});

test('slide-deck enforces slide count, field length, aggregate text, and closed fields', () => {
  const tooMany = structuredClone(fixture);
  tooMany.content.slides = Array.from({ length: 21 }, (_, index) => ({
    ...structuredClone(fixture.content.slides[0]),
    key: `slide${index + 1}`,
  }));
  reject(tooMany, 'LIMIT_EXCEEDED', ['content', 'slides']);

  const longDetail = structuredClone(fixture);
  longDetail.content.slides[1].items[0].detail = '가'.repeat(181);
  reject(longDetail, 'INVALID_VALUE', ['content', 'slides', 1, 'items', 0, 'detail']);

  const tooMuchText = structuredClone(fixture);
  tooMuchText.content.slides = Array.from({ length: 20 }, (_, index) => ({
    ...structuredClone(fixture.content.slides[0]),
    key: `slide${index + 1}`,
    subtitle: '가'.repeat(220),
    highlights: [
      { label: '가'.repeat(72), detail: '가'.repeat(180) },
      { label: '나'.repeat(72), detail: '나'.repeat(180) },
      { label: '다'.repeat(72), detail: '다'.repeat(180) },
    ],
  }));
  reject(tooMuchText, 'LIMIT_EXCEEDED', ['content']);

  const unknownField = structuredClone(fixture);
  unknownField.content.slides[0].html = '<script>alert(1)</script>';
  reject(unknownField, 'UNKNOWN_FIELD', ['content', 'slides', 0, 'html']);
});

test('slide-deck escapes hostile text instead of accepting authored HTML', () => {
  const hostile = structuredClone(fixture);
  hostile.content.slides[0].title = '<img src=x onerror=alert(1)>';
  const draft = compile(hostile);
  assert.doesNotMatch(draft.source.html, /<img/);
  assert.match(draft.source.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
