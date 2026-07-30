'use client';

import type { BoardSummaryV1, ClientGrantCapabilityV1 } from '@sceneboard/board-schema';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  CreatedPairing,
  PairingBoardDestination,
  PairingOwnerStatus,
} from '../../lib/api/board-api';
import { BoardApiClient } from '../../lib/api/board-api';
import {
  clearCreatedPairingSession,
  readCreatedPairingSession,
  writeCreatedPairingSession,
} from '../../lib/ai-connections/created-pairing-session';
import {
  deriveHeaderConnectionState,
  HEADER_GRANTS_CHANGED_EVENT,
  type HeaderConnectionState,
} from '../../lib/ai-connections/header-connection-state';
import { authSessionClient } from '../../lib/auth/session-client';
import { boardIdFromDetailPath } from '../../lib/board/board-lifecycle-navigation';
import { PairingRequestModal } from '../ai-connections/PairingRequestModal';
import { useI18n } from '../i18n/I18nProvider';
import styles from './HeaderPairingAction.module.css';

interface PairingBoardOption {
  boardId: string;
  title: string;
}

export function HeaderPairingAction() {
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const [api] = useState(() => new BoardApiClient(authSessionClient().sharedCoordinator()));
  const [created, setCreated] = useState<CreatedPairing | null>(null);
  const [ownerStatus, setOwnerStatus] = useState<PairingOwnerStatus | null>(null);
  const [boards, setBoards] = useState<PairingBoardOption[]>([]);
  const [grantState, setGrantState] = useState<HeaderConnectionState>('idle');
  const [checkedGrants, setCheckedGrants] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previousPairingState = useRef<PairingOwnerStatus['state'] | null>(null);

  const loadBoards = useCallback(
    async (signal?: AbortSignal) => {
      const result = await api.listBoards(null, signal);
      if (signal?.aborted) return;
      if (result.kind !== 'ok') {
        setError(t('ai.connectionRefreshFailed'));
        return;
      }
      setBoards(
        result.value.boards.map((board: BoardSummaryV1) => ({
          boardId: board.boardId,
          title: board.title,
        })),
      );
    },
    [api, t],
  );

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const [pairingResult, grantResult] = await Promise.all([
        api.listActivePairings(signal),
        api.listGrants(null, signal),
      ]);
      if (signal?.aborted) return;
      if (grantResult.kind === 'ok') {
        setGrantState(deriveHeaderConnectionState(grantResult.value.grants));
        setCheckedGrants(true);
      } else {
        setCheckedGrants(true);
        setError(t('ai.connectionRefreshFailed'));
      }
      if (pairingResult.kind !== 'ok') {
        setError(t('ai.connectionRefreshFailed'));
        return;
      }
      if (created === null) return;
      const matching =
        pairingResult.value.find((pairing) => pairing.pairingId === created.pairingId) ?? null;
      setOwnerStatus(matching);
      if (matching?.state === 'pending' && previousPairingState.current !== 'pending') {
        setIsOpen(true);
        void loadBoards(signal);
      }
      previousPairingState.current = matching?.state ?? null;
      if (
        matching === null ||
        ['redeemed', 'denied', 'cancelled', 'expired', 'locked'].includes(matching.state)
      ) {
        clearCreatedPairingSession(window.sessionStorage);
        setCreated(null);
        setOwnerStatus(null);
        setIsOpen(false);
      }
    },
    [api, created, loadBoards, t],
  );

  useEffect(() => {
    setCreated(readCreatedPairingSession(window.sessionStorage));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const tick = async () => {
      if (document.visibilityState !== 'visible' || inFlight) return;
      inFlight = true;
      try {
        await refresh(controller.signal);
      } finally {
        inFlight = false;
      }
    };
    const onGrantsChanged = () => void tick();
    window.addEventListener(HEADER_GRANTS_CHANGED_EVENT, onGrantsChanged);
    void tick();
    if (created === null && grantState !== 'connecting')
      return () => {
        controller.abort();
        window.removeEventListener(HEADER_GRANTS_CHANGED_EVENT, onGrantsChanged);
      };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    const interval = window.setInterval(() => void tick(), 2_000);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener(HEADER_GRANTS_CHANGED_EVENT, onGrantsChanged);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [created, grantState, refresh]);

  useEffect(() => {
    if (created === null) return;
    const expiresAt =
      ownerStatus?.state === 'pending' && ownerStatus.decisionExpiresAt !== null
        ? ownerStatus.decisionExpiresAt
        : created.codeExpiresAt;
    writeCreatedPairingSession(window.sessionStorage, created, expiresAt);
    const timeout = window.setTimeout(
      () => {
        clearCreatedPairingSession(window.sessionStorage);
        previousPairingState.current = null;
        setCreated(null);
        setOwnerStatus(null);
        setIsOpen(false);
      },
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [created, ownerStatus]);

  const csrf = () => authSessionClient().snapshot()?.csrfToken ?? null;

  function clearPairing() {
    clearCreatedPairingSession(window.sessionStorage);
    previousPairingState.current = null;
    setCreated(null);
    setOwnerStatus(null);
    setIsOpen(false);
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
    previousPairingState.current = 'created';
    setCreated(result.value);
  }

  async function approve(decision: {
    approvedScopes: ClientGrantCapabilityV1[];
    approvedLifecyclePermissions: Array<'board.create' | 'board.archive'>;
    destination: PairingBoardDestination;
    lifetime: 'session' | 'persistent';
  }) {
    const token = csrf();
    if (token === null || created === null || ownerStatus?.state !== 'pending') return;
    setBusy(true);
    setError(null);
    const result = await api.decidePairing(ownerStatus.pairingId, token, {
      decision: 'approve',
      ...decision,
    });
    setBusy(false);
    if (result.kind !== 'ok') {
      setError(t('ai.connectionRefreshFailed'));
      return;
    }
    setGrantState('connecting');
    clearPairing();
    const destination =
      result.value.boardIds?.length === 1
        ? `/boards/${encodeURIComponent(result.value.boardIds[0]!)}`
        : '/boards';
    router.replace(destination);
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
  const visualState: HeaderConnectionState = created === null ? grantState : 'connecting';
  const preferredBoardId = boardIdFromDetailPath(pathname ?? '');

  return (
    <div className={styles.control}>
      {created === null && visualState !== 'idle' ? (
        <Link
          className={`${styles.status} ${visualState === 'connecting' ? styles.connecting : ''}`}
          href="/settings/ai-connections"
        >
          <span className={styles.dot} aria-hidden="true" />
          {t(visualState === 'connected' ? 'ai.connected' : 'ai.connecting')}
        </Link>
      ) : (
        <button
          type="button"
          className={`button ${styles.action}`}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          disabled={busy || (!checkedGrants && created === null)}
          onClick={() => void openPairing()}
        >
          {busy || (!checkedGrants && created === null)
            ? t('common.loading')
            : created === null
              ? t('ai.createCode')
              : t('ai.connecting')}
        </button>
      )}
      {error !== null && !isOpen && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
      {isOpen && displayPairing !== null && (
        <PairingRequestModal
          pairing={displayPairing}
          matchingCode={created?.pairingId === displayPairing.pairingId ? created.code : null}
          boards={boards}
          preferredBoardId={preferredBoardId}
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
