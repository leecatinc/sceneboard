import { notFound } from 'next/navigation';

import { ExportRenderClient } from './ExportRenderClient';

const SESSION_ID_V1 = /^[A-Za-z0-9_-]{22}$/u;
const IPV4_OCTET_V1 = '(?:0|[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-5])';
const IPV4_LOOPBACK_V1 = new RegExp(`^127(?:\\.${IPV4_OCTET_V1}){3}$`, 'u');
const isLoopbackHost = (value: string): boolean =>
  value === '[::1]' || value === '::1' || IPV4_LOOPBACK_V1.test(value);

const loopbackOrigin = (value: string | undefined, label: string): string => {
  if (value === undefined) throw new TypeError(`${label} is unavailable`);
  const parsed = new URL(value);
  if (
    parsed.origin !== value ||
    parsed.protocol !== 'http:' ||
    !isLoopbackHost(parsed.hostname) ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    throw new TypeError(`${label} is invalid`);
  return parsed.origin;
};

export default async function ExportRenderPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  if (!SESSION_ID_V1.test(sessionId)) notFound();
  return (
    <ExportRenderClient
      sessionId={sessionId}
      apiOrigin={loopbackOrigin(process.env.SCENEBOARD_EXPORT_API_ORIGIN, 'export API origin')}
      runtimeOrigin={loopbackOrigin(
        process.env.SCENEBOARD_EXPORT_ARTIFACT_RUNTIME_ORIGIN,
        'export artifact runtime origin',
      )}
    />
  );
}
