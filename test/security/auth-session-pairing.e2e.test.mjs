import { tsImport } from 'tsx/esm/api';

import { registerAuthenticatedBoundaryRows } from './security-catalog.test-helper.mjs';

const backendImportOptions = {
  parentURL: import.meta.url,
  tsconfig: new URL('../../sceneboard-be/tsconfig.json', import.meta.url).pathname,
};

const { CryptoService } = await tsImport(
  '../../sceneboard-be/src/common/security/crypto.service.ts',
  import.meta.url,
);
const { SessionTokenService } = await tsImport(
  '../../sceneboard-be/src/auth/session-token.service.ts',
  import.meta.url,
);
const { CsrfService } = await tsImport(
  '../../sceneboard-be/src/auth/csrf.service.ts',
  import.meta.url,
);
const { CookieService } = await tsImport(
  '../../sceneboard-be/src/auth/cookie.service.ts',
  import.meta.url,
);
const { AccountApiKeyTokenCodec } = await tsImport(
  '../../sceneboard-be/src/api-keys/account-api-key-token.codec.ts',
  import.meta.url,
);
const { SessionService } = await tsImport(
  '../../sceneboard-be/src/auth/session.service.ts',
  import.meta.url,
);
const { LogoutService } = await tsImport(
  '../../sceneboard-be/src/auth/logout.service.ts',
  import.meta.url,
);
const { AuthenticationGuard } = await tsImport(
  '../../sceneboard-be/src/common/guards/authentication.guard.ts',
  backendImportOptions,
);
const { OriginGuard } = await tsImport(
  '../../sceneboard-be/src/common/guards/origin.guard.ts',
  backendImportOptions,
);
const { CsrfGuard } = await tsImport(
  '../../sceneboard-be/src/common/guards/csrf.guard.ts',
  backendImportOptions,
);
const { AccountApiKeyService } = await tsImport(
  '../../sceneboard-be/src/api-keys/account-api-key.service.ts',
  import.meta.url,
);
const { RateLimitService } = await tsImport(
  '../../sceneboard-be/src/rate-limit/rate-limit.service.ts',
  import.meta.url,
);
const { PairingService } = await tsImport(
  '../../sceneboard-be/src/pairing/pairing.service.ts',
  import.meta.url,
);
const { PairingCodeService } = await tsImport(
  '../../sceneboard-be/src/pairing/pairing-code.service.ts',
  import.meta.url,
);
const { GrantService } = await tsImport(
  '../../sceneboard-be/src/grants/grant.service.ts',
  import.meta.url,
);
const { GrantCursorService } = await tsImport(
  '../../sceneboard-be/src/grants/grant-cursor.service.ts',
  import.meta.url,
);
const { GrantTokenService } = await tsImport(
  '../../sceneboard-be/src/grants/grant-token.service.ts',
  import.meta.url,
);

const keyMaterial = Object.fromEntries(
  ['sessionToken', 'grantToken', 'csrf', 'pairingCodePepper', 'auditHmac', 'rateLimitHmac'].map(
    (name, index) => [name, Buffer.alloc(32, index + 1)],
  ),
);
const NOW = Date.parse('2027-01-15T08:00:00.000Z');

const createCrypto = () => {
  let randomCounter = 6;
  return new CryptoService(keyMaterial, (length) => {
    randomCounter = (randomCounter + 1) % 255;
    return Buffer.alloc(length, randomCounter);
  });
};

const operateProductionOwner = (fixture, owner, operation, resource, callback) => {
  const effects = resource.effects ?? new Set();
  resource.effects = effects;
  const handle = fixture.registerOwnerResource({
    owner,
    resource,
    cleanup: ({ effects }) => effects.clear(),
    inspectResidue: () => effects.size,
  });
  return fixture.operate(handle, operation, callback);
};

const executionContext = (request) => ({
  getHandler: () => function handler() {},
  getClass: () => class Controller {},
  switchToHttp: () => ({ getRequest: () => request }),
});

