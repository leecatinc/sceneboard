'use client';

import { useEffect, useRef, useState } from 'react';
import type { BoardSummaryV1, ClientGrantCapabilityV1 } from '@sceneboard/board-schema';
import { useRouter } from 'next/navigation';

import {
  BoardApiClient,
  type CreatedPairing,
  type GrantSummary,
  type PairingBoardDestination,
  type PairingOwnerStatus,
} from '../../../lib/api/board-api';
import { authSessionClient } from '../../../lib/auth/session-client';
import {
  clearCreatedPairingSession,
  readCreatedPairingSession,
  writeCreatedPairingSession,
} from '../../../lib/ai-connections/created-pairing-session';
import { HEADER_GRANTS_CHANGED_EVENT } from '../../../lib/ai-connections/header-connection-state';
import { PairingRequestModal } from '../../../components/ai-connections/PairingRequestModal';
import { PairingCard } from './pairing-card';
import { PairingRequestList } from './pairing-request-list';
import { GrantList } from './grant-list';
import { SkillInstallGuide } from './skill-install-guide';
import { useI18n } from '../../../components/i18n/I18nProvider';
import { ApiKeyList } from './api-key-list';

export function AiConnectionsClient() {
  const { t } = useI18n();
  const router = useRouter();
  const [clients, setClients] = useState<{
    auth: ReturnType<typeof authSessionClient>;
    api: BoardApiClient;
  } | null>(null);
  const [pairings, setPairings] = useState<PairingOwnerStatus[]>([]);
  const [grants, setGrants] = useState<GrantSummary[]>([]);
  const [boards, setBoards] = useState<BoardSummaryV1[]>([]);
  const [created, setCreated] = useState<CreatedPairing | null>(null);
  const [selectedPairingId, setSelectedPairingId] = useState<string | null>(null);
  const [rotatedToken, setRotatedToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>('bootstrap');
  const [error, setError] = useState<string | null>(null);
  const seenPendingPairings = useRef(new Set<string>());
  const hasLivePairing = pairings.some((pairing) =>
    ['created', 'pending', 'approved'].includes(pairing.state),
  );

  async function reload(api: BoardApiClient = requiredClients().api, signal?: AbortSignal) {
    const [pairingResult, grantResult, boardResult] = await Promise.all([
      api.listActivePairings(signal),
      api.listGrants(null, signal),
      api.listBoards(null, signal),
    ]);
    if (signal?.aborted) return;
    if (pairingResult.kind === 'ok') setPairings(pairingResult.value);
    if (grantResult.kind === 'ok') setGrants(grantResult.value.grants);
    if (boardResult.kind === 'ok') setBoards(boardResult.value.boards);
    if (pairingResult.kind !== 'ok' || grantResult.kind !== 'ok' || boardResult.kind !== 'ok')
      setError(t('ai.connectionRefreshFailed'));
  }

  useEffect(() => {
    setCreated(readCreatedPairingSession(window.sessionStorage));
  }, []);

  useEffect(() => {
    const auth = authSessionClient();
    const api = new BoardApiClient(auth.sharedCoordinator());
    setClients({ auth, api });
    void auth.reconcile().then(async (result) => {
      if (result.kind !== 'ok' || result.value === null) {
        window.location.assign('/login');
        return;
      }
      await reload(api);
      const location = new URL(window.location.href);
      if (location.searchParams.get('create') === '1') {
        location.searchParams.delete('create');
        window.history.replaceState(
          window.history.state,
          '',
          `${location.pathname}${location.search}${location.hash}`,
        );
        const token = auth.snapshot()?.csrfToken ?? null;
        if (token !== null) {
          const createdResult = await api.createPairing(token);
          if (createdResult.kind === 'ok') {
            setCreated(createdResult.value);
            writeCreatedPairingSession(window.sessionStorage, createdResult.value);
            await reload(api);
          } else {
            setError(t('ai.createCodeFailed'));
          }
        }
      }
      setBusy(null);
    });
    // `authSessionClient` is the process-wide client singleton; bootstrap runs once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (clients === null || !hasLivePairing) return;
    const controller = new AbortController();
    let inFlight = false;
    const tick = async () => {
      if (document.visibilityState !== 'visible' || inFlight) return;
      inFlight = true;
      try {
        await reload(clients.api, controller.signal);
      } finally {
        inFlight = false;
      }
    };
    const visible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    const interval = window.setInterval(() => void tick(), 2_000);
    document.addEventListener('visibilitychange', visible);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
    };
    // The effect is keyed by whether a live pairing exists, not by each polling response object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, hasLivePairing]);

  useEffect(() => {
    if (created === null) return;
    const matchingPairing = pairings.find((pairing) => pairing.pairingId === created.pairingId);
    const expiresAt =
      matchingPairing?.state === 'pending' && matchingPairing.decisionExpiresAt !== null
        ? matchingPairing.decisionExpiresAt
        : created.codeExpiresAt;
    writeCreatedPairingSession(window.sessionStorage, created, expiresAt);
    const remaining = Math.max(0, Date.parse(expiresAt) - Date.now());
    const timeout = window.setTimeout(() => {
      clearCreatedPairingSession(window.sessionStorage);
      setCreated((current) => (current?.pairingId === created.pairingId ? null : current));
    }, remaining);
    return () => window.clearTimeout(timeout);
  }, [created, pairings]);

  useEffect(() => {
    const pending = pairings.filter((pairing) => pairing.state === 'pending');
    const newlyPending = pending.find(
      (pairing) => !seenPendingPairings.current.has(pairing.pairingId),
    );
    seenPendingPairings.current = new Set(pending.map((pairing) => pairing.pairingId));
    if (newlyPending !== undefined) setSelectedPairingId(newlyPending.pairingId);
    else if (
      selectedPairingId !== null &&
      !pairings.some((pairing) => pairing.pairingId === selectedPairingId)
    ) {
      setSelectedPairingId(null);
    }
  }, [pairings, selectedPairingId]);

  useEffect(() => {
    if (rotatedToken === null) return;
    const timeout = window.setTimeout(() => setRotatedToken(null), 60_000);
    return () => window.clearTimeout(timeout);
  }, [rotatedToken]);

  function requiredClients() {
    if (clients === null) throw new TypeError('session clients are not ready');
    return clients;
  }

  const csrf = () => clients?.auth.snapshot()?.csrfToken ?? null;

  async function createPairing() {
    const token = csrf();
    if (token === null) return;
    setBusy('create');
    setError(null);
    const current = requiredClients();
    const result = await current.api.createPairing(token);
    if (result.kind === 'ok') {
      setCreated(result.value);
      writeCreatedPairingSession(window.sessionStorage, result.value);
      await reload(current.api);
    } else setError(t('ai.createCodeFailed'));
    setBusy(null);
  }

  async function deny(pairingId: string) {
    const token = csrf();
    if (token === null) return;
    setBusy(pairingId);
    const current = requiredClients();
    const result = await current.api.decidePairing(pairingId, token, { decision: 'deny' });
    if (result.kind === 'ok') {
      if (created?.pairingId === pairingId) {
        clearCreatedPairingSession(window.sessionStorage);
        setCreated(null);
      }
      setSelectedPairingId(null);
      await reload(current.api);
    } else setError(t('ai.connectionRefreshFailed'));
    setBusy(null);
  }

  async function approve(
    pairingId: string,
    decision: {
      approvedScopes: ClientGrantCapabilityV1[];
      approvedLifecyclePermissions: Array<'board.create' | 'board.archive'>;
      destination: PairingBoardDestination;
      lifetime: 'session' | 'persistent';
    },
  ) {
    const token = csrf();
    if (token === null || created?.pairingId !== pairingId) return;
    setBusy(pairingId);
    setError(null);
    const current = requiredClients();
    const result = await current.api.decidePairing(pairingId, token, {
      decision: 'approve',
      ...decision,
    });
    if (result.kind === 'ok') {
      clearCreatedPairingSession(window.sessionStorage);
      setCreated(null);
      setSelectedPairingId(null);
      const destination =
        result.value.boardIds?.length === 1
          ? `/boards/${encodeURIComponent(result.value.boardIds[0]!)}`
          : '/boards';
      router.replace(destination);
    } else setError(t('ai.connectionRefreshFailed'));
    setBusy(null);
  }

  async function cancel(pairingId: string) {
    const token = csrf();
    if (token === null) return;
    setBusy(pairingId);
    const current = requiredClients();
    const result = await current.api.cancelPairing(pairingId, token);
    if (result.kind === 'ok') {
      if (created?.pairingId === pairingId) {
        clearCreatedPairingSession(window.sessionStorage);
        setCreated(null);
      }
      setSelectedPairingId(null);
      await reload(current.api);
    } else setError(t('ai.connectionRefreshFailed'));
    setBusy(null);
  }

  async function rotate(grantId: string) {
    const token = csrf();
    if (token === null) return;
    setRotatedToken(null);
    setBusy(grantId);
    const current = requiredClients();
    const result = await current.api.rotateGrant(grantId, token);
    if (result.kind === 'ok') {
      setRotatedToken(result.value.accessToken);
      await reload(current.api);
    } else setError(t('ai.connectionRefreshFailed'));
    setBusy(null);
  }

  async function revoke(grantId: string): Promise<boolean> {
    const token = csrf();
    if (token === null) return false;
    setRotatedToken(null);
    setError(null);
    setBusy(grantId);
    const current = requiredClients();
    const result = await current.api.revokeGrant(grantId, token);
    if (result.kind === 'ok') {
      setGrants((currentGrants) => currentGrants.filter((grant) => grant.grantId !== grantId));
      window.dispatchEvent(new Event(HEADER_GRANTS_CHANGED_EVENT));
    }
    setBusy(null);
    return result.kind === 'ok';
  }

  const selectedPairing =
    selectedPairingId === null
      ? null
      : (pairings.find((pairing) => pairing.pairingId === selectedPairingId) ?? null);

  function dismissCreatedPairing() {
    clearCreatedPairingSession(window.sessionStorage);
    setCreated(null);
  }

  return (
    <section className="settings" aria-labelledby="ai-connections-title">
      <header className="settings-head">
        <div>
          <p className="eyebrow">SceneBoard</p>
          <h2 className="page-title" id="ai-connections-title">
            {t('ai.title')}
          </h2>
          <p className="muted">{t('ai.description')}</p>
        </div>
      </header>
      <SkillInstallGuide />
      <ApiKeyList />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {created &&
        !pairings.some(
          (pairing) => pairing.pairingId === created.pairingId && pairing.state === 'pending',
        ) && <PairingCard pairing={created} onDismiss={dismissCreatedPairing} />}
      {rotatedToken && (
        <article className="item">
          <h3>{t('ai.newCredential')}</h3>
          <p className="muted">{t('ai.newCredentialDescription')}</p>
          <div className="code">{rotatedToken}</div>
          <button className="button secondary" onClick={() => setRotatedToken(null)}>
            {t('common.dismiss')}
          </button>
        </article>
      )}
      <section className="section">
        <div className="section-head">
          <div>
            <h2>{t('ai.pairingRequests')}</h2>
            <p className="muted">{t('ai.pairingDescription')}</p>
          </div>
          <button className="button" disabled={busy !== null} onClick={() => void createPairing()}>
            {t('ai.createCode')}
          </button>
        </div>
        <PairingRequestList
          pairings={pairings.filter(
            (pairing) => pairing.pairingId !== created?.pairingId || pairing.state !== 'created',
          )}
          selectedPairingId={selectedPairingId}
          onSelect={setSelectedPairingId}
        />
      </section>
      {selectedPairing !== null && (
        <PairingRequestModal
          pairing={selectedPairing}
          matchingCode={created?.pairingId === selectedPairing.pairingId ? created.code : null}
          boards={boards}
          busy={busy !== null}
          onDismiss={() => setSelectedPairingId(null)}
          onApprove={(decision) => void approve(selectedPairing.pairingId, decision)}
          onDeny={() => void deny(selectedPairing.pairingId)}
          onCancel={() => void cancel(selectedPairing.pairingId)}
        />
      )}
      <section className="section">
        <h2>{t('ai.approvedClients')}</h2>
        <GrantList
          grants={grants}
          busyGrantId={busy}
          onRotate={(id) => void rotate(id)}
          onRevoke={revoke}
        />
      </section>
    </section>
  );
}
