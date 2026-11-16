// Offline staging only: no server, credentials, process, or network changes.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {privateAddress} from './omr-ssh-bridge.mjs';

const here=dirname(fileURLToPath(import.meta.url)), root=resolve(here,'../..');
const fingerprint=key=>`SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/,'')}`;

export function parsePinnedHostKey(publicKey,expectedFingerprint) {
  const parts=typeof publicKey==='string'?publicKey.trim().split(/\s+/):[];
  if(parts.length<2 || parts.length>3 || parts[0]!=='ssh-ed25519' || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1])) throw Error('Invalid worker host key.');
  const blob=Buffer.from(parts[1],'base64');
  if(blob.toString('base64')!==parts[1] || blob.length!==51 || blob.readUInt32BE(0)!==11 ||
     blob.subarray(4,15).toString()!=='ssh-ed25519' || blob.readUInt32BE(15)!==32 || fingerprint(blob)!==expectedFingerprint)
    throw Error('Worker host key fingerprint does not match independently verified evidence.');
  return `ssh-ed25519 ${parts[1]}`;
}

export async function renderPlan({revision, apiPrivateIp, workerPrivateIp, workerHostKey, workerHostFingerprint}) {
  if(!/^[a-f0-9]{40}$/.test(revision) || !privateAddress(apiPrivateIp) || !privateAddress(workerPrivateIp) || apiPrivateIp===workerPrivateIp)
    throw Error('Use one exact revision and two distinct private IPv4 addresses.');
  const key=parsePinnedHostKey(workerHostKey,workerHostFingerprint);
  const release=`/srv/maestivo/releases/split-${revision.slice(0,12)}`;
  const read=async name=>await readFile(join(here,name),'utf8');
  const replaceRelease=text=>text.replaceAll('/srv/maestivo/releases/REVIEWED',release).replaceAll('/srv/maestivo/current',release);
  const files={
    'worker/maestivo-split-scratch.service':replaceRelease(await read('maestivo-split-scratch.service.example')),
    'worker/maestivo-ephemeral-swap.service':replaceRelease(await read('maestivo-ephemeral-swap.service.example')),
    'worker/maestivo-split-omr-guard.service':replaceRelease(await read('maestivo-split-omr-guard.service.example')),
    'worker/maestivo-split-omr.service':replaceRelease(await read('maestivo-split-omr.service.example')),
    'worker/30-maestivo-omr.conf':await read('sshd-maestivo-omr-ingress.conf.example'),
    'worker/authorized-keys.template':`restrict,from="${apiPrivateIp}",command="/usr/bin/nc -U /run/maestivo-omr/worker.sock" <GENERATE_BRIDGE_PUBLIC_KEY_ON_API_VM>\n`,
    'api/maestivo-omr-bridge.service':replaceRelease((await read('maestivo-omr-bridge.service.example')).replace('REPLACE_WITH_WORKER_PRIVATE_IP',workerPrivateIp)),
    'api/omr-worker-known-hosts':`${workerPrivateIp} ${key}\n`,
  };
  if(!files['worker/maestivo-split-omr.service'].includes('MAESTIVO_AUDIVERIS_AGPL_APPROVED=false') ||
     Object.values(files).some(content=>content.includes('/srv/maestivo/current') || content.includes('/srv/maestivo/releases/REVIEWED')))
    throw Error('Plan contains an unsafe release reference.');
  return {release,files};
}

async function main() {
  const [output,revision,apiPrivateIp,workerPrivateIp,workerHostFingerprint,keyFile,...extra]=process.argv.slice(2);
  if(extra.length || !output || !isAbsolute(output) || !keyFile || !isAbsolute(keyFile)) throw Error('Usage: prepare-split-plan.mjs /new/output <full-revision> <api-private-ip> <worker-private-ip> <verified-host-fingerprint> /host-public-key');
  const current=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const dirty=execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:root,encoding:'utf8'});
  if(current!==revision || dirty) throw Error('Build the plan from the exact clean reviewed checkout.');
  const {release,files}=await renderPlan({revision,apiPrivateIp,workerPrivateIp,workerHostFingerprint,workerHostKey:await readFile(keyFile,'utf8')});
  const parent=await realpath(dirname(output)), directory=join(parent,basename(output));
  const rel=relative(await realpath(root),directory);
  if(!rel || (!rel.startsWith(`..${sep}`) && rel!=='..' && !isAbsolute(rel))) throw Error('Stage outside the repository.');
  await mkdir(directory,{mode:0o700});
  await mkdir(join(directory,'worker'),{mode:0o700}); await mkdir(join(directory,'api'),{mode:0o700});
  const digests={};
  for(const [name,content] of Object.entries(files)) {
    await writeFile(join(directory,name),content,{flag:'wx',mode:0o600});
    digests[name]=createHash('sha256').update(content).digest('hex');
  }
  await writeFile(join(directory,'manifest.json'),JSON.stringify({schemaVersion:1,revision,release,workerHostFingerprint,files:digests,installed:false,readyToDeploy:false},null,2)+'\n',{flag:'wx',mode:0o600});
  console.log('Offline split-worker configuration staged; no keys, services or servers changed.');
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error=>{console.error(error instanceof Error?error.message:'Plan failed.');process.exitCode=1;});
