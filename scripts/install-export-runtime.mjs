import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
const runtimeRoot = process.env.SCENEBOARD_EXPORT_RUNTIME_ROOT ?? '/opt/sceneboard';
const chromium = JSON.parse(
  await readFile(resolve(root, 'deploy/sceneboard-be-export/chromium.lock.json'), 'utf8'),
);
const fonts = JSON.parse(
  await readFile(resolve(root, 'deploy/sceneboard-be-export/fonts.lock.json'), 'utf8'),
);

const browsersPath = resolve(runtimeRoot, 'ms-playwright');
await mkdir(browsersPath, { recursive: true });
await new Promise((resolvePromise, reject) => {
  const child = spawn(
    process.execPath,
    [resolve(root, 'node_modules/playwright/cli.js'), 'install', '--no-shell', 'chromium'],
    {
      cwd: root,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath },
      stdio: 'inherit',
    },
  );
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0 && signal === null) resolvePromise();
    else reject(new Error(`Playwright install failed (${code ?? signal})`));
  });
});
for (const entry of await readdir(browsersPath)) {
  if (entry.startsWith('chromium_headless_shell-') || entry.startsWith('ffmpeg-'))
    await rm(resolve(browsersPath, entry), { recursive: true, force: true });
}

const fontDirectory = resolve(runtimeRoot, 'fonts');
await mkdir(fontDirectory, { recursive: true });
for (const font of fonts.fonts) {
  await copyFile(
    resolve(root, 'node_modules/@fontsource/noto-sans-kr/files', font.file),
    resolve(fontDirectory, font.file),
  );
}
await copyFile(resolve(root, fonts.licensePath), resolve(fontDirectory, 'OFL-1.1.txt'));
process.stdout.write(
  `installed ${chromium.browserName} ${chromium.revision} and ${fonts.fonts.length} locked fonts\n`,
);
