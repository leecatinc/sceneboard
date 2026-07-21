import type { RendererComponentV1 } from '../renderer-types.js';

export const GridLayout: RendererComponentV1<'layout.grid'> = ({ node, renderNode }) => (
  <section
    className="scene-layout scene-grid"
    aria-label={node.title ?? 'Grid layout'}
    style={{
      gap: `${node.gap}px`,
      gridTemplateColumns: `repeat(${node.columns}, minmax(0, 1fr))`,
      gridTemplateRows: `repeat(${node.rows}, minmax(0, auto))`,
    }}
  >
    {node.children.map((child) => (
      <div
        className="scene-grid-child"
        style={{
          gridColumn: `${child.column} / span ${child.columnSpan}`,
          gridRow: `${child.row} / span ${child.rowSpan}`,
        }}
        key={child.node.id}
      >
        {renderNode(child.node)}
      </div>
    ))}
  </section>
);
