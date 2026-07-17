import type { DrawingStyleV1 } from '@leecat-board/board-schema';
import type { RendererComponentV1 } from '../renderer-types.js';

const style = (value: DrawingStyleV1) => ({
  ...(value.stroke === undefined ? {} : { stroke: value.stroke }),
  ...(value.fill === undefined ? { fill: 'none' } : { fill: value.fill }),
  ...(value.strokeWidth === undefined ? {} : { strokeWidth: value.strokeWidth }),
  ...(value.opacity === undefined ? {} : { opacity: value.opacity }),
});

export const DrawingBlock: RendererComponentV1<'content.drawing'> = ({ node }) => (
  <figure className="scene-block scene-drawing-block">
    <figcaption>{node.title ?? 'Drawing'}</figcaption>
    <svg className="scene-drawing" viewBox={`${node.viewBox.x} ${node.viewBox.y} ${node.viewBox.width} ${node.viewBox.height}`} role="img" aria-label={node.title ?? 'Typed drawing'}>
      {node.elements.map((element) => {
        if (element.type === 'path') return <polyline key={element.id} points={element.points.map((point) => `${point.x},${point.y}`).join(' ')} {...style(element.style)} />;
        if (element.type === 'rect') return <rect key={element.id} x={element.x} y={element.y} width={element.width} height={element.height} {...style(element.style)} />;
        if (element.type === 'ellipse') return <ellipse key={element.id} cx={element.cx} cy={element.cy} rx={element.rx} ry={element.ry} {...style(element.style)} />;
        if (element.type === 'line') return <line key={element.id} x1={element.from.x} y1={element.from.y} x2={element.to.x} y2={element.to.y} {...style(element.style)} />;
        return <text key={element.id} x={element.x} y={element.y} {...style(element.style)}>{element.text}</text>;
      })}
    </svg>
    <p className="visually-hidden">Drawing with {node.elements.length} typed elements.</p>
  </figure>
);
