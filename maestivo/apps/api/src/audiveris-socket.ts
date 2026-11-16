import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname, isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import { sanitizeAudiverisOutput } from './audiveris-output';
import { exchangePdf } from './worker-wire.mjs';
import { omrClientDeadlineMs } from './runtime-omr-config';
import type { AudiverisResult } from './audiveris';

const responseSchema = z.object({
  outputs: z.array(z.object({filename: z.string().regex(/^omr-[0-9]+\.(?:mxl|xml|musicxml)$/), mimeType: z.enum(['application/vnd.recordare.musicxml', 'application/xml']), base64: z.string().max(14_000_000)}).strict()).min(1).max(20),
  exportWarningCount: z.number().int().min(0).max(100_000),
}).strict();

/** Send bytes rather than paths across the boundary and revalidate the reply. */
export async function executeSocketAudiveris(socketPath: string, source: {path: string; bytes: number; sha256: string}, signal: AbortSignal, timeoutMs: number, maxOutputBytes = 10 * 1024 * 1024): Promise<AudiverisResult> {
  if (!isAbsolute(socketPath) || normalize(socketPath) !== socketPath || !isAbsolute(source.path) || source.bytes < 1 || source.bytes > 20 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error('Invalid worker request');
  const file = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== source.bytes) throw new Error('Invalid worker input');
    bytes = await file.readFile();
  } finally { await file.close(); }
  if (signal.aborted || bytes.length !== source.bytes || createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('Invalid worker input');
  const raw = await exchangePdf({socketPath, pdf: bytes, signal, deadlineMs: omrClientDeadlineMs(timeoutMs)});
  const response = responseSchema.parse(JSON.parse(raw.toString('utf8')));
  let total = 0;
  const outputs = response.outputs.map((item) => {
    const data = Buffer.from(item.base64, 'base64');
    if (data.toString('base64') !== item.base64 || data.length === 0) throw new Error('Invalid worker output');
    total += data.length;
    if (total > Math.min(maxOutputBytes, 20 * 1024 * 1024)) throw new Error('Worker output exceeds size limits');
    const ext = extname(item.filename);
    if ((ext === '.mxl') !== (item.mimeType === 'application/vnd.recordare.musicxml')) throw new Error('Invalid worker output type');
    const sanitized = sanitizeAudiverisOutput(data, ext, [], '__maestivo_worker_boundary__');
    return {filename: item.filename, mimeType: item.mimeType, bytes: sanitized};
  });
  return {outputs, exportWarningCount: response.exportWarningCount};
}
