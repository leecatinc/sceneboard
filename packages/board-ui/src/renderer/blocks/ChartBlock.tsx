import type { ChartNodeV1 } from '@sceneboard/board-schema';
import type { ReactNode } from 'react';
import type { RendererComponentV1 } from '../renderer-types.js';
import { buildChartGeometryV1 } from './chart-geometry.js';

const palette = ['#02B391', '#328FDD', '#F9A24E', '#EB5757', '#6D5BD0', '#4F6D7A'];

const sourceLabel = (node: ChartNodeV1, value: string | number): string =>
  node.xAxis.valueType === 'datetime' ? new Date(String(value)).toLocaleString() : String(value);

const visual = (node: ChartNodeV1): ReactNode => {
  const geometry = buildChartGeometryV1(node);
  if (geometry.tableOnly)
    return (
      <p className="scene-chart-warning">
        Visual geometry is unavailable; all values remain in the table.
      </p>
    );
  if (node.chartType === 'pie') {
    const values = node.series[0]?.points ?? [];
    const total = values.reduce((sum, point) => sum + (point.y ?? 0), 0);
    let start = 0;
    return (
      <svg className="scene-chart" viewBox="0 0 120 120" role="img" aria-label="Pie chart visual">
        {values.map((point, index) => {
          const portion = total === 0 ? 0 : (point.y ?? 0) / total;
          const end = start + portion * Math.PI * 2;
          const x1 = 60 + 45 * Math.cos(start - Math.PI / 2);
          const y1 = 60 + 45 * Math.sin(start - Math.PI / 2);
          const x2 = 60 + 45 * Math.cos(end - Math.PI / 2);
          const y2 = 60 + 45 * Math.sin(end - Math.PI / 2);
          const path = `M 60 60 L ${x1} ${y1} A 45 45 0 ${portion > 0.5 ? 1 : 0} 1 ${x2} ${y2} Z`;
          start = end;
          return (
            <path key={`${point.x}-${index}`} d={path} fill={palette[index % palette.length]} />
          );
        })}
      </svg>
    );
  }
  return (
    <svg
      className="scene-chart"
      viewBox="0 0 120 110"
      role="img"
      aria-label={`${node.chartType} chart visual`}
    >
      <line x1="10" y1="5" x2="10" y2="100" className="scene-axis" />
      <line x1="10" y1="100" x2="115" y2="100" className="scene-axis" />
      {node.series.map((series, seriesIndex) => {
        const points = geometry.points.filter((point) => point.seriesId === series.id);
        const visible = points.filter(
          (point) => point.y !== null && point.y >= 0 && point.y <= 100,
        );
        const coordinates = visible.map((point) => `${10 + point.x},${point.y}`).join(' ');
        const color = palette[seriesIndex % palette.length];
        if (node.chartType === 'bar')
          return (
            <g key={series.id}>
              {visible.map((point, index) => (
                <rect
                  key={index}
                  x={8 + point.x}
                  y={point.y ?? 100}
                  width="4"
                  height={100 - (point.y ?? 100)}
                  fill={color}
                />
              ))}
            </g>
          );
        if (node.chartType === 'scatter')
          return (
            <g key={series.id}>
              {visible.map((point, index) => (
                <circle key={index} cx={10 + point.x} cy={point.y ?? 100} r="2.4" fill={color} />
              ))}
            </g>
          );
        if (node.chartType === 'area')
          return (
            <polygon
              key={series.id}
              points={`10,100 ${coordinates} 110,100`}
              fill={color}
              opacity="0.22"
              stroke={color}
            />
          );
        return (
          <polyline
            key={series.id}
            points={coordinates}
            fill="none"
            stroke={color}
            strokeWidth="2"
          />
        );
      })}
      {node.xAxis.label && (
        <text x="62" y="109" textAnchor="middle" className="scene-axis-label">
          {node.xAxis.label}
        </text>
      )}
      {node.yAxis.label && (
        <text
          x="5"
          y="52"
          textAnchor="middle"
          className="scene-axis-label"
          transform="rotate(-90 5 52)"
        >
          {node.yAxis.label}
        </text>
      )}
    </svg>
  );
};

export const ChartBlock: RendererComponentV1<'content.chart'> = ({ node }) => (
  <figure className="scene-block scene-chart-block">
    <figcaption>{node.title ?? 'Chart'}</figcaption>
    <div className="scene-chart-legend">
      {node.series.map((series, index) => (
        <span key={series.id}>
          <i style={{ background: palette[index % palette.length] }} />
          {series.label}
        </span>
      ))}
    </div>
    {visual(node)}
    <div className="scene-table-scroll">
      <table>
        <caption className="visually-hidden">
          Chart values{node.xAxis.label ? ` by ${node.xAxis.label}` : ''}
          {node.yAxis.label ? `, ${node.yAxis.label}` : ''}
        </caption>
        <thead>
          <tr>
            <th scope="col">{node.xAxis.label ?? 'X'}</th>
            {node.series.map((series) => (
              <th scope="col" key={series.id}>
                {series.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[
            ...new Set(
              node.series.flatMap((series) => series.points.map((point) => String(point.x))),
            ),
          ].map((key) => (
            <tr key={key}>
              <th scope="row">
                {sourceLabel(
                  node,
                  node.series
                    .flatMap((series) => series.points)
                    .find((point) => String(point.x) === key)?.x ?? key,
                )}
              </th>
              {node.series.map((series) => (
                <td key={series.id}>
                  {series.points.find((point) => String(point.x) === key)?.y ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </figure>
);
