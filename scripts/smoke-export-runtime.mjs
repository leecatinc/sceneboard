import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repositoryRoot = resolve(new URL('..', import.meta.url).pathname);
const inContainer = process.env.SCENEBOARD_EXPORT_RUNTIME_IN_CONTAINER === '1';

if (!inContainer) {
  const lock = JSON.parse(
    await readFile(
      resolve(repositoryRoot, 'deploy/sceneboard-be-export/chromium.lock.json'),
      'utf8',
    ),
  );
  const run = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=128m',
      '--tmpfs',
      '/home/sceneboard/.cache:rw,noexec,nosuid,size=16m',
      '--tmpfs',
      '/home/sceneboard/.config:rw,noexec,nosuid,size=16m',
      '--pids-limit',
      '256',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--env',
      'SCENEBOARD_EXPORT_RUNTIME_IN_CONTAINER=1',
      lock.imageTag,
      'node',
      '--import',
      'tsx',
      'scripts/smoke-export-runtime.mjs',
    ],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (run.status !== 0) {
    process.stderr.write(run.stderr || run.stdout || 'export runtime smoke failed\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(run.stdout);
  }
} else {
  await import('./verify-export-runtime.mjs');

  const { chromium } = await import('playwright');
  const { default: PptxGenJS } = await import('pptxgenjs');
  const { readFile: readRuntimeFile } = await import('node:fs/promises');
  const { exportChromiumLaunchOptionsV1 } =
    await import('../sceneboard-be/dist/exports/export-renderer.service.js');
  const { PdfExportEncoderV1 } =
    await import('../sceneboard-be/dist/exports/pdf-export.encoder.js');

  const expectedUid = Number(process.env.SCENEBOARD_EXPORT_RUNTIME_UID);
  if (
    !Number.isSafeInteger(expectedUid) ||
    typeof process.getuid !== 'function' ||
    process.getuid() !== expectedUid ||
    expectedUid === 0
  )
    throw new Error('export runtime smoke must run as the dedicated non-root user');

  const runtimeRoot = process.env.SCENEBOARD_EXPORT_RUNTIME_ROOT ?? '/opt/sceneboard';
  const executablePath =
    process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE ??
    resolve(runtimeRoot, 'ms-playwright/chromium-1217/chrome-linux64/chrome');
  const korean = await readRuntimeFile(
    resolve(runtimeRoot, 'fonts/noto-sans-kr-korean-400-normal.woff2'),
  );
  const latin = await readRuntimeFile(
    resolve(runtimeRoot, 'fonts/noto-sans-kr-latin-400-normal.woff2'),
  );
  const browser = await chromium.launch(
    exportChromiumLaunchOptionsV1({ executablePath, timeout: 30_000 }),
  );
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
      locale: 'en-US',
      timezoneId: 'UTC',
      serviceWorkers: 'block',
    });
    await page.setContent(`<!doctype html>
      <style>
        @font-face{font-family:ExportNotoKorean;src:url(data:font/woff2;base64,${korean.toString('base64')})}
        @font-face{font-family:ExportNotoLatin;src:url(data:font/woff2;base64,${latin.toString('base64')})}
        *{animation:none!important;transition:none!important}
        body{margin:0}
        .latin{font:400 32px ExportNotoLatin}
        .korean{font:400 32px ExportNotoKorean}
      </style><main><span class="latin">SceneBoard export</span><span class="korean">한글</span></main>`);
    await page.evaluate(() => globalThis.document.fonts.ready);
    const loaded = await page.evaluate(
      () =>
        globalThis.document.fonts.check('400 32px ExportNotoLatin', 'SceneBoard') &&
        globalThis.document.fonts.check('400 32px ExportNotoKorean', '한글'),
    );
    if (!loaded) throw new Error('locked export fonts did not load');
    const png = await page.screenshot({ type: 'png', animations: 'disabled' });
    if (png.byteLength < 1_000) throw new Error('export runtime PNG smoke failed');
    process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE = executablePath;
    const pdf = await new PdfExportEncoderV1().encode({
      boardTitle: 'SceneBoard export runtime smoke',
      deadlineMs: Date.now() + 30_000,
      lease: {
        generatedAt: '1970-01-01T00:00:00.000Z',
        pages: [{ pageIndex: 0, pageId: 'smoke_page', png }],
        projection: {
          format: {
            pdf: { widthMm: 338.67, heightMm: 190.5 },
          },
        },
      },
    });
    if (!Buffer.from(pdf).subarray(0, 5).equals(Buffer.from('%PDF-', 'ascii')))
      throw new Error('export runtime PDF smoke failed');
    const imported = PptxGenJS;
    const Constructor =
      typeof imported === 'function'
        ? imported
        : typeof imported?.default === 'function'
          ? imported.default
          : null;
    if (Constructor === null) throw new Error('export runtime PPTX constructor unavailable');
    const presentation = new Constructor();
    presentation.layout = 'LAYOUT_WIDE';
    const slide = presentation.addSlide();
    slide.addImage({
      data: `image/png;base64,${png.toString('base64')}`,
      x: 0,
      y: 0,
      w: 13.333,
      h: 7.5,
    });
    const pptx = await presentation.write({ outputType: 'nodebuffer', compression: true });
    if (!Buffer.from(pptx).subarray(0, 2).equals(Buffer.from('PK', 'ascii')))
      throw new Error('export runtime PPTX smoke failed');
    await page.close();
  } finally {
    await browser.close();
  }
  process.stdout.write('export runtime smoke passed\n');
}
