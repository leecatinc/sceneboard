'use client';

import { Fragment, useEffect, useId, useState } from 'react';
import type { ShareAnalyticsReportV1 } from '@sceneboard/board-schema';

import type { ShareAnalyticsApi } from '../../lib/share-analytics/share-analytics-api';
import { useI18n } from '../i18n/I18nProvider';
import styles from './ShareAnalyticsPanel.module.css';

type PanelStateV1 =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; report: ShareAnalyticsReportV1 }>
  | Readonly<{ kind: 'error' }>;

const utcDate = (value: Date): string => value.toISOString().slice(0, 10);

export function ShareAnalyticsPanel({
  api,
  boardId,
  enabled,
}: {
  api: ShareAnalyticsApi;
  boardId: string;
  enabled: boolean;
}) {
  const { t, formatDateTime } = useI18n();
  const headingId = useId();
  const [state, setState] = useState<PanelStateV1>({ kind: 'loading' });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const toDate = new Date();
    const fromDate = new Date(toDate);
    fromDate.setUTCDate(fromDate.getUTCDate() - 29);
    setState({ kind: 'loading' });
    void api
      .report(boardId, utcDate(fromDate), utcDate(toDate), controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setState(
          result.kind === 'ok' ? { kind: 'ready', report: result.value } : { kind: 'error' },
        );
      });
    return () => controller.abort();
  }, [api, boardId, enabled]);

  if (!enabled) return null;
  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <h3 id={headingId} tabIndex={-1}>
        {t('analytics.title')}
      </h3>
      <p className={styles.description}>{t('analytics.rangeDescription')}</p>
      {state.kind === 'loading' ? (
        <p role="status">{t('analytics.loading')}</p>
      ) : state.kind === 'error' ? (
        <p role="alert">{t('analytics.error')}</p>
      ) : state.report.publications.length === 0 ? (
        <p role="status">{t('analytics.empty')}</p>
      ) : (
        <>
          {state.report.totals.lastAggregatedAt === null && (
            <p className={styles.delayed} role="status">
              {t('analytics.delayed')}
            </p>
          )}
          <dl className={styles.totals}>
            <div>
              <dt>{t('analytics.boardOpens')}</dt>
              <dd>{state.report.totals.boardOpens.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t('analytics.pageViews')}</dt>
              <dd>{state.report.totals.pageViews.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t('analytics.estimatedDailyReach')}</dt>
              <dd>{state.report.totals.estimatedDailyReach.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t('analytics.lastAggregated')}</dt>
              <dd>
                {state.report.totals.lastAggregatedAt === null
                  ? '—'
                  : formatDateTime(state.report.totals.lastAggregatedAt)}
              </dd>
            </div>
          </dl>
          <div
            className={styles.tableViewport}
            tabIndex={0}
            role="region"
            aria-labelledby={headingId}
          >
            <table>
              <caption>{t('analytics.tableCaption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('analytics.publication')}</th>
                  <th scope="col">{t('analytics.boardOpens')}</th>
                  <th scope="col">{t('analytics.generationPageViews')}</th>
                  <th scope="col">{t('analytics.estimatedDailyReach')}</th>
                  <th scope="col">{t('analytics.page')}</th>
                  <th scope="col">{t('analytics.pageViews')}</th>
                  <th scope="col">{t('analytics.pageReach')}</th>
                </tr>
              </thead>
              <tbody>
                {state.report.publications.map((publication) => (
                  <Fragment key={`${publication.shareId}:${publication.publicationGeneration}`}>
                    <tr>
                      <th scope="row">
                        {t('analytics.generation')} {publication.publicationGeneration}
                      </th>
                      <td>{publication.boardOpens.toLocaleString()}</td>
                      <td>{publication.pageViews.toLocaleString()}</td>
                      <td>{publication.estimatedDailyReach.toLocaleString()}</td>
                      <td>—</td>
                      <td>—</td>
                      <td>—</td>
                    </tr>
                    {publication.pages.map((page) => (
                      <tr
                        key={`${publication.shareId}:${publication.publicationGeneration}:${page.pageId}`}
                      >
                        <td />
                        <td />
                        <td />
                        <td />
                        <th scope="row">
                          {page.pageOrdinal + 1}. {page.titleLabel}
                        </th>
                        <td>{page.pageViews.toLocaleString()}</td>
                        <td>
                          {page.pageReachBasisPoints === null
                            ? '—'
                            : `${(page.pageReachBasisPoints / 100).toLocaleString()}%`}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.denominator}>{t('analytics.reachDenominator')}</p>
        </>
      )}
    </section>
  );
}
