import { redactSecretsV1 } from './redact-secrets.js';

export type SafeLogEventV1 = {
  event?: string;
  requestId?: string;
  route?: string;
  attempt?: number;
  durationMs?: number;
  resultCode?: string;
};

export class SafeStderrLoggerV1 {
  constructor(private readonly write: (line: string) => void = (line) => process.stderr.write(line)) {}

  log(event: SafeLogEventV1): void {
    const safe = redactSecretsV1(event);
    this.write(`${JSON.stringify(safe)}\n`);
  }
}
