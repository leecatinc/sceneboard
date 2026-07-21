'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HitlResponseParserV1,
  type BoardId,
  type HitlInteractionV1,
  type HitlResponseV1,
  type RevisionId,
} from '@sceneboard/board-schema';
import type {
  HitlCopyStateV1,
  HitlInteractionControllerV1,
  HitlSubmissionStateV1,
  HitlSubmitIntentV1,
} from '@sceneboard/board-ui/interaction';

import {
  BoardApiClient,
  createBoardRequestIdentity,
  type ApiResult,
  type HitlRespondMutationRequest,
} from '../api/board-api';

type PendingResponseV1 = {
  canonical: string;
  response: HitlResponseV1;
  request: HitlRespondMutationRequest;
};

const IDLE_SUBMISSION: HitlSubmissionStateV1 = { kind: 'idle' };
const IDLE_COPY: HitlCopyStateV1 = { kind: 'idle', message: 'Not copied.' };

const canonicalResponse = (
  response: HitlResponseV1,
): { response: HitlResponseV1; canonical: string } => {
  const parsed = HitlResponseParserV1.parse(response);
  if (!parsed.ok) throw new TypeError('invalid HITL response');
  return {
    response: parsed.data.value,
    canonical: new TextDecoder().decode(parsed.data.canonicalBytes),
  };
};

const definitionSummary = (interaction: HitlInteractionV1): string => {
  const body =
    'body' in interaction.definition && interaction.definition.body !== undefined
      ? interaction.definition.body.replace(/\s+/gu, ' ').trim()
      : '';
  const source =
    body === '' ? interaction.definition.title : `${interaction.definition.title} — ${body}`;
  const scalars = Array.from(source);
  const summary = scalars.length <= 400 ? source : `${scalars.slice(0, 399).join('')}…`;
  return JSON.stringify(summary);
};

const typedResponse = (response: HitlResponseV1): string => JSON.stringify(response);

export const buildHitlClipboardPayloadV1 = (input: {
  boardId: BoardId;
  interaction: HitlInteractionV1;
  recordingUnknownResponse?: HitlResponseV1;
}): string | null => {
  const { boardId, interaction } = input;
  const identity = `board ${boardId}, request ${interaction.hitlRequestId} — ${definitionSummary(interaction)}`;
  if (
    interaction.state === 'answered' &&
    interaction.response !== null &&
    interaction.answeredAt !== null
  ) {
    return `[SceneBoard HITL response] ${identity}\nRecorded response: ${typedResponse(interaction.response)} (answered ${interaction.answeredAt})`;
  }
  if (interaction.state !== 'open') {
    return `[SceneBoard HITL ${interaction.state}] ${identity}\nNo response was recorded; the interaction is ${interaction.state} (${interaction.stateUpdatedAt}).\n-> Do not assume an answer. If the question still matters, create a new interaction.`;
  }
  const response = input.recordingUnknownResponse;
  if (
    response === undefined ||
    (interaction.definition.kind === 'confirmation' &&
      interaction.definition.impact === 'destructive' &&
      response.kind === 'confirmation' &&
      response.confirmed)
  )
    return null;
  return `[SceneBoard HITL response — RECORDING UNKNOWN, reconcile first]\nBoard ${boardId}, request ${interaction.hitlRequestId} — ${definitionSummary(interaction)}\nUser selected: ${typedResponse(response)}\n-> 1) Read current status with board_interaction_status. 2) If answered/terminal, use that authoritative state and STOP. 3) Only if still open: fetch the current head and submit this exact typed response via board_interaction_respond with a NEW idempotency key; treat it as accepted only on success or replay. 4) On conflict/expiry, read and use only the authoritative terminal state.`;
};

const mutationOutcomeUnknown = (result: Exclude<ApiResult<unknown>, { kind: 'ok' }>): boolean =>
  result.kind === 'reconciliation_required' ||
  result.kind === 'corrupt_response' ||
  (result.kind === 'api_error' && result.status >= 500) ||
  (result.kind === 'board_error' && result.error.httpStatusHint >= 500);

const requiresAuthoritativeRead = (result: Exclude<ApiResult<unknown>, { kind: 'ok' }>): boolean =>
  result.kind === 'board_error' &&
  (result.error.code === 'HITL_RESPONSE_CONFLICT' || result.error.code === 'HITL_REQUEST_EXPIRED');

