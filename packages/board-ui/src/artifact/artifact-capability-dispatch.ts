import type { ArtifactBridgeMessageV1 } from '@sceneboard/artifact-runtime/bridge';
import type { ArtifactRequestCapabilityV1 } from '@sceneboard/board-schema';

export type ArtifactCapabilityErrorV1 =
  | 'not_requested'
  | 'policy_denied'
  | 'activation_required'
  | 'activation_expired'
  | 'invalid_request'
  | 'revoked'
  | 'timeout'
  | 'unavailable';

export type ArtifactCapabilityResultV1 =
  | Readonly<{ ok: true; result: Readonly<{ byteLength: number }> }>
  | Readonly<{ ok: false; error: ArtifactCapabilityErrorV1 }>;

export type ClipboardCapabilityErrorV1 = ArtifactCapabilityErrorV1;
export type ClipboardCapabilityResultV1 = ArtifactCapabilityResultV1;

type UserAction = Extract<ArtifactBridgeMessageV1, { type: 'artifact.user-action' }>;
type CapabilityRequest = Extract<ArtifactBridgeMessageV1, { type: 'artifact.capability.request' }>;

type DispatcherInput = Readonly<{
  requestedCapabilities: readonly ArtifactRequestCapabilityV1[];
  allowedCapabilities: readonly ArtifactRequestCapabilityV1[];
  capabilityEpoch: number;
  writeClipboard(text: string): Promise<void>;
  now(): number;
}>;

type PendingAction = Readonly<{
  requestId: string;
  createdAt: number;
  generation: number;
  capabilityEpoch: number;
  capability: 'clipboard.write';
  error: ArtifactCapabilityErrorV1 | null;
}>;

const canonicalCapabilities = (value: readonly ArtifactRequestCapabilityV1[]): string =>
  JSON.stringify([...new Set(value)].sort());

const payloadText = (payload: Record<string, unknown>): string | null => {
  if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'text')) return null;
  const value = payload.text;
  if (typeof value !== 'string' || /\p{Cs}/u.test(value)) return null;
  const byteLength = new TextEncoder().encode(value).byteLength;
  return byteLength <= 49_152 ? value : null;
};

export class ArtifactCapabilityDispatcherV1 {
  readonly #requested: Set<ArtifactRequestCapabilityV1>;
  readonly #writeClipboard: (text: string) => Promise<void>;
  readonly #now: () => number;
  #allowed: Set<ArtifactRequestCapabilityV1>;
  #allowedKey: string;
  #capabilityEpoch: number;
  #generation = 0;
  #pending: PendingAction | null = null;
  #disposed = false;

  constructor(input: DispatcherInput) {
    this.#requested = new Set(input.requestedCapabilities);
    this.#allowed = new Set(input.allowedCapabilities);
    this.#allowedKey = canonicalCapabilities(input.allowedCapabilities);
    this.#capabilityEpoch = input.capabilityEpoch;
    this.#writeClipboard = input.writeClipboard;
    this.#now = input.now;
  }

  updateAllowedCapabilities(
    value: readonly ArtifactRequestCapabilityV1[],
    capabilityEpoch: number,
  ): void {
    const key = canonicalCapabilities(value);
    if (key === this.#allowedKey && capabilityEpoch === this.#capabilityEpoch) return;
    this.#allowedKey = key;
    this.#allowed = new Set(value);
    this.#capabilityEpoch = capabilityEpoch;
    this.#generation += 1;
  }

  admitAction(action: UserAction): void {
    // 격리 러너는 신뢰된 클릭/키 입력의 캡처 단계에서만 이 인증 브리지 메시지를 보낸다.
    // 최상위 userActivation은 credentialless 교차 출처 경계를 안정적으로 통과하지 않는다.
    if (this.#disposed || action.capability !== 'clipboard.write') return;
    let error: ArtifactCapabilityErrorV1 | null = null;
    if (!this.#requested.has(action.capability)) error = 'not_requested';
    else if (!this.#allowed.has(action.capability)) error = 'policy_denied';
    this.#pending = {
      requestId: action.requestId,
      createdAt: this.#now(),
      generation: this.#generation,
      capabilityEpoch: this.#capabilityEpoch,
      capability: action.capability,
      error,
    };
  }

  async dispatch(
    request: CapabilityRequest,
    binary: ArrayBuffer | null = null,
  ): Promise<ArtifactCapabilityResultV1> {
    if (this.#disposed || request.capability !== 'clipboard.write' || binary !== null)
      return { ok: false, error: 'invalid_request' };
    const pending = this.#pending;
    this.#pending = null;
    if (
      pending === null ||
      pending.requestId !== request.requestId ||
      pending.capability !== request.capability
    )
      return { ok: false, error: 'activation_required' };
    if (
      pending.generation !== this.#generation ||
      pending.capabilityEpoch !== this.#capabilityEpoch
    )
      return { ok: false, error: 'revoked' };
    if (pending.error !== null) return { ok: false, error: pending.error };
    if (this.#now() - pending.createdAt > 1_500) return { ok: false, error: 'activation_expired' };
    if (!this.#allowed.has(request.capability)) return { ok: false, error: 'revoked' };
    const text = payloadText(request.payload);
    if (text === null) return { ok: false, error: 'invalid_request' };
    const byteLength = new TextEncoder().encode(text).byteLength;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        this.#writeClipboard(text).then(() => 'written' as const),
        new Promise<'timeout'>((resolve) => {
          timeoutHandle = setTimeout(() => resolve('timeout'), 5_000);
        }),
      ]);
      if (outcome === 'timeout') return { ok: false, error: 'timeout' };
      return { ok: true, result: { byteLength } };
    } catch {
      return { ok: false, error: 'unavailable' };
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#pending = null;
    this.#generation += 1;
  }
}
