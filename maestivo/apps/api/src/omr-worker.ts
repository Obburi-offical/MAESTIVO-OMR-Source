import { createHash } from 'node:crypto';
import { access, chmod, lstat, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { executeAudiveris } from './audiveris';
import { createWorkerServer } from './worker-wire.mjs';
import { omrWorkerDeadlineMs } from './runtime-omr-config';

/** Run the executable in this separately sandboxed service, never in the API. */
export async function startOmrWorker(config: {socketPath: string; jobRoot: string; binaryPath: string; timeoutMs: number; tessdataPath?: string; sealedNative?: boolean}) {
  if (![config.socketPath, config.jobRoot, config.binaryPath].every(p => isAbsolute(p) && normalize(p) === p) || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 30_000 || config.timeoutMs > 600_000) throw new Error('Invalid OMR worker configuration');
  if (config.tessdataPath && (!isAbsolute(config.tessdataPath) || normalize(config.tessdataPath) !== config.tessdataPath)) throw new Error('Invalid tessdata directory');
  const executable = await lstat(config.binaryPath);
  if (!executable.isFile() || executable.isSymbolicLink()) throw new Error('Invalid Audiveris executable');
  await access(config.binaryPath, constants.X_OK);
  if (config.tessdataPath) {
    const directory = await lstat(config.tessdataPath);
    const english = await lstat(join(config.tessdataPath, 'eng.traineddata'));
    if (!directory.isDirectory() || directory.isSymbolicLink() || !english.isFile() || english.isSymbolicLink()) throw new Error('Invalid tessdata directory');
  }
  const socketDirectory = await lstat(dirname(config.socketPath));
  if (!socketDirectory.isDirectory() || socketDirectory.isSymbolicLink() || socketDirectory.uid !== process.getuid?.() || (socketDirectory.mode & 0o022) !== 0) throw new Error('OMR worker requires a trusted socket directory');
  const root = await lstat(config.jobRoot);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid?.() || (root.mode & 0o077) !== 0) throw new Error('OMR worker requires its own private job root');
  if ((await readdir(config.jobRoot)).length) throw new Error('OMR worker job root requires cleanup before startup');
  let poisoned = false;
  const service = await createWorkerServer({
    socketPath: config.socketPath,
    deadlineMs: omrWorkerDeadlineMs(config.timeoutMs),
    handlePdf: async (pdf, signal) => {
      if (poisoned) throw new Error('Worker needs cleanup before another job');
      const job = await mkdtemp(join(config.jobRoot, 'job-'));
      const source = join(job, 'input.pdf');
      const scratch = join(job, 'scratch');
      try {
        await writeFile(source, pdf, {flag:'wx', mode:0o600});
        const result = await executeAudiveris({binaryPath:config.binaryPath, agplApproved:true, scratchDirectory:scratch, timeoutMs:config.timeoutMs, privateHome:true, sealedNative:config.sealedNative, tessdataPath:config.tessdataPath}, {path:source, bytes:pdf.length, sha256:createHash('sha256').update(pdf).digest('hex')}, signal);
        const encoded = Buffer.from(JSON.stringify({exportWarningCount:result.exportWarningCount, outputs:result.outputs.map(output => ({filename:output.filename, mimeType:output.mimeType, base64:Buffer.from(output.bytes).toString('base64')}))}));
        if (encoded.length > 16 * 1024 * 1024) throw new Error('Worker output exceeds transport limit');
        return encoded;
      } finally {
        // The engine intentionally preserves scratch while a child may still
        // run. Never remove its inputs or accept a new job in that condition.
        try {
          const entries = await readdir(scratch).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
          if (entries.length) poisoned = true;
          else await rm(job, {recursive:true, force:true});
        } catch {
          poisoned = true;
          throw new Error('Worker cleanup failed');
        }
      }
    },
  });
  try { await chmod(config.socketPath, 0o660); }
  catch (error) { await service.close(); throw error; }
  return service;
}
