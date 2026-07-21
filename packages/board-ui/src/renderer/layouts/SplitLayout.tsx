import type { SplitNodeV1 } from '@sceneboard/board-schema';
import type { RendererComponentV1 } from '../renderer-types.js';

export const SplitLayout: RendererComponentV1<'layout.split'> = ({ node, renderNode }) => (
  <section
    className={`scene-layout scene-split scene-split-${node.direction}`}
    aria-label={node.title ?? 'Split layout'}
    style={{ gap: `${node.gap}px` }}
  >
    {node.children.map((child) => (
      <div
        className="scene-split-child"
        style={{ flexGrow: child.weight, flexBasis: 0 }}
        key={child.node.id}
      >
        {renderNode(child.node)}
      </div>
    ))}
  </section>
);

void (null as SplitNodeV1 | null);
