import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkerServer, exchangePdf } from './worker-wire.mjs';

const pdf = Buffer.from('%PDF-1.4\n% synthetic fixture\n');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const socketRoot = process.env.MAESTIVO_OMR_TEST_SOCKET_ROOT || tmpdir();
async function fixture(handler, deadlineMs = 1000) {
  const dir = mkdtempSync(join(socketRoot, 'ociw-'));
  const path = join(dir, 's');
  const server = await createWorkerServer({socketPath:path, handlePdf:handler, deadlineMs});
  return {path, close:async () => { await server.close(); rmSync(dir, {recursive:true,force:true}); }};
}
async function raw(path, data) {
  return new Promise((resolve, reject) => {
    const s = createConnection({path, allowHalfOpen:true}); let result = Buffer.alloc(0);
    s.on('connect', () => s.end(data)); s.on('error', reject);
    s.on('data', d => { result = Buffer.concat([result, d]); }); s.on('close', () => resolve(result.subarray(9)));
  });
}
function frame(bytes) {
  const h = Buffer.alloc(40); h.write('MOW1'); h.writeUInt32BE(bytes.length, 4); createHash('sha256').update(bytes).digest().copy(h,8);
  return Buffer.concat([h, bytes]);
}

test('sends digest-checked PDF bytes and returns opaque output', async () => {
  const f=await fixture(async bytes => { assert.deepEqual(bytes, pdf); return Buffer.from('<score/>'); });
  try { assert.equal((await exchangePdf({socketPath:f.path,pdf})).toString(), '<score/>'); } finally { await f.close(); }
});
test('refuses changed, truncated, trailing and malformed input before the handler', async () => {
  let calls=0; const f=await fixture(async () => { calls++; return Buffer.from('bad'); });
  try {
    const corrupt=frame(pdf); corrupt[8] ^= 1;
    for (const bad of [corrupt, frame(pdf).subarray(0,-1), Buffer.concat([frame(pdf),Buffer.from('x')]), Buffer.alloc(40)]) assert.equal((await raw(f.path,bad)).length,0);
    assert.equal(calls,0);
    assert.throws(() => exchangePdf({socketPath:f.path,pdf:Buffer.from('not-pdf')}), /INVALID_INPUT/);
  } finally { await f.close(); }
});
test('keeps single-worker admission occupied through cancellation until handler settles', async () => {
  let started; const active = new Promise(resolve => { started=resolve; });
  let release; const wait = new Promise(resolve => { release=resolve; });
  const f=await fixture(async (_bytes,signal) => { started(); await wait; assert.equal(signal.aborted,true); return Buffer.from('ignored'); });
  try {
    const controller=new AbortController(); const first=exchangePdf({socketPath:f.path,pdf,signal:controller.signal});
    await active; controller.abort(); await assert.rejects(first,/CANCELLED/);
    await assert.rejects(exchangePdf({socketPath:f.path,pdf}), /WORKER_BUSY|WORKER_UNAVAILABLE/);
    release(); await pause(50);
  } finally { release(); await f.close(); }
});
test('client deadline aborts processing and admission stays occupied until cleanup settles', async () => {
  let started; const active = new Promise(resolve => { started=resolve; });
  let aborted; const cancellation = new Promise(resolve => { aborted=resolve; });
  let release; const wait = new Promise(resolve => { release=resolve; });
  const f=await fixture(async (_bytes,signal) => {
    started(); signal.addEventListener('abort', aborted, {once:true}); await wait;
    return Buffer.from('ignored');
  },2000);
  try {
    const first=exchangePdf({socketPath:f.path,pdf,deadlineMs:100});
    await active; await assert.rejects(first,/TIMEOUT/); await cancellation;
    await assert.rejects(exchangePdf({socketPath:f.path,pdf}), /WORKER_BUSY|WORKER_UNAVAILABLE/);
    release(); await pause(50);
  } finally { release(); await f.close(); }
});
test('expires unfinished input without invoking handler and recovers admission', async () => {
  let calls=0; const f=await fixture(async()=>{calls++;return Buffer.from('ok');},120);
  try {
    const s=createConnection(f.path);s.on('error',()=>{});s.resume();await new Promise(resolve=>s.once('connect',resolve));
    const closed=new Promise(resolve=>s.once('close',resolve));s.write(frame(pdf).subarray(0,42));await closed;
    assert.equal(calls,0);
    assert.equal((await exchangePdf({socketPath:f.path,pdf,deadlineMs:2000})).toString(),'ok');
  } finally { await f.close(); }
});
test('holds admission and deadline when a client refuses to read the response', async () => {
  let calls=0, started; const active=new Promise(resolve=>{started=resolve;});
  const f=await fixture(async()=>{calls++;started();return calls === 1 ? Buffer.alloc(4*1024*1024,7) : Buffer.from('ok');},200);
  const s=createConnection(f.path);s.on('error',()=>{});
  try {
    await new Promise(resolve=>s.once('connect',resolve));s.write(frame(pdf));await active;
    await assert.rejects(exchangePdf({socketPath:f.path,pdf}),/WORKER_BUSY|WORKER_UNAVAILABLE/);
    await pause(300);
    assert.equal((await exchangePdf({socketPath:f.path,pdf,deadlineMs:2000})).toString(),'ok');
    assert.equal(calls,2);
  } finally {s.destroy();await f.close();}
});
test('does not leak a worker failure or accept an oversized result', async () => {
  for (const handler of [async()=>{throw new Error('secret');}, async()=>Buffer.alloc(16*1024*1024+1)]) {
    const f=await fixture(handler);
    try { await assert.rejects(exchangePdf({socketPath:f.path,pdf}), /^Error: WORKER_FAILED$/); } finally { await f.close(); }
  }
});
test('releases busy admission after both a finished result and a worker failure', async () => {
  let calls=0;
  const f=await fixture(async()=>{ if(++calls === 1) throw new Error('private failure'); return Buffer.from('recovered'); });
  try {
    await assert.rejects(exchangePdf({socketPath:f.path,pdf}),/^Error: WORKER_FAILED$/);
    await pause(30);
    assert.equal((await exchangePdf({socketPath:f.path,pdf})).toString(),'recovered');
    await pause(30);
    assert.equal((await exchangePdf({socketPath:f.path,pdf})).toString(),'recovered');
  } finally { await f.close(); }
});
test('rejects a declared oversize body before handing any input to the worker', async () => {
  let calls=0; const f=await fixture(async()=>{calls++;return Buffer.from('bad');});
  try {
    const header=Buffer.alloc(40);header.write('MOW1');header.writeUInt32BE(20*1024*1024+1,4);
    assert.equal((await raw(f.path,header)).length,0);assert.equal(calls,0);
  } finally {await f.close();}
});
test('client refuses forged oversized or trailing worker replies', async () => {
  const dir=mkdtempSync(join(socketRoot,'ociw-'));const path=join(dir,'s');
  const server=createServer({allowHalfOpen:true}, s=>{ const ready=Buffer.alloc(9); ready.write('MOR1'); ready.writeUInt8(4,4); s.write(ready); s.once('data',()=>{const h=Buffer.alloc(10);h.write('MOR1');h.writeUInt32BE(1,5);h[9]=1;s.end(Buffer.concat([h,Buffer.from('x')]));}); });
  await new Promise(resolve=>server.listen(path,resolve));
  try { await assert.rejects(exchangePdf({socketPath:path,pdf}),/INVALID_RESPONSE/); }
  finally {await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true});}
});
test('client rejects trailing response bytes delivered after the declared result', async () => {
  const dir=mkdtempSync(join(socketRoot,'ociw-')), path=join(dir,'s');
  const server=createServer({allowHalfOpen:true}, s=>{
    const ready=Buffer.alloc(9); ready.write('MOR1'); ready.writeUInt8(4,4); s.write(ready);
    s.once('data',()=>{
      const reply=Buffer.alloc(10); reply.write('MOR1'); reply.writeUInt32BE(1,5); reply[9]=1;
      s.write(reply); setTimeout(()=>s.end(Buffer.from('x')),30);
    });
  });
  await new Promise(resolve=>server.listen(path,resolve));
  try { await assert.rejects(exchangePdf({socketPath:path,pdf}),/INVALID_RESPONSE/); }
  finally {await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true});}
});

