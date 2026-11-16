export function exchangePdf(options: {socketPath: string; pdf: Buffer; signal?: AbortSignal; deadlineMs?: number}): Promise<Buffer>;
export function createWorkerServer(options: {socketPath: string; handlePdf: (pdf: Buffer, signal: AbortSignal) => Promise<Buffer>; deadlineMs?: number; shutdownTimeoutMs?: number}): Promise<{close: () => Promise<void>}>;
