'use client';

import { useEffect, useRef, useState } from 'react';
import type { BoardSummaryV1, ClientGrantCapabilityV1 } from '@leecat-board/board-schema';

import {
  BoardApiClient,
  createBoardRequestIdentity,
  type CreatedPairing,
  type GrantSummary,
  type PairingOwnerStatus,
} from '../../../lib/api/board-api';
import { authSessionClient } from '../../../lib/auth/session-client';
import {
  clearCreatedPairingSession,
  readCreatedPairingSession,
  writeCreatedPairingSession,
} from '../../../lib/ai-connections/created-pairing-session';
import { PairingRequestModal } from '../../../components/ai-connections/PairingRequestModal';
import { PairingCard } from './pairing-card';
import { PairingRequestList } from './pairing-request-list';
import { GrantList } from './grant-list';
import { SkillInstallGuide } from './skill-install-guide';
import { useI18n } from '../../../components/i18n/I18nProvider';

export function AiConnectionsClient() {
  const { t } = useI18n();
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
  const boardCreateAttempts = useRef(new Map<string, ReturnType<typeof createBoardRequestIdentity>>());

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
    if (pairingResult.kind !== 'ok' || grantResult.kind !== 'ok' || boardResult.kind !== 'ok') setError(t('ai.connectionRefreshFailed'));
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
      setBusy(null);
    });
    // `authSessionClient` is the process-wide client singleton; bootstrap runs once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (clients === null || !pairings.some((pairing) => ['created', 'pending', 'approved'].includes(pairing.state))) return;
    const controller = new AbortController();
    let inFlight = false;
    const tick = async () => {
      if (document.visibilityState !== 'visible' || inFlight) return;
      inFlight = true;
      try { await reload(clients.api, controller.signal); } finally { inFlight = false; }
    };
    const visible = () => { if (document.visibilityState === 'visible') void tick(); };
    const interval = window.setInterval(() => void tick(), 2_000);
    document.addEventListener('visibilitychange', visible);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
    };
    // The effect is keyed by whether a live pairing exists, not by each polling response object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, pairings.some((pairing) => ['created', 'pending', 'approved'].includes(pairing.state))]);

  useEffect(() => {
    if (created === null) return;
    const matchingPairing = pairings.find((pairing) => pairing.pairingId === created.pairingId);
    const expiresAt = matchingPairing?.state === 'pending' && matchingPairing.decisionExpiresAt !== null
      ? matchingPairing.decisionExpiresAt
      : created.codeExpiresAt;
    writeCreatedPairingSession(window.sessionStorage, created, expiresAt);
    const remaining = Math.max(0, Date.parse(expiresAt) - Date.now());
    const timeout = window.setTimeout(() => {
      clearCreatedPairingSession(window.sessionStorage);
      setCreated((current) => current?.pairingId === created.pairingId ? null : current);
    }, remaining);
    return () => window.clearTimeout(timeout);
  }, [created, pairings]);

  useEffect(() => {
    const pending = pairings.filter((pairing) => pairing.state === 'pending');
    const newlyPending = pending.find((pairing) => !seenPendingPairings.current.has(pairing.pairingId));
    seenPendingPairings.current = new Set(pending.map((pairing) => pairing.pairingId));
    if (newlyPending !== undefined) setSelectedPairingId(newlyPending.pairingId);
    else if (selectedPairingId !== null && !pairings.some((pairing) => pairing.pairingId === selectedPairingId)) {
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
    }
    else setError(t('ai.connectionRefreshFailed'));
    setBusy(null);
  }

  async function approve(pairingId: string, decision: {
    approvedScopes: ClientGrantCapabilityV1[];
    approvedLifecyclePermissions: Array<'board.create' | 'board.archive'>;
    boardIds: string[];
    lifetime: 'session' | 'persistent';
  }) {
    const token = csrf();
    if (token === null || created?.pairingId !== pairingId) return;
    setBusy(pairingId);
    setError(null);
    const current = requiredClients();
    const result = await current.api.decidePairing(pairingId, token, { decision: 'approve', ...decision });
    if (result.kind === 'ok') {
      clearCreatedPairingSession(window.sessionStorage);
      setCreated(null);
      setSelectedPairingId(null);
      await reload(current.api);
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
    }
    else setError(t('ai.connectionRefreshFailed'));
    setBusy(null);
  }

  async function createBoardForPairing(pairingId: string): Promise<BoardSummaryV1 | null> {
    const token = csrf();
    if (token === null) return null;
    setBusy(`board:${pairingId}`);
    setError(null);
    const current = requiredClients();
    const identity = boardCreateAttempts.current.get(pairingId) ?? createBoardRequestIdentity();
    boardCreateAttempts.current.set(pairingId, identity);
    const result = await current.api.createBoard({
      ...identity,
      title: t('boards.new'),
      csrfToken: token,
    });
    setBusy(null);
    if (result.kind !== 'ok') {
      if (result.kind === 'api_error' || result.kind === 'board_error') boardCreateAttempts.current.delete(pairingId);
      setError(t('ai.boardCreateFailed'));
      return null;
    }
    boardCreateAttempts.current.delete(pairingId);
    setBoards((currentBoards) => currentBoards.some((board) => board.boardId === result.value.board.boardId)
      ? currentBoards
      : [...currentBoards, result.value.board].sort((left, right) => left.title.localeCompare(right.title)));
    return result.value.board;
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

  async function revoke(grantId: string) {
    const token = csrf();
    if (token === null) return;
    setRotatedToken(null);
    setBusy(grantId);
    const current = requiredClients();
    const result = await current.api.revokeGrant(grantId, token);
    if (result.kind === 'ok') await reload(current.api);
    else setError(t('ai.connectionRefreshFailed'));
    setBusy(null);
  }

  const selectedPairing = selectedPairingId === null
    ? null
    : pairings.find((pairing) => pairing.pairingId === selectedPairingId) ?? null;

  function dismissCreatedPairing() {
    clearCreatedPairingSession(window.sessionStorage);
    setCreated(null);
  }

  return (
    <section className="settings" aria-labelledby="ai-connections-title">
      <header className="settings-head">
        <div><p className="eyebrow">SceneBoard</p><h2 className="page-title" id="ai-connections-title">{t('ai.title')}</h2><p className="muted">{t('ai.description')}</p></div>
      </header>
      <SkillInstallGuide />
      {error && <p className="error" role="alert">{error}</p>}
      {created && !pairings.some((pairing) => pairing.pairingId === created.pairingId && pairing.state === 'pending') && <PairingCard pairing={created} onDismiss={dismissCreatedPairing} />}
      {rotatedToken && <article className="item"><h3>{t('ai.newCredential')}</h3><p className="muted">{t('ai.newCredentialDescription')}</p><div className="code">{rotatedToken}</div><button className="button secondary" onClick={() => setRotatedToken(null)}>{t('common.dismiss')}</button></article>}
      <section className="section">
        <div className="section-head"><div><h2>{t('ai.pairingRequests')}</h2><p className="muted">{t('ai.pairingDescription')}</p></div><button className="button" disabled={busy !== null} onClick={() => void createPairing()}>{t('ai.createCode')}</button></div>
        <PairingRequestList pairings={pairings.filter((pairing) => pairing.pairingId !== created?.pairingId || pairing.state !== 'created')} selectedPairingId={selectedPairingId} onSelect={setSelectedPairingId} />
      </section>
      {selectedPairing !== null && <PairingRequestModal pairing={selectedPairing} matchingCode={created?.pairingId === selectedPairing.pairingId ? created.code : null} boards={boards} busy={busy !== null} onDismiss={() => setSelectedPairingId(null)} onCreateBoard={() => createBoardForPairing(selectedPairing.pairingId)} onApprove={(decision) => void approve(selectedPairing.pairingId, decision)} onDeny={() => void deny(selectedPairing.pairingId)} onCancel={() => void cancel(selectedPairing.pairingId)} />}
      <section className="section"><h2>{t('ai.approvedClients')}</h2><GrantList grants={grants} busyGrantId={busy} onRotate={(id) => void rotate(id)} onRevoke={(id) => void revoke(id)} /></section>
    </section>
  );
}
