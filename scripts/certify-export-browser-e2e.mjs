import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync, inflateSync } from 'node:zlib';

import bcrypt from 'bcryptjs';
import { Redis } from 'ioredis';
import mysql from 'mysql2/promise';
import { chromium, request as requestFactory } from 'playwright';
import sharp from 'sharp';

import { BROWSER_SCENARIO_IDS, validateBrowserEvidence } from './certify-ai-export-contracts.mjs';
import { canonicalJson, sha256 } from './lib/certification/canonical-json.mjs';
import {
  certificationDatabaseName,
  certificationDatabaseOwnerSha256,
} from './lib/certification/fixture-ownership.mjs';
import {
  CertificationProcessSupervisor,
  createCertificationChildEnvironment,
} from './lib/certification/process-lifecycle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputLimit = 64 * 1024;
const controlsLabel = /^(Board controls|보드 컨트롤)$/u;
const exportLabel = /^(Export|내보내기)$/u;
const exportDialogLabel = /^(Export board|보드 내보내기)$/u;
const createDownloadLabel = /^(Create download|다운로드 만들기)$/u;
const closeLabel = /^(Close|닫기)$/u;
const cancelLabel = /^(Cancel|취소)$/u;
const retryLabel = /^(Retry|다시 시도)$/u;

export const EXPORT_VISUAL_MARKERS = Object.freeze({
  retained: Object.freeze([
    Object.freeze({ id: 'retained-alpha', text: 'RETAINED ALPHA 7Q2M', rgb: [193, 58, 81] }),
    Object.freeze({ id: 'retained-beta', text: 'RETAINED BETA 4K9X', rgb: [36, 104, 162] }),
  ]),
  head: Object.freeze([
    Object.freeze({ id: 'head-alpha', text: 'HEAD ALPHA 8V3N', rgb: [46, 139, 87] }),
    Object.freeze({ id: 'head-beta', text: 'HEAD BETA 6D1R', rgb: [208, 138, 22] }),
  ]),
});

const markerFor = (suffix, pageIndex) => {
  const revision = suffix === 'retained' ? 'retained' : suffix === 'head' ? 'head' : null;
  const marker = revision === null ? undefined : EXPORT_VISUAL_MARKERS[revision][pageIndex];
  if (marker === undefined) throw new Error('browser fixture marker is invalid');
  return marker;
};

const requiredEnvironment = (environment, names) => {
  for (const name of names) {
    if (environment[name] === undefined || environment[name] === '')
      throw new Error(`browser certification environment is missing ${name}`);
  }
};

const exactStatus = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label} returned status ${actual}`);
};

const oneOfStatus = (actual, expected, label) => {
  if (!expected.includes(actual)) throw new Error(`${label} returned status ${actual}`);
};

const appendBounded = (chunks, chunk) => {
  chunks.push(Buffer.from(chunk).toString('utf8'));
  let length = chunks.reduce((sum, value) => sum + Buffer.byteLength(value), 0);
  while (length > outputLimit && chunks.length > 1) {
    length -= Buffer.byteLength(chunks.shift());
  }
};

const observeChild = (child) => {
  const output = [];
  child.stdout?.on('data', (chunk) => appendBounded(output, chunk));
  child.stderr?.on('data', (chunk) => appendBounded(output, chunk));
  return output;
};

const waitForChild = async (child, label) =>
  new Promise((resolveChild, rejectChild) => {
    child.once('error', () => rejectChild(new Error(`${label} could not start`)));
    child.once('exit', (code, signal) => {
      if (code === 0) resolveChild();
      else rejectChild(new Error(`${label} exited with ${String(code ?? signal)}`));
    });
  });

export const waitForHttpReadiness = async ({
  url,
  child,
  expectedStatuses = [200],
  timeoutMs = 90_000,
  fetchImpl = fetch,
}) => {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined)
      throw new Error('certification service exited before readiness');
    try {
      const response = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(2_000),
      });
      lastStatus = response.status;
      await response.body?.cancel();
      if (expectedStatuses.includes(response.status)) return;
    } catch {
      // Readiness is retried only inside the bounded startup window.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`certification service readiness failed with status ${lastStatus}`);
};

const reserveLoopbackPort = async () => {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  if (address === null || typeof address === 'string') throw new Error('port reservation failed');
  return address.port;
};

export const runCleanupActions = async (actions, errors) => {
  const results = await Promise.allSettled(actions.map((action) => action()));
  for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
};

const canonicalLoopbackHost = (environment) => {
  if (environment.MYSQL_HOST !== '127.0.0.1' || environment.REDIS_HOST !== '127.0.0.1')
    throw new Error('browser certification dependencies must use IPv4 loopback');
};

const keyMaterial = (label, attemptId) =>
  Buffer.from(sha256(`${label}:${attemptId}`), 'hex').toString('base64url');

export const buildServiceEnvironment = ({
  environment,
  attemptId,
  database,
  ownerSha256,
  origins,
}) =>
  createCertificationChildEnvironment(environment, {
    allowedKeys: [
      'MYSQL_HOST',
      'MYSQL_PORT',
      'MYSQL_USER',
      'MYSQL_PASSWORD',
      'REDIS_HOST',
      'REDIS_PORT',
      'REDIS_PASSWORD',
      'REDIS_DB',
      'SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE',
    ],
    overrides: {
      APP_ENV: 'test',
      NODE_ENV: 'test',
      PORT: String(origins.apiPort),
      MYSQL_DATABASE: database,
      REDIS_KEY_PREFIX: 'sceneboard:',
      SCENEBOARD_CERTIFICATION_DISPOSABLE_DATABASE: 'true',
      SCENEBOARD_CERTIFICATION_ATTEMPT_ID: attemptId,
      SCENEBOARD_CERTIFICATION_DATABASE_PURPOSE: 'browser',
      SCENEBOARD_CERTIFICATION_DATABASE_OWNER_SHA256: ownerSha256,
      BOARD_ALLOWED_ORIGINS: origins.webOrigin,
      BOARD_PUBLIC_API_ORIGIN: origins.apiOrigin,
      SCENEBOARD_EXPORT_WEB_ORIGIN: origins.webOrigin,
      SCENEBOARD_EXPORT_API_ORIGIN: origins.apiOrigin,
      SCENEBOARD_EXPORT_ARTIFACT_RUNTIME_ORIGIN: origins.runtimeOrigin,
      NEXT_PUBLIC_BOARD_API_URL: origins.apiOrigin,
      NEXT_PUBLIC_ARTIFACT_RUNTIME_ORIGIN: origins.runtimeOrigin,
      NEXT_PUBLIC_SCENEBOARD_MEDIA_ORIGIN: origins.apiOrigin,
      SCENEBOARD_GMAIL_USER: 'certification@example.test',
      SCENEBOARD_GMAIL_APP_PASSWORD: 'synthetic-app-password',
      SESSION_TOKEN_KEY_B64: keyMaterial('session', attemptId),
      GRANT_TOKEN_KEY_B64: keyMaterial('grant', attemptId),
      CSRF_KEY_B64: keyMaterial('csrf', attemptId),
      PAIRING_CODE_PEPPER_B64: keyMaterial('pairing', attemptId),
      AUDIT_HMAC_KEY_B64: keyMaterial('audit', attemptId),
      RATE_LIMIT_HMAC_KEY_B64: keyMaterial('rate-limit', attemptId),
      BOARD_CURSOR_MAC_KEY_B64: keyMaterial('cursor', attemptId),
      BOARD_STREAM_KEY_B64: Buffer.from(sha256(`stream:${attemptId}`), 'hex').toString('base64'),
      BCRYPT_COST: '10',
      AUTH_FAILURE_MIN_MS: '200',
      AUTH_FAILURE_JITTER_MS: '10',
      PAIRING_FAILURE_MIN_MS: '50',
      PAIRING_FAILURE_JITTER_MS: '10',
      TRUSTED_PROXY_CIDRS: '',
      HISTORY_RETAINED_EMISSION_ENABLED: 'true',
      REVISION_RECLAMATION_ENABLED: 'false',
      ACCOUNT_API_KEY_ISSUANCE_ENABLED: 'true',
      ACCOUNT_API_KEY_AUTH_ENABLED: 'true',
      BOARD_DOCUMENT_V3_WRITE_ENABLED: 'false',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  });

const claimDatabase = async ({
  serverOptions,
  connectionOptions,
  database,
  ownerSha256,
  state,
}) => {
  const server = await mysql.createConnection(serverOptions);
  try {
    const [existing] = await server.execute(
      'SELECT schema_name AS schemaName FROM information_schema.schemata WHERE schema_name = ?',
      [database],
    );
    if (existing.length !== 0) throw new Error('browser certification database already exists');
    await server.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    state.schemaClaimed = true;
  } finally {
    await server.end();
  }
  const owned = await mysql.createConnection(connectionOptions);
  try {
    await owned.query(
      `CREATE TABLE certification_fixture_owner (
         owner_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
         created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         PRIMARY KEY (owner_sha256)
       ) ENGINE=InnoDB`,
    );
    await owned.execute('INSERT INTO certification_fixture_owner (owner_sha256) VALUES (?)', [
      ownerSha256,
    ]);
    state.ownerMarkerInstalled = true;
  } finally {
    await owned.end();
  }
};

const assertDatabaseOwnership = async (connectionOptions, ownerSha256) => {
  const connection = await mysql.createConnection(connectionOptions);
  try {
    const [rows] = await connection.query(
      'SELECT owner_sha256 AS ownerSha256 FROM certification_fixture_owner',
    );
    if (rows.length !== 1 || rows[0].ownerSha256 !== ownerSha256)
      throw new Error('browser certification database ownership marker mismatch');
  } finally {
    await connection.end();
  }
};

const claimRedis = async (environment, ownerSha256, state) => {
  if (environment.SCENEBOARD_CERTIFICATION_DISPOSABLE_REDIS !== 'true')
    throw new Error('browser certification requires an explicitly disposable Redis database');
  const redis = new Redis({
    host: environment.REDIS_HOST,
    port: Number(environment.REDIS_PORT),
    password: environment.REDIS_PASSWORD,
    db: Number(environment.REDIS_DB),
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  await redis.connect();
  const markerKey = `sceneboard:certification-owner:${ownerSha256}`;
  try {
    if ((await redis.dbsize()) !== 0)
      throw new Error('browser certification Redis database is not empty');
    if ((await redis.set(markerKey, ownerSha256, 'NX')) !== 'OK')
      throw new Error('browser certification Redis ownership claim failed');
    state.redisClaimed = true;
    state.redis = redis;
    state.redisMarkerKey = markerKey;
  } catch (error) {
    await redis.quit().catch(() => undefined);
    throw error;
  }
};

const migrateDatabase = async (supervisor, environment) => {
  const child = supervisor.start({
    id: 'migration',
    command: resolve(root, 'node_modules/.bin/tsx'),
    args: ['sceneboard-be/src/bootstrap/persistence-certification.bootstrap.ts', 'migration', 'up'],
    env: environment,
  });
  observeChild(child);
  await waitForChild(child, 'browser certification migration');
};

const seedSyntheticPrincipals = async (connectionOptions, password) => {
  const passwordHash = await bcrypt.hash(password, 10);
  const connection = await mysql.createConnection(connectionOptions);
  const accountIds = {};
  try {
    for (const role of ['owner', 'viewer', 'editor', 'cross']) {
      const email = `cert-browser-${role}@example.test`;
      const [result] = await connection.execute(
        `INSERT INTO users (
           public_id, email_normalized, email, display_name, email_verified_at,
           password_hash, status, password_updated_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), ?, 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
        [`cert_browser_${role}`, email, email, `Certification ${role}`, passwordHash],
      );
      accountIds[role] = String(result.insertId);
    }
  } finally {
    await connection.end();
  }
  return accountIds;
};