const sessionBoundary = (row, fixture) => {
  const crypto = createCrypto();
  const tokens = new SessionTokenService(crypto);
  const csrf = new CsrfService(crypto);
  const cookies = new CookieService('test');
  const issued = tokens.issue();
  const state = row.preconditionState;
  const cascades = [];
  let rotated = false;
  const record = {
    databaseId: '1',
    publicId: 'session_1',
    familyPublicId: 'family_1',
    tokenHash: issued.tokenHash,
    status:
      state === 'presented-rotated-token-reuse-cascade'
        ? 'rotated'
        : state === 'old-generation-after-renewal' || state === 'old-generation-after-logout'
          ? 'revoked'
          : state === 'expired-session'
            ? 'expired'
            : 'active',
    user: {
      databaseId: '2',
      publicId: 'user_1',
      email: 'owner@example.test',
      status: state === 'disabled-user' ? 'disabled' : 'active',
      createdAt: new Date(NOW - 60_000).toISOString(),
    },
    idleExpiresAt: NOW + 60_000,
    absoluteExpiresAt: NOW + 120_000,
  };
  const persistence = {
    async findByLocator(locator) {
      return locator.equals(issued.locator) ? record : null;
    },
    async terminalizeFamily(_record, reason) {
      cascades.push(reason);
      record.status = 'revoked';
      return { kind: 'committed' };
    },
    async rotate() {
      rotated = true;
      record.status = 'rotated';
      return { kind: 'created' };
    },
    async observeLogout() {
      return { kind: 'committed' };
    },
  };
  const sessions = new SessionService(persistence, tokens, csrf, crypto);
  const resource = { effects: new Set(), sessions, persistence };
  return operateProductionOwner(
    fixture,
    state === 'foreign-origin' || state === 'missing-origin'
      ? 'sceneboard.authentication-guard'
      : 'sceneboard.session-service',
    `auth.session.${row.caseId.toLowerCase()}`,
    resource,
    async ({ effects }) => {
      if (state === 'foreign-origin' || state === 'missing-origin') {
        const guard = new OriginGuard(
          { getAllAndOverride: () => 'required' },
          { browserOrigin: 'https://board.example.test' },
        );
        try {
          guard.canActivate(
            executionContext({
              headers: state === 'foreign-origin' ? { origin: 'https://foreign.test' } : {},
            }),
          );
          return 'ORIGIN_ACCEPTED';
        } catch (error) {
          effects.add(error.code);
          return state === 'foreign-origin' ? 'ORIGIN_DENIED' : 'ORIGIN_REQUIRED';
        }
      }
      const csrfToken = csrf.issueSession(record.familyPublicId, NOW, record.idleExpiresAt).token;
      if (state.includes('csrf')) {
        const csrfGuard = new CsrfGuard(
          { getAllAndOverride: () => 'session' },
          { browserOrigin: 'https://board.example.test' },
          csrf,
          cookies,
        );
        const candidate =
          state === 'csrf-from-other-family'
            ? csrf.issueSession('other-family', NOW, record.idleExpiresAt).token
            : state === 'stale-csrf-after-renewal'
              ? csrf.issueSession(record.familyPublicId, NOW - 120_000, NOW - 60_000).token
              : `${csrfToken}x`;
        const request = {
          headers: {
            origin: 'https://board.example.test',
            ...(state === 'missing-csrf-header' ? {} : { 'x-csrf-token': candidate }),
          },
          cookies: state === 'missing-csrf-cookie' ? {} : { [cookies.names.csrf]: csrfToken },
          authSession: record,
        };
        try {
          csrfGuard.canActivate(executionContext(request));
          return 'CSRF_ACCEPTED';
        } catch (error) {
          effects.add(error.code);
          return 'CSRF_DENIED';
        }
      }
      if (state === 'renew-rotates-generation') {
        const renewed = await sessions.renew(issued.token, csrfToken, NOW);
        effects.add(`rotated:${rotated}`);
        return rotated && renewed.sessionCredential !== issued.token
          ? 'SESSION_GENERATION_ROTATED'
          : 'UNAUTHENTICATED';
      }
      if (state === 'logout-terminalizes-family') {
        await new LogoutService(persistence, tokens, csrf).logout(
          issued.token,
          csrfToken,
          csrfToken,
          NOW,
        );
        effects.add(`terminal:${cascades.join(',')}`);
        return cascades.includes('logout') ? 'SESSION_TERMINAL' : 'UNAUTHENTICATED';
      }
      const credential =
        state === 'missing-session-cookie'
          ? undefined
          : state === 'malformed-session-cookie'
            ? 'malformed'
            : issued.token;
      const request = {
        headers: {},
        cookies: credential === undefined ? {} : { [cookies.names.session]: credential },
      };
      const guard = new AuthenticationGuard({ getAllAndOverride: () => true }, sessions, cookies);
      try {
        await guard.canActivate(executionContext(request));
        effects.add(`resolved:${request.authSession.publicId}`);
        return 'SESSION_CURRENT';
      } catch (error) {
        effects.add(`rejected:${error.code}:${cascades.join(',')}`);
        if (state === 'disabled-user')
          return cascades.includes('disabled') ? 'FORBIDDEN' : error.code;
        if (state === 'presented-rotated-token-reuse-cascade')
          return cascades.includes('reuse') ? 'SESSION_FAMILY_REVOKED' : error.code;
        return 'UNAUTHENTICATED';
      }
    },
  );
};

