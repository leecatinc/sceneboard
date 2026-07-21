import { forwardRef } from 'react';
import type { HitlInteractionV1 } from '@sceneboard/board-schema';

import type { HitlInteractionControllerV1 } from './hitl-controller.js';

const STATE_COPY = {
  answered: { title: 'Answered', detail: 'The recorded response is shown below.' },
  superseded: {
    title: 'Replaced by a newer request',
    detail: 'This request can no longer be answered.',
  },
  expired: { title: 'Expired', detail: 'Create a new request if this question is still relevant.' },
  cancelled: { title: 'Cancelled', detail: 'No response was recorded.' },
} as const;

export const HitlTerminalSummary = forwardRef<
  HTMLHeadingElement,
  {
    interaction: Exclude<HitlInteractionV1, { state: 'open' }> | HitlInteractionV1;
    headingId: string;
    controller: HitlInteractionControllerV1;
  }
>(function HitlTerminalSummary({ interaction, headingId, controller }, headingRef) {
  if (interaction.state === 'open') return null;
  const copy = STATE_COPY[interaction.state];
  const copyState = controller.copyState(interaction.hitlRequestId);
  return (
    <div className={`hitl-terminal hitl-terminal-${interaction.state}`}>
      <h3 id={headingId} ref={headingRef} tabIndex={-1}>
        {copy.title}
      </h3>
      <p>{copy.detail}</p>
      {interaction.state === 'answered' && interaction.response !== null && (
        <pre className="hitl-response" aria-label="Recorded response">
          {JSON.stringify(interaction.response, null, 2)}
        </pre>
      )}
      {controller.canCopy(interaction.hitlRequestId) && (
        <div className="hitl-copy-row">
          <button type="button" onClick={() => void controller.copy(interaction.hitlRequestId)}>
            Copy authoritative state
          </button>
          <span role="status" className={copyState.kind === 'failed' ? 'hitl-copy-failed' : ''}>
            {copyState.message}
          </span>
        </div>
      )}
    </div>
  );
});
