import { Controller, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { BoardIdParserV1, type BoardId } from '@sceneboard/board-schema';
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';

import { AppError } from '../common/errors/app-error.js';
import { RequireBoardPrincipal } from '../common/guards/board-principal.guard.js';
import { RequireCsrf } from '../common/guards/csrf.guard.js';
import type { ResolvedBoardPrincipalV1 } from '../grants/board-access.policy.js';
import {
  ExportAdmissionServiceV1,
  type ExportAdmittedLeaseV1,
} from './export-admission.service.js';
import { ExportFailureV1 } from './export-errors.js';
import { exportSuccessHeadersV1 } from './export-http-response.js';
import { PdfExportEncoderV1 } from './pdf-export.encoder.js';
import { PptxExportEncoderV1 } from './pptx-export.encoder.js';
import {
  EXPORT_ENCODE_TIMEOUT_MS_V1,
  EXPORT_TOTAL_TIMEOUT_MS_V1,
  ExportRequestSchemaV1,
  type ExportFormatV1,
} from './export-request.schema.js';

interface ExportHttpRequestV1 extends Request {
  boardPrincipal?: ResolvedBoardPrincipalV1 | undefined;
}

const principal = (request: ExportHttpRequestV1): ResolvedBoardPrincipalV1 => {
  if (request.boardPrincipal === undefined) throw new AppError('UNAUTHENTICATED');
  return request.boardPrincipal;
};

const boardId = (value: string): BoardId => {
  const parsed = BoardIdParserV1.parse(value);
  if (!parsed.ok) throw new ExportFailureV1('EXPORT_INVALID_REQUEST');
  return parsed.data.value;
};

const writeResponse = async (
  request: ExportHttpRequestV1,
  response: Response,
  bytes: Buffer,
  signal: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    let terminal = false;
    const finish = (): void => {
      if (terminal) return;
      terminal = true;
      cleanup();
      resolve();
    };
    const fail = (error: unknown): void => {
      if (terminal) return;
      terminal = true;
      cleanup();
      reject(error);
    };
    const aborted = (): void => fail(new Error('export client aborted'));
    const timedOut = (): void => {
      if (response.headersSent) response.destroy();
      fail(new Error('export response timed out'));
    };
    const cleanup = (): void => {
      response.off('finish', finish);
      response.off('error', fail);
      request.off('aborted', aborted);
      signal.removeEventListener('abort', timedOut);
    };
    if (signal.aborted) {
      timedOut();
      return;
    }
    response.once('finish', finish);
    response.once('error', fail);
    request.once('aborted', aborted);
    signal.addEventListener('abort', timedOut, { once: true });
    response.end(bytes);
  });

@Controller('api/v1/boards')
@RequireBoardPrincipal()
export class ExportControllerV1 {
  constructor(
    @Inject(ExportAdmissionServiceV1) private readonly admission: ExportAdmissionServiceV1,
    @Inject(PdfExportEncoderV1) private readonly pdf: PdfExportEncoderV1,
    @Inject(PptxExportEncoderV1) private readonly pptx: PptxExportEncoderV1,
  ) {}

  @Post(':boardId/exports')
  @RequireCsrf('session')
  async export(
    @Param('boardId') pathBoardId: string,
    @Req() request: ExportHttpRequestV1,
    @Res() response: Response,
  ): Promise<void> {
    const parsed = ExportRequestSchemaV1.safeParse(request.body);
    if (!parsed.success) throw new ExportFailureV1('EXPORT_INVALID_REQUEST');
    const startedAt = Date.now();
    let lease: ExportAdmittedLeaseV1 | undefined;
    let responseCommitted = false;
    let clientAborted = request.aborted;
    let encodeTimedOut = false;
    const abortController = new AbortController();
    const onClientAbort = (): void => {
      clientAborted = true;
      abortController.abort();
    };
    request.once('aborted', onClientAbort);
    try {
      lease = await this.admission.admit({
        principal: principal(request),
        boardId: boardId(pathBoardId),
        request: parsed.data,
        correlationId: randomBytes(16).toString('base64url'),
      });
      if (clientAborted) return;
      const remaining = EXPORT_TOTAL_TIMEOUT_MS_V1 - (Date.now() - startedAt);
      if (remaining <= 0) throw new ExportFailureV1('EXPORT_RENDER_TIMEOUT');
      const timeout = setTimeout(
        () => {
          encodeTimedOut = true;
          abortController.abort();
        },
        Math.min(EXPORT_ENCODE_TIMEOUT_MS_V1, remaining),
      );
      timeout.unref();
      try {
        const encode = parsed.data.format === 'pdf' ? this.pdf : this.pptx;
        const bytes = await encode.encode({
          lease,
          boardTitle: lease.boardTitle,
          signal: abortController.signal,
        });
        if (clientAborted) return;
        const headers = exportSuccessHeadersV1({
          title: lease.boardTitle,
          revisionNumber: lease.projection.revisionNumber,
          format: parsed.data.format,
          byteLength: bytes.byteLength,
        });
        await lease.auditCompleted(bytes.byteLength);
        for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
        response.status(200);
        responseCommitted = true;
        await writeResponse(request, response, bytes, abortController.signal);
        await lease.completeResponse();
        lease = undefined;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      let auditError: unknown;
      if (lease !== undefined) {
        const reason = encodeTimedOut
          ? 'EXPORT_RENDER_TIMEOUT'
          : error instanceof ExportFailureV1
            ? error.code
            : 'EXPORT_ENCODE_FAILED';
        try {
          await lease.auditFailed(reason);
        } catch (failedAuditError) {
          auditError = failedAuditError;
        }
        if (responseCommitted || response.headersSent) await lease.completeResponse();
        else await lease.abort();
        lease = undefined;
      }
      if (clientAborted) return;
      if (responseCommitted || response.headersSent) return;
      if (auditError !== undefined) throw new ExportFailureV1('EXPORT_INTERNAL_ERROR', auditError);
      if (encodeTimedOut) throw new ExportFailureV1('EXPORT_RENDER_TIMEOUT');
      if (error instanceof ExportFailureV1) throw error;
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
    } finally {
      request.off('aborted', onClientAbort);
      if (lease !== undefined) {
        await lease.auditFailed('EXPORT_INTERNAL_ERROR').catch(() => undefined);
        await lease.abort().catch(() => undefined);
      }
    }
  }
}

export const exportEncoderForFormatV1 = (
  format: ExportFormatV1,
  encoders: { pdf: PdfExportEncoderV1; pptx: PptxExportEncoderV1 },
): PdfExportEncoderV1 | PptxExportEncoderV1 => encoders[format];
