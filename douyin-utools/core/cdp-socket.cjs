'use strict';

// Narrow, dependency-free CDP transport for Node 18. Construction hooks are for
// offline tests only; the production class always uses node:net on loopback.
const net = require('node:net');
const { Buffer } = require('node:buffer');
const { URL } = require('node:url');
const { randomBytes, createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const timers = require('node:timers');

const MAX_PAYLOAD = 8 * 1024 * 1024;
const MAX_HTTP_HEADER = 16 * 1024;
const HANDSHAKE_MS = 7000;
const CLOSE_MS = 250;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PUBLIC_ERROR = 'Local CDP WebSocket connection failed.';
const EVENT_TYPES = new Set(['open', 'message', 'error', 'close']);
const EMPTY = Buffer.alloc(0);
const swallow = () => {};

function fixedError(code, message) {
  return Object.assign(new Error(message), { code });
}
function endpoint(input) {
  // Validate the original string too: URL normalizes abbreviated IPv4, escaped
  // paths, default values, dot segments, and empty ?/# markers.
  if (typeof input !== 'string' || !/^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/devtools\/browser\/[A-Za-z0-9_-]{1,100}$/.test(input)) {
    throw fixedError('CDP_INVALID_URL', 'Invalid local CDP WebSocket URL.');
  }
  let url;
  try { url = new URL(input); } catch { throw fixedError('CDP_INVALID_URL', 'Invalid local CDP WebSocket URL.'); }
  // An explicit port 80 is normalized to an empty url.port.
  const port = Number(input.slice('ws://127.0.0.1:'.length).split('/')[0]);
  if (port < 1 || port > 65535 || url.hostname !== '127.0.0.1' || url.protocol !== 'ws:' || url.username || url.password || url.search || url.hash) {
    throw fixedError('CDP_INVALID_URL', 'Invalid local CDP WebSocket URL.');
  }
  return { port, pathname: url.pathname };
}

function acceptFor(key) { return createHash('sha1').update(key + GUID).digest('base64'); }
function validUpgrade(buffer, key) {
  const text = buffer.toString('latin1');
  if (/[^\x09\x0d\x0a\x20-\x7e]/.test(text)) return false;
  const lines = text.slice(0, -4).split('\r\n');
  if (!/^HTTP\/1\.1 101(?: [\x20-\x7e]*)?$/.test(lines.shift() || '')) return false;
  const headers = Object.create(null);
  for (const line of lines) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line);
    if (!match) return false;
    const name = match[1].toLowerCase();
    if (Object.prototype.hasOwnProperty.call(headers, name)) return false;
    headers[name] = match[2].trim();
  }
  const connection = String(headers.connection || '').split(',').map(value => value.trim().toLowerCase());
  return String(headers.upgrade || '').toLowerCase() === 'websocket' &&
    connection.length > 0 && connection.every(value => /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(value)) && connection.includes('upgrade') &&
    headers['sec-websocket-accept'] === acceptFor(key) &&
    !Object.prototype.hasOwnProperty.call(headers, 'sec-websocket-extensions') &&
    !Object.prototype.hasOwnProperty.call(headers, 'sec-websocket-protocol') &&
    !Object.prototype.hasOwnProperty.call(headers, 'transfer-encoding') &&
    (!Object.prototype.hasOwnProperty.call(headers, 'content-length') || headers['content-length'] === '0');
}
function utf8(buffer) { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
function validCloseCode(code) {
  return (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999);
}
function clientFrame(opcode, payload) {
  const length = payload.length;
  const extra = length < 126 ? 0 : length <= 65535 ? 2 : 8;
  const output = Buffer.allocUnsafe(2 + extra + 4 + length);
  output[0] = 0x80 | opcode;
  output[1] = 0x80 | (extra === 0 ? length : extra === 2 ? 126 : 127);
  if (extra === 2) output.writeUInt16BE(length, 2);
  if (extra === 8) output.writeBigUInt64BE(BigInt(length), 2);
  const mask = randomBytes(4);
  mask.copy(output, 2 + extra);
  for (let i = 0; i < length; i++) output[6 + extra + i] = payload[i] ^ mask[i & 3];
  return output;
}

function createLocalWebSocket(factory = {}) {
  if (typeof factory === 'function') factory = { connect: factory };
  if (!factory || typeof factory !== 'object' || Array.isArray(factory)) {
    throw fixedError('CDP_INVALID_FACTORY', 'Invalid local CDP WebSocket factory.');
  }
  const { connect = options => net.createConnection(options), setTimeout: setTimer = timers.setTimeout, clearTimeout: clearTimer = timers.clearTimeout } = factory;
  if (typeof connect !== 'function' || typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw fixedError('CDP_INVALID_FACTORY', 'Invalid local CDP WebSocket factory.');
  }
  return class LocalWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    get CONNECTING() { return 0; }
    get OPEN() { return 1; }
    get CLOSING() { return 2; }
    get CLOSED() { return 3; }
    get readyState() { return this._state; }

    constructor(wsUrl) {
      const target = endpoint(wsUrl);
      this._state = 0;
      this._listeners = new Map();
      this._socket = null;
      this._timer = null;
      this._handshake = EMPTY;
      this._header = EMPTY;
      this._frame = null;
      this._fragment = null;
      this._fragmentBytes = 0;
      this._failed = false;
      this._receivedClose = false;
      this._closeCode = 1006;
      this._bindings = null;
      this._key = randomBytes(16).toString('base64');
      this._timer = setTimer(() => this._fail(), HANDSHAKE_MS);
      try {
        const socket = connect({ host: '127.0.0.1', port: target.port });
        if (!socket || ['on', 'removeListener', 'write', 'end', 'destroy'].some(name => typeof socket[name] !== 'function')) {
          throw fixedError('CDP_INVALID_FACTORY', 'Invalid local CDP WebSocket factory.');
        }
        this._socket = socket;
        const handlers = {
          connect: () => {
            if (this._state !== 0) return;
            const request = `GET ${target.pathname} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${this._key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
            try { socket.write(request); } catch { this._fail(); }
          },
          data: data => {
            try { this._data(data); } catch { this._fail(); }
          },
          error: () => this._fail(),
          end: () => {
            if (this._state === 2) this._finish(this._receivedClose ? this._closeCode : 1006);
            else this._fail();
          },
          close: () => {
            if (this._state === 2) this._finish(this._receivedClose ? this._closeCode : 1006);
            else if (this._state !== 3) this._fail();
          },
        };
        this._bindings = handlers;
        for (const [name, callback] of Object.entries(handlers)) socket.on(name, callback);
      } catch {
        // Constructor-side socket errors must not escape with OS details, and
        // subscribers must have an opportunity to attach their error listener.
        queueMicrotask(() => this._fail());
      }
    }

    addEventListener(type, callback, options) {
      if (!EVENT_TYPES.has(type) || typeof callback !== 'function') return;
      if (!this._listeners.has(type)) this._listeners.set(type, new Map());
      const list = this._listeners.get(type);
      if (!list.has(callback)) list.set(callback, { once: !!(options && options.once) });
    }
    removeEventListener(type, callback) {
      const list = this._listeners.get(type);
      if (list) list.delete(callback);
    }
    _emit(type, fields = {}) {
      const list = this._listeners.get(type);
      if (!list) return;
      const event = Object.freeze({ type, target: this, ...fields });
      for (const [callback, options] of [...list.entries()]) {
        if (!list.has(callback)) continue;
        if (options.once) list.delete(callback);
        try { callback.call(this, event); } catch { /* Listener failures never affect transport state. */ }
      }
    }
    _clearTimer() {
      if (this._timer !== null) { clearTimer(this._timer); this._timer = null; }
    }
    _closingTimer() {
      if (this._timer === null) this._timer = setTimer(() => this._finish(this._receivedClose ? this._closeCode : 1006), CLOSE_MS);
    }
    _finish(code) {
      if (this._state === 3) return;
      this._state = 3;
      this._clearTimer();
      this._handshake = this._header = EMPTY;
      this._frame = this._fragment = null;
      this._fragmentBytes = 0;
      const socket = this._socket;
      this._socket = null;
      if (socket) {
        if (this._bindings) {
          for (const [name, callback] of Object.entries(this._bindings)) socket.removeListener(name, callback);
        }
        // A raw Socket can still deliver an already-queued error after destroy.
        // This inert listener retains neither this object nor private data.
        socket.on('error', swallow);
        try { socket.destroy(); } catch { /* Fixed public state already closed. */ }
      }
      this._bindings = null;
      this._emit('close', { code, reason: '', wasClean: this._receivedClose && code !== 1006 });
      this._listeners.clear();
    }
    _fail() {
      if (this._state === 3 || this._failed) return;
      this._failed = true;
      this._state = 2;
      const error = fixedError('CDP_SOCKET_ERROR', PUBLIC_ERROR);
      this._emit('error', { code: error.code, message: PUBLIC_ERROR, error });
      this._finish(1006);
    }
    _write(opcode, payload) {
      if (!this._socket || this._state === 3) return false;
      try { this._socket.write(clientFrame(opcode, payload)); return true; }
      catch { this._fail(); return false; }
    }
    send(text) {
      if (typeof text !== 'string') throw fixedError('CDP_INVALID_DATA', 'Local CDP messages must be text.');
      if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD) throw fixedError('CDP_INVALID_DATA', 'Local CDP message is too large.');
      if (this._state !== 1) throw fixedError('CDP_NOT_OPEN', 'Local CDP WebSocket is not open.');
      this._write(1, Buffer.from(text, 'utf8'));
    }
    close() {
      if (this._state === 2 || this._state === 3) return;
      if (this._state === 0) { this._state = 2; this._finish(1006); return; }
      this._state = 2;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(1000);
      if (this._write(8, payload)) this._closingTimer();
    }

    _data(data) {
      if (this._state === 3 || this._receivedClose) return;
      if (!Buffer.isBuffer(data)) { this._fail(); return; }
      if (this._state === 0) {
        const previous = this._handshake.length;
        const prefix = data.subarray(0, MAX_HTTP_HEADER - previous);
        const head = Buffer.concat([this._handshake, prefix]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) {
          if (head.length >= MAX_HTTP_HEADER) this._fail();
          else this._handshake = head;
          return;
        }
        const headerLength = end + 4;
        if (!validUpgrade(head.subarray(0, headerLength), this._key)) { this._fail(); return; }
        this._handshake = EMPTY;
        this._state = 1;
        this._clearTimer();
        this._emit('open');
        if (this._state === 3) return;
        data = data.subarray(headerLength - previous);
      }
      let offset = 0;
      while (offset < data.length && this._state !== 3 && !this._receivedClose) {
        if (!this._frame) {
          const minimum = this._header.length < 2 ? 2 : 2 + ((this._header[1] & 127) === 126 ? 2 : (this._header[1] & 127) === 127 ? 8 : 0);
          const count = Math.min(minimum - this._header.length, data.length - offset);
          if (count > 0) {
            this._header = Buffer.concat([this._header, data.subarray(offset, offset + count)]);
            offset += count;
          }
          if (this._header.length < 2) return;
          const first = this._header[0];
          const second = this._header[1];
          const opcode = first & 15;
          const final = !!(first & 128);
          const lengthTag = second & 127;
          const control = opcode >= 8;
          if ((first & 112) || (second & 128) || ![0, 1, 8, 9, 10].includes(opcode) ||
              (control && (!final || lengthTag > 125))) { this._fail(); return; }
          const needed = 2 + (lengthTag === 126 ? 2 : lengthTag === 127 ? 8 : 0);
          if (this._header.length < needed) continue;
          let length = lengthTag;
          if (lengthTag === 126) length = this._header.readUInt16BE(2);
          if (lengthTag === 127) {
            const big = this._header.readBigUInt64BE(2);
            if (big > BigInt(MAX_PAYLOAD)) { this._fail(); return; }
            length = Number(big);
          }
          if (length > MAX_PAYLOAD || (lengthTag === 126 && length < 126) || (lengthTag === 127 && length < 65536) ||
              (opcode === 0 && !this._fragment) || (opcode === 1 && this._fragment) ||
              (opcode === 0 && this._fragmentBytes + length > MAX_PAYLOAD)) { this._fail(); return; }
          this._frame = { opcode, final, length, received: 0, payload: Buffer.allocUnsafe(length) };
          this._header = EMPTY;
          if (length === 0) {
            const frame = this._frame; this._frame = null;
            this._completeFrame(frame, EMPTY);
            continue;
          }
        }
        const frame = this._frame;
        const count = Math.min(frame.length - frame.received, data.length - offset);
        if (count > 0) {
          data.copy(frame.payload, frame.received, offset, offset + count);
          frame.received += count;
          offset += count;
        }
        if (frame.received === frame.length) {
          this._frame = null;
          this._completeFrame(frame, frame.payload);
        }
      }
    }

    _completeFrame(frame, payload) {
      if (frame.opcode === 9) { this._write(10, payload); return; }
      if (frame.opcode === 10) return;
      if (frame.opcode === 8) {
        if (payload.length === 1) { this._fail(); return; }
        let code = 1005;
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          if (!validCloseCode(code)) { this._fail(); return; }
          try { utf8(payload.subarray(2)); } catch { this._fail(); return; }
        }
        const alreadyClosing = this._state === 2;
        this._receivedClose = true;
        this._closeCode = code;
        this._state = 2;
        this._fragment = null; this._fragmentBytes = 0;
        if (!alreadyClosing && !this._write(8, payload)) return;
        if (this._state === 3) return;
        this._closingTimer();
        try { this._socket.end(); } catch { this._fail(); }
        return;
      }
      if (frame.opcode === 1 && !frame.final) {
        // A fixed bounded accumulator prevents endless empty fragments or
        // one-byte chunks from building an unbounded array of Buffer objects.
        this._fragment = Buffer.allocUnsafe(MAX_PAYLOAD);
        payload.copy(this._fragment);
        this._fragmentBytes = payload.length;
        return;
      }
      if (frame.opcode === 0) {
        payload.copy(this._fragment, this._fragmentBytes);
        this._fragmentBytes += payload.length;
        if (!frame.final) return;
        payload = this._fragment.subarray(0, this._fragmentBytes);
        this._fragment = null; this._fragmentBytes = 0;
      }
      let text;
      try { text = utf8(payload); } catch { this._fail(); return; }
      if (this._state === 1) this._emit('message', { data: text });
    }
  };
}

const LocalWebSocket = createLocalWebSocket();
module.exports = { LocalWebSocket, createLocalWebSocket };
