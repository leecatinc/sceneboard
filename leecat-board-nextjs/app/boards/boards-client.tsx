'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { BoardSummaryV1, PageCursorV1 } from '@leecat-board/board-schema';

import { useI18n } from '../../components/i18n/I18nProvider';
import {
  BoardApiClient,
  createBoardRequestIdentity,
  type ApiResult,
} from '../../lib/api/board-api';
import { authSessionClient } from '../../lib/auth/session-client';

type CreateAttempt = ReturnType<typeof createBoardRequestIdentity> & { title: string };

export function BoardsClient() {
  const { formatDateTime, t } = useI18n();
  const [boards, setBoards] = useState<BoardSummaryV1[]>([]);
  const [nextCursor, setNextCursor] = useState<PageCursorV1 | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'creating' | 'loading-more'>('loading');
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<CreateAttempt | null>(null);
  const api = useRef<BoardApiClient | null>(null);

  async function load(cursor: PageCursorV1 | null = null) {
    const client = api.current;
    if (client === null) return;
    setPhase(cursor === null ? 'loading' : 'loading-more');
    const result = await client.listBoards(cursor);
    if (result.kind === 'ok') {
      setBoards((current) => cursor === null ? result.value.boards : [...current, ...result.value.boards]);
      setNextCursor(result.value.nextCursor);
      setError(null);
    } else setError(result.kind === 'board_error' && result.error.code === 'FORBIDDEN'
      ? t('boards.forbidden')
      : result.kind === 'corrupt_response'
        ? t('boards.corrupt')
        : result.kind === 'unsupported_browser'
          ? t('auth.unsupportedBrowser')
          : t('boards.unreachable'));
    setPhase('ready');
  }

  useEffect(() => {
    api.current = new BoardApiClient(authSessionClient().sharedCoordinator());
    void load();
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const client = api.current;
    const csrfToken = authSessionClient().snapshot()?.csrfToken;
    if (client === null || csrfToken === undefined) return;
    const title = String(new FormData(event.currentTarget).get('title') ?? '').trim();
    if (title === '') return;
    const identity = attempt.current?.title === title ? attempt.current : { title, ...createBoardRequestIdentity() };
    attempt.current = identity;
    setPhase('creating');
    setError(null);
    const result = await client.createBoard({ ...identity, csrfToken });
    if (result.kind === 'ok') {
      attempt.current = null;
      window.location.assign(`/boards/${encodeURIComponent(result.value.board.boardId)}`);
      return;
    }
    if (result.kind === 'board_error' || result.kind === 'api_error') attempt.current = null;
    setError(result.kind === 'corrupt_response' ? t('boards.corrupt') : t('boards.unreachable'));
    setPhase('ready');
  }

  return (
    <section className="boards-page" aria-labelledby="boards-title">
      <div className="page-heading"><div><p className="eyebrow">{t('boards.workspace')}</p><h2 id="boards-title">{t('boards.yours')}</h2><p>{t('boards.description')}</p></div></div>
      <form className="create-board" onSubmit={create}>
        <label htmlFor="board-title">{t('boards.new')}</label><div><input id="board-title" name="title" maxLength={200} required placeholder={t('boards.placeholder')} /><button className="button" disabled={phase === 'creating'}>{phase === 'creating' ? t('boards.creating') : t('boards.create')}</button></div>
      </form>
      {error && <div className="notice notice-error" role="alert"><p>{error}</p><button className="button secondary" disabled={phase !== 'ready'} onClick={() => void load()}>{t('boards.retryList')}</button></div>}
      {phase === 'loading' ? <div className="board-grid" aria-busy="true">{[1, 2, 3].map((item) => <div className="board-card skeleton" key={item} />)}</div>
        : boards.length === 0 ? <div className="empty-state"><span aria-hidden="true">◇</span><h3>{t('boards.none')}</h3><p>{t('boards.noneDescription')}</p></div>
          : <div className="board-grid">{boards.map((board) => <Link className="board-card" href={`/boards/${encodeURIComponent(board.boardId)}`} key={board.boardId}><div><span className="live-dot" />{board.archivedAt === null ? t('boards.available') : t('boards.archived')}</div><h3>{board.title}</h3><p>{t('boards.revision', { number: board.headRevision.revisionNumber })}</p><time dateTime={board.updatedAt}>{t('boards.updated', { date: formatDateTime(board.updatedAt) })}</time></Link>)}</div>}
      {nextCursor !== null && <button className="button secondary load-more" disabled={phase === 'loading-more'} onClick={() => void load(nextCursor)}>{phase === 'loading-more' ? t('common.loading') : t('boards.loadMore')}</button>}
    </section>
  );
}
