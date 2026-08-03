import { Controller, Get, Headers, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { ExportRenderBrokerServiceV1 } from './export-render-broker.service.js';

const SESSION_ID = /^[A-Za-z0-9_-]{22,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const IPV4_OCTET_V1 = '(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])';
const IPV4_LOOPBACK_V1 = new RegExp(`^127(?:\\.${IPV4_OCTET_V1}){3}$`, 'u');
const IPV4_MAPPED_LOOPBACK_V1 = new RegExp(`^::ffff:127(?:\\.${IPV4_OCTET_V1}){3}$`, 'u');

const token = (authorization: string | undefined): string | null => {
  const match = /^SceneBoard-Export ([A-Za-z0-9_-]{22,128})$/u.exec(authorization ?? '');
  return match?.[1] ?? null;
};

const isLoopbackAddress = (value: string): boolean =>
  value === '::1' || IPV4_LOOPBACK_V1.test(value) || IPV4_MAPPED_LOOPBACK_V1.test(value);

const isLoopbackHost = (value: string): boolean => {
  const separator = value.lastIndexOf(':');
  if (separator < 1) return false;
  const hostname = value.slice(0, separator);
  const port = value.slice(separator + 1);
  if (!/^[1-9][0-9]{0,4}$/u.test(port) || Number(port) > 65_535) return false;
  return isLoopbackAddress(hostname === '[::1]' ? '::1' : hostname);
};

const isForwardingHeader = (name: string): boolean =>
  name === 'forwarded' ||
  name === 'via' ||
  name === 'x-real-ip' ||
  name === 'proxy-authorization' ||
  name.startsWith('x-forwarded-');

const admissibleRequest = (request: Request): boolean => {
  const remoteAddress = request.socket.remoteAddress;
  return (
    request.method === 'GET' &&
    typeof request.headers.host === 'string' &&
    isLoopbackHost(request.headers.host) &&
    typeof remoteAddress === 'string' &&
    isLoopbackAddress(remoteAddress) &&
    !Object.keys(request.headers).some(isForwardingHeader) &&
    request.originalUrl === request.path &&
    request.headers.range === undefined &&
    request.headers['if-match'] === undefined &&
    request.headers['if-none-match'] === undefined &&
    request.headers['if-modified-since'] === undefined &&
    request.headers['if-unmodified-since'] === undefined
  );
};

@Controller('/internal/v1/export-render')
export class ExportRenderControllerV1 {
  constructor(
    @Inject(ExportRenderBrokerServiceV1) private readonly broker: ExportRenderBrokerServiceV1,
  ) {}

  @Get(':sessionId/projection')
  async projection(
    @Param('sessionId') sessionId: string,
    @Headers('authorization') authorization: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const credential = token(authorization);
    if (!SESSION_ID.test(sessionId) || credential === null || !admissibleRequest(request)) {
      response.status(404).end();
      return;
    }
    const result = await this.broker.projection({
      sessionId,
      token: credential,
      nowMs: Date.now(),
    });
    if (result === null) {
      response.status(404).end();
      return;
    }
    if (request.headers.origin !== result.webOrigin) {
      await this.broker.dispose(sessionId);
      response.status(404).end();
      return;
    }
    response
      .status(200)
      .setHeader('Cache-Control', 'no-store, private')
      .setHeader('Access-Control-Allow-Origin', result.webOrigin)
      .setHeader('Vary', 'Origin')
      .setHeader('Content-Type', result.mediaType)
      .setHeader('Content-Length', String(result.bytes.byteLength))
      .end(result.bytes);
  }

  @Get(':sessionId/resources/:sha256')
  async resource(
    @Param('sessionId') sessionId: string,
    @Param('sha256') sha256: string,
    @Headers('authorization') authorization: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const credential = token(authorization);
    if (
      !SESSION_ID.test(sessionId) ||
      !SHA256.test(sha256) ||
      credential === null ||
      !admissibleRequest(request)
    ) {
      response.status(404).end();
      return;
    }
    const result = await this.broker.resource({
      sessionId,
      token: credential,
      sha256,
      nowMs: Date.now(),
    });
    if (result === null) {
      response.status(404).end();
      return;
    }
    if (request.headers.origin !== result.webOrigin) {
      await this.broker.dispose(sessionId);
      response.status(404).end();
      return;
    }
    response
      .status(200)
      .setHeader('Cache-Control', 'no-store, private')
      .setHeader('Access-Control-Allow-Origin', result.webOrigin)
      .setHeader('Vary', 'Origin')
      .setHeader('Content-Type', result.mediaType)
      .setHeader('Content-Length', String(result.bytes.byteLength))
      .end(result.bytes);
  }
}
