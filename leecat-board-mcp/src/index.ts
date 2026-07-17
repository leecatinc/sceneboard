import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createBoardMcpServerV1 } from './server.js';

const runtime = await createBoardMcpServerV1();
const transport = new StdioServerTransport();
let closing = false;

const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await runtime.close();
};

process.stdin.once('end', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });

try {
  await runtime.connect(transport);
} catch {
  process.stderr.write('{"event":"mcp_start_failed"}\n');
  process.exitCode = 1;
  await shutdown();
}
