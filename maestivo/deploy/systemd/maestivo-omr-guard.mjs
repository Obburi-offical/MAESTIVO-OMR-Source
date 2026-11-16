// Research candidate. The fixed policy is the private synthetic probe policy,
// not a capacity guarantee or a public-deployment approval.
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

export const LIMITS = Object.freeze({
  minimumAvailableKiB: 174080, maximumApiSwapBytes: 16777216,
  maximumSwapUsedKiB: 393216, minimumSwapTotalKiB: 716800,
  maximumSwapTotalKiB: 786432, pollMs: 2000, healthTimeoutMs: 2000,
});
const apiUnits = ['maestivo-api.service', 'maestivo-web-omr.service'];
const swapAlias = '/dev/mapper/maestivo-ephemeral-swap';
const run = promisify(execFile);

export function parseMeminfo(input) {
  if (typeof input !== 'string' || input.length > 128 * 1024) throw Error('INVALID_MEMORY');
  const values = {};
  for (const key of ['MemAvailable', 'SwapTotal', 'SwapFree']) {
    const lines = input.split('\n').filter(line => line.startsWith(`${key}:`));
    if (lines.length !== 1) throw Error('INVALID_MEMORY');
    const match = new RegExp(`^${key}:\\s+([0-9]+)\\s+kB\\s*$`).exec(lines[0]);
    if (!match) throw Error('INVALID_MEMORY');
    values[key] = Number(match[1]);
    if (!Number.isSafeInteger(values[key])) throw Error('INVALID_MEMORY');
  }
  return values;
}

function nonnegativeInteger(value) {
  if (typeof value !== 'string' || !/^\d+\s*$/.test(value)) throw Error('INVALID_CGROUP');
  const number = Number(value.trim());
  if (!Number.isSafeInteger(number)) throw Error('INVALID_CGROUP');
  return number;
}

export function assessSnapshot(snapshot) {
  const memory = parseMeminfo(snapshot?.meminfo);
  if (memory.SwapFree > memory.SwapTotal || memory.SwapTotal < LIMITS.minimumSwapTotalKiB ||
      memory.SwapTotal > LIMITS.maximumSwapTotalKiB || memory.MemAvailable < LIMITS.minimumAvailableKiB ||
      memory.SwapTotal - memory.SwapFree > LIMITS.maximumSwapUsedKiB) throw Error('MEMORY_LIMIT');
  if (!Array.isArray(snapshot.apiSwap) || snapshot.apiSwap.length !== 2) throw Error('INVALID_CGROUP');
  const totalApiSwap = snapshot.apiSwap.reduce((sum, value) => sum + nonnegativeInteger(value), 0);
  if (!Number.isSafeInteger(totalApiSwap) || totalApiSwap > LIMITS.maximumApiSwapBytes) throw Error('API_SWAP_LIMIT');
  if (snapshot.expectedSwap !== true || !Array.isArray(snapshot.apiHealth) || snapshot.apiHealth.length !== 2 ||
      snapshot.apiHealth.some(status => status !== 200)) throw Error('DEPENDENCY_UNAVAILABLE');
  return true;
}

function health(port) {
  return new Promise((resolveHealth, rejectHealth) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: LIMITS.healthTimeoutMs, maxHeaderSize: 8192 }, response => {
      const status = response.statusCode; response.destroy(); resolveHealth(status);
    });
    req.on('timeout', () => req.destroy(Error('HEALTH_TIMEOUT')));
    req.on('error', rejectHealth); req.end();
  });
}

async function activeSwapIsExpected() {
  const content = await readFile('/proc/swaps', 'utf8');
  if (content.length > 64 * 1024) return false;
  const lines = content.trim().split('\n');
  if (lines.length !== 2 || !/^Filename\s+Type\s+Size\s+Used\s+Priority\s*$/.test(lines[0])) return false;
  const fields = lines[1].trim().split(/\s+/);
  if (fields.length !== 5 || fields[1] !== 'partition') return false;
  try { return await realpath(fields[0]) === await realpath(swapAlias); }
  catch { return false; }
}

export async function sampleHost() {
  const [meminfo, apiSwap, expectedSwap, oldHealth, webHealth] = await Promise.all([
    readFile('/proc/meminfo', 'utf8'),
    Promise.all(apiUnits.map(unit => readFile(`/sys/fs/cgroup/system.slice/${unit}/memory.swap.current`, 'utf8'))),
    activeSwapIsExpected(), health(8788), health(8789),
  ]);
  return { meminfo, apiSwap, expectedSwap, apiHealth: [oldHealth, webHealth] };
}

/** Readiness is sent only after a valid sample; any later sampling or notifier
 * failure rejects. Under systemd BindsTo, either an error or guard death causes
 * the worker to stop. Tests inject all dependencies; no host access is needed. */
export async function supervise(sample, notify, wait, heartbeat) {
  assessSnapshot(await sample());
  await notify();
  for (;;) { await wait(LIMITS.pollMs); assessSnapshot(await sample()); await heartbeat(); }
}

async function main() {
  await supervise(sampleHost, async () => {
    await run('/usr/bin/systemd-notify', ['--ready', '--status=OMR resource guard ready'], { timeout: 2000, maxBuffer: 8192 });
  }, ms => new Promise(done => setTimeout(done, ms)), async () => {
    await run('/usr/bin/systemd-notify', ['WATCHDOG=1'], { timeout: 2000, maxBuffer: 8192 });
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('OMR guard refused or lost required resources; worker must stop.'); process.exitCode = 1; });
}
