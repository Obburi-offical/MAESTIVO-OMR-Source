import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, lstat, readFile, copyFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, extname } from 'node:path';
import { createAudiverisScratchAttempt, groupExited } from './audiveris-scratch';
import { sanitizeAudiverisOutput } from './audiveris-output';
import { executeSocketAudiveris } from './audiveris-socket';
import { sealedAudiverisEnvironment, verifySealedJobDirectory } from './sealed-native-runtime';

import { DEFAULT_OMR_ENGINE_TIMEOUT_MS, MAX_OMR_ENGINE_TIMEOUT_MS } from './runtime-omr-config';

export interface AudiverisConfig { binaryPath:string; agplApproved:boolean; scratchDirectory:string; socketPath?:string; privateHome?:boolean; sealedNative?:boolean; tessdataPath?:string; timeoutMs?:number; maxOutputBytes?:number; }
export interface OmrOutput {filename:string;mimeType:string;bytes:Uint8Array;}
export interface AudiverisResult { outputs: OmrOutput[]; exportWarningCount: number; }
interface AudiverisSource { path: string; bytes: number; sha256: string; }

export function audiverisTimeoutMs(configured?: number): number {
  return Math.min(configured || DEFAULT_OMR_ENGINE_TIMEOUT_MS, MAX_OMR_ENGINE_TIMEOUT_MS);
}

// Audiveris 5.11 can write MusicXML and exit successfully after these export failures.
// Match its bundled console layout and the logger-name layout used by local workers.
const exportWarning = /^WARN +(?:\[[^\r\n\]]*\] +PartwiseBuilder +\d+ +\| |(?:o\.a\.o\.s|org\.audiveris\.omr\.score)\.PartwiseBuilder - )Error visiting (?:System|MetronomeInter)#\d+(?=[{ \r]|$)/gm;

async function verifyStagedPdf(path: string, source: AudiverisSource, signal: AbortSignal) {
  const file = await lstat(path);
  const mismatch = () => new Error('Audiveris input does not match the retained PDF');
  if (!file.isFile() || file.size !== source.bytes) throw mismatch();
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    bytes += chunk.byteLength;
    if (bytes > source.bytes) throw mismatch();
    hash.update(chunk);
  }
  if (bytes !== source.bytes || hash.digest('hex') !== source.sha256) throw mismatch();
}

