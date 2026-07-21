import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { loadArtifactRuntimeConfigV1 } from './config.js';
import { loadArtifactRuntimeAssetsV1, routeArtifactRuntimeRequestV1 } from './routes.js';

export const main = async (): Promise<void> => {
  const config = await loadArtifactRuntimeConfigV1();
  const assets = await loadArtifactRuntimeAssetsV1(config.publicDirectory);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', config.runtimeOrigin);
    const routed = routeArtifactRuntimeRequestV1({
      method: request.method ?? '',
      path: url.search === '' ? url.pathname : `${url.pathname}${url.search}`,
      host: request.headers.host,
      topology: config,
      assets,
    });
    response.statusCode = routed.status;
    for (const [name, value] of Object.entries(routed.headers)) response.setHeader(name, value);
    response.end(routed.body);
  });
  server.on('clientError', (error, socket) => {
    void error;
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.listenPort, config.listenHost, () => {
      server.off('error', reject);
      resolve();
    });
  });
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'artifact runtime startup failed'}\n`,
    );
    process.exitCode = 1;
  });
}
