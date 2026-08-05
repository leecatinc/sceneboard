import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Request, Response } from 'express';

import type { ExportRenderBrokerServiceV1 } from '../../src/exports/export-render-broker.service.js';
import { ExportRenderControllerV1 } from '../../src/exports/export-render.controller.js';
import {
  exportChromiumLaunchOptionsV1,
  exportChromiumSandboxEnabledV1,
} from '../../src/exports/export-renderer.service.js';

const sessionId = 'AAAAAAAAAAAAAAAAAAAAAA';
const credential = 'BBBBBBBBBBBBBBBBBBBBBB';

test('export Chromium launch configuration preserves the production sandbox', () => {
  assert.deepEqual(
    exportChromiumLaunchOptionsV1({
      executablePath: '/opt/sceneboard/chromium',
      timeout: 30_000,
    }),
    {
      headless: true,
      executablePath: '/opt/sceneboard/chromium',
      chromiumSandbox: true,
      timeout: 30_000,
    },
  );
});

test('allows the explicit Chromium sandbox escape hatch only in development', () => {
  assert.equal(
    exportChromiumSandboxEnabledV1({
      APP_ENV: 'development',
      SCENEBOARD_EXPORT_DISABLE_CHROMIUM_SANDBOX: 'true',
    }),
    false,
  );
  assert.equal(
    exportChromiumSandboxEnabledV1({
      APP_ENV: 'production',
      SCENEBOARD_EXPORT_DISABLE_CHROMIUM_SANDBOX: 'true',
    }),
    true,
  );
  assert.equal(exportChromiumSandboxEnabledV1({ APP_ENV: 'development' }), true);
});

const requestV1 = (overrides: Partial<Request> = {}): Request =>
  ({
    method: 'GET',
    headers: {
      authorization: `SceneBoard-Export ${credential}`,
      host: '127.0.0.1:3411',
      origin: 'http://127.0.0.1:3410',
    },
    socket: { remoteAddress: '127.0.0.1' },
    path: `/internal/v1/export-render/${sessionId}/projection`,
    originalUrl: `/internal/v1/export-render/${sessionId}/projection`,
    ...overrides,
  }) as unknown as Request;

const responseV1 = () => {
  const state: {
    status: number | null;
    headers: Record<string, string>;
    body: unknown;
  } = { status: null, headers: {}, body: undefined };
  const response = {
    status(value: number) {
      state.status = value;
      return response;
    },
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return response;
    },
    end(value?: unknown) {
      state.body = value;
      return response;
    },
  } as unknown as Response;
  return { response, state };
};

test('export broker controller rejects non-GET, query, and malformed loopback hosts before access', async () => {
  let reads = 0;
  const broker = {
    async projection() {
      reads += 1;
      return null;
    },
  } as unknown as ExportRenderBrokerServiceV1;
  const controller = new ExportRenderControllerV1(broker);
  for (const request of [
    requestV1({ method: 'HEAD' }),
    requestV1({
      originalUrl: `/internal/v1/export-render/${sessionId}/projection?q=1`,
    }),
    requestV1({
      headers: {
        authorization: `SceneBoard-Export ${credential}`,
        host: '127.999.0.1:3411',
      },
    }),
    requestV1({
      headers: {
        authorization: `SceneBoard-Export ${credential}`,
        host: '127.0.0.1:65536',
      },
    }),
  ]) {
    const output = responseV1();
    await controller.projection(sessionId, request.headers.authorization, request, output.response);
    assert.equal(output.state.status, 404);
  }
  assert.equal(reads, 0);
});

test('export broker controller closes a claimed session on Origin mismatch', async () => {
  const disposed: string[] = [];
  const broker = {
    async projection() {
      return {
        mediaType: 'application/vnd.sceneboard.export-projection+json;version=1',
        bytes: Buffer.from('{}'),
        webOrigin: 'http://127.0.0.1:3410',
      };
    },
    async dispose(value: string) {
      disposed.push(value);
    },
  } as unknown as ExportRenderBrokerServiceV1;
  const controller = new ExportRenderControllerV1(broker);
  const request = requestV1({
    headers: {
      authorization: `SceneBoard-Export ${credential}`,
      host: '127.0.0.1:3411',
      origin: 'http://127.0.0.1:9999',
    },
  });
  const output = responseV1();
  await controller.projection(sessionId, request.headers.authorization, request, output.response);
  assert.equal(output.state.status, 404);
  assert.deepEqual(disposed, [sessionId]);
  assert.equal(output.state.body, undefined);
});

test('export broker controller fails closed on peer, forwarding, Origin, and header ambiguity', async () => {
  let reads = 0;
  const broker = {
    async projection() {
      reads += 1;
      return {
        mediaType: 'application/vnd.sceneboard.export-projection+json;version=1',
        bytes: Buffer.from('{}'),
        webOrigin: 'http://127.0.0.1:3410',
      };
    },
    async dispose() {},
  } as unknown as ExportRenderBrokerServiceV1;
  const controller = new ExportRenderControllerV1(broker);
  const hostile = [
    requestV1({ socket: {} as never }),
    requestV1({ socket: { remoteAddress: '10.0.0.2' } as never }),
    requestV1({ headers: { ...requestV1().headers, forwarded: 'for=203.0.113.1' } }),
    requestV1({ headers: { ...requestV1().headers, 'x-forwarded-for': '203.0.113.1' } }),
    requestV1({ headers: { ...requestV1().headers, origin: undefined } }),
    requestV1({ headers: { ...requestV1().headers, origin: 'null' } }),
    requestV1({ headers: { ...requestV1().headers, range: 'bytes=0-1' } }),
    requestV1({ headers: { ...requestV1().headers, authorization: 'Bearer ambient' } }),
  ];
  for (const request of hostile) {
    const output = responseV1();
    await controller.projection(sessionId, request.headers.authorization, request, output.response);
    assert.equal(output.state.status, 404);
    assert.equal(output.state.body, undefined);
  }
  assert.equal(reads, 2);
});

test('export broker controller serves exact-origin projection and resource requests', async () => {
  const broker = {
    async projection() {
      return {
        mediaType: 'application/vnd.sceneboard.export-projection+json;version=1',
        bytes: Buffer.from('{}'),
        webOrigin: 'http://127.0.0.1:3410',
      };
    },
    async resource() {
      return {
        mediaType: 'font/woff2',
        bytes: Buffer.from('font'),
        webOrigin: 'http://127.0.0.1:3410',
      };
    },
  } as unknown as ExportRenderBrokerServiceV1;
  const controller = new ExportRenderControllerV1(broker);
  const projection = responseV1();
  const projectionRequest = requestV1();
  await controller.projection(
    sessionId,
    projectionRequest.headers.authorization,
    projectionRequest,
    projection.response,
  );
  assert.equal(projection.state.status, 200);
  const resource = responseV1();
  const resourceRequest = requestV1({
    path: `/internal/v1/export-render/${sessionId}/resources/${'a'.repeat(64)}`,
    originalUrl: `/internal/v1/export-render/${sessionId}/resources/${'a'.repeat(64)}`,
  });
  await controller.resource(
    sessionId,
    'a'.repeat(64),
    resourceRequest.headers.authorization,
    resourceRequest,
    resource.response,
  );
  assert.equal(resource.state.status, 200);
});
