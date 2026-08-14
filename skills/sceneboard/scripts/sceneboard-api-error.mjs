export class SceneBoardApiError extends Error {
  constructor(code, message, { retryable = false, details = null, exitCode = 1 } = {}) {
    super(message);
    this.name = 'SceneBoardApiError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.exitCode = exitCode;
  }
}
