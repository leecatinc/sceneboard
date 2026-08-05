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
import { ExportFailureV1, type ExportFailureCodeV1 } from './export-errors.js';
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

const responseIsCommitted = (response: Response): boolean =>
  response.headersSent || response.writableEnded;

const clearResponseHeaders = (response: Response, names: readonly string[]): void => {
  for (const name of names) response.removeHeader(name);
};

const EXPORT_FAILURE_CLEANUP_GRACE_MS_V1 = 1_000;

const observeCleanupOperation = (operation: () => Promise<void>): Promise<void> => {
  try {
    return operation().catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
};

const waitForCleanupGrace = async (operation: Promise<void>): Promise<void> => {
  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    operation,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, EXPORT_FAILURE_CLEANUP_GRACE_MS_V1);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
};

const finalizeFailedLease = async (
  lease: ExportAdmittedLeaseV1,
  reason: ExportFailureCodeV1,
): Promise<void> => {
  void observeCleanupOperation(() => lease.auditFailed(reason));
  await waitForCleanupGrace(observeCleanupOperation(() => lease.abort()));
};

const writeResponse = async (
  request: ExportHttpRequestV1,
  response: Response,
  bytes: Buffer,
  signal: AbortSignal,
  completeResponse: () => Promise<void>,
): Promise<void> =>
  new Promise((resolve, reject) => {
    let terminal = false;
    const complete = (): void => {
      if (terminal) return;
      terminal = true;
      cleanup();
      let operation: Promise<void>;
      try {
        operation = completeResponse();
      } catch (error) {
        reject(error);
        return;
      }
      void operation.then(resolve, reject);
    };
    const fail = (error: unknown): void => {
      if (terminal) return;
      terminal = true;
      cleanup();
      reject(error);
    };
    const failTransport = (error: unknown): void => {
      fail(error);
      response.destroy();
    };
    const aborted = (): void => failTransport(new Error('export client aborted'));
    const ownershipLost = (): void => {
      failTransport(
        signal.reason instanceof Error ? signal.reason : new Error('export ownership lost'),
      );
    };
    const cleanup = (): void => {
      response.off('finish', complete);
      response.off('error', failTransport);
      request.off('aborted', aborted);
      signal.removeEventListener('abort', ownershipLost);
    };
    if (signal.aborted) {
      ownershipLost();
      return;
    }
    response.once('finish', complete);
    response.once('error', failTransport);
    request.once('aborted', aborted);
    signal.addEventListener('abort', ownershipLost, { once: true });
    try {
      response.end(bytes);
    } catch (error) {
      failTransport(error);
    }
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
    const deadlineMs = startedAt + EXPORT_TOTAL_TIMEOUT_MS_V1;
    let lease: ExportAdmittedLeaseV1 | undefined;
    let responseCommitted = false;
    let responseFinished = false;
    let successHeaderNames: readonly string[] = [];
    let clientAborted = request.aborted;
    let deadlineTimedOut = false;
    const abortController = new AbortController();
    const onClientAbort = (): void => {
      clientAborted = true;
      abortController.abort();
    };
    request.once('aborted', onClientAbort);
    if (clientAborted) abortController.abort();
    const totalTimeout = setTimeout(() => {
      deadlineTimedOut = true;
      abortController.abort();
    }, EXPORT_TOTAL_TIMEOUT_MS_V1);
    totalTimeout.unref();
    try {
      lease = await this.admission.admit({
        principal: principal(request),
        boardId: boardId(pathBoardId),
        request: parsed.data,
        correlationId: randomBytes(16).toString('base64url'),
        signal: abortController.signal,
        deadlineMs,
      });
      if (clientAborted) return;
      const deliverySignal =
        lease.ownershipSignal instanceof AbortSignal
          ? AbortSignal.any([abortController.signal, lease.ownershipSignal])
          : abortController.signal;
      const assertDeliveryOwnership = (): void => {
        lease?.assertOwnership?.();
        if (deliverySignal.aborted) {
          if (deliverySignal.reason instanceof Error) throw deliverySignal.reason;
          throw new ExportFailureV1('EXPORT_RENDERER_UNAVAILABLE');
        }
      };
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) throw new ExportFailureV1('EXPORT_RENDER_TIMEOUT');
      const encodeDeadlineMs = Math.min(deadlineMs, Date.now() + EXPORT_ENCODE_TIMEOUT_MS_V1);
      const timeout = setTimeout(
        () => {
          deadlineTimedOut = true;
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
          signal: deliverySignal,
          deadlineMs: encodeDeadlineMs,
        });
        if (clientAborted) return;
        assertDeliveryOwnership();
        const headers = exportSuccessHeadersV1({
          title: lease.boardTitle,
          revisionNumber: lease.projection.revisionNumber,
          format: parsed.data.format,
          byteLength: bytes.byteLength,
        });
        successHeaderNames = Object.keys(headers);
        await lease.auditCompleted(bytes.byteLength);
        assertDeliveryOwnership();
        for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
        response.status(200);
        await writeResponse(request, response, bytes, deliverySignal, () => {
          responseFinished = true;
          return lease?.completeResponse() ?? Promise.resolve();
        });
        responseCommitted = true;
        lease = undefined;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      responseCommitted = responseCommitted || responseIsCommitted(response);
      if (!responseCommitted) clearResponseHeaders(response, successHeaderNames);
      if (lease !== undefined) {
        if (responseFinished) {
          await lease.completeResponse().catch(() => undefined);
        } else {
          deadlineTimedOut = deadlineTimedOut || Date.now() >= deadlineMs;
          const reason = deadlineTimedOut
            ? 'EXPORT_RENDER_TIMEOUT'
            : clientAborted
              ? 'EXPORT_ENCODE_FAILED'
              : error instanceof ExportFailureV1
                ? error.code
                : 'EXPORT_ENCODE_FAILED';
          await finalizeFailedLease(lease, reason);
        }
        lease = undefined;
      }
      if (clientAborted) return;
      if (responseCommitted) return;
      if (deadlineTimedOut) throw new ExportFailureV1('EXPORT_RENDER_TIMEOUT');
      if (error instanceof ExportFailureV1) throw error;
      throw new ExportFailureV1('EXPORT_ENCODE_FAILED');
    } finally {
      clearTimeout(totalTimeout);
      request.off('aborted', onClientAbort);
      if (lease !== undefined) {
        await finalizeFailedLease(lease, 'EXPORT_INTERNAL_ERROR');
      }
    }
  }
}

export const exportEncoderForFormatV1 = (
  format: ExportFormatV1,
  encoders: { pdf: PdfExportEncoderV1; pptx: PptxExportEncoderV1 },
): PdfExportEncoderV1 | PptxExportEncoderV1 => encoders[format];
