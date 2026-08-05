'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BoardSessionAccessV1,
  BoardSummaryV1,
  ClientGrantCapabilityV1,
} from '@sceneboard/board-schema';

import type {
  BoardApiClient,
  CreatedPairing,
  GrantSummary,
  PairingBoardDestination,
  PairingOwnerStatus,
} from '../../lib/api/board-api';
import { authSessionClient } from '../../lib/auth/session-client';
import {
  clearCreatedPairingSession,
  readCreatedPairingSession,
  writeCreatedPairingSession,
} from '../../lib/ai-connections/created-pairing-session';
import { HEADER_GRANTS_CHANGED_EVENT } from '../../lib/ai-connections/header-connection-state';
import { PairingRequestModal } from '../ai-connections/PairingRequestModal';
import { useI18n } from '../i18n/I18nProvider';

interface PairingBoardOption {
  boardId: string;
  title: string;
}

export function BoardPairingControl({
  api,
  boardId,
  boardTitle,
  enabled,
  capabilityEpoch,
  connectionGrantCeiling,
}: {
  api: BoardApiClient;
  boardId: string;
  boardTitle: string;
  enabled: boolean;
  capabilityEpoch: number;
  connectionGrantCeiling: BoardSessionAccessV1['connectionGrantCeiling'];
}) {
  const { t } = useI18n();
  const [created, setCreated] = useState<CreatedPairing | null>(null);
  const [ownerStatus, setOwnerStatus] = useState<PairingOwnerStatus | null>(null);
  const [boards, setBoards] = useState<PairingBoardOption[]>([{ boardId, title: boardTitle }]);
  const [isOpen, setIsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isGrantCheckComplete, setIsGrantCheckComplete] = useState(false);
  const [boardGrant, setBoardGrant] = useState<GrantSummary | null>(null);
  const previousState = useRef<PairingOwnerStatus['state'] | null>(null);
  const requestAborts = useRef(new Map<string, AbortController>());
  const requestEpochs = useRef(new Map<string, number>());
  const currentCapabilityEpoch = useRef(capabilityEpoch);

  const beginAction = useCallback(
    (action: string) => {
      requestAborts.current.get(action)?.abort();
      const controller = new AbortController();
      const epoch = (requestEpochs.current.get(action) ?? 0) + 1;
      requestAborts.current.set(action, controller);
      requestEpochs.current.set(action, epoch);
      return {
        action,
        boardId,
        capabilityEpoch: currentCapabilityEpoch.current,
        controller,
        epoch,
      };
    },
    [boardId],
  );

  const actionIsCurrent = useCallback(
    (request: ReturnType<typeof beginAction>) =>
      !request.controller.signal.aborted &&
      request.boardId === boardId &&
      request.capabilityEpoch === currentCapabilityEpoch.current &&
      requestAborts.current.get(request.action) === request.controller &&
      requestEpochs.current.get(request.action) === request.epoch,
    [boardId],
  );

  const clearForbiddenState = useCallback(() => {
    for (const controller of requestAborts.current.values()) controller.abort();
    requestAborts.current.clear();
    for (const [action, epoch] of requestEpochs.current)
      requestEpochs.current.set(action, epoch + 1);
    clearCreatedPairingSession(window.sessionStorage);
    previousState.current = null;
    setCreated(null);
    setOwnerStatus(null);
    setBoardGrant(null);
    setIsOpen(false);
    setBusy(false);
    setError(null);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const restored = readCreatedPairingSession(window.sessionStorage);
    setCreated(restored);
  }, [enabled]);

  const ceilingIdentity = `${connectionGrantCeiling.scopes.join(',')}|${connectionGrantCeiling.lifecyclePermissions.join(',')}`;
  const previousAccess = useRef<{
    enabled: boolean;
    capabilityEpoch: number;
    ceilingIdentity: string;
  } | null>(null);

  useEffect(() => {
    const previous = previousAccess.current;
    currentCapabilityEpoch.current = capabilityEpoch;
    previousAccess.current = { enabled, capabilityEpoch, ceilingIdentity };
    if (
      !enabled ||
      (previous !== null &&
        (previous.enabled !== enabled ||
          previous.capabilityEpoch !== capabilityEpoch ||
          previous.ceilingIdentity !== ceilingIdentity))
    )
      clearForbiddenState();
  }, [capabilityEpoch, ceilingIdentity, clearForbiddenState, enabled]);

  useEffect(() => clearForbiddenState, [boardId, clearForbiddenState]);

  useEffect(() => {
    setBoards((current) => {
      const withoutCurrent = current.filter((board) => board.boardId !== boardId);
      return [{ boardId, title: boardTitle }, ...withoutCurrent];
    });
  }, [boardId, boardTitle]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const refreshGrant = async () => {
      let cursor: string | null = null;
      do {
        const result = await api.listGrants(cursor, controller.signal);
        if (controller.signal.aborted) return;
        if (result.kind !== 'ok') {
          setBoardGrant(null);
          setIsGrantCheckComplete(true);
          return;
        }
        const matching =
          result.value.grants.find(
            (grant) =>
              ['pending_redemption', 'active'].includes(grant.status) &&
              grant.boardIds.includes(boardId),
          ) ?? null;
        if (matching !== null) {
          setBoardGrant(matching);
          setIsGrantCheckComplete(true);
          return;
        }
        cursor = result.value.nextCursor;
      } while (cursor !== null);
      setBoardGrant(null);
      setIsGrantCheckComplete(true);
    };
    const onGrantsChanged = () => void refreshGrant();
    setIsGrantCheckComplete(false);
    window.addEventListener(HEADER_GRANTS_CHANGED_EVENT, onGrantsChanged);
    void refreshGrant();
    return () => {
      controller.abort();
      window.removeEventListener(HEADER_GRANTS_CHANGED_EVENT, onGrantsChanged);
    };
  }, [api, boardId, capabilityEpoch, enabled]);

  useEffect(() => {
    if (created === null) return;
    const expiresAt =
      ownerStatus?.state === 'pending' && ownerStatus.decisionExpiresAt !== null
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
        const matching =
          result.value.find((pairing) => pairing.pairingId === created.pairingId) ?? null;
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
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2_000);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [api, created, t]);

  const csrf = () => authSessionClient().snapshot()?.csrfToken ?? null;

  async function loadBoards() {
    const request = beginAction('connection.boards.list');
    const result = await api.listBoards(null, request.controller.signal);
    if (!actionIsCurrent(request)) return;
    if (result.kind !== 'ok') {
      setError(t('ai.connectionRefreshFailed'));
      return;
    }
    const options: PairingBoardOption[] = result.value.boards.map((board: BoardSummaryV1) => ({
      boardId: board.boardId,
      title: board.title,
    }));
    if (!options.some((board) => board.boardId === boardId))
      options.unshift({ boardId, title: boardTitle });
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
    const request = beginAction('connection.create');
    const result = await api.createPairing(token, request.controller.signal);
    if (!actionIsCurrent(request)) return;
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
    destination: PairingBoardDestination;
    lifetime: 'session' | 'persistent';
  }) {
    const token = csrf();
    if (token === null || created === null || ownerStatus?.state !== 'pending') return;
    setBusy(true);
    setError(null);
    const approvedScopes = decision.approvedScopes.filter((scope) =>
      connectionGrantCeiling.scopes.includes(scope),
    );
    const approvedLifecyclePermissions = decision.approvedLifecyclePermissions.filter(
      (permission) => connectionGrantCeiling.lifecyclePermissions.includes(permission),
    );
    const request = beginAction('connection.update');
    const result = await api.decidePairing(
      ownerStatus.pairingId,
      token,
      {
        decision: 'approve',
        ...decision,
        approvedScopes,
        approvedLifecyclePermissions,
      },
      request.controller.signal,
    );
    if (!actionIsCurrent(request)) return;
    setBusy(false);
    if (result.kind === 'ok') {
      const destinationBoardId =
        result.value.boardIds?.length === 1 ? (result.value.boardIds[0] ?? null) : null;
      clearPairing();
      if (destinationBoardId !== null)
        window.location.assign(`/boards/${encodeURIComponent(destinationBoardId)}`);
    } else setError(t('ai.connectionRefreshFailed'));
  }

  async function deny() {
    const token = csrf();
    if (token === null || ownerStatus?.state !== 'pending') return;
    setBusy(true);
    setError(null);
    const request = beginAction('connection.update');
    const result = await api.decidePairing(
      ownerStatus.pairingId,
      token,
      { decision: 'deny' },
      request.controller.signal,
    );
    if (!actionIsCurrent(request)) return;
    setBusy(false);
    if (result.kind === 'ok') clearPairing();
    else setError(t('ai.connectionRefreshFailed'));
  }

  async function cancel() {
    const token = csrf();
    if (token === null || created === null) return;
    setBusy(true);
    setError(null);
    const request = beginAction('connection.revoke');
    const result = await api.cancelPairing(created.pairingId, token, request.controller.signal);
    if (!actionIsCurrent(request)) return;
    setBusy(false);
    if (result.kind === 'ok') clearPairing();
    else setError(t('ai.connectionRefreshFailed'));
  }

  const displayPairing = ownerStatus ?? created;

  if (!enabled || !isGrantCheckComplete) return null;

  // The global header already exposes the connected state. Keep board chrome focused on the
  // presentation by managing active grants only from the AI connections settings page.
  if (boardGrant !== null) return null;

  return (
    <div className="board-pairing-control">
      <button
        type="button"
        className="button board-pairing-button"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        disabled={busy && created === null}
        onClick={() => void openPairing()}
      >
        {busy && created === null ? t('common.loading') : t('nav.aiConnections')}
      </button>
      {error && !isOpen && (
        <span className="board-pairing-error" role="alert">
          {error}
        </span>
      )}
      {isOpen && displayPairing !== null && (
        <PairingRequestModal
          pairing={displayPairing}
          matchingCode={created?.pairingId === displayPairing.pairingId ? created.code : null}
          boards={boards}
          preferredBoardId={boardId}
          busy={busy}
          error={error}
          connectionGrantCeiling={connectionGrantCeiling}
          onDismiss={() => setIsOpen(false)}
          onApprove={(decision) => void approve(decision)}
          onDeny={() => void deny()}
          onCancel={() => void cancel()}
        />
      )}
    </div>
  );
}
