'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Buffer } = require('node:buffer');
const { createHash } = require('node:crypto');
const { LocalWebSocket, createLocalWebSocket } = require('../core/cdp-socket.cjs');

const URL_VALUE = 'ws://127.0.0.1:9222/devtools/browser/test-CDP_1';
const MAX = 8 * 1024 * 1024;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
class Clock {
  constructor() { this.now = 0; this.next = 1; this.pending = new Map(); }
  setTimeout(callback, milliseconds) {
    const id = this.next++;
    this.pending.set(id, { callback, due: this.now + milliseconds });
    return id;
  }
  clearTimeout(id) { this.pending.delete(id); }
  advance(milliseconds) {
    const until = this.now + milliseconds;
    while (true) {
      const ready = [...this.pending.entries()].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
      if (!ready) break;
      this.now = ready[1].due; this.pending.delete(ready[0]); ready[1].callback();
    }
    this.now = until;
  }
}
class MockSocket extends EventEmitter {
  constructor() { super(); this.writes = []; this.destroyed = false; this.destroyCount = 0; this.ended = false; this.throwWrite = false; }
  write(data) {
    if (this.throwWrite) throw new Error('SECRET bottom-level URL ws://private.invalid/secret');
    this.writes.push(Buffer.from(data));
    return true;
  }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; this.destroyCount++; this.emit('close'); }
}
function fixture(t, { connect } = {}) {
  const clock = new Clock();
  const raw = new MockSocket();
  const calls = [];
  const Socket = createLocalWebSocket({ connect: options => { calls.push(options); return connect ? connect(raw) : raw; },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: id => clock.clearTimeout(id) });
  const ws = new Socket(URL_VALUE);
  const events = { open: [], message: [], error: [], close: [] };
  for (const name of Object.keys(events)) ws.addEventListener(name, event => events[name].push(event));
  t.after(() => { ws.close(); clock.advance(1000); assert.equal(clock.pending.size, 0); });
  function request() { raw.emit('connect'); return raw.writes[0].toString('ascii'); }
  function response(changes = {}) {
    const requestText = raw.writes[0].toString('ascii');
    const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(requestText)[1];
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    const headers = {
      Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Accept': accept, ...changes,
    };
    return Buffer.from(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(headers).filter(([, value]) => value !== null).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`, 'ascii');
  }
  function open() { request(); raw.emit('data', response()); assert.equal(ws.readyState, 1); }
  return { clock, raw, calls, Socket, ws, events, request, response, open };
}
function frame(opcode, value = '', { final = true, masked = false, rsv = 0, tag } = {}) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = payload.length;
  const lengthTag = tag == null ? length < 126 ? length : length <= 65535 ? 126 : 127 : tag;
  const extra = lengthTag === 126 ? 2 : lengthTag === 127 ? 8 : 0;
  const header = Buffer.alloc(2 + extra + (masked ? 4 : 0));
  header[0] = (final ? 128 : 0) | rsv | opcode;
  header[1] = (masked ? 128 : 0) | lengthTag;
  if (extra === 2) header.writeUInt16BE(length, 2);
  if (extra === 8) header.writeBigUInt64BE(BigInt(length), 2);
  if (masked) {
    const mask = Buffer.from([1, 2, 3, 4]); mask.copy(header, 2 + extra);
    const output = Buffer.from(payload);
    for (let i = 0; i < output.length; i++) output[i] ^= mask[i & 3];
    return Buffer.concat([header, output]);
  }
  return Buffer.concat([header, payload]);
}
function unpack(buffer) {
  const opcode = buffer[0] & 15;
  const masked = !!(buffer[1] & 128);
  const tag = buffer[1] & 127;
  let length = tag;
  let offset = 2;
  if (tag === 126) { length = buffer.readUInt16BE(2); offset += 2; }
  if (tag === 127) { length = Number(buffer.readBigUInt64BE(2)); offset += 8; }
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  const data = Buffer.from(buffer.subarray(offset));
  if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
  assert.equal(data.length, length);
  return { opcode, masked, tag, data, mask };
}
function assertFailed(f) {
  assert.equal(f.ws.readyState, 3);
  assert.equal(f.events.error.length, 1);
  assert.equal(f.events.error[0].message, 'Local CDP WebSocket connection failed.');
  assert.equal(f.events.error[0].error.message, 'Local CDP WebSocket connection failed.');
  assert.equal(f.events.error[0].error.code, 'CDP_SOCKET_ERROR');
  assert.equal(f.events.close.length, 1);
  assert.equal(f.events.close[0].code, 1006);
  assert.equal(f.raw.destroyed, true);
  assert.equal(f.clock.pending.size, 0);
}

const badUrls = [
  '', null, {}, 'http://127.0.0.1:9222/devtools/browser/id', 'wss://127.0.0.1:9222/devtools/browser/id',
  'ws://localhost:9222/devtools/browser/id', 'ws://[::1]:9222/devtools/browser/id',
  'ws://127.1:9222/devtools/browser/id', 'ws://2130706433:9222/devtools/browser/id',
  'ws://127.0.0.2:9222/devtools/browser/id', 'ws://192.168.1.2:9222/devtools/browser/id',
  'ws://user:secret@127.0.0.1:9222/devtools/browser/id',
  'ws://127.0.0.1/devtools/browser/id', 'ws://127.0.0.1:0/devtools/browser/id',
  'ws://127.0.0.1:65536/devtools/browser/id', 'ws://127.0.0.1:099/devtools/browser/id',
  'ws://127.0.0.1:9222/devtools/page/id', 'ws://127.0.0.1:9222/devtools/browser/',
  `ws://127.0.0.1:9222/devtools/browser/${'a'.repeat(101)}`,
  `${URL_VALUE}?token=secret`, `${URL_VALUE}?`, `${URL_VALUE}#secret`, `${URL_VALUE}#`,
  `${URL_VALUE}/`, `${URL_VALUE}%20`, `${URL_VALUE}\r\nCookie: secret`, ` ${URL_VALUE}`,
  'ws://127.0.0.1:9222/devtools/page/../browser/id',
];
test('constructor enforces exact literal loopback URL and sanitized synchronous errors without connecting', () => {
  let connections = 0;
  const Socket = createLocalWebSocket({ connect() { connections++; throw new Error('must not run'); } });
  for (const value of badUrls) assert.throws(() => new Socket(value), error => error.code === 'CDP_INVALID_URL' && error.message === 'Invalid local CDP WebSocket URL.');
  for (const value of badUrls) assert.throws(() => new LocalWebSocket(value), { code: 'CDP_INVALID_URL' });
  assert.equal(connections, 0);
});

test('accepts boundary ports and 100-character browser IDs without normalization ambiguity', () => {
  for (const port of [1, 80, 65535]) {
    const clock = new Clock(); const raw = new MockSocket(); const calls = [];
    const Socket = createLocalWebSocket({ connect: options => { calls.push(options); return raw; }, setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: id => clock.clearTimeout(id) });
    const ws = new Socket(`ws://127.0.0.1:${port}/devtools/browser/${'a'.repeat(100)}`);
    assert.deepEqual(calls[0], { host: '127.0.0.1', port }); ws.close();
    assert.equal(ws.readyState, 3); assert.equal(clock.pending.size, 0);
  }
});

test('factory supports a bare offline connect callback and rejects malformed hooks', () => {
  const raw = new MockSocket(); const calls = [];
  const Socket = createLocalWebSocket(options => { calls.push(options); return raw; });
  const ws = new Socket(URL_VALUE); ws.close();
  assert.deepEqual(calls, [{ host: '127.0.0.1', port: 9222 }]); assert.equal(raw.destroyed, true);
  for (const factory of [null, false, 1, [], { connect: null }, { setTimeout: null }, { clearTimeout: false }]) {
    assert.throws(() => createLocalWebSocket(factory), { code: 'CDP_INVALID_FACTORY' });
  }
});

test('generates random upgrade keys and validates a correct split HTTP response', t => {
  const a = fixture(t); const b = fixture(t);
  assert.equal(a.ws.readyState, 0);
  const request = a.request(); const other = b.request();
  assert.match(request, /^GET \/devtools\/browser\/test-CDP_1 HTTP\/1\.1\r\n/);
  assert.match(request, /Host: 127\.0\.0\.1:9222\r\n/);
  const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(request)[1];
  assert.equal(Buffer.from(key, 'base64').length, 16);
  assert.notEqual(key, /Sec-WebSocket-Key: (.+)\r\n/.exec(other)[1]);
  assert.equal(/Cookie|Authorization|Origin:|Extensions:/i.test(request), false);
  const response = a.response({ Connection: 'keep-alive, UpGrAdE', Upgrade: 'WebSocket' });
  for (let i = 0; i < response.length; i++) a.raw.emit('data', response.subarray(i, i + 1));
  assert.equal(a.ws.readyState, 1); assert.equal(a.events.open.length, 1); assert.equal(a.clock.pending.size, 0);
  assert.deepEqual(a.calls, [{ host: '127.0.0.1', port: 9222 }]);
});

test('upgrade plus first message in one TCP chunk delivers open before message', t => {
  const f = fixture(t); const order = [];
  f.ws.addEventListener('open', () => order.push('open'));
  f.ws.addEventListener('message', event => order.push(event.data));
  f.request(); f.raw.emit('data', Buffer.concat([f.response(), frame(1, '{"id":1}') ]));
  assert.deepEqual(order, ['open', '{"id":1}']);
});

for (const [name, change] of [
  ['wrong accept', { 'Sec-WebSocket-Accept': 'wrong' }],
  ['missing accept', { 'Sec-WebSocket-Accept': null }],
  ['missing upgrade', { Upgrade: null }],
  ['invalid upgrade', { Upgrade: 'h2c' }],
  ['missing connection token', { Connection: 'keep-alive' }],
  ['malformed connection token', { Connection: 'Upgrade, ' }],
  ['extensions even if empty', { 'Sec-WebSocket-Extensions': '' }],
  ['compression', { 'Sec-WebSocket-Extensions': 'permessage-deflate' }],
  ['unsolicited protocol', { 'Sec-WebSocket-Protocol': 'cdp' }],
  ['body transfer encoding', { 'Transfer-Encoding': 'chunked' }],
  ['HTTP body length', { 'Content-Length': '1' }],
]) {
  test(`rejects handshake ${name}`, t => {
    const f = fixture(t); f.request(); f.raw.emit('data', f.response(change)); assertFailed(f);
  });
}
for (const [name, rewrite] of [
  ['HTTP 200', text => text.replace('101 Switching Protocols', '200 OK')],
  ['HTTP 1.0', text => text.replace('HTTP/1.1', 'HTTP/1.0')],
  ['duplicate header', text => text.replace('\r\n\r\n', '\r\nUpgrade: websocket\r\n\r\n')],
  ['header folding', text => text.replace('\r\nUpgrade:', '\r\n Upgrade:')],
  ['bare LF', text => text.replace('Upgrade: websocket\r\n', 'Upgrade: websocket\n')],
  ['non ASCII', text => text.replace('Upgrade: websocket', 'Upgrade: websock\x80et')],
]) {
  test(`rejects malformed upgrade ${name}`, t => {
    const f = fixture(t); f.request(); f.raw.emit('data', Buffer.from(rewrite(f.response().toString('latin1')), 'latin1')); assertFailed(f);
  });
}

test('HTTP header cap is exactly 16KiB, excludes post-upgrade frame bytes', t => {
  const f = fixture(t); f.request();
  const base = f.response().toString('ascii');
  const line = '\r\nX-Padding: ';
  const padding = 'a'.repeat(16384 - Buffer.byteLength(base) - Buffer.byteLength(line));
  const bounded = base.replace('\r\n\r\n', `${line}${padding}\r\n\r\n`);
  assert.equal(Buffer.byteLength(bounded), 16384);
  f.raw.emit('data', Buffer.concat([Buffer.from(bounded), frame(1, 'x'.repeat(32768))]));
  assert.equal(f.ws.readyState, 1); assert.equal(f.events.message[0].data.length, 32768);
});

test('oversized or unterminated handshake fails without waiting for the deadline', t => {
  const f = fixture(t); f.request();
  f.raw.emit('data', Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nX-Pad: ${'x'.repeat(20000)}\r\n\r\n`));
  assertFailed(f);
});

test('7-second fixed deadline includes connect and is not reset by trickled headers', t => {
  const f = fixture(t); f.request();
  f.clock.advance(3000); f.raw.emit('data', Buffer.from('HTTP/1.1'));
  f.clock.advance(3999); assert.equal(f.ws.readyState, 0);
  f.clock.advance(1); assertFailed(f);
  const g = fixture(t); g.clock.advance(7000); assertFailed(g);
});

for (const size of [0, 125, 126, 65535, 65536, MAX]) {
  test(`outbound text length ${size} uses masked canonical frames`, t => {
    const f = fixture(t); f.open(); const value = 'x'.repeat(size);
    f.ws.send(value);
    const decoded = unpack(f.raw.writes.at(-1));
    assert.equal(decoded.masked, true); assert.equal(decoded.opcode, 1); assert.equal(decoded.data.toString(), value);
    assert.equal(decoded.tag, size < 126 ? size : size <= 65535 ? 126 : 127);
  });
}

test('outbound multibyte strings count UTF8 bytes and send rejects non-text, oversize, and closed state with fixed errors', t => {
  const f = fixture(t);
  assert.throws(() => f.ws.send('before open'), { code: 'CDP_NOT_OPEN' });
  f.open(); f.ws.send('中文😀'); assert.equal(unpack(f.raw.writes.at(-1)).data.toString(), '中文😀');
  for (const value of [null, {}, Buffer.from('binary'), 1]) assert.throws(() => f.ws.send(value), { code: 'CDP_INVALID_DATA' });
  assert.throws(() => f.ws.send('x'.repeat(MAX + 1)), { code: 'CDP_INVALID_DATA' });
  assert.throws(() => f.ws.send('中'.repeat(Math.floor(MAX / 3) + 1)), { code: 'CDP_INVALID_DATA' });
  f.ws.close(); assert.throws(() => f.ws.send('closing'), { code: 'CDP_NOT_OPEN' });
  f.clock.advance(250); assert.throws(() => f.ws.send('closed'), { code: 'CDP_NOT_OPEN' });
});

for (const size of [0, 125, 126, 65535, 65536, MAX]) {
  test(`inbound unmasked text length ${size} handles all length encodings`, t => {
    const f = fixture(t); f.open(); const value = 'a'.repeat(size);
    const incoming = frame(1, value);
    for (let index = 0; index < Math.min(11, incoming.length); index++) f.raw.emit('data', incoming.subarray(index, index + 1));
    if (incoming.length > 11) f.raw.emit('data', incoming.subarray(11));
    assert.equal(f.events.message.length, 1); assert.equal(f.events.message[0].data, value);
  });
}

test('fragmented UTF8 spanning continuation and ping/pong preserves text and BOM', t => {
  const f = fixture(t); f.open();
  const bytes = Buffer.from('\ufeff中文😀');
  f.raw.emit('data', frame(1, bytes.subarray(0, 2), { final: false }));
  f.raw.emit('data', frame(9, 'ping-token'));
  f.raw.emit('data', frame(0, bytes.subarray(2, 6), { final: false }));
  f.raw.emit('data', frame(10, 'ignored-pong'));
  f.raw.emit('data', frame(0, bytes.subarray(6)));
  assert.equal(f.events.message[0].data, '\ufeff中文😀');
  const pong = unpack(f.raw.writes.at(-1)); assert.equal(pong.opcode, 10); assert.equal(pong.masked, true); assert.equal(pong.data.toString(), 'ping-token');
});

test('all TCP partition widths preserve coalesced frames, control interleaving and UTF8 continuations', t => {
  const text = Buffer.from('分片😀');
  const stream = Buffer.concat([frame(1, text.subarray(0, 2), { final: false }), frame(9, 'p'), frame(0, text.subarray(2)), frame(1, ''), frame(1, 'x'.repeat(126)), frame(1, 'end')]);
  for (const width of [1, 2, 3, 7, 19, stream.length]) {
    const f = fixture(t); f.open();
    for (let offset = 0; offset < stream.length; offset += width) f.raw.emit('data', stream.subarray(offset, offset + width));
    assert.deepEqual(f.events.message.map(event => event.data), ['分片😀', '', 'x'.repeat(126), 'end']);
    assert.equal(unpack(f.raw.writes.at(-1)).data.toString(), 'p');
  }
});

test('many coalesced messages and empty continuations do not grow fragment metadata', t => {
  const f = fixture(t); f.open();
  f.raw.emit('data', Buffer.concat([frame(1, '', { final: false }), ...Array.from({ length: 2000 }, () => frame(0, '', { final: false })), frame(0, 'done'), frame(1, 'next')]));
  assert.deepEqual(f.events.message.map(event => event.data), ['done', 'next']);
  assert.equal(f.ws._fragment, null);
});

for (const [name, incoming] of [
  ['server masked frame', frame(1, 'secret', { masked: true })],
  ['binary', frame(2, 'binary')],
  ['reserved data opcode', frame(3, '')],
  ['reserved control opcode', frame(11, '')],
  ['RSV1', frame(1, 'compressed', { rsv: 64 })],
  ['RSV2', frame(1, '', { rsv: 32 })],
  ['RSV3', frame(1, '', { rsv: 16 })],
  ['fragmented control', frame(9, '', { final: false })],
  ['control with extended length', frame(9, Buffer.alloc(126))],
  ['unexpected continuation', frame(0, 'no start')],
  ['new text during fragmented text', Buffer.concat([frame(1, 'start', { final: false }), frame(1, 'invalid')])],
  ['invalid UTF8', frame(1, Buffer.from([0xc0, 0xaf]))],
  ['incomplete UTF8', frame(1, Buffer.from([0xe4, 0xb8]))],
  ['invalid fragmented UTF8', Buffer.concat([frame(1, Buffer.from([0xe4]), { final: false }), frame(0, Buffer.from([0xff]))])],
  ['nonminimal 16-bit length', frame(1, 'a', { tag: 126 })],
  ['nonminimal 64-bit length', frame(1, 'a', { tag: 127 })],
  ['close with length one', frame(8, Buffer.from([0]))],
  ['invalid reserved close code', frame(8, Buffer.from([0x03, 0xed]))],
  ['invalid close reason UTF8', frame(8, Buffer.from([0x03, 0xe8, 0xff]))],
]) {
  test(`protocol error ${name} emits exactly one fixed error and closes`, t => {
    const f = fixture(t); f.open(); f.raw.emit('data', incoming); assertFailed(f);
    f.raw.emit('data', frame(1, 'late')); f.raw.emit('error', new Error('SECRET late failure'));
    f.ws.close(); assert.equal(f.events.error.length, 1); assert.equal(f.events.close.length, 1);
  });
}

test('64-bit oversized/high-bit payload is rejected from its header without allocating the claimed length', t => {
  for (const length of [BigInt(MAX + 1), 0x8000000000000000n, 0xffffffffffffffffn]) {
    const f = fixture(t); f.open(); const header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(length, 2);
    f.raw.emit('data', header); assertFailed(f);
  }
});

test('8MiB aggregate fragmented limit is checked before reading/allocating the next payload', t => {
  const f = fixture(t); f.open();
  f.raw.emit('data', frame(1, 'x'.repeat(MAX), { final: false }));
  f.raw.emit('data', Buffer.from([0x80, 1]));
  assertFailed(f);
});

test('maximum aggregate fragmented text is accepted', t => {
  const f = fixture(t); f.open();
  f.raw.emit('data', frame(1, 'x'.repeat(MAX - 1), { final: false }));
  f.raw.emit('data', frame(0, 'y'));
  assert.equal(f.events.message.length, 1); assert.equal(f.events.message[0].data.length, MAX);
  assert.equal(f.events.message[0].data.at(-1), 'y');
});

test('server close is validated, echoed masked, reason redacted and lifecycle bounded', t => {
  const f = fixture(t); f.open();
  const payload = Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from('SECRET ws://private.invalid/url')]);
  f.raw.emit('data', frame(8, payload));
  assert.equal(f.ws.readyState, 2); assert.equal(f.raw.ended, true);
  const close = unpack(f.raw.writes.at(-1)); assert.equal(close.opcode, 8); assert.equal(close.masked, true); assert.deepEqual(close.data, payload);
  f.raw.emit('close');
  assert.equal(f.ws.readyState, 3); assert.equal(f.events.close[0].code, 1000); assert.equal(f.events.close[0].reason, ''); assert.equal(f.events.close[0].wasClean, true);
  assert.equal(f.events.error.length, 0); assert.equal(f.clock.pending.size, 0);
});

test('empty server close is valid and ignored text after it never reaches message listeners', t => {
  const f = fixture(t); f.open();
  f.raw.emit('data', Buffer.concat([frame(8), frame(1, 'ignore')]));
  f.clock.advance(250);
  assert.equal(f.ws.readyState, 3); assert.equal(f.events.close[0].code, 1005); assert.equal(f.events.message.length, 0);
});

test('client close sends one masked normal-close, suppresses late messages and times out in 250ms', t => {
  const f = fixture(t); f.open(); const prior = f.raw.writes.length;
  f.ws.close(); f.ws.close();
  assert.equal(f.ws.readyState, 2); assert.equal(f.raw.writes.length, prior + 1);
  const close = unpack(f.raw.writes.at(-1)); assert.equal(close.opcode, 8); assert.equal(close.masked, true); assert.equal(close.data.readUInt16BE(), 1000);
  f.raw.emit('data', frame(1, 'too late')); assert.equal(f.events.message.length, 0);
  f.clock.advance(249); assert.equal(f.ws.readyState, 2);
  f.clock.advance(1); assert.equal(f.ws.readyState, 3); assert.equal(f.raw.destroyed, true);
  assert.equal(f.events.close[0].code, 1006); assert.equal(f.events.error.length, 0);
});

test('peer close response completes client close without duplicate close frames', t => {
  const f = fixture(t); f.open(); f.ws.close(); const prior = f.raw.writes.length;
  f.raw.emit('data', frame(8, Buffer.from([0x03, 0xe8]))); f.raw.emit('end');
  assert.equal(f.ws.readyState, 3); assert.equal(f.raw.writes.length, prior); assert.equal(f.events.close[0].wasClean, true);
});

test('close during connect or handshake is idempotent, clears deadline and destroys immediately', t => {
  for (const sendHeaders of [false, true]) {
    const f = fixture(t); if (sendHeaders) f.request();
    f.ws.close(); f.ws.close();
    assert.equal(f.ws.readyState, 3); assert.equal(f.events.close.length, 1); assert.equal(f.events.error.length, 0);
    assert.equal(f.clock.pending.size, 0); assert.equal(f.raw.destroyCount, 1);
    f.raw.emit('connect'); f.raw.emit('data', Buffer.from('late')); f.clock.advance(7000);
    assert.equal(f.events.open.length, 0); assert.equal(f.events.close.length, 1);
  }
});

for (const phase of ['connect', 'handshake', 'open', 'closing']) {
  test(`raw socket error in ${phase} is fully sanitized and destroys transport`, t => {
    const f = fixture(t);
    if (phase === 'handshake') f.request();
    if (phase === 'open' || phase === 'closing') f.open();
    if (phase === 'closing') f.ws.close();
    f.raw.emit('error', new Error('SECRET ws://private.invalid:1234/user?password=secret'));
    assertFailed(f);
    const error = f.events.error[0];
    assert.equal(/SECRET|private|password|ws:\/\//.test(error.message + error.error.message + error.error.stack), false);
    assert.equal(error.error.cause, undefined);
  });
}

test('constructor factory throws asynchronously sanitized error, with no escaping bottom-level cause', async t => {
  const f = fixture(t, { connect() { throw new Error('SECRET private endpoint'); } });
  await Promise.resolve();
  assert.equal(f.ws.readyState, 3); assert.equal(f.events.error.length, 1); assert.equal(f.events.error[0].error.message, 'Local CDP WebSocket connection failed.'); assert.equal(f.clock.pending.size, 0);
});

test('invalid factory socket is asynchronously rejected without an escaping error or live deadline', async () => {
  const clock = new Clock();
  const Socket = createLocalWebSocket({ connect: () => null, setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: id => clock.clearTimeout(id) });
  const ws = new Socket(URL_VALUE);
  await Promise.resolve();
  assert.equal(ws.readyState, 3); assert.equal(clock.pending.size, 0);
});

test('write exceptions and abrupt remote EOF are fixed errors, never bottom-level throws', t => {
  const f = fixture(t); f.open(); f.raw.throwWrite = true; assert.doesNotThrow(() => f.ws.send('test')); assertFailed(f);
  const g = fixture(t); g.open(); g.raw.emit('end'); assertFailed(g);
  const h = fixture(t); h.request(); h.raw.throwWrite = true; h.raw.emit('connect'); assertFailed(h);
});

test('event listener failures, once/removal/deduplication and close reentrancy do not escape', t => {
  const f = fixture(t); let once = 0; let removed = 0; let deduplicated = 0;
  const duplicate = () => deduplicated++;
  const obsolete = () => removed++;
  f.ws.addEventListener('message', () => { throw new Error('listener failure'); });
  f.ws.addEventListener('message', () => once++, { once: true });
  f.ws.addEventListener('message', duplicate); f.ws.addEventListener('message', duplicate);
  f.ws.addEventListener('message', obsolete); f.ws.removeEventListener('message', obsolete);
  f.ws.addEventListener('error', () => { f.ws.close(); throw new Error('error listener'); });
  f.ws.addEventListener('close', () => { f.ws.close(); throw new Error('close listener'); });
  f.ws.addEventListener('open', () => { throw new Error('open listener'); });
  assert.doesNotThrow(() => f.open());
  assert.doesNotThrow(() => f.raw.emit('data', Buffer.concat([frame(1, 'one'), frame(1, 'two')])));
  assert.equal(once, 1); assert.equal(removed, 0); assert.equal(deduplicated, 2);
  assert.doesNotThrow(() => f.raw.emit('data', frame(2, 'binary'))); assertFailed(f);
});

test('closing from open listener cannot reopen the connection or leak upgrade leftovers', t => {
  const f = fixture(t); f.ws.addEventListener('open', () => f.ws.close());
  f.request(); f.raw.emit('data', Buffer.concat([f.response(), frame(1, 'late')]));
  assert.equal(f.ws.readyState, 2); assert.equal(f.events.message.length, 0); f.clock.advance(250); assert.equal(f.ws.readyState, 3);
});

test('Node18 transport does not depend on ambient Buffer, URL or WebSocket globals', t => {
  const previous = { Buffer: globalThis.Buffer, URL: globalThis.URL, WebSocket: globalThis.WebSocket };
  try {
    globalThis.Buffer = undefined; globalThis.URL = undefined; globalThis.WebSocket = undefined;
    const f = fixture(t);
    f.open(); f.ws.send('no globals'); f.raw.emit('data', frame(1, 'works'));
    assert.equal(f.events.message[0].data, 'works'); f.ws.close(); f.clock.advance(250);
  } finally { globalThis.Buffer = previous.Buffer; globalThis.URL = previous.URL; globalThis.WebSocket = previous.WebSocket; }
});
