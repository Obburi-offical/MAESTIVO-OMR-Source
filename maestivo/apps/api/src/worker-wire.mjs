// Experimental byte-only IPC. This module does not provide an OS sandbox and
// must not be used to enable production OMR without a separately verified one.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { isAbsolute, resolve } from 'node:path';

const MAX_PDF = 20 * 1024 * 1024;
const MAX_RESULT = 16 * 1024 * 1024;
const REQUEST_HEADER = 40;
const RESPONSE_HEADER = 9;
const digest = bytes => createHash('sha256').update(bytes).digest();

function requestFrame(pdf) {
  if (!Buffer.isBuffer(pdf) || pdf.length < 5 || pdf.length > MAX_PDF || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('INVALID_INPUT');
  const header = Buffer.alloc(REQUEST_HEADER);
  header.write('MOW1'); header.writeUInt32BE(pdf.length, 4); digest(pdf).copy(header, 8);
  return Buffer.concat([header, pdf]);
}
function responseFrame(code, body = Buffer.alloc(0)) {
  const header = Buffer.alloc(RESPONSE_HEADER);
  header.write('MOR1'); header.writeUInt8(code, 4); header.writeUInt32BE(body.length, 5);
  return Buffer.concat([header, body]);
}

// The caller must arrange an existing, trusted socket directory. Never unlink a
// pre-existing path: a second server must fail rather than replacing a socket.
export async function createWorkerServer({ socketPath, handlePdf, deadlineMs = 120000, shutdownTimeoutMs = 12000 }) {
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath) || resolve(socketPath) !== socketPath || socketPath.includes('\0') || typeof handlePdf !== 'function' || !Number.isInteger(deadlineMs) || deadlineMs < 1 || !Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 15000) throw new Error('INVALID_CONFIGURATION');
  let busy = false, closing = false, shutdown;
  const sockets = new Set(), handlers = new Set();
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (closing) { socket.destroy(); return; }
    if (busy) { socket.on('error', () => {}); socket.end(responseFrame(2), () => socket.destroy()); return; }
    busy = true;
    // Admission is acknowledged before the client sends PDF bytes. This lets
    // it distinguish a busy worker even for large requests.
    socket.write(responseFrame(4));
    const header = Buffer.alloc(REQUEST_HEADER);
    let headerUsed = 0, pdf, pdfUsed = 0, started = false, completed = false;
    const controller = new AbortController();
    let released = false, workerSettled = false, socketClosed = false;
    const release = () => {
      if (!released && socketClosed && (!started || workerSettled)) {
        released = true; busy = false; clearTimeout(timer);
      }
    };
    const close = () => { controller.abort(); socket.destroy(); };
    const timer = setTimeout(close, deadlineMs); timer.unref();
    socket.on('error', close);
    socket.on('close', () => { socketClosed = true; if (!completed) controller.abort(); release(); });
    const processRequest = async () => {
      if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) || !timingSafeEqual(header.subarray(8, 40), digest(pdf))) return close();
      started = true;
      try {
        const output = await handlePdf(pdf, controller.signal);
        if (!Buffer.isBuffer(output) || output.length > MAX_RESULT) throw new Error('INVALID_OUTPUT');
        // Finish the whole socket after the frame is flushed. A half-open
        // connection can make Linux nc wait for the client's stdin EOF while
        // the client waits for worker EOF, deadlocking the SSH relay.
        if (!controller.signal.aborted && !socket.destroyed) { completed = true; socket.end(responseFrame(0, output), () => socket.destroy()); }
      } catch {
        if (!controller.signal.aborted && !socket.destroyed) { completed = true; socket.end(responseFrame(1), () => socket.destroy()); }
      } finally { workerSettled = true; release(); }
    };
    socket.on('data', chunk => {
      if (started) return close();
      let offset = 0;
      if (headerUsed < REQUEST_HEADER) {
        const n = Math.min(REQUEST_HEADER - headerUsed, chunk.length);
        chunk.copy(header, headerUsed, 0, n); headerUsed += n; offset += n;
      }
      if (headerUsed === REQUEST_HEADER && pdf === undefined) {
        const bytes = header.readUInt32BE(4);
        if (!header.subarray(0, 4).equals(Buffer.from('MOW1')) || bytes < 5 || bytes > MAX_PDF) return close();
        pdf = Buffer.alloc(bytes);
      }
      if (pdf !== undefined) {
        const n = chunk.length - offset;
        if (n > pdf.length - pdfUsed) return close();
        chunk.copy(pdf, pdfUsed, offset); pdfUsed += n;
        if (pdfUsed === pdf.length) {
          const handler = processRequest();
          handlers.add(handler);
          void handler.finally(() => handlers.delete(handler));
        }
      }
    });
    // Keep the sender's write side open until it has received a result, so a
    // disconnect is observable even while the worker is still computing.
    socket.once('end', close);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
  });
  // Do not expose listen() to callers: this boundary must remain a Unix socket.
  return { close: () => {
    if (shutdown) return shutdown;
    closing = true;
    const serverClosed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    // Stop admitting work and abort idle and active clients. Socket closure
    // aborts the handler; wait for its cleanup before the service may exit.
    for (const socket of sockets) socket.destroy();
    const drained = Promise.all([serverClosed, ...handlers]);
    shutdown = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WORKER_SHUTDOWN_TIMEOUT')), shutdownTimeoutMs);
      drained.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
    });
    return shutdown;
  } };
}

