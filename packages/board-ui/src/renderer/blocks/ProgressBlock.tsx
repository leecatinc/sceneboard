import type { RendererComponentV1 } from '../renderer-types.js';

export const ProgressBlock: RendererComponentV1<'content.progress'> = ({ node }) => (
  <section className="scene-block scene-progress" aria-label={node.label}>
    <div className="scene-progress-head"><strong>{node.label}</strong><span>{node.value === null ? node.state : `${Math.round(node.value * 100)}% · ${node.state}`}</span></div>
    {node.value === null
      ? <div className="scene-progress-track" role="progressbar" aria-label={node.label}><span className="scene-progress-indeterminate" /></div>
      : <progress max={1} value={node.value}>{Math.round(node.value * 100)}%</progress>}
    {node.detail && <p>{node.detail}</p>}
  </section>
);