const accountApiKeyBoundary = (row, fixture) => {
  const crypto = createCrypto();
  const tokens = new AccountApiKeyTokenCodec(crypto);
  const issued = tokens.issue();
  const effects = new Set();
  const state = row.preconditionState;
  const limiter = new RateLimitService(
    {
      async consume() {
        return state === 'authentication-failure-bucket-saturated' ? [61, 60_000] : [1, 60_000];
      },
    },
    crypto,
    'sceneboard:',
  );
  const repository = {
    async findCredential() {
      effects.add('credential-lookup');
      if (state === 'unknown-key-digest') return null;
      return {
        keyPk: '9',
        keyPublicId: 'key_1',
        ownerUserPk: '2',
        ownerPublicId: 'user_1',
        ownerStatus: state === 'disabled-owner-account' ? 0 : 1,
        tokenHash: issued.tokenHash,
        scopeMask: 4,
        persistedStatus: state === 'revoked-key' ? 0 : 1,
        expiresAt: state === 'expired-key' ? NOW : NOW + 60_000,
        databaseNow: NOW,
      };
    },
    async writeAuthenticationAudit(input) {
      effects.add(`audit:${input.result.reason ?? 'success'}`);
    },
    async markUsed() {
      effects.add('mark-used');
    },
  };
  const service = new AccountApiKeyService(repository, tokens, crypto, limiter, {
    accountApiKeyIssuanceEnabled: true,
    accountApiKeyAuthEnabled: true,
  });
  return operateProductionOwner(
    fixture,
    'sceneboard.account-api-key-service',
    `auth.account-api-key.${row.caseId.toLowerCase()}`,
    { effects, service },
    async ({ service }) => {
      const token =
        state === 'missing-bearer'
          ? ''
          : state === 'malformed-bearer' || state === 'authentication-failure-bucket-saturated'
            ? 'malformed'
            : state === 'unknown-key-digest'
              ? new AccountApiKeyTokenCodec(createCrypto()).issue().token
              : issued.token;
      try {
        const snapshot = await service.resolveBearer(token, {
          correlationId: `correlation-${row.caseId}`,
          clientIp: '192.0.2.10',
        });
        return snapshot.keyPublicId === 'key_1'
          ? 'ACCOUNT_API_KEY_AUTHENTICATED'
          : 'UNAUTHENTICATED';
      } catch (error) {
        if (error.code === 'RATE_LIMITED') return 'RATE_LIMITED';
        if (state === 'disabled-owner-account' && effects.has('audit:owner_disabled'))
          return 'FORBIDDEN';
        return 'UNAUTHENTICATED';
      }
    },
  );
};

