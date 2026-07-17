import type {
  BoardId,
  HitlRequestId,
  HitlResponseV1,
  RevisionId,
} from '@leecat-board/board-schema';

export type HitlSubmitIntentV1 = {
  boardId: BoardId;
  expectedRevisionId: RevisionId;
  hitlRequestId: HitlRequestId;
  response: HitlResponseV1;
};

export type HitlSubmissionStateV1 =
  | { kind: 'idle' }
  | { kind: 'submitting'; message: string }
  | { kind: 'recording_unknown'; message: string; canRetry: true }
  | { kind: 'reconciliation_failed'; message: string; canRetry: false }
  | { kind: 'failed'; message: string; canRetry: false };

export type HitlCopyStateV1 =
  | { kind: 'idle'; message: string }
  | { kind: 'copied'; message: string }
  | { kind: 'failed'; message: string };

export type HitlInteractionControllerV1 = {
  mode: 'live' | 'history' | 'read-only';
  isSubmitting(hitlRequestId: HitlRequestId): boolean;
  submit(intent: HitlSubmitIntentV1): Promise<void>;
  submissionState(hitlRequestId: HitlRequestId): HitlSubmissionStateV1;
  retry(hitlRequestId: HitlRequestId): Promise<void>;
  canCopy(hitlRequestId: HitlRequestId): boolean;
  copy(hitlRequestId: HitlRequestId): Promise<void>;
  copyState(hitlRequestId: HitlRequestId): HitlCopyStateV1;
};
