import type { CSSProperties } from 'react';
import type { RendererComponentV1 } from '../renderer-types.js';

export const CanvasLayout: RendererComponentV1<'layout.canvas'> = ({ node, renderNode }) => {
  return (
    <section className="scene-layout scene-canvas" aria-label={node.title ?? 'Canvas'}>
      <div
        className="scene-canvas-stage"
        style={
          {
            '--scene-canvas-width': `${node.width}px`,
            '--scene-canvas-height': `${node.height}px`,
          } as CSSProperties
        }
      >
        <div className="scene-canvas-reserved">
          <div className="scene-canvas-plane">
            {node.children.map((child) => (
              <div
                className="scene-canvas-child"
                key={child.node.id}
                style={{
                  left: `${(child.x / node.width) * 100}%`,
                  top: `${(child.y / node.height) * 100}%`,
                  width: `${(child.width / node.width) * 100}%`,
                  height: `${(child.height / node.height) * 100}%`,
                  zIndex: child.zIndex,
                }}
              >
                {renderNode(child.node)}
              </div>
            ))}
          </div>
        </div>
      </div>
      <details className="scene-canvas-list">
        <summary>Readable canvas contents</summary>
        <ol>
          {node.children.map((child) => (
            <li key={child.node.id}>{child.node.title ?? child.node.type}</li>
          ))}
        </ol>
      </details>
    </section>
  );
};
