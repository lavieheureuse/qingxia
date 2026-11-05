'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createDownloader, isAllowedMediaUrl, safeFilename, MEDIA_DOMAINS } = require('../core/download.cjs');

const MP4 = Buffer.concat([
  Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex'),
  Buffer.from('000000106d6461740001020304050607', 'hex'),
]);
const WEBM = Buffer.from('1a45dfa39f4286810142f7810142f2810442f381084282847765626d42878104428581021853806780', 'hex');

async function fixture(t, handler, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-download-test-'));
  const server = http.createServer((req, res) => handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const downloader = createDownloader({ allowUrl: url => url.origin === origin, timeoutMs: 1000, ...options });
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, origin, downloader };
}
function video(res, body = MP4, mime = 'video/mp4') {
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': body.length });
  res.end(body);
}
async function noParts(directory) {
  assert.equal((await fs.readdir(directory)).some(name => name.endsWith('.part')), false);
}

const policyCases = [
  ['https://v3.douyinvod.com/a.mp4?signature=keep', true],
  ['https://media.douyinvodmp.com/a', true],
  ['https://p1.byteimg.com/a', true],
  ['https://aweme.snssdk.com/aweme/v1/play/?video_id=a', true],
  ['https://www.douyin.com/aweme/v1/playwm?video_id=a', true],
  ['https://aweme.snssdk.com/aweme/v1/play/extra', false],
  ['https://aweme.snssdk.com/aweme/v1/user/', false],
  ['https://other.snssdk.com/aweme/v1/play/', false],
  ['https://douyin.com/aweme/v1/play/', false],
  ['https://www.douyin.com/video/123', false],
  ['https://douyinvod.com.evil.test/a', false],
  ['https://evildouyinvod.com/a', false],
  ['https://user:secret@v3.douyinvod.com/a', false],
  ['http://v3.douyinvod.com/a', false],
  ['https://v3.douyinvod.com:444/a', false],
  ['https://127.0.0.1/a', false],
  ['file:///a.mp4', false],
];
test('default policy uses domain boundaries and exact official play endpoints', () => {
  for (const [url, allowed] of policyCases) assert.equal(isAllowedMediaUrl(url), allowed, url);
  for (const domain of MEDIA_DOMAINS) assert.equal(isAllowedMediaUrl(`https://v1.${domain}/media`), true);
});

test('streams MP4, returns real bytes/mime, and always emits final progress', async t => {
  let seen;
  const f = await fixture(t, (req, res) => { seen = req.headers; video(res); });
  const progress = [];
  const result = await f.downloader.downloadMedia({
    urls: [`${f.origin}/video?signature=unmodified`], outputDir: f.directory, filename: '示例.mp4',
    referer: 'https://www.douyin.com/', userAgent: 'DouyinTest/1', onProgress: p => progress.push(p),
    headers: { Cookie: 'never-send-this' },
  });
  assert.equal(result.mime, 'video/mp4');
  assert.equal(result.bytes, MP4.length);
  assert.equal(path.basename(result.path), '示例.mp4');
  assert.deepEqual(await fs.readFile(result.path), MP4);
  assert.equal(seen.cookie, undefined);
  assert.equal(seen['user-agent'], 'DouyinTest/1');
  assert.equal(seen.referer, 'https://www.douyin.com/');
  assert.equal(seen['accept-encoding'], 'identity');
  assert.equal(progress.at(-1).received, MP4.length);
  assert.equal(progress.at(-1).total, MP4.length);
  assert.equal(progress.at(-1).percent, 100);
  assert.ok(progress.at(-1).speed > 0);
  await noParts(f.directory);
});

test('WebM is sniffed from octet stream and gets a matching extension', async t => {
  const f = await fixture(t, (_req, res) => video(res, WEBM, 'application/octet-stream'));
  const result = await f.downloader.downloadMedia({ urls: [`${f.origin}/webm`], outputDir: f.directory, filename: 'clip.mp4' });
  assert.equal(result.mime, 'video/webm');
  assert.equal(path.extname(result.path), '.webm');
  assert.deepEqual(await fs.readFile(result.path), WEBM);
});

test('preserves query signatures and does not replay response cookies on redirect', async t => {
  const hits = [];
  const f = await fixture(t, (req, res) => {
    hits.push({ url: req.url, cookie: req.headers.cookie });
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/movie?x=a%2Fb&signature=ABC%2BDEF', 'Set-Cookie': 'secret=never' });
      res.end();
    } else video(res);
  });
  await f.downloader.downloadMedia({ urls: [`${f.origin}/start`], outputDir: f.directory });
  assert.equal(hits[1].url, '/movie?x=a%2Fb&signature=ABC%2BDEF');
  assert.ok(hits.every(hit => hit.cookie === undefined));
});