test('worker shutdown closes an admitted idle socket and is idempotent', async () => {
  const f=await fixture(async()=>Buffer.from('unused'),10000);
  const socket=createConnection({path:f.path});
  socket.on('error',()=>{});
  try {
    const ready=await new Promise((resolve,reject)=>{socket.once('data',resolve);socket.once('error',reject);});
    assert.equal(ready.readUInt8(4),4);
    const closed=new Promise(resolve=>socket.once('close',resolve));
    const first=f.close(), second=f.close();
    await Promise.all([first,second,closed]);
  } finally {socket.destroy();}
});

test('worker shutdown aborts an active handler and waits for its cleanup', async () => {
  let started,aborted,release,settled=false;
  const active=new Promise(resolve=>{started=resolve;});
  const cancellation=new Promise(resolve=>{aborted=resolve;});
  const cleanup=new Promise(resolve=>{release=resolve;});
  const f=await fixture(async(_pdf,signal)=>{
    started(); signal.addEventListener('abort',aborted,{once:true});
    await cleanup; settled=true; return Buffer.from('ignored');
  },10000);
  const client=exchangePdf({socketPath:f.path,pdf,deadlineMs:10000});
  const clientClosed=assert.rejects(client,/WORKER_UNAVAILABLE|INVALID_RESPONSE/);
  try {
    await active;
    let closed=false;
    const stopping=f.close().then(()=>{closed=true;});
    await cancellation;
    await pause(30);
    assert.equal(closed,false);
    assert.equal(settled,false);
    await assert.rejects(exchangePdf({socketPath:f.path,pdf,deadlineMs:1000}), /WORKER_UNAVAILABLE/);
    release();
    await stopping;
    await clientClosed;
    assert.equal(settled,true);
  } finally {release(); await clientClosed;}
});

test('worker shutdown times out rather than falsely claiming handler cleanup', async () => {
  const dir=mkdtempSync(join(socketRoot,'ociw-')),path=join(dir,'s');
  let started,release;
  const active=new Promise(resolve=>{started=resolve;});
  const held=new Promise(resolve=>{release=resolve;});
  const server=await createWorkerServer({socketPath:path,deadlineMs:10000,shutdownTimeoutMs:80,handlePdf:async()=>{started();await held;return Buffer.from('late');}});
  const client=exchangePdf({socketPath:path,pdf,deadlineMs:10000});
  const clientClosed=assert.rejects(client,/WORKER_UNAVAILABLE|INVALID_RESPONSE/);
  try {
    await active;
    const stopping=server.close();
    assert.equal(stopping,server.close());
    await assert.rejects(stopping,/WORKER_SHUTDOWN_TIMEOUT/);
    await clientClosed;
  } finally {release();await pause(30);rmSync(dir,{recursive:true});}
});
