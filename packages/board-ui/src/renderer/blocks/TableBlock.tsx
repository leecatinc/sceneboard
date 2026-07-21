import type { TableNodeV1 } from '@sceneboard/board-schema';
import type { RendererComponentV1 } from '../renderer-types.js';

export const formatTableValueV1 = (
  value: string | number | boolean | null,
  valueType: TableNodeV1['columns'][number]['valueType'],
): string => {
  if (value === null) return '—';
  if (valueType === 'boolean') return value ? 'Yes' : 'No';
  if (valueType === 'datetime' && typeof value === 'string')
    return new Date(value).toLocaleString();
  return String(value);
};

export const TableBlock: RendererComponentV1<'content.table'> = ({ node }) => (
  <figure className="scene-block scene-table-wrap">
    <figcaption>{node.title ?? 'Table'}</figcaption>
    <div className="scene-table-scroll">
      <table>
        <thead>
          <tr>
            {node.columns.map((column) => (
              <th scope="col" key={column.key}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {node.rows.map((row) => (
            <tr key={row.id}>
              {node.columns.map((column) => (
                <td key={column.key}>
                  {formatTableValueV1(row.cells[column.key] ?? null, column.valueType)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </figure>
);