test('validates every redirect target before making a request', async t => {
  let hits = 0;
  const f = await fixture(t, (_req, res) => { hits++; res.writeHead(302, { Location: 'http://localhost:1/denied' }); res.end(); });
  await assert.rejects(f.downloader.downloadMedia({ urls: [`${f.origin}/start`], outputDir: f.directory }), { code: 'URL_NOT_ALLOWED' });
  assert.equal(hits, 1);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('redirect cycles stop at the fixed limit', async t => {
  let hits = 0;
  const f = await fixture(t, (_req, res) => { hits++; res.writeHead(302, { Location: '/again' }); res.end(); });
  await assert.rejects(f.downloader.downloadMedia({ urls: [`${f.origin}/again`], outputDir: f.directory }), { code: 'TOO_MANY_REDIRECTS' });
  assert.equal(hits, 6);
});

test('fails over HTML, a fake video body and HTTP failure to a good candidate', async t => {
  const hits = [];
  const f = await fixture(t, (req, res) => {
    hits.push(req.url);
    if (req.url === '/html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>login</html>'); }
    else if (req.url === '/fake') video(res, Buffer.from('<html>fake video login gate</html>'));
    else if (req.url === '/blocked') { res.writeHead(403); res.end('blocked'); }
    else video(res);
  });
  const result = await f.downloader.downloadMedia({
    urls: ['/html', '/fake', '/blocked', '/good'].map(route => f.origin + route), outputDir: f.directory,
  });
  assert.equal(result.bytes, MP4.length);
  assert.deepEqual(hits, ['/html', '/fake', '/blocked', '/good']);
  assert.equal((await fs.readdir(f.directory)).length, 1);
  await noParts(f.directory);
});

for (const [label, body, mime, code] of [
  ['JSON MIME', Buffer.from('{"error":"login"}'), 'application/json', 'INVALID_CONTENT_TYPE'],
  ['HTML with video MIME', Buffer.from('<html>not a video</html>'), 'video/mp4', 'INVALID_MEDIA'],
  ['empty video', Buffer.alloc(0), 'video/mp4', 'LENGTH_MISMATCH'],
  ['mismatched WebM MIME', MP4, 'video/webm', 'INVALID_MEDIA'],
  ['truncated MP4 signature', Buffer.from('0000001866747970', 'hex'), 'video/mp4', 'INVALID_MEDIA'],
  ['incomplete ftyp box', Buffer.from('000000186674797069736f6d00000200', 'hex'), 'video/mp4', 'INVALID_MEDIA'],
]) {
  test(`rejects ${label} and removes temporary data`, async t => {
    const f = await fixture(t, (_req, res) => video(res, body, mime));
    await assert.rejects(f.downloader.downloadMedia({ urls: [`${f.origin}/bad`], outputDir: f.directory }), { code });
    assert.deepEqual(await fs.readdir(f.directory), []);
  });
}

test('rejects truncated responses with a clear length error', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MP4.length + 100 });
    res.end(MP4);
  });
  await assert.rejects(f.downloader.downloadMedia({ urls: [`${f.origin}/truncated`], outputDir: f.directory }), { code: 'LENGTH_MISMATCH' });
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('size limit applies to advertised length and unknown-length streams', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/known') video(res);
    else { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.write(MP4.subarray(0, 20)); res.end(MP4.subarray(20)); }
  });
  for (const route of ['/known', '/unknown']) {
    await assert.rejects(f.downloader.downloadMedia({ urls: [f.origin + route], outputDir: f.directory, maxBytes: 25 }), { code: 'TOO_LARGE' });
    assert.deepEqual(await fs.readdir(f.directory), []);
  }
});

test('progress is throttled 100–250ms apart, final chunk is mandatory, unknown total stays null', async t => {
  const chunks = [MP4, ...Array.from({ length: 8 }, () => Buffer.alloc(1024, 7))];
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    res.write(chunks[0]);
    let index = 1;
    const timer = setInterval(() => {
      res.write(chunks[index++]);
      if (index === chunks.length) { clearInterval(timer); res.end(); }
    }, 50);
    res.once('close', () => clearInterval(timer));
  });
  const progress = [];
  const result = await f.downloader.downloadMedia({ urls: [`${f.origin}/slow`], outputDir: f.directory,
    onProgress: p => progress.push({ ...p, at: Date.now() }) });
  assert.ok(progress.length >= 2 && progress.length <= 4, JSON.stringify(progress));
  for (let i = 1; i < progress.length - 1; i++) {
    const interval = progress[i].at - progress[i - 1].at;
    assert.ok(interval >= 100 && interval <= 250, `interval ${interval}`);
  }
  assert.equal(progress.at(-1).received, result.bytes);
  assert.ok(progress.every(p => p.total === null && p.percent === null));
  await noParts(f.directory);
});

