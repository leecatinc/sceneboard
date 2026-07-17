'use client';

import { useEffect, useRef, useState } from 'react';
import type { BoardId, HitlInteractionV1, RevisionId } from '@leecat-board/board-schema';

import type { HitlInteractionControllerV1 } from './hitl-controller.js';
import { HitlOpenContent } from './HitlOpenContent.js';
import { HitlTerminalSummary } from './HitlTerminalSummary.js';

export function HitlBlock({
  interaction,
  boardId,
  expectedRevisionId,
  controller,
  nodeId,
}: {
  interaction: HitlInteractionV1;
  boardId: BoardId;
  expectedRevisionId: RevisionId;
  controller: HitlInteractionControllerV1;
  nodeId: string;
}) {
  const root = useRef<HTMLElement | null>(null);
  const terminalHeading = useRef<HTMLHeadingElement | null>(null);
  const previousState = useRef(interaction.state);
  const [liveAnnouncement, setLiveAnnouncement] = useState('');
  const idPrefix = `hitl-${nodeId}`;
  const submission = controller.submissionState(interaction.hitlRequestId);
  const copy = controller.copyState(interaction.hitlRequestId);

  useEffect(() => {
    if (previousState.current === 'open' && interaction.state !== 'open') {
      const active = document.activeElement;
      if (active !== null && root.current?.contains(active)) {
        terminalHeading.current?.focus();
        setLiveAnnouncement('');
      } else {
        const label = interaction.state === 'answered' ? 'Interaction answered'
          : interaction.state === 'superseded' ? 'Interaction replaced by a newer request'
            : interaction.state === 'expired' ? 'Interaction expired' : 'Interaction cancelled';
        setLiveAnnouncement(`${label}. Review interaction for details.`);
      }
    }
    previousState.current = interaction.state;
  }, [interaction.state]);

  useEffect(() => () => {
    const active = document.activeElement;
    const element = root.current;
    if (element === null || active === null || !element.contains(active)) return;
    const stableParent = element.parentElement?.closest<HTMLElement>('.scene-block, .scene-layout, .scene-root');
    const fallback = document.querySelector<HTMLElement>('.board-topbar h2');
    const target = stableParent ?? fallback;
    if (target === null) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus();
  }, []);

  return (
    <section ref={root} className="scene-block scene-attention hitl-block" aria-labelledby={`${idPrefix}-heading`}>
      {interaction.state === 'open' ? (
        <>
          <h3 id={`${idPrefix}-heading`}>{interaction.definition.title}</h3>
          {controller.mode === 'live' ? (
            <HitlOpenContent
              interaction={interaction}
              boardId={boardId}
              expectedRevisionId={expectedRevisionId}
              controller={controller}
              idPrefix={idPrefix}
            />
          ) : (
            <p className="hitl-read-only">{controller.mode === 'history'
              ? 'Historical view — return to Latest to respond.'
              : 'This interaction is read-only.'}</p>
          )}
        </>
      ) : (
        <HitlTerminalSummary
          interaction={interaction}
          headingId={`${idPrefix}-heading`}
          controller={controller}
          ref={terminalHeading}
        />
      )}
      {submission.kind !== 'idle' && (
        <div className={`hitl-submission hitl-submission-${submission.kind}`} role={submission.kind === 'failed' || submission.kind === 'reconciliation_failed' ? 'alert' : 'status'}>
          <p>{submission.message}</p>
          {submission.kind === 'recording_unknown' && (
            <div className="hitl-actions">
              <button type="button" onClick={() => void controller.retry(interaction.hitlRequestId)}>Retry recording</button>
              {controller.canCopy(interaction.hitlRequestId) && (
                <button type="button" onClick={() => void controller.copy(interaction.hitlRequestId)}>Copy reconciliation handoff</button>
              )}
            </div>
          )}
        </div>
      )}
      {submission.kind === 'recording_unknown' && <p className={copy.kind === 'failed' ? 'hitl-copy-failed' : ''} role="status">{copy.message}</p>}
      <div className="hitl-live-update" aria-live="polite" aria-atomic="true">
        {liveAnnouncement !== '' && (
          <>
            <span>{liveAnnouncement}</span>
            <button type="button" onClick={() => terminalHeading.current?.focus()}>Review interaction</button>
          </>
        )}
      </div>
    </section>
  );
}
