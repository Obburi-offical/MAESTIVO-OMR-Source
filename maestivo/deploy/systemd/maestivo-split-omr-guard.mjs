// Uninstalled split-host candidate. Protects the worker VM only; it does not
// infer the remote API's health, establish capacity, or approve deployment.
import {execFile} from 'node:child_process';
import {readFile, realpath, stat, statfs} from 'node:fs/promises';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {parseMeminfo} from './maestivo-omr-guard.mjs';

export const LIMITS=Object.freeze({minimumAvailableKiB:174080, maximumSwapUsedKiB:393216,
  minimumSwapTotalKiB:716800,maximumSwapTotalKiB:786432,pollMs:2000});
const run=promisify(execFile), swapAlias='/dev/mapper/maestivo-ephemeral-swap';

export function assessSplitSnapshot({meminfo,expectedSwap,sshActive,scratchReady}={}) {
  const m=parseMeminfo(meminfo);
  if(m.SwapFree>m.SwapTotal || m.SwapTotal<LIMITS.minimumSwapTotalKiB || m.SwapTotal>LIMITS.maximumSwapTotalKiB ||
     m.MemAvailable<LIMITS.minimumAvailableKiB || m.SwapTotal-m.SwapFree>LIMITS.maximumSwapUsedKiB) throw Error('MEMORY_LIMIT');
  if(expectedSwap!==true || sshActive!==true || scratchReady!==true) throw Error('DEPENDENCY_UNAVAILABLE');
  return true;
}
// Linux can expose device-mapper swap in /proc/swaps as /dm-N even though
// its actual device node is /dev/dm-N. Accept only that exact kernel spelling.
export async function swapIsExpected(data, filesystem={realpath,stat}) {
  if(typeof data!=='string' || data.length>65536) return false;
  const lines=data.trim().split('\n');
  if(lines.length!==2 || !/^Filename\s+Type\s+Size\s+Used\s+Priority\s*$/.test(lines[0])) return false;
  const fields=lines[1].trim().split(/\s+/);
  if(fields.length!==5 || fields[1]!=='partition') return false;
  let device=fields[0];
  if(/^\/dm-(0|[1-9][0-9]*)$/.test(device)) device='/dev'+device;
  if(device!==swapAlias && !/^\/dev\/dm-(0|[1-9][0-9]*)$/.test(device)) return false;
  try {
    const [actual,expected]=await Promise.all([filesystem.realpath(device),filesystem.realpath(swapAlias)]);
    if(actual!==expected || !/^\/dev\/dm-(0|[1-9][0-9]*)$/.test(actual)) return false;
    const [actualStat,expectedStat]=await Promise.all([filesystem.stat(device),filesystem.stat(swapAlias)]);
    return actualStat.isBlockDevice() && expectedStat.isBlockDevice() && actualStat.rdev===expectedStat.rdev;
  } catch {return false;}
}
async function activeSwapIsExpected() {
  try {return await swapIsExpected(await readFile('/proc/swaps','utf8'));} catch {return false;}
}
async function scratchIsExpected() {
  const mount='/var/lib/maestivo-omr-scratch', alias='/dev/mapper/maestivo-split-scratch';
  try {
    const [found, mapped, stats]=await Promise.all([
      run('/usr/bin/findmnt',['-n','-o','SOURCE,FSTYPE','--mountpoint',mount],{timeout:2000,maxBuffer:8192}),
      realpath(alias),statfs(mount,{bigint:true}),
    ]);
    const fields=found.stdout.trim().split(/\s+/);
    if(fields.length!==2 || fields[1]!=='ext4' || await realpath(fields[0])!==mapped) return false;
    const bytes=stats.blocks*stats.bsize,free=stats.bavail*stats.bsize,mib=1024n*1024n;
    return bytes>=512n*mib && bytes<=2048n*mib && free>=128n*mib;
  } catch {return false;}
}
export async function sampleHost() {
  const [meminfo,expectedSwap,sshActive,scratchReady]=await Promise.all([
    readFile('/proc/meminfo','utf8'),activeSwapIsExpected(),
    run('/usr/bin/systemctl',['is-active','--quiet','ssh.service'],{timeout:2000,maxBuffer:8192}).then(()=>true,()=>false),
    scratchIsExpected(),
  ]);
  return {meminfo,expectedSwap,sshActive,scratchReady};
}
export async function supervise(sample,notify,wait,heartbeat) {
  assessSplitSnapshot(await sample()); await notify();
  for(;;) {await wait(LIMITS.pollMs); assessSplitSnapshot(await sample()); await heartbeat();}
}
async function main() {
  await supervise(sampleHost,
    async()=>{await run('/usr/bin/systemd-notify',['--ready','--status=Split worker guard ready'],{timeout:2000,maxBuffer:8192});},
    ms=>new Promise(done=>setTimeout(done,ms)),
    async()=>{await run('/usr/bin/systemd-notify',['WATCHDOG=1'],{timeout:2000,maxBuffer:8192});});
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(()=>{console.error('Split worker guard lost required resources; worker must stop.');process.exitCode=1;});
