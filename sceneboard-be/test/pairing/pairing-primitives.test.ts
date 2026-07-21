import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PairingCodeService } from '../../src/pairing/pairing-code.service.js';
import { parsePairingClaim, parsePairingDecision } from '../../src/pairing/pairing.dto.js';
import { GrantTokenService } from '../../src/grants/grant-token.service.js';
import {
  lifecycleMaskFromValues,
  lifecycleValuesFromMask,
  scopeMaskFromValues,
  scopeValuesFromMask,
} from '../../src/grants/scope-map.js';
import { AppError } from '../../src/common/errors/app-error.js';
import { CryptoService } from '../../src/common/security/crypto.service.js';
import { PairingProofService } from '../../src/pairing/pairing-proof.service.js';
import { pendingRetryAfterSeconds } from '../../src/pairing/pairing-client.status.js';

const key = Buffer.alloc(32, 9);
let randomCounter = 0;
const crypto = new CryptoService(
  {
    sessionToken: key,
    grantToken: key,
    csrf: key,
    pairingCodePepper: key,
    auditHmac: key,
    rateLimitHmac: key,
  },
  (length) => Buffer.alloc(length, randomCounter++),
);

test('issues two independent Crockford halves and persists only locator/verifier HMACs', () => {
  const service = new PairingCodeService(crypto);
  const issued = service.issue();
  assert.match(issued.code, /^SB-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.equal(issued.locatorHash.byteLength, 32);
  assert.equal(issued.verifierHash.byteLength, 32);
  assert.equal(issued.locatorHash.includes(Buffer.from(issued.code)), false);
  const parsed = service.parse(issued.code.toLowerCase());
  assert.equal(service.verify(parsed, issued.locatorHash, issued.verifierHash), true);
  assert.deepEqual(service.parse(issued.code.slice(3)), parsed);
  for (const invalid of ['AAAAAA-AAAAAI', 'AAAAAA_AAAAAA', 'AAAAAAAAAAAA', 'OOOOOO-000000']) {
    assert.throws(
      () => service.parse(invalid),
      (error) => error instanceof AppError && error.code === 'PAIRING_UNAVAILABLE',
    );
  }
});

test('maps the seven D1 scopes and two lifecycle permissions without unknown bits', () => {
  const scopes = ['board.read', 'board.write', 'artifact.control'] as const;
  assert.equal(scopeMaskFromValues(scopes), 67);
  assert.deepEqual(scopeValuesFromMask(67), scopes);
  assert.equal(lifecycleMaskFromValues(['board.create', 'board.archive']), 3);
  assert.deepEqual(lifecycleValuesFromMask(3), ['board.create', 'board.archive']);
  assert.throws(() => scopeValuesFromMask(128));
  assert.throws(() => scopeMaskFromValues(['board.write', 'board.read']));
});

test('parses exact claim and decision DTOs without echoing proof or installation secrets', () => {
  const proofChallenge = Buffer.alloc(32, 1).toString('base64url');
  assert.deepEqual(
    parsePairingClaim({
      code: 'sb-000000-000001',
      installationId: 'codex.local.installation-1',
      clientName: 'Codex local MCP',
      requestedScopes: ['board.read', 'board.write'],
      requestedLifecyclePermissions: ['board.create'],
      clientProofChallenge: proofChallenge,
    }),
    {
      code: 'SB-000000-000001',
      installationId: 'codex.local.installation-1',
      clientName: 'Codex local MCP',
      requestedScopes: ['board.read', 'board.write'],
      requestedLifecyclePermissions: ['board.create'],
      clientProofChallenge: Buffer.alloc(32, 1),
    },
  );
  assert.deepEqual(parsePairingDecision({ decision: 'deny' }), { decision: 'deny' });
  assert.throws(
    () => parsePairingDecision({ decision: 'deny', boardIds: [] }),
    (error) => error instanceof AppError && error.code === 'INVALID_PAYLOAD',
  );
  assert.deepEqual(
    parsePairingDecision({
      decision: 'approve',
      approvedScopes: ['board.write'],
      approvedLifecyclePermissions: ['board.create'],
      destination: { mode: 'create', title: '새 보드' },
      lifetime: 'session',
    }),
    {
      decision: 'approve',
      approvedScopes: ['board.write'],
      approvedLifecyclePermissions: ['board.create'],
      destination: { mode: 'create', title: '새 보드' },
      lifetime: 'session',
    },
  );
  assert.deepEqual(
    parsePairingDecision({
      decision: 'approve',
      approvedScopes: ['board.read'],
      approvedLifecyclePermissions: [],
      destination: { mode: 'existing', boardId: 'board_1' },
      lifetime: 'persistent',
    }),
    {
      decision: 'approve',
      approvedScopes: ['board.read'],
      approvedLifecyclePermissions: [],
      destination: { mode: 'existing', boardId: 'board_1' },
      lifetime: 'persistent',
    },
  );
  assert.throws(
    () =>
      parsePairingDecision({
        decision: 'approve',
        approvedScopes: ['board.write'],
        approvedLifecyclePermissions: ['board.create'],
        destination: { mode: 'create', title: '' },
        lifetime: 'session',
      }),
    (error) => error instanceof AppError && error.code === 'INVALID_PAYLOAD',
  );
  for (const invalid of [
    { approvedScopes: ['board.read'], approvedLifecyclePermissions: ['board.create'] },
    { approvedScopes: ['board.write'], approvedLifecyclePermissions: [] },
  ]) {
    assert.throws(
      () =>
        parsePairingDecision({
          decision: 'approve',
          destination: { mode: 'deferred' },
          lifetime: 'session',
          ...invalid,
        }),
      (error) => error instanceof AppError && error.code === 'PAIRING_SCOPE_INVALID',
    );
  }
});

test('issues purpose-separated opaque grant credentials and stores only a digest', () => {
  const service = new GrantTokenService(crypto);
  const issued = service.issue();
  assert.match(issued.token, /^lcbg_v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(service.verify(issued.token, issued.tokenHash), true);
  assert.equal(service.verify(issued.token.replace(/.$/, 'A'), issued.tokenHash), false);
  assert.equal(issued.tokenHash.byteLength, 32);
});

test('accepts only the exact PairingProof authorization credential and derives SHA-256 challenge bytes', () => {
  const proofs = new PairingProofService(crypto);
  const encoded = Buffer.alloc(32, 7).toString('base64url');
  const parsed = proofs.parseAuthorization(`PairingProof ${encoded}`);
  assert.equal(parsed.proof.byteLength, 32);
  assert.equal(
    parsed.challenge.toString('hex'),
    '4bb06f8e4e3a7715d201d573d0aa423762e55dabd61a2c02278fa56cc6d294e0',
  );
  assert.equal(parsed.rateLimitFingerprint.length, 22);
  for (const invalid of [
    undefined,
    `Bearer ${encoded}`,
    `PairingProof  ${encoded}`,
    `PairingProof ${encoded}=`,
    'PairingProof AA',
  ]) {
    assert.throws(
      () => proofs.parseAuthorization(invalid),
      (error) => error instanceof AppError && error.code === 'PAIRING_PROOF_INVALID',
    );
  }
});

test('pins proof-client pending backoff at the exact 30s and 120s boundaries', () => {
  const claimedAt = 1_800_000_000_000;
  assert.equal(pendingRetryAfterSeconds(claimedAt, claimedAt + 29_999), 2);
  assert.equal(pendingRetryAfterSeconds(claimedAt, claimedAt + 30_000), 5);
  assert.equal(pendingRetryAfterSeconds(claimedAt, claimedAt + 119_999), 5);
  assert.equal(pendingRetryAfterSeconds(claimedAt, claimedAt + 120_000), 10);
  assert.throws(() => pendingRetryAfterSeconds(claimedAt, claimedAt - 1));
});
