import type { RendererComponentV1 } from '../renderer-types.js';
import { SafeMarkdownContent } from './SafeMarkdownContent.js';

export const MarkdownBlock: RendererComponentV1<'content.markdown'> = ({ node }) => (
  <article className="scene-block scene-markdown" aria-label={node.title ?? 'Markdown'}>
    {node.title && <h2 className="scene-block-title">{node.title}</h2>}
    <SafeMarkdownContent markdown={node.markdown} />
  </article>
);