/** Isolated working directory and process group; not an OS/network sandbox. Never executes a shell or a user-supplied command. */
export async function executeAudiveris(config:AudiverisConfig,source:AudiverisSource,signal:AbortSignal):Promise<AudiverisResult> {
  if (!config.agplApproved) throw new Error('Audiveris requires approved licensing');
  if (config.socketPath) return executeSocketAudiveris(config.socketPath, source, signal, audiverisTimeoutMs(config.timeoutMs), config.maxOutputBytes);
  if (config.sealedNative && !config.privateHome) throw new Error('Sealed native runtime requires a private home');
  if (!isAbsolute(config.binaryPath) || !isAbsolute(source.path)) throw new Error('Audiveris requires fixed absolute executable/input paths');
  if (config.tessdataPath && !isAbsolute(config.tessdataPath)) throw new Error('Invalid tessdata path');
  const executable=await lstat(config.binaryPath);const input=await lstat(source.path);
  if(!executable.isFile() || executable.isSymbolicLink() || !input.isFile() || input.size>20*1024*1024 || input.size!==source.bytes)throw new Error('Unsafe Audiveris input or executable');
  if(signal.aborted)throw new Error('Cancelled');
  const attempt = createAudiverisScratchAttempt(config.scratchDirectory);
  let workerPid: number | undefined;
  let workerClosed = false;
  const byteLimit=Math.min(config.maxOutputBytes || 10*1024*1024,20*1024*1024);
  try {
    await mkdir(attempt.workingDirectory, { mode: 0o700 });
    await mkdir(join(attempt.workingDirectory, 'output'), { mode: 0o700 });
    const preparingInput = join(attempt.workingDirectory, 'input.pdf');
    await copyFile(source.path, preparingInput);
    await verifyStagedPdf(preparingInput, source, signal);
    if (signal.aborted) throw new Error('Cancelled');
    attempt.activate();
    const directory = attempt.workingDirectory;
    if (config.sealedNative) await verifySealedJobDirectory(directory);
    const outputDirectory = join(directory, 'output');
    const stagedInput = join(directory, 'input.pdf');
    const stagedLocations = [...new Set([stagedInput, await realpath(stagedInput)])];
    const attemptName = basename(dirname(directory));
    const exportWarningCount = await new Promise<number>((resolve, reject) => {
      const useProcessGroup = process.platform !== 'win32';
      const child = spawn(
        config.binaryPath,
        ['-batch', '-export', '-output', outputDirectory, stagedInput],
        {
          cwd: directory,
          shell: false,
          detached: useProcessGroup,
          stdio: ['ignore', 'pipe', 'pipe'],
          // Expo augments ProcessEnv with a required NODE_ENV, but this Node
          // child intentionally receives only the listed, non-secret values.
          env: (config.sealedNative ? sealedAudiverisEnvironment(directory) : {
            PATH: process.env.PATH || '/usr/bin:/bin',
            LANG: 'C.UTF-8',
            TMPDIR: directory,
            ...(config.privateHome ? { HOME: directory } : process.env.HOME ? { HOME: process.env.HOME } : {}),
            ...(config.tessdataPath ? { TESSDATA_PREFIX: config.tessdataPath } : {}),
            ...(process.env.JAVA_HOME ? { JAVA_HOME: process.env.JAVA_HOME } : {}),
          }) as unknown as NodeJS.ProcessEnv,
        },
      );
      workerPid = child.pid;
      let failure: Error | undefined;
      let seen = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let drain: ReturnType<typeof setTimeout> | undefined;
      const groupIsLive = () => useProcessGroup && child.pid !== undefined && !groupExited(child.pid);
      const send = (killSignal: NodeJS.Signals) => {
        try {
          if (useProcessGroup && child.pid !== undefined) process.kill(-child.pid, killSignal);
          else child.kill(killSignal);
        } catch {
          // A concurrent exit may have already removed the process or group.
        }
      };
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        clearTimeout(escalation);
        clearTimeout(drain);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve([stdout, stderr].reduce((count, chunks) =>
          count + Array.from(Buffer.concat(chunks).toString('utf8').matchAll(exportWarning)).length, 0));
      };
      const stop = (error: Error) => {
        if (failure) return;
        failure = error;
        send('SIGTERM');
        escalation = setTimeout(() => {
          if (groupIsLive() || (!useProcessGroup && !workerClosed)) send('SIGKILL');
          // If another process still holds a pipe, it cannot keep the job open.
          drain = setTimeout(() => {
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            finish(error);
          }, 150);
        }, 150);
      };
      const timeout = setTimeout(() => stop(new Error('Audiveris timed out')), audiverisTimeoutMs(config.timeoutMs));
      const abort = () => stop(new Error('Cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      const collect = (chunks: Buffer[], chunk: Buffer) => {
        seen += chunk.byteLength;
        if (seen > 65_536) stop(new Error('Audiveris output exceeded the logging limit'));
        else chunks.push(chunk);
      };
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.once('error', (error) => {
        if (child.pid === undefined) finish(failure ?? error);
        else stop(error);
      });
      child.once('close', (code) => {
        workerClosed = true;
        if (groupIsLive()) {
          stop(new Error('Audiveris left a running worker process'));
          return;
        }
        finish(failure ?? (code === 0 ? undefined : new Error('Audiveris failed')));
      });
      child.once('exit', () => {
        if (groupIsLive()) stop(new Error('Audiveris left a running worker process'));
      });
      if (workerPid !== undefined) {
        try { attempt.recordGroup(workerPid); }
        catch { stop(new Error('Could not record the Audiveris worker group')); }
      }
      if (signal.aborted) abort();
    });
    if (signal.aborted) throw new Error('Cancelled');
    await verifyStagedPdf(stagedInput, source, signal);
    if (!(await lstat(outputDirectory)).isDirectory()) throw new Error('Unsafe Audiveris output directory');
    const results:OmrOutput[]=[];let total=0,deliveredTotal=0,entries=0;
    const walk=async(directory:string,depth:number):Promise<void>=>{
      if(depth>3)throw new Error('Audiveris output structure exceeded limits');
      for(const entry of await readdir(directory,{withFileTypes:true})){
        if(++entries>80)throw new Error('Too many Audiveris output files');
        const path=join(directory,entry.name),stat=await lstat(path);if(stat.isSymbolicLink())throw new Error('Unsafe Audiveris symbolic link');
        if(stat.isDirectory()){await walk(path,depth+1);continue;}
        if(!stat.isFile())throw new Error('Unsafe Audiveris output file');
        // Audiveris uses a null movement ID when the score is absent from its book's movement list.
        // Multiple movements can overwrite this same path before the worker exits successfully.
        if (entry.name === 'input.mvtnull.mxl' || entry.name === 'input.mvtnull.xml') {
          throw new Error('Audiveris exported a movement without an ID');
        }
        const extension=extname(entry.name).toLowerCase();if(!['.mxl','.xml','.musicxml'].includes(extension))continue;
        total+=stat.size;if(total>byteLimit || results.length>=20)throw new Error('Audiveris output exceeds size limits');
        const raw=new Uint8Array(await readFile(path));
        if(raw.byteLength!==stat.size)throw new Error('Audiveris output changed before inspection');
        if(extension==='.mxl' && !(raw[0]===80 && raw[1]===75))throw new Error('Invalid compressed MusicXML output');
        const bytes = sanitizeAudiverisOutput(raw, extension, stagedLocations, attemptName);
        deliveredTotal += bytes.byteLength;
        if (deliveredTotal > byteLimit) throw new Error('Audiveris output exceeds size limits');
        results.push({filename:`omr-${results.length}${extension}`,mimeType:extension==='.mxl'?'application/vnd.recordare.musicxml':'application/xml',bytes});
      }
    };
    await walk(outputDirectory,0);if(!results.length)throw new Error('No MusicXML output was produced');
    return { outputs: results, exportWarningCount };
  } finally {
    if (workerPid === undefined || (process.platform === 'win32' ? workerClosed : groupExited(workerPid)))
      attempt.remove();
  }
}