const pairingBoundary = (row, fixture) => {
  const crypto = createCrypto();
  const state = row.preconditionState;
  const effects = new Set();
  const ownerState = state.toLowerCase();
  const ownerStatus = { pairingId: 'pairing_1', state: ownerState };
  const clientStatus = { pairingId: 'pairing_1', state: ownerState };
  const proof = {
    proof: Buffer.alloc(32, 7),
    challenge: Buffer.alloc(32, 8),
    rateLimitFingerprint: 'attempt-proof',
  };
  const session = {
    databaseId: '2',
    publicId: 'session_1',
    familyPublicId: 'family_1',
    user: { databaseId: '1', publicId: 'user_1' },
  };
  if (row.caseId.startsWith('PAIR-GRANT-')) {
    const repository = {
      async revoke() {
        effects.add(`grant-revoke:${state}`);
        return { kind: 'revoked' };
      },
      async rotate() {
        effects.add(`grant-rotate:${state}`);
        return state === 'ACTIVE'
          ? { kind: 'rotated', grant: { grantId: 'grant_1', status: 'active' } }
          : { kind: 'not_active' };
      },
    };
    const service = new GrantService(
      repository,
      new GrantCursorService(crypto),
      new GrantTokenService(crypto),
    );
    return operateProductionOwner(
      fixture,
      'sceneboard.grant-service',
      `pairing.grant.${row.caseId.toLowerCase()}`,
      { effects, service },
      async ({ service }) => {
        if (row.caseId.startsWith('PAIR-GRANT-REVOKE-')) {
          await service.revoke(session, 'grant_1', NOW);
          return '204_GRANT_REVOKE_RESULT';
        }
        try {
          const result = await service.rotate(session, 'grant_1', NOW);
          return result.accessToken ? '200_GRANT_CREDENTIAL_RESPONSE' : '409_GRANT_NOT_ACTIVE';
        } catch (error) {
          return error.code === 'GRANT_NOT_ACTIVE'
            ? '409_GRANT_NOT_ACTIVE'
            : 'UNRECOGNIZED_PAIRING_OPERATION';
        }
      },
    );
  }
  const repository = {
    async ownerStatus() {
      effects.add(`owner-status:${state}`);
      return { kind: 'status', status: ownerStatus };
    },
    async clientStatus() {
      effects.add(`client-status:${state}`);
      return row.caseId.startsWith('PAIR-CLIENT-PROOF-')
        ? { kind: 'proof_invalid' }
        : { kind: 'status', status: clientStatus };
    },
    async redeem() {
      effects.add(`redeem:${state}`);
      if (state === 'INVALID-PROOF') return { kind: 'proof_invalid' };
      if (state === 'PENDING') return { kind: 'not_ready', retryAfterSeconds: 2 };
      if (state === 'APPROVED')
        return { kind: 'redeemed', grant: { grantId: 'grant_1', status: 'active' } };
      return { kind: 'terminal' };
    },
  };
  const service = new PairingService(
    repository,
    new PairingCodeService(crypto),
    crypto,
    0,
    0,
    async () => {},
  );
  return operateProductionOwner(
    fixture,
    'sceneboard.pairing-service',
    `pairing.lifecycle.${row.caseId.toLowerCase()}`,
    { effects, service },
    async ({ service }) => {
      if (row.caseId.startsWith('PAIR-OWNER-')) {
        const result = await service.getOwnerStatus(session, 'pairing_1', NOW);
        return `200_PAIRING_OWNER_STATUS_${result.state.toUpperCase()}`;
      }
      if (row.caseId.startsWith('PAIR-CLIENT-')) {
        try {
          const result = await service.clientStatus('pairing_1', proof, NOW);
          return `200_PAIRING_CLIENT_STATUS_${result.state.toUpperCase()}`;
        } catch (error) {
          return error.code === 'PAIRING_PROOF_INVALID'
            ? '401_PAIRING_PROOF_INVALID'
            : 'UNRECOGNIZED_PAIRING_OPERATION';
        }
      }
      if (row.caseId.startsWith('PAIR-REDEEM-')) {
        try {
          const result = await service.redeem('pairing_1', proof, NOW);
          return result.accessToken ? '200_GRANT_CREDENTIAL_RESPONSE' : 'PAIRING_REDEEM_FAILED';
        } catch (error) {
          if (error.code === 'PAIRING_NOT_READY') return '409_PAIRING_NOT_READY';
          if (error.code === 'PAIRING_PROOF_INVALID') return '401_PAIRING_PROOF_INVALID';
          if (error.code === 'PAIRING_TERMINAL') return '410_PAIRING_TERMINAL';
          return 'UNRECOGNIZED_PAIRING_OPERATION';
        }
      }
      return 'UNRECOGNIZED_PAIRING_OPERATION';
    },
  );
};

const executeAuthBoundary = (row) =>
  Object.freeze({
    caseId: row.caseId,
    cluster: row.cluster,
    preconditionState: row.preconditionState,
    principalKind: row.principalKind,
  });

const executeAuthProductionBoundary = (row, fixture) => {
  if (row.cluster === 'AUTH_SESSION') return sessionBoundary(row, fixture);
  if (row.cluster === 'ACCOUNT_API_KEY_AUTHENTICATION') return accountApiKeyBoundary(row, fixture);
  if (row.cluster === 'PAIRING') return pairingBoundary(row, fixture);
  throw new Error(`unsupported auth boundary cluster: ${row.cluster}`);
};

await registerAuthenticatedBoundaryRows({
  producerId: 'sceneboard.security.auth-session-pairing.v1',
  expectedCounts: { AUTH_SESSION: 18, PAIRING: 33, ACCOUNT_API_KEY_AUTHENTICATION: 8 },
  adapter: executeAuthBoundary,
  executeBoundary: executeAuthProductionBoundary,
});
