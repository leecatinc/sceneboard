import type {
  ExportProjectionBundleV1,
  ExportResourceMediaTypeV1,
} from './export-projection.service.js';
import { EXPORT_PROJECTION_MEDIA_TYPE_V1 } from './export-projection.service.js';
import { ExportRenderSessionRepositoryV1 } from './export-render-session.repository.js';

type RegisteredBundleV1 = Readonly<{
  bundle: ExportProjectionBundleV1;
  webOrigin: string;
  claimNonce: string | null;
}>;

export type ExportBrokerResponseV1 = Readonly<{
  mediaType: typeof EXPORT_PROJECTION_MEDIA_TYPE_V1 | ExportResourceMediaTypeV1;
  bytes: Buffer;
  webOrigin: string;
}>;

export class ExportRenderBrokerServiceV1 {
  private readonly bundles = new Map<string, RegisteredBundleV1>();

  constructor(private readonly sessions: ExportRenderSessionRepositoryV1) {}

  register(input: {
    sessionId: string;
    bundle: ExportProjectionBundleV1;
    webOrigin: string;
  }): void {
    if (this.bundles.has(input.sessionId))
      throw new Error('export render bundle is already registered');
    this.bundles.set(
      input.sessionId,
      Object.freeze({
        bundle: input.bundle,
        webOrigin: new URL(input.webOrigin).origin,
        claimNonce: null,
      }),
    );
  }

  async projection(input: {
    sessionId: string;
    token: string;
    nowMs: number;
  }): Promise<ExportBrokerResponseV1 | null> {
    const registered = await this.authorize(input);
    if (registered === null || registered.claimNonce === null) return null;
    if (
      !(await this.sessions.debitProjection({
        sessionId: input.sessionId,
        claimNonce: registered.claimNonce,
        nowMs: input.nowMs,
        bytes: registered.bundle.projectionBytes.byteLength,
      }))
    ) {
      await this.dispose(input.sessionId);
      return null;
    }
    return Object.freeze({
      mediaType: EXPORT_PROJECTION_MEDIA_TYPE_V1,
      bytes: Buffer.from(registered.bundle.projectionBytes),
      webOrigin: registered.webOrigin,
    });
  }

  async resource(input: {
    sessionId: string;
    token: string;
    sha256: string;
    nowMs: number;
  }): Promise<ExportBrokerResponseV1 | null> {
    if (!/^[a-f0-9]{64}$/u.test(input.sha256)) return null;
    const registered = await this.authorize(input);
    if (registered === null || registered.claimNonce === null) return null;
    const descriptor = registered.bundle.projection.resources.find(
      (resource) => resource.sha256 === input.sha256,
    );
    const bytes = registered.bundle.resourceBytes.get(input.sha256);
    if (
      descriptor === undefined ||
      bytes === undefined ||
      descriptor.byteLength !== bytes.byteLength ||
      !(await this.sessions.debitResource({
        sessionId: input.sessionId,
        claimNonce: registered.claimNonce,
        nowMs: input.nowMs,
        bytes: bytes.byteLength,
      }))
    ) {
      await this.dispose(input.sessionId);
      return null;
    }
    return Object.freeze({
      mediaType: descriptor.mediaType,
      bytes: Buffer.from(bytes),
      webOrigin: registered.webOrigin,
    });
  }

  async renew(sessionId: string, nowMs: number): Promise<boolean> {
    const registered = this.bundles.get(sessionId);
    return registered?.claimNonce === null || registered?.claimNonce === undefined
      ? false
      : this.sessions.renew({ sessionId, claimNonce: registered.claimNonce, nowMs });
  }

  async dispose(sessionId: string, nowMs: number = Date.now()): Promise<void> {
    const registered = this.bundles.get(sessionId);
    this.bundles.delete(sessionId);
    if (registered?.claimNonce !== null && registered?.claimNonce !== undefined)
      await this.sessions
        .close({ sessionId, claimNonce: registered.claimNonce, nowMs })
        .catch(() => undefined);
  }

  private async authorize(input: {
    sessionId: string;
    token: string;
    nowMs: number;
  }): Promise<RegisteredBundleV1 | null> {
    const registered = this.bundles.get(input.sessionId);
    if (registered === undefined) return null;
    if (!(await this.sessions.authorizeToken(input.sessionId, input.token))) {
      await this.dispose(input.sessionId);
      return null;
    }
    if (registered.claimNonce !== null) return registered;
    const claimNonce = await this.sessions.claim(input);
    if (claimNonce === null) return null;
    const claimed = Object.freeze({ ...registered, claimNonce });
    this.bundles.set(input.sessionId, claimed);
    return claimed;
  }
}