const startService = (supervisor, specification) => {
  const child = supervisor.start(specification);
  observeChild(child);
  return child;
};

const loginContext = async ({ browser, apiOrigin, webOrigin, email, password, contexts }) => {
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
  });
  contexts.add(context);
  const csrfResponse = await context.request.get(`${apiOrigin}/api/v1/auth/csrf`);
  exactStatus(csrfResponse.status(), 200, `${email} CSRF bootstrap`);
  const csrf = await csrfResponse.json();
  const loginResponse = await context.request.post(`${apiOrigin}/api/v1/auth/login`, {
    headers: { Origin: webOrigin, 'X-CSRF-Token': csrf.csrfToken },
    data: { email, password },
  });
  exactStatus(loginResponse.status(), 200, `${email} login`);
  const login = await loginResponse.json();
  if (typeof login.csrfToken !== 'string') throw new Error('synthetic login response is invalid');
  return { context, csrfToken: login.csrfToken, page: await context.newPage() };
};

const sessionRequest = (context, csrfToken, webOrigin, method, url, data, headers = {}) =>
  context.request.fetch(url, {
    method,
    headers: {
      Origin: webOrigin,
      'X-CSRF-Token': csrfToken,
      'Content-Type': 'application/json',
      ...headers,
    },
    data,
  });

