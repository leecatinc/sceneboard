import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { runApiKeyCredentialCommandV1 } from './cli/api-key-credential.command.js';
import { createBoardMcpServerV1 } from './server.js';

const command = await runApiKeyCredentialCommandV1({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  stdin: process.stdin,
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
});

if (command.handled) {
  process.exitCode = command.exitCode;
} else {
  const runtime = await createBoardMcpServerV1();
  const transport = new StdioServerTransport();
  let closing = false;

  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await runtime.close();
  };

  process.stdin.once('end', () => {
    void shutdown();
  });
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });

  try {
    await runtime.connect(transport);
  } catch {
    process.stderr.write('{"event":"mcp_start_failed"}\n');
    process.exitCode = 1;
    await shutdown();
  }
}
