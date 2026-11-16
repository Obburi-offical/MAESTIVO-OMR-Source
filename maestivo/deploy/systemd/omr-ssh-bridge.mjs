// Isolated research candidate: uninstalled and never a release approval.
// The remote SSH account must have forwarding disabled and a fixed
// ForceCommand connected to the worker Unix socket. No shell is requested.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const absolute = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && !value.includes('\0');
export function privateAddress(value) {
  if (typeof value !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
  const parts=value.split('.'), n=parts.map(Number);
  return n.every((x,i)=>x>=0 && x<=255 && String(x)===parts[i]) && (n[0]===10 || (n[0]===172 && n[1]>=16 && n[1]<=31) || (n[0]===192 && n[1]===168));
}
export function sshArguments({host, user, port, keyPath, knownHosts}) {
  if (!privateAddress(host) || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || !Number.isInteger(port) || port<1 || port>65535 || !absolute(keyPath) || !absolute(knownHosts) || /\s/.test(keyPath) || /\s/.test(knownHosts)) throw Error('INVALID_BRIDGE_CONFIGURATION');
  return ['-F','/dev/null','-T','-p',String(port),'-i',keyPath,
    '-o','IdentitiesOnly=yes','-o','IdentityAgent=none','-o','BatchMode=yes',
    '-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${knownHosts}`,'-o','GlobalKnownHostsFile=/dev/null',
    '-o','UpdateHostKeys=no','-o','ForwardAgent=no','-o','ForwardX11=no',
    '-o','ClearAllForwardings=yes','-o','ControlMaster=no','-o','PermitLocalCommand=no',
    '-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3','-o','ConnectTimeout=8',
    `${user}@${host}`,'/usr/bin/false'];
}

/** One bounded SSH subprocess per client; no PDF or token is logged. */
export async function createSshBridge({socketPath, sshPath='/usr/bin/ssh', sshArgs, deadlineMs=390000, maxClients=2, spawnSsh=spawn}) {
  if (!absolute(socketPath) || !absolute(sshPath) || !Array.isArray(sshArgs) || !Number.isInteger(deadlineMs) || deadlineMs<1000 || !Number.isInteger(maxClients) || maxClients<1 || maxClients>2) throw Error('INVALID_BRIDGE_CONFIGURATION');
  let active=0, closing=false;
  const children = new Set(), clients = new Set();
  const server = createServer({allowHalfOpen:true}, client => {
    if (closing || active>=maxClients) { client.destroy(); return; }
    active++;
    clients.add(client);
    let child, done=false, released=false, remoteEnded=false;
    const release = () => {if(released)return;released=true;active--;if(child)children.delete(child);};
    const finish = () => {
      if (done) return; done=true; clearTimeout(timer); clients.delete(client);
      client.destroy();
      if (child && child.exitCode===null && child.signalCode===null) {
        child.kill('SIGTERM');
        const escalation=setTimeout(()=>{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');},2000);escalation.unref();
      } else if (!child) release();
    };
    const timer=setTimeout(finish,deadlineMs);timer.unref();
    try { child=spawnSsh(sshPath,sshArgs,{stdio:['pipe','pipe','ignore'],shell:false}); }
    catch { finish(); return; }
    children.add(child);
    client.on('error',finish);client.on('close',finish);
    child.stdout.once('end',()=>{remoteEnded=true;});
    child.on('error',()=>{finish();release();});
    child.on('close',()=>{
      release();
      // stdout may have ended while bytes are still queued for the local
      // client. Let the pipe finish flushing before destroying its socket.
      if (!remoteEnded || client.writableFinished) finish();
      else client.once('finish',finish);
    });
    child.stdin.on('error',finish);child.stdout.on('error',finish);
    client.pipe(child.stdin);child.stdout.pipe(client);
  });
  await new Promise((ok,bad)=>{server.once('error',bad);server.listen(socketPath,()=>{server.removeListener('error',bad);ok();});});
  return {close:()=>new Promise((ok,bad)=>{closing=true;for(const client of clients)client.destroy();for(const child of children)child.kill('SIGTERM');server.close(err=>err?bad(err):ok());})};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const env=process.env;
    const sshArgs=sshArguments({host:env.MAESTIVO_BRIDGE_HOST,user:env.MAESTIVO_BRIDGE_USER,port:Number(env.MAESTIVO_BRIDGE_PORT || 22),keyPath:env.MAESTIVO_BRIDGE_KEY,knownHosts:env.MAESTIVO_BRIDGE_KNOWN_HOSTS});
    process.umask(0o117);
    const bridge=await createSshBridge({socketPath:env.MAESTIVO_BRIDGE_SOCKET,sshArgs});
    console.log('MAESTIVO OMR SSH bridge listening on its private Unix socket.');
    let stopped=false;const stop=async()=>{if(stopped)return;stopped=true;try{await bridge.close();process.exit(0)}catch{process.exit(1)}};
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
  } catch { console.error('MAESTIVO OMR SSH bridge failed closed.');process.exit(1); }
}
