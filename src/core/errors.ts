export class ApigoError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode = 2,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'ApigoError';
  }
}

export function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  if ('cause' in error) return errorCode(error.cause);
  return undefined;
}

export function assert(condition: unknown, message: string, code = 'VALIDATION'): asserts condition {
  if (!condition) throw new ApigoError(code, message);
}
