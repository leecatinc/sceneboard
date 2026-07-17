'use client';

import { useEffect, useRef, useState } from 'react';
import type { BoardSummaryV1, ClientGrantCapabilityV1 } from '@leecat-board/board-schema';

import type { BoardApiClient, CreatedPairing, PairingOwnerStatus } from '../../lib/api/board-api';
import { authSessionClient } from '../../lib/auth/session-client';
import {
  clearCreatedPairingSession,
  readCreatedPairingSession,
  writeCreatedPairingSession,
} from '../../lib/ai-connections/created-pairing-session';
import { PairingRequestModal } from '../ai-connections/PairingRequestModal';
import { useI18n } from '../i18n/I18nProvider';

interface PairingBoardOption {
  boardId: string;
  title: string;
}

export function BoardPairingControl({ api, boardId, boardTitle }: {
  api: BoardApiClient;
  boardId: string;
  boardTitle: string;
}) {
  const { t } = useI18n();
  const [created, setCreated] = useState<CreatedPairing | null>(null);
  const [ownerStatus, setOwnerStatus] = useState<PairingOwnerStatus | null>(null);
  const [boards, setBoards] = useState<PairingBoardOption[]>([{ boardId, title: boardTitle }]);
  const [isOpen, setIsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previousState = useRef<PairingOwnerStatus['state'] | null>(null);

  useEffect(() => {
    const restored = readCreatedPairingSession(window.sessionStorage);
    setCreated(restored);
  }, []);

  useEffect(() => {
    setBoards((current) => {
      const withoutCurrent = current.filter((board) => board.boardId !== boardId);
      return [{ boardId, title: boardTitle }, ...withoutCurrent];
    });
  }, [boardId, boardTitle]);

  useEffect(() => {
    if (created === null) return;
    const expiresAt = ownerStatus?.state === 'pending' && ownerStatus.decisionExpiresAt !== null
      ? ownerStatus.decisionExpiresAt
      : created.codeExpiresAt;
    writeCreatedPairingSession(window.sessionStorage, created, expiresAt);
    const remaining = Math.max(0, Date.parse(expiresAt) - Date.now());
    const timeout = window.setTimeout(() => {
      clearCreatedPairingSession(window.sessionStorage);
      setCreated(null);
      setOwnerStatus(null);
      setIsOpen(false);
    }, remaining);
    return () => window.clearTimeout(timeout);
  }, [created, ownerStatus]);

  useEffect(() => {
    if (created === null) return;
    const controller = new AbortController();
    let inFlight = false;
    const refresh = async () => {
      if (document.visibilityState !== 'visible' || inFlight) return;
      inFlight = true;
      try {
        const result = await api.listActivePairings(controller.signal);
        if (controller.signal.aborted) return;
        if (result.kind !== 'ok') {
          setError(t('ai.connectionRefreshFailed'));
          return;
        }
        const matching = result.value.find((pairing) => pairing.pairingId === created.pairingId) ?? null;
        setOwnerStatus(matching);
        if (matching?.state === 'pending' && previousState.current !== 'pending') setIsOpen(true);
        previousState.current = matching?.state ?? null;
        if (matching !== null && !['created', 'pending'].includes(matching.state)) {
          clearCreatedPairingSession(window.sessionStorage);
          setCreated(null);
          setOwnerStatus(null);
          setIsOpen(false);
        }
      } finally {
        inFlight = false;
      }
    };
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') void refresh(); };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2_000);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [api, created?.pairingId, t]);

  const csrf = () => authSessionClient().snapshot()?.csrfToken ?? null;

  async function loadBoards() {
    const result = await api.listBoards();
    if (result.kind !== 'ok') {
      setError(t('ai.connectionRefreshFailed'));
      return;
    }
    const options: PairingBoardOption[] = result.value.boards.map((board: BoardSummaryV1) => ({ boardId: board.boardId, title: board.title }));
    if (!options.some((board) => board.boardId === boardId)) options.unshift({ boardId, title: boardTitle });
    setBoards(options);
  }

  async function openPairing() {
    setIsOpen(true);
    setError(null);
    void loadBoards();
    if (created !== null || busy) return;
    const token = csrf();
    if (token === null) {
      setIsOpen(false);
      setError(t('ai.createCodeFailed'));
      return;
    }
    setBusy(true);
    const result = await api.createPairing(token);
    setBusy(false);
    if (result.kind !== 'ok') {
      setIsOpen(false);
      setError(t('ai.createCodeFailed'));
      return;
    }
    writeCreatedPairingSession(window.sessionStorage, result.value);
    previousState.current = 'created';
    setCreated(result.value);
  }

  function clearPairing() {
    clearCreatedPairingSession(window.sessionStorage);
    previousState.current = null;
    setCreated(null);
    setOwnerStatus(null);
    setIsOpen(false);
  }

  async function approve(decision: {
    approvedScopes: ClientGrantCapabilityV1[];
    approvedLifecyclePermissions: Array<'board.create' | 'board.archive'>;
    boardIds: string[];
    lifetime: 'session' | 'persistent';
  }) {
    const token = csrf();
    if (token === null || created === null || ownerStatus?.state !== 'pending') return;
    setBusy(true);
    setError(null);
    const result = await api.decidePairing(ownerStatus.pairingId, token, { decision: 'approve', ...decision });
    setBusy(false);
    if (result.kind === 'ok') clearPairing();
    else setError(t('ai.connectionRefreshFailed'));
  }

  async function deny() {
    const token = csrf();
    if (token === null || ownerStatus?.state !== 'pending') return;
    setBusy(true);
    setError(null);
    const result = await api.decidePairing(ownerStatus.pairingId, token, { decision: 'deny' });
    setBusy(false);
    if (result.kind === 'ok') clearPairing();
    else setError(t('ai.connectionRefreshFailed'));
  }

  async function cancel() {
    const token = csrf();
    if (token === null || created === null) return;
    setBusy(true);
    setError(null);
    const result = await api.cancelPairing(created.pairingId, token);
    setBusy(false);
    if (result.kind === 'ok') clearPairing();
    else setError(t('ai.connectionRefreshFailed'));
  }

  const displayPairing = ownerStatus ?? created;

  return (
    <div className="board-pairing-control">
      <button type="button" className="button board-pairing-button" aria-haspopup="dialog" aria-expanded={isOpen} disabled={busy && created === null} onClick={() => void openPairing()}>
        {busy && created === null ? t('common.loading') : t('nav.aiConnections')}
      </button>
      {error && !isOpen && <span className="board-pairing-error" role="alert">{error}</span>}
      {isOpen && displayPairing !== null && (
        <PairingRequestModal
          pairing={displayPairing}
          matchingCode={created?.pairingId === displayPairing.pairingId ? created.code : null}
          boards={boards}
          initialBoardIds={[boardId]}
          busy={busy}
          error={error}
          onDismiss={() => setIsOpen(false)}
          onApprove={(decision) => void approve(decision)}
          onDeny={() => void deny()}
          onCancel={() => void cancel()}
        />
      )}
    </div>
  );
}
