'use client';

import { useState } from 'react';
import type { RendererComponentV1 } from '../renderer-types.js';

export const CanvasLayout: RendererComponentV1<'layout.canvas'> = ({ node, renderNode }) => {
  const [zoom, setZoom] = useState(1);
  return (
    <section className="scene-layout scene-canvas" aria-label={node.title ?? 'Canvas'}>
      <div className="scene-canvas-controls" aria-label="Canvas zoom controls">
        <button
          type="button"
          onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
          aria-label="Zoom out"
        >
          −
        </button>
        <output aria-live="polite">{Math.round(zoom * 100)}%</output>
        <button
          type="button"
          onClick={() => setZoom((value) => Math.min(2, value + 0.25))}
          aria-label="Zoom in"
        >
          +
        </button>
        <button type="button" onClick={() => setZoom(1)}>
          Reset
        </button>
      </div>
      <div className="scene-canvas-viewport">
        <div
          className="scene-canvas-plane"
          style={{ aspectRatio: `${node.width} / ${node.height}`, transform: `scale(${zoom})` }}
        >
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
