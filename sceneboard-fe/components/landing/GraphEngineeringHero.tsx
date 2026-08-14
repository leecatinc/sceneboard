'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';

import { useI18n } from '../i18n/I18nProvider';
import workflowSpec from './graph-engineering-sample.json';
import styles from './GraphEngineeringHero.module.css';

const canonicalWorkflowSpec = `${JSON.stringify(workflowSpec)}\n`;
const previewNodes = [...workflowSpec.nodes].sort((left, right) => {
  const rank = (kind: string) => (kind === 'start' ? 0 : kind === 'end' ? 2 : 1);
  const rankOrder = rank(left.kind) - rank(right.kind);
  return rankOrder !== 0 ? rankOrder : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
});
const previewNodeIndex = new Map(previewNodes.map((node, index) => [node.id, index]));
const previewNodeLabels = new Map(previewNodes.map((node) => [node.id, node.label]));
const previewEdges = [...workflowSpec.edges].sort(
  (left, right) =>
    (previewNodeIndex.get(left.fromNodeId) ?? 0) - (previewNodeIndex.get(right.fromNodeId) ?? 0),
);
const nodeClasses = [styles.startNode, styles.reviewNode, styles.endNode] as const;
const edgeClasses = [styles.startReviewEdge, styles.reviewEndEdge] as const;

export function GraphEngineeringHero() {
  const { locale, t } = useI18n();
  const jsonRef = useRef<HTMLTextAreaElement>(null);
  const [selectionStatus, setSelectionStatus] = useState('');

  const selectWorkflowSpec = () => {
    jsonRef.current?.focus();
    jsonRef.current?.select();
    setSelectionStatus(t('graphLanding.selectionReady'));
  };

  return (
    <section
      className={styles.hero}
      aria-label={t('graphLanding.heroAria')}
      data-landing-capability="graph"
      data-landing-workflow-hero="v1"
    >
      <div className={styles.copy}>
        <p className={styles.eyebrow}>{t('graphLanding.eyebrow')}</p>
        <h1 data-locale={locale}>{t('graphLanding.title')}</h1>
        <p className={styles.lead}>{t('graphLanding.lead')}</p>
        <p className={styles.promptExample} data-landing-workflow-prompt-example>
          {t('graphLanding.promptExample')}
        </p>
        <div className={styles.actions}>
          <Link className={styles.primaryAction} href="/signup">
            {t('auth.createAccount')}
          </Link>
          <button type="button" className={styles.secondaryAction} onClick={selectWorkflowSpec}>
            {t('graphLanding.selectJson')}
          </button>
        </div>
        <div className={styles.exportPanel} data-landing-workflow-export="manual">
          <div>
            <strong>{t('graphLanding.exportTitle')}</strong>
            <p>{t('graphLanding.exportBody')}</p>
          </div>
          <textarea
            ref={jsonRef}
            value={canonicalWorkflowSpec}
            readOnly
            spellCheck={false}
            aria-label={t('graphLanding.exportTitle')}
          />
        </div>
        <p className={styles.liveStatus} aria-live="polite">
          {selectionStatus}
        </p>
      </div>

      <div className={styles.preview} aria-label={t('graphLanding.previewAria')}>
        <div className={styles.previewHeader}>
          <span>{t('graphLanding.specVersion')}</span>
          <span>
            {t('graphLanding.graphCounts', {
              nodes: workflowSpec.nodes.length,
              edges: workflowSpec.edges.length,
            })}
          </span>
        </div>
        <div
          className={styles.graph}
          data-landing-workflow-graph="v1"
          data-landing-workflow-interaction="static"
        >
          <svg viewBox="0 0 800 420" aria-hidden="true">
            <path d="M172 210 H332" />
            <path d="M468 210 H660" />
          </svg>
          {previewNodes.map((node, index) => (
            <div
              key={node.id}
              className={`${styles.node} ${nodeClasses[index]}`}
              data-landing-workflow-node={node.id}
            >
              <small>{node.id}</small>
              <strong>{node.label}</strong>
            </div>
          ))}
          {previewEdges.map((edge, index) => {
            const title =
              edge.label ??
              `${previewNodeLabels.get(edge.fromNodeId) ?? edge.fromNodeId} → ${previewNodeLabels.get(edge.toNodeId) ?? edge.toNodeId}`;
            return (
              <div
                key={edge.id}
                className={`${styles.edge} ${edgeClasses[index]}`}
                data-landing-workflow-edge={edge.id}
              >
                {title}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
