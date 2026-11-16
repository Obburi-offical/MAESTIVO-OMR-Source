#!/usr/bin/env node
// Example worker preflight. This does not create or mount a filesystem, clean
// leftovers, approve OMR, or make an untrusted host suitable for deployment.
import { lstat, readFile, realpath, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIB = 1024n * 1024n;
const EXT4_MAGIC = 0xef53n;
const decodeMountPath = value => value.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

/** Refuse ambiguous mounts, memory-backed scratch, insufficient free space or shared/writable owners. */
export function validateScratchEvidence({ mountPath, jobRoot, mountinfo, volume, jobs, ancestors, stats, uid, canonicalMount, canonicalJobs }) {
  if (typeof mountPath !== 'string' || !isAbsolute(mountPath) || normalize(mountPath) !== mountPath || mountPath === '/' ||
      jobRoot !== join(mountPath, 'jobs') || canonicalMount !== mountPath || canonicalJobs !== jobRoot ||
      !Number.isInteger(uid) || uid <= 0) throw Error('SCRATCH_PATH_UNTRUSTED');
  if (!Array.isArray(ancestors) || ancestors.length === 0 || ancestors.some(item =>
        !item.directory || item.symlink || item.uid !== 0 || (item.mode & 0o022) !== 0) ||
      !volume?.directory || volume.symlink || volume.uid !== 0 || (volume.mode & 0o022) !== 0 ||
      !jobs?.directory || jobs.symlink || jobs.uid !== uid || (jobs.mode & 0o077) !== 0) throw Error('SCRATCH_PERMISSIONS_UNTRUSTED');
  if (typeof mountinfo !== 'string' || mountinfo.length > 4 * 1024 * 1024) throw Error('SCRATCH_MOUNT_UNVERIFIED');
  const mounts = mountinfo.split('\n').flatMap(line => {
    const fields = line.split(' '), separator = fields.indexOf('-');
    if (separator < 6 || fields.length < separator + 3) return [];
    const path = decodeMountPath(fields[4]);
    if (path !== mountPath && path !== jobRoot) return [];
    return [{ path, device: fields[2], root: decodeMountPath(fields[3]), options: fields[5].split(','), filesystem: fields[separator + 1] }];
  });
  const matching = mounts.filter(item => item.path === mountPath), jobMounts = mounts.filter(item => item.path === jobRoot);
  const secure = item => item.filesystem === 'ext4' && /^\d+:\d+$/.test(item.device) &&
    ['nodev', 'nosuid', 'noexec'].every(option => item.options.includes(option));
  const root = matching[0], rootRw = root?.options.includes('rw'), rootRo = root?.options.includes('ro');
  if (matching.length !== 1 || root.root !== '/' || !secure(root) || rootRw === rootRo || jobMounts.length > 1)
    throw Error('SCRATCH_MOUNT_UNVERIFIED');
  // ProtectSystem=strict may make the mount root read-only while
  // ReadWritePaths binds only /jobs back as writable on the same filesystem.
  // Reject an unrelated, stacked, nested or insecure child mount.
  if ((!rootRw && jobMounts.length !== 1) || (jobMounts.length === 1 &&
      (jobMounts[0].root !== '/jobs' || jobMounts[0].device !== root.device || !secure(jobMounts[0]) ||
       !jobMounts[0].options.includes('rw') || jobMounts[0].options.includes('ro')))) throw Error('SCRATCH_MOUNT_UNVERIFIED');
  const type = BigInt(stats?.type ?? -1), blocks = BigInt(stats?.blocks ?? -1), bsize = BigInt(stats?.bsize ?? -1), available = BigInt(stats?.bavail ?? -1);
  if (type !== EXT4_MAGIC || blocks <= 0n || bsize <= 0n || available < 0n || available > blocks) throw Error('SCRATCH_FILESYSTEM_UNVERIFIED');
  const capacity = blocks * bsize, free = available * bsize;
  // The cap is a containment ceiling, not a throughput or OCR guarantee.
  if (capacity < 512n * MIB || capacity > 2048n * MIB || free < 256n * MIB) throw Error('SCRATCH_CAPACITY_UNSAFE');
  return { capacityBytes: capacity.toString(), availableBytes: free.toString() };
}

export async function inspectScratch(mountPath) {
  if (typeof mountPath !== 'string' || !isAbsolute(mountPath) || normalize(mountPath) !== mountPath || mountPath === '/') throw Error('SCRATCH_PATH_UNTRUSTED');
  const jobRoot = join(mountPath, 'jobs');
  const ancestorPaths = [];
  for (let path = dirname(mountPath); ; path = dirname(path)) {
    ancestorPaths.push(path);
    if (path === '/') break;
  }
  const [mountinfo, volume, jobs, stats, canonicalMount, canonicalJobs, ancestorStats] = await Promise.all([
    readFile('/proc/self/mountinfo', 'utf8'), lstat(mountPath), lstat(jobRoot), statfs(jobRoot, { bigint: true }), realpath(mountPath), realpath(jobRoot),
    Promise.all(ancestorPaths.map(path => lstat(path))),
  ]);
  return validateScratchEvidence({ mountPath, jobRoot, mountinfo, stats, uid: process.getuid?.(), canonicalMount, canonicalJobs,
    ancestors: ancestorStats.map(item => ({ directory: item.isDirectory(), symlink: item.isSymbolicLink(), uid: item.uid, mode: item.mode })),
    volume: { directory: volume.isDirectory(), symlink: volume.isSymbolicLink(), uid: volume.uid, mode: volume.mode },
    jobs: { directory: jobs.isDirectory(), symlink: jobs.isSymbolicLink(), uid: jobs.uid, mode: jobs.mode } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw Error('INVALID_ARGUMENT');
    await inspectScratch(process.argv[2]);
    console.log('OMR scratch filesystem checks passed; deployment is not approved.');
  } catch {
    // Do not disclose filesystem paths or infrastructure data in service logs.
    console.error('OMR scratch filesystem check failed.');
    process.exitCode = 1;
  }
}