// The adapter must independently validate and sanitize any OMR output.
export function exchangePdf({ socketPath, pdf, signal, deadlineMs = 120000 }) {
  const request = requestFrame(pdf);
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath) || resolve(socketPath) !== socketPath || socketPath.includes('\0') || !Number.isInteger(deadlineMs) || deadlineMs < 1) throw new Error('INVALID_CONFIGURATION');
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('CANCELLED'));
    const socket = createConnection({ path: socketPath, allowHalfOpen: true });
    const header = Buffer.alloc(RESPONSE_HEADER);
    let headerUsed = 0, body, bodyUsed = 0, done = false, ready = false;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new Error('CANCELLED'));
    const timer = setTimeout(() => finish(new Error('TIMEOUT')), deadlineMs); timer.unref();
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('connect', () => {});
    socket.on('error', () => finish(new Error('WORKER_UNAVAILABLE')));
    socket.on('data', chunk => {
      let offset = 0;
      if (headerUsed < RESPONSE_HEADER) {
        const n = Math.min(RESPONSE_HEADER - headerUsed, chunk.length);
        chunk.copy(header, headerUsed, 0, n); headerUsed += n; offset += n;
      }
      if (headerUsed === RESPONSE_HEADER && !ready) {
        const code = header.readUInt8(4), size = header.readUInt32BE(5);
        if (!header.subarray(0, 4).equals(Buffer.from('MOR1')) || size !== 0 || offset !== chunk.length) return finish(new Error('INVALID_RESPONSE'));
        if (code === 2) return finish(new Error('WORKER_BUSY'));
        if (code !== 4) return finish(new Error('INVALID_RESPONSE'));
        ready = true; headerUsed = 0; socket.write(request); return;
      }
      if (headerUsed === RESPONSE_HEADER && body === undefined) {
        const size = header.readUInt32BE(5);
        if (!header.subarray(0, 4).equals(Buffer.from('MOR1')) || size > MAX_RESULT) return finish(new Error('INVALID_RESPONSE'));
        body = Buffer.alloc(size);
      }
      if (body !== undefined) {
        const n = chunk.length - offset;
        if (n > body.length - bodyUsed) return finish(new Error('INVALID_RESPONSE'));
        chunk.copy(body, bodyUsed, offset); bodyUsed += n;
      }
    });
    socket.on('end', () => {
      if (body === undefined || bodyUsed !== body.length) return finish(new Error('INVALID_RESPONSE'));
      const code = header.readUInt8(4);
      if (code !== 0 || body.length === 0) return finish(new Error(code === 2 ? 'WORKER_BUSY' : 'WORKER_FAILED'));
      finish(null, body);
    });
    socket.on('close', () => { if (!done) finish(new Error('WORKER_UNAVAILABLE')); });
  });
}
