import type { RendererComponentV1 } from '../renderer-types.js';

const symbols = { neutral: '○', info: 'i', success: '✓', warning: '!', error: '×' } as const;

export const StatusBlock: RendererComponentV1<'content.status'> = ({ node }) => (
  <section className={`scene-block scene-status scene-status-${node.status}`} role="status">
    <strong>
      <span aria-hidden="true">{symbols[node.status]}</span> {node.label}
    </strong>
    {node.detail && <p>{node.detail}</p>}
  </section>
);
