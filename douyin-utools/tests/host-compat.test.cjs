'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const http = require('node:http');
const { URL: NodeURL } = require('node:url');
const { Buffer } = require('node:buffer');
const { EventEmitter, once } = require('node:events');
const { Readable } = require('node:stream');
const { createRequire } = require('node:module');

// Browser URL has its own brand/prototype. Older Node transports require their
// own node:url URL, rather than the renderer global. No Node Buffer is global.
class BrowserURL {
  constructor(input, base) {
    const parsed = new NodeURL(String(input), base == null ? undefined : String(base));
    for (const key of ['href', 'origin', 'protocol', 'hostname', 'host', 'port', 'pathname', 'search', 'hash', 'username', 'password', 'searchParams']) {
      Object.defineProperty(this, key, { get: () => parsed[key] });
    }
  }
  toString() { return this.href; }
  get [Symbol.toStringTag]() { return 'URL'; }
}
function rendererModule(name, replacements = {}) {
  const filename = path.resolve(__dirname, '..', 'core', name);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: id => Object.prototype.hasOwnProperty.call(replacements, id) ? replacements[id] : localRequire(id),
    URL: BrowserURL, Buffer: undefined, setTimeout, clearTimeout });
  new vm.Script(fs.readFileSync(filename, 'utf8'), { filename }).runInContext(context);
  return module.exports;
}
const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32000000106d6461740001020304050607', 'hex');

test('downloader works with a browser URL global, no global Buffer, and strict older Node transports', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'douyin-renderer-test-'));
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MP4.length }); res.end(MP4); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; await fsp.rm(directory, { recursive: true, force: true }); });
  let calls = 0;
  const strictTransport = { get(url, options, callback) { calls++; assert.ok(url instanceof NodeURL, 'transport must receive node:url URL, not DOM URL'); return http.get(url, options, callback); } };
  const { createDownloader } = rendererModule('download.cjs', { 'node:http': strictTransport });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const downloader = createDownloader({ allowUrl: url => url.origin === origin });
  const result = await downloader.downloadMedia({ urls: [`${origin}/video?signed=keep`], outputDir: directory, filename: 'renderer' });
  assert.equal(calls, 1);
  assert.equal(result.bytes, MP4.length);
  assert.deepEqual(await fsp.readFile(result.path), MP4);
  assert.equal((await fsp.readdir(directory)).some(name => name.endsWith('.part')), false);
});

test('public-page parser works without Node globals in the renderer realm', async () => {
  const parser = rendererModule('parse.cjs');
  const id = '7678695071319841723';
  assert.equal(parser.parseShareInput(`分享 https://www.douyin.com/video/${id}`).id, id);
  const body = '<html><title>public page</title></html>';
  let calls = 0;
  const request = (url, options, callback) => {
    assert.ok(url instanceof NodeURL, 'page transport must receive node:url URL');
    calls++;
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const res = Readable.from([Buffer.from(body)]);
      Object.assign(res, { statusCode: 200, headers: { 'content-length': String(Buffer.byteLength(body)) }, complete: true });
      callback(res);
    });
    return req;
  };
  const result = await parser._fetchPage(`https://www.douyin.com/video/${id}`, { request, timeoutMs: 500 });
  assert.equal(result.body, body);
  assert.equal(calls, 1);
});

test('unexpected host transport exceptions show only a safe error code and stop futile retries', async () => {
  let calls = 0;
  const transport = { get() { calls++; throw Object.assign(new TypeError('bad host object https://v3.douyinvod.com/a?signature=PRIVATE'), { code: 'ERR_INVALID_ARG_TYPE' }); } };
  const { createDownloader } = rendererModule('download.cjs', { 'node:https': transport });
  await assert.rejects(createDownloader().downloadMedia({ urls: ['https://v3.douyinvod.com/a', 'https://v4.douyinvod.com/b'], outputDir: os.tmpdir() }), error => {
    assert.equal(error.code, 'HOST_RUNTIME_ERROR');
    assert.match(error.message, /ERR_INVALID_ARG_TYPE/);
    assert.doesNotMatch(error.message, /PRIVATE|signature|https:/);
    return true;
  });
  assert.equal(calls, 1);
});
