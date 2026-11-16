import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import sealedAppJars from './sealed-app-jars.json';

// Reviewed x86-64 synthetic candidate only; these hashes are not a license or
// supply-chain approval, nor a validation of all JRE/JAR dependencies.
export const SEALED_NATIVE_DIR = '/srv/maestivo/audiveris/native';
export const SEALED_JOB_ROOT = '/var/lib/maestivo-omr-scratch/jobs';
export const SEALED_WORKER_SOCKET = '/run/maestivo-omr/worker.sock';
export const SEALED_ENGINE = '/srv/maestivo/audiveris/bin/Audiveris';
export const SEALED_TESSDATA = '/srv/maestivo/tessdata';
const CONFIG = '/srv/maestivo/audiveris/lib/app/Audiveris.cfg';
const APP_DIR = '/srv/maestivo/audiveris/lib/app';
export const SEALED_CONFIG_SHA256 = '749c84a4fd90901f8561ad02f7e934d1071e7a65a3c259d8f3ef2c3f6d20eac1';
const fileDigests: Readonly<Record<string, string>> = Object.freeze({
  'libjnitesseract.so':'099665dc6648197204a554f70a3187e47251c8201e1a7ab822081768d19504c7',
  'libtesseract.so.5.5':'2349797948739a8f09397a375ac254c455ead8f15a16b3a048230981c1e707ee',
  'libjnileptonica.so':'beefa0bc7327ff2c36fbaae12a60481c566f4bd12bb742380096eb131a5b0738',
  'libleptonica.so.6':'44a37baf2ad329d7bfa1e3a9883a8fefffd16966ffc075aeea122227752ea93b',
  'libgomp.so.1':'115302e45583ad3e8df681c0a5af4c8273b7399f764965280d70d8780e5ee454',
  'libjnidispatch.so':'c0ff03e4593fedd2fa96bd76a66ee9dab7a057df8739a7a38133cb5f21d12552',
});
export const SEALED_NATIVE_FILES = fileDigests;
const trustedFiles = Object.freeze({
  [CONFIG]:SEALED_CONFIG_SHA256,
  [SEALED_ENGINE]:'64ad1b8f8a528efc9234b90000480df4510588fa905014ebffa64746e50623c3',
  [join(SEALED_TESSDATA,'eng.traineddata')]:'daa0c97d651c19fba3b25e81317cd697e9908c8208090c94c3905381c23fc047',
});

export function validateSealedWorkerEnvironment(env: Record<string,string|undefined>) {
  if (env.MAESTIVO_OMR_NATIVE_PROFILE !== 'sealed-v1' || env.NODE_ENV !== 'production' ||
      env.MAESTIVO_AUDIVERIS_SOCKET !== SEALED_WORKER_SOCKET || env.MAESTIVO_OMR_JOB_ROOT !== SEALED_JOB_ROOT ||
      env.MAESTIVO_AUDIVERIS_BINARY !== SEALED_ENGINE || env.TESSDATA_PREFIX !== SEALED_TESSDATA ||
      env.MAESTIVO_AUDIVERIS_AGPL_APPROVED !== 'true' || env.MAESTIVO_AUDIVERIS_TIMEOUT_MS !== '360000')
    throw new Error('Sealed OMR profile requires the fixed reviewed worker configuration.');
}

async function trustedPath(path: string, directory: boolean) {
  if (!isAbsolute(path) || normalize(path)!==path || await realpath(path)!==path) throw new Error('Untrusted runtime path.');
  for(let part=path;;part=dirname(part)) {
    const info=await lstat(part), isTarget=part===path;
    if(info.isSymbolicLink() || info.uid!==0 || (info.mode & 0o022)!==0 || (isTarget && !directory && info.size>32*1024*1024) ||
       (isTarget && !directory ? !info.isFile() : !info.isDirectory())) throw new Error('Untrusted runtime owner or mode.');
    if(part==='/') break;
  }
}
async function sha256(path: string) {
  const hash=createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes as Buffer);
  return hash.digest('hex');
}