const markerScene = (suffix, pageIndex) => {
  const marker = markerFor(suffix, pageIndex);
  const fill = `#${marker.rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  return {
    protocolVersion: 1,
    type: 'scene',
    root: {
      id: `marker_${suffix}_${pageIndex}`,
      type: 'content.drawing',
      viewBox: { x: 0, y: 0, width: 1600, height: 900 },
      elements: [
        {
          id: `marker_background_${suffix}_${pageIndex}`,
          type: 'rect',
          x: 0,
          y: 0,
          width: 1600,
          height: 900,
          style: { fill, stroke: fill, strokeWidth: 0, opacity: 1 },
        },
        {
          id: `marker_text_${suffix}_${pageIndex}`,
          type: 'text',
          x: 140,
          y: 260,
          text: marker.text,
          style: { fill: '#ffffff', stroke: '#ffffff', strokeWidth: 1, opacity: 1 },
        },
      ],
    },
  };
};

const mutationDocument = (suffix) => ({
  schemaVersion: 2,
  defaultPageId: 'cert_page_alpha',
  pages: [
    {
      pageId: 'cert_page_alpha',
      title: `Alpha ${suffix}`,
      displayMode: 'fit-page',
      scene: markerScene(suffix, 0),
    },
    {
      pageId: 'cert_page_beta',
      title: `Beta ${suffix}`,
      displayMode: 'fit-page',
      scene: markerScene(suffix, 1),
    },
  ],
});

const unwrapOperation = (body) => body?.result?.result ?? body?.result;

const createBoardFixtures = async ({
  owner,
  apiOrigin,
  webOrigin,
  connectionOptions,
  accountIds,
}) => {
  const createResponse = await sessionRequest(
    owner.context,
    owner.csrfToken,
    webOrigin,
    'POST',
    `${apiOrigin}/api/v1/boards`,
    {
      protocolVersion: 1,
      requestId: 'cert_browser_create',
      type: 'board.create',
      idempotencyKey: 'cert-browser-create-v1',
      title: 'Certification export board',
    },
  );
  oneOfStatus(createResponse.status(), [200, 201], 'synthetic board create');
  const created = unwrapOperation(await createResponse.json());
  const boardId = created?.board?.boardId;
  const initialRevisionId = created?.board?.headRevision?.revisionId;
  if (typeof boardId !== 'string' || typeof initialRevisionId !== 'string')
    throw new Error('synthetic board response is invalid');

  const replace = async (expectedRevisionId, suffix, requestId) => {
    const response = await sessionRequest(
      owner.context,
      owner.csrfToken,
      webOrigin,
      'POST',
      `${apiOrigin}/api/v1/boards/${boardId}/mutations?documentSchemaVersion=2`,
      {
        protocolVersion: 1,
        requestId,
        idempotencyKey: `${requestId}-idempotency`,
        boardId,
        expectedRevisionId,
        command: { type: 'document.replace', document: mutationDocument(suffix) },
      },
    );
    oneOfStatus(response.status(), [200, 201], `synthetic document ${suffix}`);
    const result = unwrapOperation(await response.json());
    if (typeof result?.revision?.revisionId !== 'string')
      throw new Error('synthetic mutation response is invalid');
    return result.revision.revisionId;
  };
  const retainedRevisionId = await replace(initialRevisionId, 'retained', 'cert_browser_retained');
  const headRevisionId = await replace(retainedRevisionId, 'head', 'cert_browser_head');

  const connection = await mysql.createConnection(connectionOptions);
  try {
    const [boards] = await connection.execute(
      'SELECT board_pk AS boardPk FROM boards WHERE public_id = ?',
      [boardId],
    );
    if (boards.length !== 1) throw new Error('synthetic board database row is invalid');
    for (const role of ['viewer', 'editor']) {
      await connection.execute(
        `INSERT INTO board_memberships (
           public_id, board_pk, account_pk, role, state, version,
           owner_account_pk, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'active', 1, NULL, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
        [`cert_membership_${role}`, boards[0].boardPk, accountIds[role], role],
      );
    }
  } finally {
    await connection.end();
  }
  return { boardId, retainedRevisionId, headRevisionId };
};

const boardPayloadState = async (connection, boardId) => {
  const [rows] = await connection.execute(
    `SELECT b.title, b.archived_at AS archivedAt, h.head_revision_number AS headRevisionNumber,
            h.last_event_sequence AS lastEventSequence, r.revision_number AS revisionNumber,
            LOWER(HEX(r.scene_sha256)) AS sceneSha256,
            LOWER(HEX(r.idempotency_scope_sha256)) AS idempotencySha256
       FROM boards b
       JOIN board_heads h ON h.board_pk = b.board_pk
       JOIN board_revisions r ON r.board_pk = b.board_pk
      WHERE b.public_id = ?
      ORDER BY r.revision_number`,
    [boardId],
  );
  if (rows.length !== 3) throw new Error('synthetic revision fixture is not closed');
  return rows;
};

const openExportDialog = async (page) => {
  const exportButton = page.getByRole('button', { name: exportLabel });
  if (!(await exportButton.isVisible())) {
    await page.getByRole('button', { name: controlsLabel }).click();
  }
  await exportButton.waitFor({ state: 'visible' });
  await exportButton.click();
  const dialog = page.getByRole('dialog', { name: exportDialogLabel });
  await dialog.waitFor({ state: 'visible' });
  return { dialog, exportButton };
};

const selectRetainedRevision = async (page) => {
  const history = page
    .getByRole('combobox')
    .filter({ hasText: /(?:Revision|리비전)/u })
    .first();
  await history.waitFor({ state: 'visible' });
  await history.click();
  const option = page
    .getByRole('option')
    .filter({ hasText: /(?:Revision|리비전)\s*2\b/u })
    .first();
  await option.waitFor({ state: 'visible' });
  await option.click();
  await page
    .getByText(/(?:Revision|리비전)\s*2\b/u)
    .first()
    .waitFor({ state: 'visible' });
};

const downloadFromDialog = async (page, dialog) => {
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: createDownloadLabel }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (path === null) throw new Error('browser download did not produce a local artifact');
  return readFile(path);
};

const pdfPageCount = (bytes) =>
  [
    ...Buffer.from(bytes)
      .toString('latin1')
      .matchAll(/\/Type\s*\/Page\b/gu),
  ].length;

const zipEntries = (bytes) => {
  const input = Buffer.from(bytes);
  let eocd = -1;
  for (let index = input.length - 22; index >= Math.max(0, input.length - 65_557); index -= 1) {
    if (input.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error('PPTX central directory is missing');
  const count = input.readUInt16LE(eocd + 10);
  let offset = input.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (input.readUInt32LE(offset) !== 0x02014b50) throw new Error('PPTX central entry is invalid');
    const method = input.readUInt16LE(offset + 10);
    const compressedSize = input.readUInt32LE(offset + 20);
    const nameLength = input.readUInt16LE(offset + 28);
    const extraLength = input.readUInt16LE(offset + 30);
    const commentLength = input.readUInt16LE(offset + 32);
    const localOffset = input.readUInt32LE(offset + 42);
    const name = input.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (input.readUInt32LE(localOffset) !== 0x04034b50)
      throw new Error('PPTX local entry is invalid');
    const localNameLength = input.readUInt16LE(localOffset + 26);
    const localExtraLength = input.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = input.subarray(start, start + compressedSize);
    entries.set(name, method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

const xmlAttribute = (xml, expression, label) => {
  const match = expression.exec(xml);
  if (match === null || typeof match[1] !== 'string')
    throw new Error(`${label} is missing from the exported artifact`);
  return match[1];
};

const pptxPageImages = (bytes) => {
  const archive = zipEntries(bytes);
  const slides = [...archive.keys()]
    .filter((name) => /^ppt\/slides\/slide[1-9][0-9]*\.xml$/u.test(name))
    .sort((left, right) => {
      const leftIndex = Number(/slide([0-9]+)\.xml$/u.exec(left)?.[1]);
      const rightIndex = Number(/slide([0-9]+)\.xml$/u.exec(right)?.[1]);
      return leftIndex - rightIndex;
    });
  return slides.map((slideName) => {
    const slide = archive.get(slideName)?.toString('utf8') ?? '';
    const relationshipId = xmlAttribute(
      slide,
      /<a:blip\b[^>]*\br:embed="([^"]+)"/u,
      `${slideName} image relationship`,
    );
    const relationshipName = slideName.replace('/slides/', '/slides/_rels/') + '.rels';
    const relationships = archive.get(relationshipName)?.toString('utf8') ?? '';
    const relationship = relationships
      .match(/<Relationship\b[^>]*\/>/gu)
      ?.find((value) => new RegExp(`\\bId="${relationshipId}"`, 'u').test(value));
    if (relationship === undefined) throw new Error(`${slideName} image relationship is invalid`);
    const target = xmlAttribute(relationship, /\bTarget="([^"]+)"/u, `${slideName} image target`);
    if (!/^\.\.\/media\/[A-Za-z0-9._-]+$/u.test(target))
      throw new Error(`${slideName} image target is invalid`);
    const image = archive.get(`ppt/${target.slice(3)}`);
    if (image === undefined) throw new Error(`${slideName} image is missing`);
    return image;
  });
};

const pdfObjects = (bytes) => {
  const input = Buffer.from(bytes);
  const source = input.toString('latin1');
  const matches = [...source.matchAll(/(?:^|[\r\n])(\d+)\s+0\s+obj\b/gu)];
  const objects = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    const objectId = Number(matches[index][1]);
    const start = matches[index].index + matches[index][0].length;
    const limit = index + 1 < matches.length ? matches[index + 1].index : input.length;
    const end = source.lastIndexOf('endobj', limit);
    if (!Number.isSafeInteger(objectId) || objectId < 1 || end < start)
      throw new Error('PDF indirect object table is invalid');
    objects.set(objectId, input.subarray(start, end));
  }
  if (objects.size === 0) throw new Error('PDF indirect object table is missing');
  return objects;
};

