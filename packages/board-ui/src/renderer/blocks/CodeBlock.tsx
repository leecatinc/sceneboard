import type { RendererComponentV1 } from '../renderer-types.js';

export const CodeBlock: RendererComponentV1<'content.code'> = ({ node }) => (
  <figure className="scene-block scene-code">
    <figcaption>{node.title ?? 'Code'} <span className="scene-badge">{node.language}</span></figcaption>
    <pre className={node.wrap ? 'scene-code-wrap' : ''}>
      <code>{node.showLineNumbers
        ? node.code.split('\n').map((line, index) => `${String(index + 1).padStart(3, ' ')}  ${line}`).join('\n')
        : node.code}</code>
    </pre>
  </figure>
);