test('active cancellation stops the stream and removes .part files', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    res.write(MP4);
    const timer = setInterval(() => res.write(Buffer.alloc(512)), 40);
    res.once('close', () => clearInterval(timer));
  });
  const controller = new AbortController();
  await assert.rejects(f.downloader.downloadMedia({ urls: [`${f.origin}/forever`], outputDir: f.directory,
    signal: controller.signal, onProgress: () => controller.abort() }), { code: 'ABORTED' });
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('pre-aborted requests do not create files or make network requests', async t => {
  let hits = 0;
  const f = await fixture(t, (_req, res) => { hits++; video(res); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.downloader.downloadMedia({ urls: [`${f.origin}/video`], outputDir: f.directory, signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(hits, 0);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('inactivity timeout cleans partial files', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.write(MP4); }, { timeoutMs: 60 });
  await assert.rejects(f.downloader.downloadMedia({ urls: [`${f.origin}/stalled`], outputDir: f.directory }), { code: 'TIMEOUT' });
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('timeout also covers a server that never sends response headers', async t => {
  const f = await fixture(t, () => {}, { timeoutMs: 60 });
  await assert.rejects(f.downloader.downloadMedia({ urls: [`${f.origin}/headers`], outputDir: f.directory }), { code: 'TIMEOUT' });
});

test('parallel identical names are published without overwriting existing content', async t => {
  const f = await fixture(t, (_req, res) => video(res));
  const original = path.join(f.directory, 'same.mp4');
  await fs.writeFile(original, 'keep existing');
  const options = { urls: [`${f.origin}/video`], outputDir: f.directory, filename: 'same.mp4' };
  const results = await Promise.all([f.downloader.downloadMedia(options), f.downloader.downloadMedia(options)]);
  assert.notEqual(results[0].path, results[1].path);
  assert.equal(await fs.readFile(original, 'utf8'), 'keep existing');
  for (const result of results) assert.deepEqual(await fs.readFile(result.path), MP4);
  await noParts(f.directory);
});

test('filename sanitization stays inside destination, handles reserved names and actual extension', async t => {
  const f = await fixture(t, (_req, res) => video(res));
  const result = await f.downloader.downloadMedia({ urls: [`${f.origin}/video`], outputDir: f.directory, filename: '../../CON:evil\\name?.exe.mp4' });
  assert.equal(path.dirname(result.path), f.directory);
  assert.equal(/[<>:"/\\|?*]/.test(path.basename(result.path)), false);
  assert.equal(path.extname(result.path), '.mp4');
  assert.equal(safeFilename('CON.mp4', '.mp4'), '_CON.mp4');
  assert.equal(safeFilename('...   ', '.webm'), 'douyin-video.webm');
  assert.ok(safeFilename('长'.repeat(300), '.mp4').length <= 104);
});

test('handles signatures split across small network chunks without assuming a full first chunk', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MP4.length });
    let index = 0;
    const timer = setInterval(() => {
      res.write(MP4.subarray(index, ++index));
      if (index === MP4.length) { clearInterval(timer); res.end(); }
    }, 2);
    res.once('close', () => clearInterval(timer));
  });
  const result = await f.downloader.downloadMedia({ urls: [`${f.origin}/fragmented`], outputDir: f.directory });
  assert.deepEqual(await fs.readFile(result.path), MP4);
});

test('failed partial candidates are cleaned before a successful retry', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/broken') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MP4.length + 20 });
      res.end(MP4);
    } else video(res);
  });
  const result = await f.downloader.downloadMedia({ urls: [`${f.origin}/broken`, `${f.origin}/good`], outputDir: f.directory });
  assert.deepEqual(await fs.readFile(result.path), MP4);
  assert.equal((await fs.readdir(f.directory)).length, 1);
});

test('unusable output directory fails with FILE_WRITE_ERROR rather than retrying forever', async t => {
  const f = await fixture(t, (_req, res) => video(res));
  const target = path.join(f.directory, 'not-directory');
  await fs.writeFile(target, 'keep');
  await assert.rejects(f.downloader.downloadMedia({ urls: [`${f.origin}/video`], outputDir: target }), { code: 'FILE_WRITE_ERROR' });
  assert.equal(await fs.readFile(target, 'utf8'), 'keep');
  await noParts(f.directory);
});

test('progress callback failures do not corrupt successful downloads', async t => {
  const f = await fixture(t, (_req, res) => video(res));
  const result = await f.downloader.downloadMedia({ urls: [`${f.origin}/video`], outputDir: f.directory, onProgress() { throw new Error('UI failed'); } });
  assert.deepEqual(await fs.readFile(result.path), MP4);
});

test('request-level allowUrl/header injection cannot bypass the construction-time policy', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-policy-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(createDownloader().downloadMedia({
    urls: ['http://127.0.0.1:1/video'], outputDir: directory, allowUrl: () => true,
  }), { code: 'URL_NOT_ALLOWED' });
});

test('invalid arguments and malformed headers have clear errors', async t => {
  const f = await fixture(t, (_req, res) => video(res));
  for (const patch of [{ urls: [] }, { outputDir: '' }, { maxBytes: 0 }, { userAgent: 'bad\r\nCookie: secret' }, { referer: 'https://user:secret@example.com/' }]) {
    await assert.rejects(f.downloader.downloadMedia({ urls: [`${f.origin}/video`], outputDir: f.directory, ...patch }), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(f.downloader.downloadMedia({ urls: ['http://user:password@127.0.0.1/x'], outputDir: f.directory }), { code: 'URL_NOT_ALLOWED' });
  assert.throws(() => createDownloader({ timeoutMs: 0 }), { code: 'INVALID_ARGUMENT' });
});