/** The historical candidate contained 56 app JARs including iText. This
 * candidate must have exactly the other 55 and no additional JAR files. */
export function validateSealedAppJarNames(names: readonly string[]) {
  const jars=names.filter(name=>/\.jar$/i.test(name));
  const expected=Object.keys(sealedAppJars);
  if(jars.length!==expected.length || new Set(jars).size!==expected.length ||
      jars.some(name=>!Object.prototype.hasOwnProperty.call(sealedAppJars,name)))
    throw new Error('Unexpected application JAR inventory.');
}

/** Check before opening the worker socket. Untrusted score paths are never
 * accepted as native library, launcher, or traineddata paths. */
export async function verifySealedNativeRuntime() {
  await trustedPath(APP_DIR,true);
  validateSealedAppJarNames(await readdir(APP_DIR));
  for(const [name,expected] of Object.entries(sealedAppJars)) {
    const path=join(APP_DIR,name); await trustedPath(path,false);
    if(await sha256(path)!==expected) throw new Error('Application JAR digest mismatch.');
  }
  await trustedPath(SEALED_NATIVE_DIR,true);
  const names=await readdir(SEALED_NATIVE_DIR);
  if(names.length!==Object.keys(fileDigests).length || names.some(name=>!(name in fileDigests))) throw new Error('Unexpected native inventory.');
  for(const [name,expected] of Object.entries(fileDigests)) {
    const path=join(SEALED_NATIVE_DIR,name); await trustedPath(path,false);
    if(await sha256(path)!==expected) throw new Error('Native library digest mismatch.');
  }
  for(const [path,expected] of Object.entries(trustedFiles)) {
    await trustedPath(path,false);
    if(await sha256(path)!==expected) throw new Error('Runtime file digest mismatch.');
  }
  const job=await lstat(SEALED_JOB_ROOT),uid=process.getuid?.();
  if(await realpath(SEALED_JOB_ROOT)!==SEALED_JOB_ROOT || !job.isDirectory() || job.isSymbolicLink() ||
     !uid || job.uid!==uid || (job.mode & 0o077)!==0) throw new Error('Untrusted job root.');
}

/** Deterministic, worker-created path only. No caller-controlled JVM options
 * or native search path are interpolated. */
export function sealedJavaEnvironment(directory: string): Record<string,string> {
  const suffix=directory.slice(SEALED_JOB_ROOT.length);
  if (!directory.startsWith(`${SEALED_JOB_ROOT}/`) || normalize(directory)!==directory ||
      !/^\/job-[A-Za-z0-9]{6}\/scratch\/active-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/work$/.test(suffix))
    throw new Error('Untrusted Java job directory.');
  return { JAVA_TOOL_OPTIONS: [
    `-Djava.io.tmpdir=${directory}`, `-Duser.home=${directory}`, '-XX:-UsePerfData',
    '-Dorg.bytedeco.javacpp.pathsFirst=true', '-Dorg.bytedeco.javacpp.cacheLibraries=false',
    `-Djava.library.path=${SEALED_NATIVE_DIR}`, `-Djna.boot.library.path=${SEALED_NATIVE_DIR}`,
    '-Djna.nosys=true', '-Djna.noclasspath=true', '-Djna.nounpack=true',
  ].join(' ') };
}

export function sealedAudiverisEnvironment(directory: string): Record<string,string> {
  return {PATH:'/usr/bin:/bin',LANG:'C.UTF-8',TMPDIR:directory,HOME:directory,
    TESSDATA_PREFIX:SEALED_TESSDATA,...sealedJavaEnvironment(directory)};
}

export async function verifySealedJobDirectory(directory: string) {
  sealedJavaEnvironment(directory);
  if(await realpath(directory)!==directory) throw new Error('Untrusted Java job path.');
  const uid=process.getuid?.();
  for(let current=directory;current!==SEALED_JOB_ROOT;current=dirname(current)) {
    const info=await lstat(current);
    if(!info.isDirectory() || info.isSymbolicLink() || info.uid!==uid || (info.mode&0o077)!==0)
      throw new Error('Untrusted Java job ownership.');
  }
}