const pdfDictionary = (body) => {
  const source = body.toString('latin1');
  const streamIndex = source.indexOf('stream');
  return source.slice(0, streamIndex < 0 ? source.length : streamIndex);
};

const pdfReference = (source, key) => {
  const match = new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R\\b`, 'u').exec(source);
  return match === null ? null : Number(match[1]);
};

const pdfStream = (objects, objectId) => {
  const body = objects.get(objectId);
  if (body === undefined) throw new Error('PDF stream reference is invalid');
  const source = body.toString('latin1');
  const marker = /stream\r?\n/gu.exec(source);
  if (marker === null) throw new Error('PDF stream is missing');
  const dictionary = source.slice(0, marker.index);
  const lengthReference = pdfReference(dictionary, 'Length');
  const directLength = /\/Length\s+(\d+)\b(?!\s+0\s+R)/u.exec(dictionary);
  const lengthSource =
    lengthReference === null
      ? directLength?.[1]
      : objects.get(lengthReference)?.toString('ascii').trim();
  const length = Number(lengthSource);
  const start = marker.index + marker[0].length;
  if (!Number.isSafeInteger(length) || length < 0 || start + length > body.length)
    throw new Error('PDF stream length is invalid');
  let decoded = Buffer.from(body.subarray(start, start + length));
  if (/\/Filter\s*\/FlateDecode\b/u.test(dictionary)) decoded = inflateSync(decoded);
  else if (/\/Filter\b/u.test(dictionary) && !/\/Filter\s*\/DCTDecode\b/u.test(dictionary))
    throw new Error('PDF stream filter is unsupported');
  return { dictionary, bytes: decoded };
};

const pdfPageObjectIds = (objects) => {
  const catalog = [...objects.entries()].find(([, body]) =>
    /\/Type\s*\/Catalog\b/u.test(pdfDictionary(body)),
  );
  if (catalog === undefined) throw new Error('PDF catalog is missing');
  const rootPages = pdfReference(pdfDictionary(catalog[1]), 'Pages');
  if (rootPages === null) throw new Error('PDF page tree is missing');
  const pages = [];
  const visit = (objectId, ancestors = new Set()) => {
    if (ancestors.has(objectId)) throw new Error('PDF page tree is circular');
    const body = objects.get(objectId);
    if (body === undefined) throw new Error('PDF page tree reference is invalid');
    const dictionary = pdfDictionary(body);
    if (/\/Type\s*\/Page\b/u.test(dictionary)) {
      pages.push(objectId);
      return;
    }
    if (!/\/Type\s*\/Pages\b/u.test(dictionary)) throw new Error('PDF page tree node is invalid');
    const kids = /\/Kids\s*\[([^\]]+)\]/u.exec(dictionary)?.[1] ?? '';
    const childIds = [...kids.matchAll(/(\d+)\s+0\s+R\b/gu)].map((match) => Number(match[1]));
    if (childIds.length === 0) throw new Error('PDF page tree node is empty');
    const nextAncestors = new Set(ancestors).add(objectId);
    for (const childId of childIds) visit(childId, nextAncestors);
  };
  visit(rootPages);
  return pages;
};

const pdfXObjectMap = (objects, pageDictionary) => {
  const resourcesReference = pdfReference(pageDictionary, 'Resources');
  const resources =
    resourcesReference === null
      ? pageDictionary
      : pdfDictionary(objects.get(resourcesReference) ?? Buffer.alloc(0));
  if (resources === undefined) throw new Error('PDF page resources are missing');
  const xObjectReference = pdfReference(resources, 'XObject');
  const xObjects =
    xObjectReference === null
      ? /\/XObject\s*<<(.*?)>>/su.exec(resources)?.[1]
      : pdfDictionary(objects.get(xObjectReference) ?? Buffer.alloc(0));
  if (xObjects === undefined) throw new Error('PDF page image resources are missing');
  return new Map(
    [...xObjects.matchAll(/\/([A-Za-z0-9]+)\s+(\d+)\s+0\s+R\b/gu)].map((match) => [
      match[1],
      Number(match[2]),
    ]),
  );
};

const decodePngPredictor = (bytes, width, height, channels, predictor) => {
  const rowBytes = width * channels;
  if (predictor < 10) {
    if (bytes.length !== rowBytes * height) throw new Error('PDF image byte length is invalid');
    return bytes;
  }
  if (bytes.length !== (rowBytes + 1) * height) throw new Error('PDF PNG predictor is invalid');
  const output = Buffer.alloc(rowBytes * height);
  for (let row = 0; row < height; row += 1) {
    const filter = bytes[row * (rowBytes + 1)];
    const inputOffset = row * (rowBytes + 1) + 1;
    const outputOffset = row * rowBytes;
    for (let column = 0; column < rowBytes; column += 1) {
      const left = column >= channels ? output[outputOffset + column - channels] : 0;
      const above = row > 0 ? output[outputOffset + column - rowBytes] : 0;
      const upperLeft =
        row > 0 && column >= channels ? output[outputOffset + column - rowBytes - channels] : 0;
      const value = bytes[inputOffset + column];
      if (filter === 0) output[outputOffset + column] = value;
      else if (filter === 1) output[outputOffset + column] = (value + left) & 0xff;
      else if (filter === 2) output[outputOffset + column] = (value + above) & 0xff;
      else if (filter === 3)
        output[outputOffset + column] = (value + Math.floor((left + above) / 2)) & 0xff;
      else if (filter === 4) {
        const estimate = left + above - upperLeft;
        const leftDistance = Math.abs(estimate - left);
        const aboveDistance = Math.abs(estimate - above);
        const upperLeftDistance = Math.abs(estimate - upperLeft);
        const prediction =
          leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
            ? left
            : aboveDistance <= upperLeftDistance
              ? above
              : upperLeft;
        output[outputOffset + column] = (value + prediction) & 0xff;
      } else throw new Error('PDF PNG predictor filter is invalid');
    }
  }
  return output;
};

const rawPdfImage = async (objects, objectId) => {
  const { dictionary, bytes } = pdfStream(objects, objectId);
  if (!/\/Subtype\s*\/Image\b/u.test(dictionary))
    throw new Error('PDF page resource is not an image');
  const width = Number(/\/Width\s+(\d+)\b/u.exec(dictionary)?.[1]);
  const height = Number(/\/Height\s+(\d+)\b/u.exec(dictionary)?.[1]);
  const bits = Number(/\/BitsPerComponent\s+(\d+)\b/u.exec(dictionary)?.[1]);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    bits !== 8
  )
    throw new Error('PDF page image dimensions are invalid');
  if (/\/Filter\s*\/DCTDecode\b/u.test(dictionary)) {
    const decoded = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return {
      data: decoded.data,
      width: decoded.info.width,
      height: decoded.info.height,
      channels: decoded.info.channels,
    };
  }
  const channels = /\/ColorSpace\s*\/DeviceGray\b/u.test(dictionary)
    ? 1
    : /\/ColorSpace\s*\/DeviceRGB\b/u.test(dictionary)
      ? 3
      : 0;
  if (channels === 0) throw new Error('PDF page image color space is unsupported');
  const predictor = Number(/\/Predictor\s+(\d+)\b/u.exec(dictionary)?.[1] ?? 1);
  const decoded = decodePngPredictor(bytes, width, height, channels, predictor);
  return { data: decoded, width, height, channels };
};

const pdfPageImages = async (bytes) => {
  const objects = pdfObjects(bytes);
  const images = [];
  for (const pageId of pdfPageObjectIds(objects)) {
    const pageDictionary = pdfDictionary(objects.get(pageId));
    const contentReferences = /\/Contents\s*\[([^\]]+)\]/u.exec(pageDictionary)?.[1];
    const contentIds = contentReferences
      ? [...contentReferences.matchAll(/(\d+)\s+0\s+R\b/gu)].map((match) => Number(match[1]))
      : [pdfReference(pageDictionary, 'Contents')].filter((value) => value !== null);
    const xObjects = pdfXObjectMap(objects, pageDictionary);
    const usedNames = [];
    for (const contentId of contentIds) {
      const content = pdfStream(objects, contentId).bytes.toString('latin1');
      usedNames.push(
        ...[...content.matchAll(/\/([A-Za-z0-9]+)\s+Do\b/gu)].map((match) => match[1]),
      );
    }
    const imageIds = usedNames
      .map((name) => xObjects.get(name))
      .filter((objectId) => objectId !== undefined)
      .filter((objectId) => /\/Subtype\s*\/Image\b/u.test(pdfDictionary(objects.get(objectId))));
    if (imageIds.length !== 1) throw new Error('PDF page must contain exactly one rendered image');
    images.push(await rawPdfImage(objects, imageIds[0]));
  }
  return images;
};

const rawPngImage = async (bytes) => {
  const decoded = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    data: decoded.data,
    width: decoded.info.width,
    height: decoded.info.height,
    channels: decoded.info.channels,
  };
};

const markerCoverage = (image, rgb) => {
  let matches = 0;
  const pixels = image.width * image.height;
  for (let offset = 0; offset < image.data.length; offset += image.channels) {
    const red = image.data[offset];
    const green = image.channels === 1 ? red : image.data[offset + 1];
    const blue = image.channels === 1 ? red : image.data[offset + 2];
    if (
      Math.abs(red - rgb[0]) <= 4 &&
      Math.abs(green - rgb[1]) <= 4 &&
      Math.abs(blue - rgb[2]) <= 4
    )
      matches += 1;
  }
  return matches / pixels;
};

const identifyVisualMarker = (image) => {
  const markers = [...EXPORT_VISUAL_MARKERS.retained, ...EXPORT_VISUAL_MARKERS.head];
  const matches = markers.filter((marker) => markerCoverage(image, marker.rgb) >= 0.2);
  if (matches.length !== 1) throw new Error('exported page visual marker is missing or ambiguous');
  return matches[0].id;
};

export const verifyRetainedExportArtifacts = async ({ pdfBytes, pptxBytes }) => {
  const [pdfImages, pptxImages] = await Promise.all([
    pdfPageImages(pdfBytes),
    Promise.all(pptxPageImages(pptxBytes).map(rawPngImage)),
  ]);
  const expectedMarkerIds = EXPORT_VISUAL_MARKERS.retained.map(({ id }) => id);
  const headMarkerIds = EXPORT_VISUAL_MARKERS.head.map(({ id }) => id);
  const pdfMarkerIds = pdfImages.map(identifyVisualMarker);
  const pptxMarkerIds = pptxImages.map(identifyVisualMarker);
  assert.deepEqual(pdfMarkerIds, expectedMarkerIds);
  assert.deepEqual(pptxMarkerIds, expectedMarkerIds);
  if ([...pdfMarkerIds, ...pptxMarkerIds].some((id) => headMarkerIds.includes(id)))
    throw new Error('head revision marker leaked into retained export');
  return {
    schemaVersion: 1,
    revision: 'retained',
    expectedMarkerIds,
    pdfMarkerIds,
    pptxMarkerIds,
    absentHeadMarkerIds: headMarkerIds,
    pdfArtifactSha256: sha256(pdfBytes),
    pptxArtifactSha256: sha256(pptxBytes),
  };
};

const recordScenario = (scenarioEvidence, id, evidence) => {
  if (!BROWSER_SCENARIO_IDS.includes(id) || scenarioEvidence.has(id))
    throw new Error('browser certification scenario ownership is invalid');
  scenarioEvidence.set(id, sha256(canonicalJson(evidence)));
};

const createApiKey = async (owner, apiOrigin, webOrigin, displayName, scopes) => {
  const response = await sessionRequest(
    owner.context,
    owner.csrfToken,
    webOrigin,
    'POST',
    `${apiOrigin}/api/v1/account/api-keys`,
    {
      displayName,
      scopes,
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    },
  );
  exactStatus(response.status(), 201, 'synthetic API key issue');
  const value = await response.json();
  if (typeof value?.apiKey !== 'string' || typeof value?.metadata?.apiKeyId !== 'string')
    throw new Error('synthetic API key response is invalid');
  return value;
};

const failurePayload = (code, message, retryable) =>
  canonicalJson({ ok: false, error: { code, message, retryable } });

export const runBrowserCertification = async (environment = process.env) => {
  requiredEnvironment(environment, [
    'MYSQL_HOST',
    'MYSQL_PORT',
    'MYSQL_USER',
    'MYSQL_PASSWORD',
    'MYSQL_DATABASE',
    'REDIS_HOST',
    'REDIS_PORT',
    'REDIS_PASSWORD',
    'REDIS_DB',
    'SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE',
    'SCENEBOARD_TEST_USER_PASSWORD',
    'SCENEBOARD_CERTIFICATION_DISPOSABLE_DATABASE',
    'SCENEBOARD_CERTIFICATION_DISPOSABLE_REDIS',
    'SCENEBOARD_CERTIFICATION_ATTEMPT_ID',
    'SCENEBOARD_CERTIFICATION_DATABASE_PURPOSE',
    'SCENEBOARD_CERTIFICATION_DATABASE_OWNER_SHA256',
  ]);
  canonicalLoopbackHost(environment);
  if (environment.SCENEBOARD_CERTIFICATION_DISPOSABLE_DATABASE !== 'true')
    throw new Error('browser certification requires a disposable database');
  const attemptId = environment.SCENEBOARD_CERTIFICATION_ATTEMPT_ID;
  const fixtureAttemptId = `${attemptId}.browser`;
  const database = certificationDatabaseName(fixtureAttemptId);
  const ownerSha256 = certificationDatabaseOwnerSha256(fixtureAttemptId);
  if (
    environment.MYSQL_DATABASE !== database ||
    environment.SCENEBOARD_CERTIFICATION_DATABASE_PURPOSE !== 'browser' ||
    environment.SCENEBOARD_CERTIFICATION_DATABASE_OWNER_SHA256 !== ownerSha256
  )
    throw new Error('browser certification database is not owned by this attempt');

  const serverOptions = {
    host: environment.MYSQL_HOST,
    port: Number(environment.MYSQL_PORT),
    user: environment.MYSQL_USER,
    password: environment.MYSQL_PASSWORD,
  };
  const connectionOptions = { ...serverOptions, database };
  const supervisor = new CertificationProcessSupervisor({ workspaceRoot: root });
  const state = {
    schemaClaimed: false,
    ownerMarkerInstalled: false,
    redisClaimed: false,
    redis: null,
    redisMarkerKey: null,
  };
  const contexts = new Set();
  const requestContexts = new Set();
  const createdApiKeyIds = [];
  const createdGrantIds = [];
  const scenarioEvidence = new Map();
  let browser;
  let owner;
  let connection;
  let serviceOrigins;
  let report;
  let primaryFailure;
  const cleanupFailures = [];
  let revokedCredentialCount = 0;
  let databaseResidueCount = null;
  let redisResidueCount = null;

  try {
    await claimDatabase({ serverOptions, connectionOptions, database, ownerSha256, state });
    await claimRedis(environment, ownerSha256, state);
    const ports = await Promise.all([
      reserveLoopbackPort(),
      reserveLoopbackPort(),
      reserveLoopbackPort(),
    ]);
    const origins = {
      apiPort: ports[0],
      apiOrigin: `http://127.0.0.1:${ports[0]}`,
      webOrigin: `http://127.0.0.1:${ports[1]}`,
      runtimeOrigin: `http://127.0.0.1:${ports[2]}`,
    };
    serviceOrigins = origins;
    const serviceEnvironment = buildServiceEnvironment({
      environment,
      attemptId,
      database,
      ownerSha256,
      origins,
    });
    await migrateDatabase(supervisor, serviceEnvironment);
    await assertDatabaseOwnership(connectionOptions, ownerSha256);
    const accountIds = await seedSyntheticPrincipals(
      connectionOptions,
      environment.SCENEBOARD_TEST_USER_PASSWORD,
    );

    const backend = startService(supervisor, {
      id: 'backend',
      command: resolve(root, 'node_modules/.bin/tsx'),
      args: ['sceneboard-be/src/main.ts'],
      env: serviceEnvironment,
    });
    await waitForHttpReadiness({ url: `${origins.apiOrigin}/api/v1/auth/csrf`, child: backend });
    const frontend = startService(supervisor, {
      id: 'frontend',
      command: resolve(root, 'node_modules/.bin/next'),
      args: ['dev', 'sceneboard-fe', '--hostname', '127.0.0.1', '--port', String(ports[1])],
      env: serviceEnvironment,
    });
    await waitForHttpReadiness({
      url: `${origins.webOrigin}/login`,
      child: frontend,
      expectedStatuses: [200, 307, 308],
    });

    browser = await chromium.launch({
      headless: true,
      executablePath: environment.SCENEBOARD_EXPORT_CHROMIUM_EXECUTABLE,
    });
    owner = await loginContext({
      browser,
      apiOrigin: origins.apiOrigin,
      webOrigin: origins.webOrigin,
      email: 'cert-browser-owner@example.test',
      password: environment.SCENEBOARD_TEST_USER_PASSWORD,
      contexts,
    });
    const fixture = await createBoardFixtures({
      owner,
      apiOrigin: origins.apiOrigin,
      webOrigin: origins.webOrigin,
      connectionOptions,
      accountIds,
    });
    connection = await mysql.createConnection(connectionOptions);
    const beforeState = await boardPayloadState(connection, fixture.boardId);

    await owner.page.goto(`${origins.webOrigin}/boards/${fixture.boardId}`);
    await owner.page.locator('[data-page-heading]').waitFor({ state: 'visible' });
    await selectRetainedRevision(owner.page);
    const firstDialog = await openExportDialog(owner.page);
    assert.ok(await firstDialog.dialog.getAttribute('aria-labelledby'));
    assert.ok(await firstDialog.dialog.getAttribute('aria-describedby'));
    const pdfBytes = Buffer.from(await downloadFromDialog(owner.page, firstDialog.dialog));
    if (pdfBytes.subarray(0, 5).toString('ascii') !== '%PDF-')
      throw new Error('PDF download signature is invalid');
    recordScenario(scenarioEvidence, 'owner-session-pdf', {
      signature: '%PDF-',
      bytesSha256: sha256(pdfBytes),
    });
    await firstDialog.dialog.getByRole('button', { name: closeLabel }).click();

    const allowedKey = await createApiKey(
      owner,
      origins.apiOrigin,
      origins.webOrigin,
      'Certification export key',
      ['board:read', 'export:read', 'history:read'],
    );
    createdApiKeyIds.push(allowedKey.metadata.apiKeyId);
    const deniedKey = await createApiKey(
      owner,
      origins.apiOrigin,
      origins.webOrigin,
      'Certification read-only key',
      ['board:read'],
    );
    createdApiKeyIds.push(deniedKey.metadata.apiKeyId);
    const keyRequest = await requestFactory.newContext();
    requestContexts.add(keyRequest);
    const keyResponse = await keyRequest.post(
      `${origins.apiOrigin}/api/v1/boards/${fixture.boardId}/exports`,
      {
        headers: { Authorization: `Bearer ${allowedKey.apiKey}` },
        data: { revisionId: fixture.retainedRevisionId, format: 'pptx' },
      },
    );
    exactStatus(keyResponse.status(), 200, 'API key PPTX export');
    const pptxBytes = Buffer.from(await keyResponse.body());
    if (pptxBytes.subarray(0, 2).toString('ascii') !== 'PK')
      throw new Error('PPTX download signature is invalid');
    recordScenario(scenarioEvidence, 'scoped-api-key-pptx', {
      signature: 'PK',
      bytesSha256: sha256(pptxBytes),
    });
    const missingResponse = await keyRequest.post(
      `${origins.apiOrigin}/api/v1/boards/${fixture.boardId}/exports`,
      { data: { revisionId: fixture.retainedRevisionId, format: 'pptx' } },
    );
    exactStatus(missingResponse.status(), 401, 'missing credential export');
    recordScenario(scenarioEvidence, 'missing-key-denial', { status: 401 });
    const deniedResponse = await keyRequest.post(
      `${origins.apiOrigin}/api/v1/boards/${fixture.boardId}/exports`,
      {
        headers: { Authorization: `Bearer ${deniedKey.apiKey}` },
        data: { revisionId: fixture.retainedRevisionId, format: 'pptx' },
      },
    );
    oneOfStatus(deniedResponse.status(), [403, 404], 'insufficient API key export');
    recordScenario(scenarioEvidence, 'insufficient-key-denial', {
      status: deniedResponse.status(),
    });

    for (const { role, scenarioId } of [
      { role: 'viewer', scenarioId: 'viewer-control-denial' },
      { role: 'editor', scenarioId: 'editor-control-denial' },
    ]) {
      const principal = await loginContext({
        browser,
        apiOrigin: origins.apiOrigin,
        webOrigin: origins.webOrigin,
        email: `cert-browser-${role}@example.test`,
        password: environment.SCENEBOARD_TEST_USER_PASSWORD,
        contexts,
      });
      await principal.page.goto(`${origins.webOrigin}/boards/${fixture.boardId}`);
      await principal.page.locator('[data-page-heading]').waitFor({ state: 'visible' });
      assert.equal(await principal.page.getByRole('button', { name: exportLabel }).count(), 0);
      const denial = await sessionRequest(
        principal.context,
        principal.csrfToken,
        origins.webOrigin,
        'POST',
        `${origins.apiOrigin}/api/v1/boards/${fixture.boardId}/exports`,
        { revisionId: fixture.retainedRevisionId, format: 'pdf' },
      );
      oneOfStatus(denial.status(), [403, 404], `${role} export`);
      recordScenario(scenarioEvidence, scenarioId, {
        controlCount: 0,
        status: denial.status(),
      });
    }

    const shareResponse = await sessionRequest(
      owner.context,
      owner.csrfToken,
      origins.webOrigin,
      'POST',
      `${origins.apiOrigin}/api/v1/boards/${fixture.boardId}/shares`,
      { pinnedRevisionId: fixture.retainedRevisionId },
      { 'Idempotency-Key': 'certification-share-idempotency' },
    );
    exactStatus(shareResponse.status(), 201, 'public share create');
    const share = await shareResponse.json();
    if (typeof share?.linkToken !== 'string') throw new Error('public share response is invalid');
    const publicContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    contexts.add(publicContext);
    const publicPage = await publicContext.newPage();
    await publicPage.goto(`${origins.webOrigin}/s/${share.linkToken}`);
    await publicPage.locator('[data-page-heading]').waitFor({ state: 'visible' });
    assert.equal(await publicPage.getByRole('button', { name: exportLabel }).count(), 0);
    recordScenario(scenarioEvidence, 'public-share-control-denial', { controlCount: 0 });

    const cross = await loginContext({
      browser,
      apiOrigin: origins.apiOrigin,
      webOrigin: origins.webOrigin,
      email: 'cert-browser-cross@example.test',
      password: environment.SCENEBOARD_TEST_USER_PASSWORD,
      contexts,
    });
    await cross.page.goto(`${origins.webOrigin}/boards/${fixture.boardId}`);
    assert.equal(await cross.page.getByRole('button', { name: exportLabel }).count(), 0);
    const crossResponse = await sessionRequest(
      cross.context,
      cross.csrfToken,
      origins.webOrigin,
      'POST',
      `${origins.apiOrigin}/api/v1/boards/${fixture.boardId}/exports`,
      { revisionId: fixture.retainedRevisionId, format: 'pdf' },
    );
    exactStatus(crossResponse.status(), 404, 'cross-account export');
    recordScenario(scenarioEvidence, 'cross-account-denial', { controlCount: 0, status: 404 });

    const pairingCreate = await sessionRequest(
      owner.context,
      owner.csrfToken,
      origins.webOrigin,
      'POST',
      `${origins.apiOrigin}/api/v1/pairings`,
      {},
    );
    exactStatus(pairingCreate.status(), 201, 'pairing create');
    const pairing = await pairingCreate.json();
    const proof = randomBytes(32);
    const proofValue = proof.toString('base64url');
    const pairingRequest = await requestFactory.newContext();
    requestContexts.add(pairingRequest);
    const claimed = await pairingRequest.post(`${origins.apiOrigin}/api/v1/pairings/claim`, {
      data: {
        code: pairing.code,
        installationId: 'certification-installation-v1',
        clientName: 'Certification client',
        requestedScopes: ['board.read'],
        requestedLifecyclePermissions: [],
        clientProofChallenge: Buffer.from(sha256(proof), 'hex').toString('base64url'),
      },
    });
    exactStatus(claimed.status(), 202, 'pairing claim');
    const decision = await sessionRequest(
      owner.context,
      owner.csrfToken,
      origins.webOrigin,
      'POST',
      `${origins.apiOrigin}/api/v1/pairings/${pairing.pairingId}/decision`,
      {
        decision: 'approve',
        approvedScopes: ['board.read'],
        approvedLifecyclePermissions: [],
        destination: { mode: 'existing', boardId: fixture.boardId },
        lifetime: 'session',
      },
    );
    exactStatus(decision.status(), 200, 'pairing approval');
    const redeemed = await pairingRequest.post(
      `${origins.apiOrigin}/api/v1/pairings/${pairing.pairingId}/redeem`,
      { headers: { Authorization: `PairingProof ${proofValue}` }, data: {} },
    );
    exactStatus(redeemed.status(), 200, 'pairing redeem');
    const redeemedBody = await redeemed.json();
    if (typeof redeemedBody?.accessToken !== 'string')
      throw new Error('pairing redeem did not return one-time credentials');
    if (typeof redeemedBody?.grant?.grantId !== 'string')
      throw new Error('pairing redeem did not return an owned grant');
    createdGrantIds.push(redeemedBody.grant.grantId);
    recordScenario(scenarioEvidence, 'pairing-regression', {
      createStatus: 201,
      claimStatus: 202,
      decisionStatus: 200,
      redeemStatus: 200,
    });

    assert.notEqual(fixture.retainedRevisionId, fixture.headRevisionId);
    const artifactSemantics = await verifyRetainedExportArtifacts({ pdfBytes, pptxBytes });
    recordScenario(scenarioEvidence, 'retained-non-head-revision', {
      retainedRevisionNumber: 2,
      headRevisionNumber: 3,
      revision: artifactSemantics.revision,
      markerIds: artifactSemantics.expectedMarkerIds,
      absentHeadMarkerIds: artifactSemantics.absentHeadMarkerIds,
    });
    const pageCount = pdfPageCount(pdfBytes);
    if (pageCount !== 2) throw new Error('PDF page order fixture has an unexpected page count');
    recordScenario(scenarioEvidence, 'pdf-page-signature-order', {
      signature: '%PDF-',
      pageCount,
      pageOrderSha256: sha256(canonicalJson(artifactSemantics.pdfMarkerIds)),
      artifactSha256: artifactSemantics.pdfArtifactSha256,
    });
    const archive = zipEntries(pptxBytes);
    const slides = [...archive.keys()]
      .filter((name) => /^ppt\/slides\/slide[1-9][0-9]*\.xml$/u.test(name))
      .sort((left, right) => left.localeCompare(right, 'en'));
    if (
      slides.length !== 2 ||
      slides[0] !== 'ppt/slides/slide1.xml' ||
      slides[1] !== 'ppt/slides/slide2.xml'
    )
      throw new Error('PPTX slide order fixture is invalid');
    recordScenario(scenarioEvidence, 'pptx-slide-signature-order', {
      signature: 'PK',
      slideCount: slides.length,
      slideOrderSha256: sha256(canonicalJson(artifactSemantics.pptxMarkerIds)),
      artifactSha256: artifactSemantics.pptxArtifactSha256,
    });

    const cancelDialog = await openExportDialog(owner.page);
    const exportUrl = `${origins.apiOrigin}/api/v1/boards/${fixture.boardId}/exports`;
    const startedRequest = owner.page.waitForRequest(
      (request) => request.url() === exportUrl && request.method() === 'POST',
    );
    await cancelDialog.dialog.getByRole('button', { name: createDownloadLabel }).click();
    const cancelRequest = await startedRequest;
    const failedRequest = owner.page.waitForEvent('requestfailed', {
      predicate: (request) => request === cancelRequest,
      timeout: 10_000,
    });
    await cancelDialog.dialog.getByRole('button', { name: cancelLabel }).click();
    await failedRequest;
    recordScenario(scenarioEvidence, 'cancel-aborts', { requestFailed: true });

    let retryAttempt = 0;
    await owner.page.route(exportUrl, async (route) => {
      retryAttempt += 1;
      if (retryAttempt === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: failurePayload(
            'EXPORT_RENDERER_UNAVAILABLE',
            'Export renderer is unavailable',
            true,
          ),
        });
      } else await route.continue();
    });
    const retryDialog = await openExportDialog(owner.page);
    await retryDialog.dialog.getByRole('button', { name: createDownloadLabel }).click();
    const retryButton = retryDialog.dialog.getByRole('button', { name: retryLabel });
    await retryButton.waitFor({ state: 'visible' });
    const retryDownload = owner.page.waitForEvent('download');
    await retryButton.click();
    await retryDownload;
    await owner.page.unroute(exportUrl);
    await retryDialog.dialog.getByRole('button', { name: closeLabel }).click();
    recordScenario(scenarioEvidence, 'retryable-failure-retry', { attempts: retryAttempt });

    await owner.page.route(exportUrl, async (route) =>
      route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: failurePayload(
          'EXPORT_REQUIRED_CONTENT_UNSUPPORTED',
          'Required content cannot be exported',
          false,
        ),
      }),
    );
    const nonRetryDialog = await openExportDialog(owner.page);
    await nonRetryDialog.dialog.getByRole('button', { name: createDownloadLabel }).click();
    await nonRetryDialog.dialog.getByRole('alert').waitFor({ state: 'visible' });
    assert.equal(await nonRetryDialog.dialog.getByRole('button', { name: retryLabel }).count(), 0);
    recordScenario(scenarioEvidence, 'non-retryable-failure-no-retry', { retryCount: 0 });
    await nonRetryDialog.dialog.getByRole('button', { name: closeLabel }).click();
    await owner.page.unroute(exportUrl);
    await owner.page.waitForFunction(
      () =>
        globalThis.document.activeElement?.textContent?.trim() === 'Export' ||
        globalThis.document.activeElement?.textContent?.trim() === '내보내기',
    );
    recordScenario(scenarioEvidence, 'focus-restoration', { triggerFocused: true });

    await owner.page.setViewportSize({ width: 320, height: 568 });
    const narrowDialog = await openExportDialog(owner.page);
    const box = await narrowDialog.dialog.boundingBox();
    if (box === null || box.width > 320)
      throw new Error('export dialog exceeds the 320px viewport');
    recordScenario(scenarioEvidence, 'viewport-320', {
      viewportWidth: 320,
      dialogWidth: box.width,
    });
    await narrowDialog.dialog.getByRole('button', { name: closeLabel }).click();

    const afterState = await boardPayloadState(connection, fixture.boardId);
    if (canonicalJson(afterState) !== canonicalJson(beforeState))
      throw new Error('export scenarios changed board, head, or revision payloads');
    const payloadDigest = sha256(canonicalJson(beforeState));
    recordScenario(scenarioEvidence, 'board-head-revision-invariance', {
      before: payloadDigest,
      after: sha256(canonicalJson(afterState)),
    });
    if (scenarioEvidence.size !== BROWSER_SCENARIO_IDS.length - 1)
      throw new Error('browser certification scenario set is incomplete');
    report = {
      schemaVersion: 1,
      status: 'PENDING',
      scenarios: BROWSER_SCENARIO_IDS.map((id) => ({
        id,
        status: id === 'credential-and-fixture-cleanup' ? 'PENDING' : 'PASS',
        evidenceSha256: scenarioEvidence.get(id) ?? sha256(`${id}:PENDING`),
      })),
      payloadDigests: { before: payloadDigest, after: sha256(canonicalJson(afterState)) },
      artifactSemantics,
      targetTopology: {
        kind: 'isolated-loopback-browser-fixture',
        attemptId,
        databaseOwnerSha256: ownerSha256,
        frontendOrigin: serviceOrigins.webOrigin,
        apiOrigin: serviceOrigins.apiOrigin,
        runtimeOrigin: serviceOrigins.runtimeOrigin,
      },
      cleanupStatus: 'PENDING',
    };
  } catch (error) {
    primaryFailure = error;
  } finally {
    await runCleanupActions(
      [
        async () => {
          if (createdApiKeyIds.length === 0 && createdGrantIds.length === 0) return;
          if (!owner || !serviceOrigins) throw new Error('API key cleanup context is unavailable');
          for (const apiKeyId of createdApiKeyIds) {
            const response = await sessionRequest(
              owner.context,
              owner.csrfToken,
              serviceOrigins.webOrigin,
              'DELETE',
              `${serviceOrigins.apiOrigin}/api/v1/account/api-keys/${apiKeyId}`,
              undefined,
            );
            oneOfStatus(response.status(), [204, 404], 'synthetic API key cleanup');
            revokedCredentialCount += 1;
          }
          for (const grantId of createdGrantIds) {
            const response = await sessionRequest(
              owner.context,
              owner.csrfToken,
              serviceOrigins.webOrigin,
              'DELETE',
              `${serviceOrigins.apiOrigin}/api/v1/grants/${grantId}`,
              undefined,
            );
            oneOfStatus(response.status(), [204, 404], 'synthetic grant cleanup');
            revokedCredentialCount += 1;
          }
        },
      ],
      cleanupFailures,
    );
    await runCleanupActions(
      [
        ...[...requestContexts].map((requestContext) => () => requestContext.dispose()),
        ...[...contexts].map((context) => () => context.close()),
        async () => supervisor.stopAll(),
        async () => connection?.end(),
      ],
      cleanupFailures,
    );
    await runCleanupActions([async () => browser?.close()], cleanupFailures);
    await runCleanupActions(
      [
        async () => {
          if (!state.redisClaimed || state.redis === null || state.redisMarkerKey === null) return;
          try {
            if ((await state.redis.get(state.redisMarkerKey)) !== ownerSha256)
              throw new Error('browser certification Redis ownership marker mismatch');
            await state.redis.flushdb();
            redisResidueCount = await state.redis.dbsize();
            if (redisResidueCount !== 0)
              throw new Error('browser certification cleanup left Redis residue');
          } finally {
            await state.redis.quit().catch(() => state.redis.disconnect());
          }
        },
        async () => {
          if (!state.schemaClaimed) return;
          if (state.ownerMarkerInstalled)
            await assertDatabaseOwnership(connectionOptions, ownerSha256);
          const server = await mysql.createConnection(serverOptions);
          try {
            const [claimed] = await server.execute(
              'SELECT schema_name AS schemaName FROM information_schema.schemata WHERE schema_name = ?',
              [database],
            );
            if (claimed.length > 1)
              throw new Error('browser certification schema claim is ambiguous');
            if (claimed.length === 1) await server.query(`DROP DATABASE \`${database}\``);
            const [remaining] = await server.execute(
              'SELECT schema_name AS schemaName FROM information_schema.schemata WHERE schema_name = ?',
              [database],
            );
            databaseResidueCount = remaining.length;
            if (databaseResidueCount !== 0)
              throw new Error('browser certification cleanup left database residue');
          } finally {
            await server.end();
          }
        },
      ],
      cleanupFailures,
    );
    if (report && cleanupFailures.length === 0) {
      const cleanupEvidence = sha256(
        canonicalJson({
          databaseOwnershipVerified: state.ownerMarkerInstalled,
          databaseResidueCount,
          redisResidueCount,
          revokedCredentialCount,
          activeServiceCount: supervisor.activeIds.length,
        }),
      );
      const cleanupScenario = report.scenarios.find(
        ({ id }) => id === 'credential-and-fixture-cleanup',
      );
      cleanupScenario.status = 'PASS';
      cleanupScenario.evidenceSha256 = cleanupEvidence;
      report.cleanupStatus = 'PASS';
      report.status = 'PASS';
    }
  }
  if (primaryFailure || cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures].filter(Boolean),
      'browser certification or cleanup failed',
    );
  }
  validateBrowserEvidence(report);
  return report;
};

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  runBrowserCertification()
    .then((report) => process.stdout.write(`${canonicalJson(report)}\n`))
    .catch((error) => {
      const name = error instanceof Error ? error.name : 'BrowserCertificationError';
      process.stderr.write(`Browser certification failed: ${name}\n`);
      process.exitCode = 1;
    });
}
