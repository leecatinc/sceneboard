import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Request, Response } from 'express';

import type { ExportRenderBrokerServiceV1 } from '../../src/exports/export-render-broker.service.js';
import { ExportRenderControllerV1 } from '../../src/exports/export-render.controller.js';

const sessionId = 'AAAAAAAAAAAAAAAAAAAAAA';
const credential = 'BBBBBBBBBBBBBBBBBBBBBB';

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
