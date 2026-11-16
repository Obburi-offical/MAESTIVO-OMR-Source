import { isAbsolute, normalize } from 'node:path';

// Bounded low-memory defaults; both the API and worker must use the same
// configured engine timeout. Transport budgets below allow staging and cleanup.
export const DEFAULT_OMR_ENGINE_TIMEOUT_MS = 360_000;
export const MAX_OMR_ENGINE_TIMEOUT_MS = 600_000;
export const omrWorkerDeadlineMs = (engineTimeoutMs: number) => engineTimeoutMs + 10_000;
export const omrClientDeadlineMs = (engineTimeoutMs: number) => omrWorkerDeadlineMs(engineTimeoutMs) + 10_000;

/** Validate resource budgets before the runtime opens or migrates its data store. */
export function readRuntimeOmrLimits(environment: Record<string, string | undefined>) {
  const read = (name: string, fallback: number, min: number, max: number) => {
    const raw = environment[name];
    if (raw === undefined) return fallback;
    if (!/^[0-9]+$/.test(raw)) throw new Error(`Invalid ${name}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`Invalid ${name}`);
    return value;
  };
  return {
    timeoutMs: read('MAESTIVO_AUDIVERIS_TIMEOUT_MS', DEFAULT_OMR_ENGINE_TIMEOUT_MS, 30_000, MAX_OMR_ENGINE_TIMEOUT_MS),
    uploadConcurrency: read('MAESTIVO_OMR_UPLOAD_CONCURRENCY', 1, 1, 4),
  };
}

/** Production API processes may invoke OMR only through the isolated worker. */
export function readRuntimeOmrTransport(environment: Record<string, string | undefined>) {
  const socketPath = environment.MAESTIVO_AUDIVERIS_SOCKET;
  const binaryPath = environment.MAESTIVO_AUDIVERIS_BINARY;
  if (socketPath !== undefined && (!isAbsolute(socketPath) || normalize(socketPath) !== socketPath || socketPath.includes('\0') || socketPath.endsWith('/'))) throw new Error('Invalid MAESTIVO_AUDIVERIS_SOCKET');
  if (environment.NODE_ENV === 'production' && binaryPath && !socketPath) throw new Error('Production OMR requires a separately sandboxed worker socket');
  return {socketPath, binaryPath};
}
