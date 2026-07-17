import type { RendererComponentV1 } from '../renderer-types.js';
import { projectMapPositionV1 } from './map-projection.js';

const safeFeatureName = (properties: Record<string, unknown>, index: number): string => {
  const name = properties.name;
  return typeof name === 'string' && name.length <= 200 ? name : `Feature ${index + 1}`;
};

export const MapBlock: RendererComponentV1<'content.map'> = ({ node }) => (
  <figure className="scene-block scene-map-block">
    <figcaption>{node.title ?? 'Map'} <span className="scene-badge">Offline · no tiles</span></figcaption>
    <svg className="scene-map" viewBox="0 0 100 100" role="img" aria-label="Tile-free feature map">
      <rect x="0" y="0" width="100" height="100" className="scene-map-bg" />
      {node.data.features.map((feature, index) => {
        const key = String(feature.id ?? index);
        if (feature.geometry.type === 'Point') {
          const point = projectMapPositionV1(feature.geometry.coordinates, node.viewport);
          return point.visible ? <circle key={key} cx={point.x} cy={point.y} r="2.5" className="scene-map-mark" /> : null;
        }
        if (feature.geometry.type === 'LineString') {
          const points = feature.geometry.coordinates.map((position) => projectMapPositionV1(position, node.viewport));
          return points.some((point) => point.visible) ? <polyline key={key} points={points.map((point) => `${point.x},${point.y}`).join(' ')} className="scene-map-line" /> : null;
        }
        return <g key={key}>{feature.geometry.coordinates.map((ring, ringIndex) => {
          const points = ring.map((position) => projectMapPositionV1(position, node.viewport));
          return points.some((point) => point.visible) ? <polygon key={ringIndex} points={points.map((point) => `${point.x},${point.y}`).join(' ')} className="scene-map-area" /> : null;
        })}</g>;
      })}
    </svg>
    <ol className="scene-feature-list">{node.data.features.map((feature, index) => <li key={String(feature.id ?? index)}>{safeFeatureName(feature.properties, index)} · {feature.geometry.type}</li>)}</ol>
  </figure>
);
