import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SessionRecord } from '../../src/auth/session.service.js';
import { AppError } from '../../src/common/errors/app-error.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';
import { PairingCodeService } from '../../src/pairing/pairing-code.service.js';
import type { PairingRepository } from '../../src/pairing/pairing.repository.js';
import { PairingService } from '../../src/pairing/pairing.service.js';
import type { PairingId } from '../../src/common/ids/public-id.js';
import type { PairingOwnerStatus } from '../../src/pairing/pairing.status.js';
import type { BoardId } from '@sceneboard/board-schema';
import type { PairingClientStatus } from '../../src/pairing/pairing-client.status.js';
import type { PairingProofCredential } from '../../src/pairing/pairing-proof.service.js';
import type { GrantSummary } from '../../src/grants/grant.status.js';

const key = Buffer.alloc(32, 4);
const crypto = new CryptoService(
  {
    sessionToken: key,
    grantToken: key,
    csrf: key,
    pairingCodePepper: key,
    auditHmac: key,
    rateLimitHmac: key,
  },
  (length) => Buffer.alloc(length, 11),
);

const session = {
  databaseId: '2',
  publicId: 'session_1',
  familyPublicId: 'family_1',
  user: { databaseId: '1', publicId: 'user_1' },
} as SessionRecord;

test('pairing create returns the raw short code once while persisting only its two digests', async () => {
  let captured: Parameters<PairingRepository['create']>[0] | undefined;
  const repository = {
    async create(input: Parameters<PairingRepository['create']>[0]) {
      captured = input;
      return { kind: 'created' as const };
    },
  } as unknown as PairingRepository;
  const service = new PairingService(repository, new PairingCodeService(crypto), crypto);
  const result = await service.create(session, 1_800_000_000_000);
  assert.match(result.code, /^SB-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.equal(result.codeExpiresAt, '2027-01-15T08:05:00.000Z');
  assert.equal(captured?.locatorHash.byteLength, 32);
  assert.equal(captured?.verifierHash.byteLength, 32);
  assert.equal('code' in (captured ?? {}), false);
});

test('pairing create maps the durable five-active-owner cap to exact rate limiting', async () => {
  const repository = {
    async create() {
      return { kind: 'quota' as const, retryAfterSeconds: 42 };
    },
  } as unknown as PairingRepository;
  const service = new PairingService(repository, new PairingCodeService(crypto), crypto);
  await assert.rejects(
    () => service.create(session, 1_800_000_000_000),
    (error) =>
      error instanceof AppError && error.code === 'RATE_LIMITED' && error.retryAfterSeconds === 42,
  );
});

test('pairing claim consumes the code into a secret-free pending response', async () => {
  let captured: Parameters<PairingRepository['claim']>[0] | undefined;
  const repository = {
    async claim(input: Parameters<PairingRepository['claim']>[0]) {
      captured = input;
      return { kind: 'claimed' as const, pairingId: 'pairing_1' as PairingId };
    },
  } as unknown as PairingRepository;
  const service = new PairingService(
    repository,
    new PairingCodeService(crypto),
    crypto,
    50,
    10,
    async () => {},
  );
  const result = await service.claim(
    {
      code: '000000-000000',
      installationId: 'installation-0001',
      clientName: 'SceneBoard Codex',
      requestedScopes: ['board.read', 'board.write'],
      requestedLifecyclePermissions: ['board.create'],
      clientProofChallenge: Buffer.alloc(32, 1),
    },
    1_800_000_000_000,
  );
  assert.deepEqual(result, {
    pairingId: 'pairing_1',
    state: 'pending',
    decisionExpiresAt: '2027-01-15T08:10:00.000Z',
    pollAfterSeconds: 2,
  });
  assert.equal(captured?.requestedScopeMask, 3);
  assert.equal(captured?.requestedLifecycleMask, 1);
  assert.equal('code' in (captured ?? {}), false);
});

test('pairing claim pads every non-enumerating unavailable result', async () => {
  const delays: number[] = [];
  const repository = {
    async claim() {
      return { kind: 'unavailable' as const };
    },
  } as unknown as PairingRepository;
  const service = new PairingService(
    repository,
    new PairingCodeService(crypto),
    crypto,
    50,
    10,
    async (milliseconds) => {
      delays.push(milliseconds);
    },
  );
  await assert.rejects(
    () =>
      service.claim(
        {
          code: '000000-000000',
          installationId: 'installation-0001',
          clientName: 'SceneBoard Codex',
          requestedScopes: ['board.read'],
          requestedLifecyclePermissions: [],
          clientProofChallenge: Buffer.alloc(32, 1),
        },
        1_800_000_000_000,
      ),
    (error) => error instanceof AppError && error.code === 'PAIRING_UNAVAILABLE',
  );
  assert.equal(delays.length, 1);
  assert.ok(delays[0]! >= 1 && delays[0]! <= 60);
});

test('pairing approval passes only catalog masks and approving-session ownership to persistence', async () => {
  let captured: Parameters<PairingRepository['decide']>[0] | undefined;
  const status = { pairingId: 'pairing_1', state: 'approved' } as PairingOwnerStatus;
  const repository = {
    async decide(input: Parameters<PairingRepository['decide']>[0]) {
      captured = input;
      return { kind: 'decided' as const, status };
    },
  } as unknown as PairingRepository;
  const service = new PairingService(repository, new PairingCodeService(crypto), crypto);
  const result = await service.decide(
    session,
    'pairing_1',
    {
      decision: 'approve',
      approvedScopes: ['board.read', 'board.write'],
      approvedLifecyclePermissions: ['board.create'],
      destination: { mode: 'existing', boardId: 'board_1' as BoardId },
      lifetime: 'session',
    },
    1_800_000_000_000,
  );
  assert.equal(result, status);
  assert.equal(captured?.ownerUserDatabaseId, '1');
  assert.equal(captured?.approvingSessionDatabaseId, '2');
  if (captured?.decision !== 'approve') throw new Error('approval input was not persisted');
  assert.equal(captured.approvedScopeMask, 3);
  assert.equal(captured.approvedLifecycleMask, 1);
});

test('pairing approval preserves a zero-board create grant for deferred board creation', async () => {
  let captured: Parameters<PairingRepository['decide']>[0] | undefined;
  const status = { pairingId: 'pairing_1', state: 'approved' } as PairingOwnerStatus;
  const repository = {
    async decide(input: Parameters<PairingRepository['decide']>[0]) {
      captured = input;
      return { kind: 'decided' as const, status };
    },
  } as unknown as PairingRepository;
  const service = new PairingService(repository, new PairingCodeService(crypto), crypto);
  const result = await service.decide(
    session,
    'pairing_1',
    {
      decision: 'approve',
      approvedScopes: ['board.write'],
      approvedLifecyclePermissions: ['board.create'],
      destination: { mode: 'deferred' },
      lifetime: 'session',
    },
    1_800_000_000_000,
  );
  assert.equal(result, status);
  if (captured?.decision !== 'approve') throw new Error('approval input was not persisted');
  assert.deepEqual(captured.destination, { mode: 'deferred' });
  assert.equal(captured.approvedScopeMask, 2);
  assert.equal(captured.approvedLifecycleMask, 1);
});

const proof = {
  proof: Buffer.alloc(32, 7),
  challenge: Buffer.alloc(32, 8),
  rateLimitFingerprint: 'proof_fingerprint',
} as PairingProofCredential;

test('proof-authenticated client status returns only the exact secret-free projection', async () => {
  const status = {
    pairingId: 'pairing_1',
    state: 'pending',
    retryAfterSeconds: 5,
    decisionExpiresAt: '2027-01-15T08:10:00.000Z',
    redeemExpiresAt: null,
  } as PairingClientStatus;
  let captured: Parameters<PairingRepository['clientStatus']>[0] | undefined;
  const repository = {
    async clientStatus(input: Parameters<PairingRepository['clientStatus']>[0]) {
      captured = input;
      return { kind: 'status' as const, status };
    },
  } as unknown as PairingRepository;
  const service = new PairingService(repository, new PairingCodeService(crypto), crypto);
  assert.equal(await service.clientStatus('pairing_1', proof, 1_800_000_000_000), status);
  assert.deepEqual(captured?.proofChallenge, proof.challenge);
  assert.equal('proof' in (captured ?? {}), false);
});

test('single-use redemption persists only a fresh credential locator/digest and releases raw token once', async () => {
  let captured: Parameters<PairingRepository['redeem']>[0] | undefined;
  const grant = {
    grantId: 'grant_1',
    status: 'active',
    activatedAt: '2027-01-15T08:00:00.000Z',
  } as GrantSummary;
  const repository = {
    async redeem(input: Parameters<PairingRepository['redeem']>[0]) {
      captured = input;
      return { kind: 'redeemed' as const, grant };
    },
  } as unknown as PairingRepository;
  const service = new PairingService(repository, new PairingCodeService(crypto), crypto);
  const response = await service.redeem('pairing_1', proof, 1_800_000_000_000);
  assert.equal(response.tokenType, 'Bearer');
  assert.match(response.accessToken, /^lcbg_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(response.grant, grant);
  assert.equal(captured?.credentialLocator.byteLength, 16);
  assert.equal(captured?.credentialHash.byteLength, 32);
  assert.equal('accessToken' in (captured ?? {}), false);
  assert.equal('proof' in (captured ?? {}), false);
});

test('redemption preserves pending retry and terminal distinctions without issuing a credential', async () => {
  const pendingRepository = {
    async redeem() {
      return { kind: 'not_ready' as const, retryAfterSeconds: 10 };
    },
  } as unknown as PairingRepository;
  const pending = new PairingService(pendingRepository, new PairingCodeService(crypto), crypto);
  await assert.rejects(
    () => pending.redeem('pairing_1', proof, 1_800_000_000_000),
    (error) =>
      error instanceof AppError &&
      error.code === 'PAIRING_NOT_READY' &&
      error.retryAfterSeconds === 10,
  );

  const terminalRepository = {
    async redeem() {
      return { kind: 'terminal' as const };
    },
  } as unknown as PairingRepository;
  const terminal = new PairingService(terminalRepository, new PairingCodeService(crypto), crypto);
  await assert.rejects(
    () => terminal.redeem('pairing_1', proof, 1_800_000_000_000),
    (error) => error instanceof AppError && error.code === 'PAIRING_TERMINAL',
  );
});

test('owner pairing reads, active list, and cancellation stay owner-scoped through session identity', async () => {
  const status = { pairingId: 'pairing_1', state: 'pending' } as PairingOwnerStatus;
  const captured: Array<{
    operation: string;
    ownerUserDatabaseId: string;
    sessionPublicId: string;
  }> = [];
  const repository = {
    async ownerStatus(input: Parameters<PairingRepository['ownerStatus']>[0]) {
      captured.push({ operation: 'get', ...input });
      return { kind: 'status' as const, status };
    },
    async listActive(input: Parameters<PairingRepository['listActive']>[0]) {
      captured.push({ operation: 'list', ...input });
      return [status];
    },
    async cancel(input: Parameters<PairingRepository['cancel']>[0]) {
      captured.push({ operation: 'cancel', ...input });
      return { kind: 'cancelled' as const };
    },
  } as unknown as PairingRepository;
  const service = new PairingService(repository, new PairingCodeService(crypto), crypto);
  assert.equal(await service.getOwnerStatus(session, 'pairing_1', 1_800_000_000_000), status);
  assert.deepEqual(await service.listActive(session, 1_800_000_000_000), { pairings: [status] });
  await service.cancel(session, 'pairing_1', 1_800_000_000_000);
  assert.deepEqual(
    captured.map(({ operation, ownerUserDatabaseId, sessionPublicId }) => ({
      operation,
      ownerUserDatabaseId,
      sessionPublicId,
    })),
    [
      { operation: 'get', ownerUserDatabaseId: '1', sessionPublicId: 'session_1' },
      { operation: 'list', ownerUserDatabaseId: '1', sessionPublicId: 'session_1' },
      { operation: 'cancel', ownerUserDatabaseId: '1', sessionPublicId: 'session_1' },
    ],
  );
});

test('owner pairing routes preserve not-found and state-conflict classifications', async () => {
  const repository = {
    async ownerStatus() {
      return { kind: 'not_found' as const };
    },
    async cancel() {
      return { kind: 'conflict' as const };
    },
  } as unknown as PairingRepository;
  const service = new PairingService(repository, new PairingCodeService(crypto), crypto);
  await assert.rejects(
    () => service.getOwnerStatus(session, 'pairing_1', 1_800_000_000_000),
    (error) => error instanceof AppError && error.code === 'PAIRING_NOT_FOUND',
  );
  await assert.rejects(
    () => service.cancel(session, 'pairing_1', 1_800_000_000_000),
    (error) => error instanceof AppError && error.code === 'PAIRING_STATE_CONFLICT',
  );
});
