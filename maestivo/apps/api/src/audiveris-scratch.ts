import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

const attemptName = /^(preparing|active|quarantine)-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;
const bootId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
let scope: string | null | undefined;

export function audiverisScratchRoot(databasePath: string) {
  const canonical = realpathSync(databasePath);
  return join(dirname(canonical), `.${basename(canonical)}.audiveris-scratch`);
}

function privateDirectory(path: string) {
  const info = lstatSync(path, { throwIfNoEntry: false });
  const uid = process.getuid?.();
  return !!info?.isDirectory() && (uid === undefined || (info.uid === uid && (info.mode & 0o077) === 0));
}

function assertPrivateRoot(root: string) {
  if (!isAbsolute(root) || !privateDirectory(root))
    throw new Error('Audiveris scratch requires a private, non-symlink directory');
}

export function groupExited(pid: number) {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid < 2 || pid > 0x7fffffff) return false;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function processScope() {
  if (scope !== undefined) return scope;
  scope = null;
  try {
    if (process.platform === 'linux') {
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const namespace = readlinkSync('/proc/self/ns/pid');
      if (bootId.test(boot) && /^pid:\[[0-9]+\]$/.test(namespace)) scope = `linux:${boot}:${namespace}`;
    } else if (process.platform === 'darwin') {
      const boot = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
        encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (bootId.test(boot)) scope = `darwin:${boot}`;
    }
  } catch {
    // Without local boot/namespace identity, a missing PID cannot prove exit.
  }
  return scope;
}

function recordedGroup(directory: string) {
  const path = join(directory, 'group');
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info?.isFile() || info.size > 128 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) return null;
  const current = processScope();
  if (current === null) return null;
  const receipt = readFileSync(path, 'utf8');
  const match = /^([^\n]+)\n([1-9][0-9]{0,9})\n$/.exec(receipt);
  return match?.[1] === current ? Number(match[2]) : null;
}

function removeQuarantined(root: string, directory: string, id: string) {
  assertPrivateRoot(root);
  if (!privateDirectory(directory)) throw new Error('Invalid Audiveris workspace path');
  const quarantine = join(root, `quarantine-${id}`);
  if (directory !== quarantine) renameSync(directory, quarantine);
  if (!privateDirectory(quarantine)) throw new Error('Invalid Audiveris quarantine path');
  rmSync(quarantine, { recursive: true, force: true });
}

export function createAudiverisScratchAttempt(root: string) {
  if (!isAbsolute(root)) throw new Error('Audiveris scratch requires an absolute path');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertPrivateRoot(root);
  const current = processScope();
  const id = randomUUID();
  let directory = join(root, `preparing-${id}`);
  mkdirSync(directory, { mode: 0o700 });
  return {
    get workingDirectory() { return join(directory, 'work'); },
    activate() {
      // Only the active path may be passed to a child process. A crash during
      // staging therefore leaves no worker with the preparing path.
      const active = join(root, `active-${id}`);
      renameSync(directory, active);
      directory = active;
    },
    recordGroup(pid: number) {
      if (current === null) return;
      const pending = join(directory, 'group.pending');
      writeFileSync(pending, `${current}\n${pid}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(pending, join(directory, 'group'));
    },
    remove() { removeQuarantined(root, directory, id); },
  };
}

/** Snapshot old work while holding the API owner lock, before admitting new jobs. */
export function startAudiverisScratchRecovery(root: string, retryMs = 30_000) {
  if (!lstatSync(root, { throwIfNoEntry: false })) return () => {};
  assertPrivateRoot(root);
  let candidates = readdirSync(root).filter(name => attemptName.test(name));
  let timer: ReturnType<typeof setInterval> | undefined;

  const retry = () => {
    if (!privateDirectory(root)) {
      if (timer) clearInterval(timer);
      return;
    }
    candidates = candidates.filter(name => {
      const [, phase, id] = attemptName.exec(name)!;
      const directory = join(root, name);
      const quarantine = join(root, `quarantine-${id}`);
      try {
        if (!privateDirectory(directory) && privateDirectory(quarantine)) {
          removeQuarantined(root, quarantine, id);
          return false;
        }
        if (!privateDirectory(directory)) return false;
        if (phase === 'active') {
          // Missing/partial receipts, unsupported platforms, and malformed
          // groups have no proof of exit. Leave their private workspace in place.
          const pid = recordedGroup(directory);
          if (pid === null || pid < 2 || pid > 0x7fffffff) return false;
          if (!groupExited(pid)) return true;
        }
        removeQuarantined(root, directory, id);
        return false;
      } catch {
        // Keep a failed move/removal eligible for retry without exposing paths.
        return true;
      }
    });
    if (candidates.length === 0 && timer) clearInterval(timer);
  };

  retry();
  if (candidates.length > 0) {
    timer = setInterval(retry, retryMs);
    timer.unref();
  }
  return () => { if (timer) clearInterval(timer); };
}
