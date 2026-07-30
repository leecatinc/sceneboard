import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import mysql from 'mysql2/promise';
import { chromium, request as requestFactory } from 'playwright';

if (process.env.SCENEBOARD_CERTIFICATION_DISPOSABLE_DATABASE !== 'true')
  throw new Error('browser certification requires a disposable database');

const requiredEnvironment = [
  'MYSQL_HOST',
  'MYSQL_PORT',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
  'MYSQL_DATABASE',
  'SCENEBOARD_EXPORT_WEB_ORIGIN',
  'SCENEBOARD_EXPORT_API_ORIGIN',
  'SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE',
  'SCENEBOARD_TEST_USER_PASSWORD',
];
for (const name of requiredEnvironment)
  if (process.env[name] === undefined || process.env[name] === '')
    throw new Error(`browser certification environment is missing ${name}`);

const loopbackOrigin = (value, label) => {
  const parsed = new URL(value);
  if (
    parsed.origin !== value ||
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(parsed.hostname) ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    throw new Error(`${label} must be one canonical loopback HTTP origin`);
  return parsed.origin;
};

const webOrigin = loopbackOrigin(
  process.env.SCENEBOARD_EXPORT_WEB_ORIGIN,
  'browser certification web origin',
);
const apiOrigin = loopbackOrigin(
  process.env.SCENEBOARD_EXPORT_API_ORIGIN,
  'browser certification API origin',
);
const password = process.env.SCENEBOARD_TEST_USER_PASSWORD;

const expectStatus = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label} returned status ${actual}`);
};

const connection = await mysql.createConnection({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
});
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE,
});

try {
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const csrfResponse = await context.request.get(`${apiOrigin}/api/v1/auth/csrf`);
  expectStatus(csrfResponse.status(), 200, 'CSRF bootstrap');
  const csrfBody = await csrfResponse.json();
  const loginResponse = await context.request.post(`${apiOrigin}/api/v1/auth/login`, {
    headers: {
      Origin: webOrigin,
      'X-CSRF-Token': csrfBody.csrfToken,
    },
    data: {
      email: 'cert-browser-owner@example.test',
      password,
    },
  });
  expectStatus(loginResponse.status(), 200, 'synthetic owner login');
  const loginBody = await loginResponse.json();
  const createResponse = await context.request.post(`${apiOrigin}/api/v1/boards`, {
    headers: {
      Origin: webOrigin,
      'X-CSRF-Token': loginBody.csrfToken,
    },
    data: {
      protocolVersion: 1,
      requestId: 'cert_browser_create',
      type: 'board.create',
      idempotencyKey: 'cert-browser-create-v1',
      title: 'Certification export board',
    },
  });
  if (![200, 201].includes(createResponse.status()))
    throw new Error(`synthetic board create returned status ${createResponse.status()}`);
  const createBody = await createResponse.json();
  const result = createBody?.result?.result;
  if (
    typeof result?.board?.boardId !== 'string' ||
    typeof result?.board?.headRevision?.revisionId !== 'string' ||
    typeof result?.board?.headRevision?.revisionNumber !== 'number'
  )
    throw new Error('synthetic board response is invalid');
  const boardId = result.board.boardId;
  const revisionId = result.board.headRevision.revisionId;
  const csrfToken = loginBody.csrfToken;

  const [beforeRows] = await connection.query(
    `SELECT
       LOWER(HEX(r.revision_id)) AS revisionId,
       h.head_revision_number AS revisionNumber,
       LOWER(HEX(r.scene_sha256)) AS sceneSha256,
       LOWER(HEX(r.idempotency_scope_sha256)) AS idempotencySha256
     FROM board_heads h
     JOIN board_revisions r
       ON r.board_pk = h.board_pk AND r.revision_pk = h.head_revision_pk
     JOIN boards b ON b.board_pk = h.board_pk
     WHERE b.public_id = ?`,
    [boardId],
  );
  if (beforeRows.length !== 1) throw new Error('synthetic board head fixture is invalid');

  await page.goto(`${webOrigin}/boards/${boardId}`);
  await page
    .getByRole('button', { name: /^(Board controls|보드 컨트롤)$/u })
    .waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /^(Board controls|보드 컨트롤)$/u }).click();
  const exportButton = page.getByRole('button', { name: /^(Export|내보내기)$/u });
  await exportButton.waitFor({ state: 'visible' });
  await exportButton.click();
  const dialog = page.getByRole('dialog', { name: /^(Export board|보드 내보내기)$/u });
  await dialog.waitFor({ state: 'visible' });
  assert.ok(await dialog.getAttribute('aria-labelledby'));
  assert.ok(await dialog.getAttribute('aria-describedby'));
  await dialog.getByRole('button', { name: /^(Close|닫기)$/u }).click();

  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByRole('button', { name: /^(Board controls|보드 컨트롤)$/u }).click();
  await page.getByRole('button', { name: /^(Export|내보내기)$/u }).click();
  await dialog.waitFor({ state: 'visible' });
  const dialogBox = await dialog.boundingBox();
  if (dialogBox === null || dialogBox.width > 320)
    throw new Error('export dialog exceeds the 320px viewport');
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: /^(Create download|다운로드 만들기)$/u }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (downloadPath === null) throw new Error('PDF download did not produce a local artifact');
  const sessionBytes = await readFile(downloadPath);
  if (sessionBytes.subarray(0, 5).toString('ascii') !== '%PDF-')
    throw new Error('PDF download signature is invalid');
  await dialog.getByRole('button', { name: /^(Close|닫기)$/u }).click();

  const createApiKey = async (displayName, scopes) => {
    const value = await page.evaluate(
      async ({ origin, token, name, selectedScopes }) => {
        const response = await fetch(`${origin}/api/v1/account/api-keys`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': token,
          },
          body: JSON.stringify({
            displayName: name,
            scopes: selectedScopes,
            expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          }),
        });
        return { status: response.status, body: await response.json() };
      },
      { origin: apiOrigin, token: csrfToken, name: displayName, selectedScopes: scopes },
    );
    expectStatus(value.status, 201, 'synthetic API key issue');
    if (
      typeof value.body?.apiKey !== 'string' ||
      typeof value.body?.metadata?.apiKeyId !== 'string'
    )
      throw new Error('synthetic API key response is invalid');
    return value.body;
  };

  const allowedKey = await createApiKey('Certification export key', [
    'board:read',
    'export:read',
    'history:read',
  ]);
  const deniedKey = await createApiKey('Certification read-only key', ['board:read']);
  const keyRequest = await requestFactory.newContext();
  try {
    const missingResponse = await keyRequest.post(`${apiOrigin}/api/v1/boards/${boardId}/exports`, {
      data: { revisionId, format: 'pptx' },
    });
    expectStatus(missingResponse.status(), 401, 'missing credential export');
    const deniedResponse = await keyRequest.post(`${apiOrigin}/api/v1/boards/${boardId}/exports`, {
      headers: {
        Authorization: `Bearer ${deniedKey.apiKey}`,
        'Content-Type': 'application/json',
      },
      data: { revisionId, format: 'pptx' },
    });
    expectStatus(deniedResponse.status(), 404, 'insufficient API key export');
    const keyResponse = await keyRequest.post(`${apiOrigin}/api/v1/boards/${boardId}/exports`, {
      headers: {
        Authorization: `Bearer ${allowedKey.apiKey}`,
        'Content-Type': 'application/json',
      },
      data: { revisionId, format: 'pptx' },
    });
    expectStatus(keyResponse.status(), 200, 'API key PPTX export');
    const keyBytes = Buffer.from(await keyResponse.body());
    if (keyBytes.subarray(0, 2).toString('ascii') !== 'PK')
      throw new Error('PPTX download signature is invalid');
  } finally {
    await keyRequest.dispose();
  }

  const revokeStatuses = await page.evaluate(
    async ({ origin, token, identifiers }) =>
      Promise.all(
        identifiers.map(async (identifier) => {
          const response = await fetch(
            `${origin}/api/v1/account/api-keys/${encodeURIComponent(identifier)}`,
            {
              method: 'DELETE',
              credentials: 'include',
              headers: { 'X-CSRF-Token': token },
            },
          );
          return response.status;
        }),
      ),
    {
      origin: apiOrigin,
      token: csrfToken,
      identifiers: [allowedKey.metadata.apiKeyId, deniedKey.metadata.apiKeyId],
    },
  );
  if (revokeStatuses.some((status) => status !== 204))
    throw new Error('synthetic API key cleanup failed');

  const [afterRows] = await connection.query(
    `SELECT
       LOWER(HEX(r.revision_id)) AS revisionId,
       h.head_revision_number AS revisionNumber,
       LOWER(HEX(r.scene_sha256)) AS sceneSha256,
       LOWER(HEX(r.idempotency_scope_sha256)) AS idempotencySha256
     FROM board_heads h
     JOIN board_revisions r
       ON r.board_pk = h.board_pk AND r.revision_pk = h.head_revision_pk
     JOIN boards b ON b.board_pk = h.board_pk
     WHERE b.public_id = ?`,
    [boardId],
  );
  if (JSON.stringify(afterRows) !== JSON.stringify(beforeRows))
    throw new Error('export changed the synthetic board head or revision payload');
  await context.close();
  process.stdout.write('browser-e2e:PASS\n');
} finally {
  await browser.close();
  await connection.end();
}