const safeFailureMessage = (result: Exclude<ApiResult<unknown>, { kind: 'ok' }>): string => {
  if (result.kind === 'board_error') {
    if (result.error.code === 'FORBIDDEN') return 'This response is not permitted.';
    if (result.error.code === 'REVISION_CONFLICT')
      return 'The board changed. Return to the latest view and try again.';
    if (result.error.code === 'INVALID_PAYLOAD') return 'Check the response and try again.';
  }
  if (result.kind === 'unsupported_browser')
    return 'This browser cannot protect the SceneBoard session.';
  return 'The response was not recorded.';
};

export function useHitlInteractionController(input: {
  api: BoardApiClient;
  boardId: BoardId;
  expectedRevisionId: RevisionId;
  interaction: HitlInteractionV1;
  mode: HitlInteractionControllerV1['mode'];
  routeEpoch: string;
}): { interaction: HitlInteractionV1; controller: HitlInteractionControllerV1 } {
  const [interaction, setInteraction] = useState(input.interaction);
  const [submission, setSubmission] = useState<HitlSubmissionStateV1>(IDLE_SUBMISSION);
  const [copyState, setCopyState] = useState<HitlCopyStateV1>(IDLE_COPY);
  const interactionRef = useRef(input.interaction);
  const pending = useRef<PendingResponseV1 | null>(null);
  const active = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const contextKey = `${input.routeEpoch}:${input.mode}:${input.interaction.hitlRequestId}`;

  useEffect(() => {
    epoch.current += 1;
    active.current?.abort();
    active.current = null;
    pending.current = null;
    interactionRef.current = input.interaction;
    setInteraction(input.interaction);
    setSubmission(IDLE_SUBMISSION);
    setCopyState(IDLE_COPY);
    return () => active.current?.abort();
  }, [contextKey]);

  useEffect(() => {
    interactionRef.current = input.interaction;
    setInteraction(input.interaction);
    setCopyState(IDLE_COPY);
    if (input.interaction.state !== 'open') {
      active.current?.abort();
      active.current = null;
      pending.current = null;
      setSubmission(IDLE_SUBMISSION);
    }
  }, [input.interaction.state, input.interaction.stateUpdatedAt]);

  const writeClipboard = useCallback(
    async (
      payload: string,
      expectedEpoch = epoch.current,
      expectedStateUpdatedAt = interactionRef.current.stateUpdatedAt,
    ): Promise<void> => {
      try {
        if (typeof navigator === 'undefined' || navigator.clipboard === undefined)
          throw new TypeError('clipboard unavailable');
        await navigator.clipboard.writeText(payload);
        if (
          expectedEpoch !== epoch.current ||
          expectedStateUpdatedAt !== interactionRef.current.stateUpdatedAt
        )
          return;
        setCopyState({ kind: 'copied', message: 'Copied.' });
      } catch {
        if (
          expectedEpoch !== epoch.current ||
          expectedStateUpdatedAt !== interactionRef.current.stateUpdatedAt
        )
          return;
        setCopyState({
          kind: 'failed',
          message: 'Copy failed. Use the copy button after granting clipboard access.',
        });
      }
    },
    [],
  );

  const authoritativeRead = useCallback(
    async (capturedEpoch: number, baseline: HitlInteractionV1) => {
      const requestId = createBoardRequestIdentity().requestId;
      const controller = active.current;
      let result;
      try {
        result = await input.api.readInteraction(
          {
            protocolVersion: 1,
            requestId,
            type: 'hitl.read',
            boardId: input.boardId,
            hitlRequestId: baseline.hitlRequestId,
            wait: null,
          },
          controller?.signal,
        );
      } catch {
        return null;
      }
      if (capturedEpoch !== epoch.current || controller?.signal.aborted) return null;
      if (result.kind !== 'ok') return null;
      interactionRef.current = result.value.hitl;
      setInteraction(result.value.hitl);
      return result.value.hitl;
    },
    [input.api, input.boardId],
  );

  const execute = useCallback(
    async (response: PendingResponseV1): Promise<void> => {
      if (input.mode !== 'live' || active.current !== null) return;
      const capturedEpoch = epoch.current;
      const controller = new AbortController();
      active.current = controller;
      setSubmission({ kind: 'submitting', message: 'Recording response…' });
      setCopyState(IDLE_COPY);
      let result: Awaited<ReturnType<BoardApiClient['respondToInteraction']>>;
      try {
        result = await input.api.respondToInteraction(response.request, controller.signal);
      } catch {
        result = { kind: 'corrupt_response' };
      }
      if (capturedEpoch !== epoch.current || controller.signal.aborted) return;
      if (result.kind === 'ok') {
        pending.current = null;
        interactionRef.current = result.value.hitl;
        setInteraction(result.value.hitl);
        setSubmission(IDLE_SUBMISSION);
        active.current = null;
        return;
      }
      const unknown = mutationOutcomeUnknown(result);
      const mustRead = unknown || requiresAuthoritativeRead(result);
      if (mustRead) {
        const baseline = interactionRef.current;
        const current = await authoritativeRead(capturedEpoch, baseline);
        if (capturedEpoch !== epoch.current || controller.signal.aborted) return;
        if (current !== null && current.state !== 'open') {
          pending.current = null;
          setSubmission(IDLE_SUBMISSION);
          active.current = null;
          return;
        }
        if (
          unknown &&
          current !== null &&
          current.state === 'open' &&
          current.stateUpdatedAt === baseline.stateUpdatedAt
        ) {
          setSubmission({
            kind: 'recording_unknown',
            message:
              'The response may or may not have been recorded. The authoritative state is still open.',
            canRetry: true,
          });
          const payload = buildHitlClipboardPayloadV1({
            boardId: input.boardId,
            interaction: current,
            recordingUnknownResponse: response.response,
          });
          active.current = null;
          if (payload !== null) await writeClipboard(payload);
          return;
        }
        pending.current = null;
        setSubmission(
          unknown
            ? {
                kind: 'reconciliation_failed',
                message:
                  'Recording is unknown and the authoritative state could not be verified. Refresh before taking further action.',
                canRetry: false,
              }
            : {
                kind: 'failed',
                message: 'The interaction changed before this response was accepted.',
                canRetry: false,
              },
        );
        active.current = null;
        return;
      }
      pending.current = null;
      setSubmission({ kind: 'failed', message: safeFailureMessage(result), canRetry: false });
      active.current = null;
    },
    [authoritativeRead, input.api, input.boardId, input.mode, writeClipboard],
  );

  const submit = useCallback(
    async (intent: HitlSubmitIntentV1): Promise<void> => {
      if (
        input.mode !== 'live' ||
        intent.boardId !== input.boardId ||
        intent.expectedRevisionId !== input.expectedRevisionId ||
        intent.hitlRequestId !== interactionRef.current.hitlRequestId ||
        interactionRef.current.state !== 'open'
      )
        return;
      let parsed: ReturnType<typeof canonicalResponse>;
      try {
        parsed = canonicalResponse(intent.response);
      } catch {
        setSubmission({
          kind: 'failed',
          message: 'The response could not be verified.',
          canRetry: false,
        });
        return;
      }
      if (pending.current === null || pending.current.canonical !== parsed.canonical) {
        const identity = createBoardRequestIdentity();
        pending.current = {
          canonical: parsed.canonical,
          response: parsed.response,
          request: {
            protocolVersion: 1,
            requestId: identity.requestId,
            idempotencyKey: identity.idempotencyKey,
            boardId: input.boardId,
            expectedRevisionId: input.expectedRevisionId,
            command: {
              type: 'hitl.respond',
              hitlRequestId: intent.hitlRequestId,
              response: parsed.response,
            },
          },
        };
      }
      await execute(pending.current);
    },
    [execute, input.boardId, input.expectedRevisionId, input.mode],
  );

  const retry = useCallback(async (): Promise<void> => {
    if (submission.kind !== 'recording_unknown' || pending.current === null) return;
    await execute(pending.current);
  }, [execute, submission.kind]);

  const payload = useCallback(
    (): string | null =>
      input.mode === 'live'
        ? buildHitlClipboardPayloadV1({
            boardId: input.boardId,
            interaction: interactionRef.current,
            ...(submission.kind === 'recording_unknown' && pending.current !== null
              ? { recordingUnknownResponse: pending.current.response }
              : {}),
          })
        : null,
    [input.boardId, input.mode, submission.kind],
  );

  const controller: HitlInteractionControllerV1 = {
    mode: input.mode,
    isSubmitting: (hitlRequestId) =>
      hitlRequestId === interaction.hitlRequestId && submission.kind === 'submitting',
    submit,
    submissionState: (hitlRequestId) =>
      hitlRequestId === interaction.hitlRequestId ? submission : IDLE_SUBMISSION,
    retry: async (hitlRequestId) => {
      if (hitlRequestId === interaction.hitlRequestId) await retry();
    },
    canCopy: (hitlRequestId) => hitlRequestId === interaction.hitlRequestId && payload() !== null,
    copy: async (hitlRequestId) => {
      if (hitlRequestId !== interaction.hitlRequestId) return;
      const value = payload();
      if (value !== null) await writeClipboard(value);
    },
    copyState: (hitlRequestId) =>
      hitlRequestId === interaction.hitlRequestId ? copyState : IDLE_COPY,
  };

  return { interaction, controller };
}
