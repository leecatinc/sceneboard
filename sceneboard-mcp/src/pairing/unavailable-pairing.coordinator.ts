import type {
  BoardPairRequestResultV1,
  BoardPairStatusResultV1,
  PairingCoordinatorPortV1,
  PairingCoordinatorResultV1,
  PairRequestInputV1,
} from './pairing-session.owner.js';

export type UnavailablePairingReasonV1 = 'read_only' | 'unavailable';

export class UnavailablePairingCoordinatorV1 implements PairingCoordinatorPortV1 {
  constructor(private readonly reason: UnavailablePairingReasonV1) {}

  async request(
    _input: PairRequestInputV1,
    _signal?: AbortSignal,
  ): Promise<PairingCoordinatorResultV1<BoardPairRequestResultV1>> {
    return {
      ok: false,
      source: 'local',
      error: {
        code: this.reason === 'read_only' ? 'PAIRING_SINK_READ_ONLY' : 'PAIRING_SINK_UNAVAILABLE',
      },
    };
  }

  async status(
    _pairingId: string,
    _waitTimeoutMs: number,
    _signal?: AbortSignal,
  ): Promise<PairingCoordinatorResultV1<BoardPairStatusResultV1>> {
    return { ok: false, source: 'local', error: { code: 'PAIRING_STATE_LOST' } };
  }

  async close(): Promise<void> {}
}
