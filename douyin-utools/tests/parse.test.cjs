'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const https = require('node:https');
const zlib = require('node:zlib');
const {
  parseShareInput, parseVideoData, fetchVideo, isMediaUrl, isCoverUrl, _fetchPage
} = require('../core/parse.cjs');

const ID = '7424673920123456789';
const OTHER_ID = '7424673920987654321';
const PAGE = 'https://www.douyin.com/video/' + ID;
const MOBILE = 'https://www.iesdouyin.com/share/video/' + ID + '/';
const MEDIA = 'https://v3-web.douyinvod.com/video/tos/cn/test.mp4?signature=abc%2Fxyz&x=1';
const COVER = 'https://p3-sign.douyinpic.com/tos-cn-p/test.jpeg?x-expires=1900000000&x-signature=abc';

function item(overrides) {
  return Object.assign({
    aweme_id: ID,
    aweme_type: 0,
    desc: '真实视频标题 <b>保持纯文本</b>',
    author: { nickname: '视频作者' },
    video: {
      duration: 12345,
      width: 1080,
      height: 1920,
      play_addr: { url_list: [MEDIA] },
      cover: { url_list: [COVER] }
    }
  }, overrides || {});
}

function html(data) {
  return '<!doctype html><html><body><script>window._ROUTER_DATA = ' +
    JSON.stringify(data).replace(/</g, '\\u003c') + ';</script></body></html>';
}

function transport(responses) {
  const calls = [];
  let count = 0;
  const request = (url, options, callback) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; if (req.response) req.response.destroy(); };
    req.end = () => {
      const call = { url: url.href, options, req };
      calls.push(call);
      const config = typeof responses === 'function' ? responses(call, count++) : responses[count++];
      process.nextTick(() => {
        if (req.destroyed) return;
        if (!config) { req.emit('error', new Error('No fixture for ' + call.url)); return; }
        if (config.error) { req.emit('error', config.error); return; }
        if (config.noResponse) return;
        const response = new PassThrough();
        req.response = response;
        response.statusCode = config.status === undefined ? 200 : config.status;
        response.headers = Object.assign({}, config.headers);
        callback(response);
        if (response.destroyed || config.hold) return;
        if (config.aborted) { response.emit('aborted'); return; }
        for (const chunk of config.chunks || [config.body === undefined ? '' : config.body]) {
          if (!response.destroyed) response.write(chunk);
        }
        if (!response.destroyed) response.end();
      });
    };
    return req;
  };
  request.calls = calls;
  return request;
}

async function withRequests(request, work) {
  const original = https.request;
  https.request = request;
  try { return await work(); } finally { https.request = original; }
}

function hasCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0);
    return true;
  };
}

test('share input supports full text, short links, hostnames and both public video paths', () => {
  assert.deepEqual(parseShareInput('3.42 复制打开抖音，看看【作者】的作品 https://v.douyin.com/Ab_c123/ 复制此链接'), { url: 'https://v.douyin.com/Ab_c123/' });
  assert.deepEqual(parseShareInput('抖音视频：' + PAGE + '。'), { url: PAGE, id: ID });
  assert.deepEqual(parseShareInput('www.douyin.com/video/' + ID), { url: PAGE, id: ID });
  assert.equal(parseShareInput(MOBILE + '?from=share').id, ID);
  assert.equal(parseShareInput('https://iesdouyin.com/share/video/' + ID).id, ID);
  assert.equal(parseShareInput('https://douyin.com/video/' + ID).id, ID);
  assert.equal(parseShareInput('https://m.douyin.com/share/video/' + ID + '/').id, ID);
  assert.deepEqual(parseShareInput('https://www.douyin.com/?modal_id=' + ID), { url: PAGE, id: ID });
});

test('input rejects unrelated, recommendation, user, private-network and deceptive URLs', () => {
  const invalid = [
    '', null, {}, 'just a title', 'https://www.douyin.com/',
    'https://www.douyin.com/?modal_id=' + ID + '&modal_id=' + OTHER_ID,
    'https://www.douyin.com/?modal_id=' + ID + '&recommend=1',
    'https://www.douyin.com/?modal_id=invalid',
    'https://www.douyin.com/recommend?modal_id=' + ID,
    'https://www.douyin.com/user/abc', 'https://live.douyin.com/123',
    'https://127.0.0.1/video/' + ID, 'https://[::1]/video/' + ID,
    'https://localhost/video/' + ID,
    'https://www.douyin.com.evil.test/video/' + ID,
    'https://evil-douyin.com/video/' + ID,
    'https://www.douyin.com@evil.test/video/' + ID,
    'https://user:password@www.douyin.com/video/' + ID,
    'https://www.douyin.com:443/video/' + ID,
    'https://www.douyin.com:444/video/' + ID,
    'https://www.douyin.com./video/' + ID,
    'https://www%2edouyin.com/video/' + ID,
    'https://www.douyin.com\\@evil.test/video/' + ID,
    'http://www.douyin.com/video/' + ID,
    'ftp://www.douyin.com/video/' + ID,
    'javascript:alert(1)', 'data:text/html,' + PAGE,
    'https://v.douyin.com/', 'https://v.douyin.com/ab/cd',
    'https://www.douyin.com/video/not-a-number',
    PAGE + '\u0000', 'x'.repeat(16385)
  ];
  for (const input of invalid) assert.throws(() => parseShareInput(input), hasCode('INVALID_URL'), String(input));
});

test('multiple distinct videos are ambiguous and explicit album links are not videos', () => {
  assert.throws(() => parseShareInput(PAGE + ' https://www.douyin.com/video/' + OTHER_ID), hasCode('INVALID_URL'));
  assert.deepEqual(parseShareInput(PAGE + ' ' + PAGE), { url: PAGE, id: ID });
  assert.throws(() => parseShareInput('https://www.douyin.com/note/' + ID), hasCode('NOT_VIDEO'));
  assert.throws(() => parseShareInput('https://www.iesdouyin.com/share/slides/' + ID), hasCode('NOT_VIDEO'));
});

test('media allowlist is HTTPS, suffix-boundary checked and restricts playback API routes', () => {
  for (const host of ['v3.douyinvod.com', 'v1.douyinvodmp.com', 'x.bytecdn.cn', 'x.bytecdn.com', 'x.ibytedtos.com', 'x.ibytedtos.cn', 'v3-dy-o.zjcdn.com', 'v6-dy.ixigua.com', 'x.byteimg.com']) {
    assert.equal(isMediaUrl('https://' + host + '/video.mp4?signature=abc'), true, host);
  }
  for (const url of [
    'https://aweme.snssdk.com/aweme/v1/play/?video_id=x&signature=a%2Bb',
    'https://aweme.snssdk.com/aweme/v1/playwm/?video_id=x',
    'https://www.douyin.com/aweme/v1/play?video_id=x'
  ]) assert.equal(isMediaUrl(url), true, url);
  for (const url of [
    'https://evil.test/test.mp4', 'http://v3.douyinvod.com/x',
    'https://v3.douyinvod.com.evil.test/x', 'https://notdouyinvod.com/x',
    'https://a@v3.douyinvod.com/x', 'https://v3.douyinvod.com:443/x',
    'https://v3.douyinvod.com:8443/x', 'https://v3.douyinvod.com/x#fragment',
    'https://v3.douyinvod.com/white space', 'https://v3.douyinvod.com\\evil/x',
    'https://aweme.snssdk.com/aweme/v1/detail/',
    'https://evil.snssdk.com/aweme/v1/play/', 'https://douyin.com/aweme/v1/play/',
    'https://www.douyin.com/aweme/v1/play/extra', 'https://www.douyin.com/video/' + ID,
    'data:video/mp4;base64,AAAA', 'file:///test.mp4', null
  ]) assert.equal(isMediaUrl(url), false, String(url));
});

test('cover allowlist excludes inline/script URLs and third-party trackers', () => {
  assert.equal(isCoverUrl(COVER), true);
  assert.equal(isCoverUrl('https://p3.pstatp.com/test.jpg'), true);
  assert.equal(isCoverUrl('https://p3.byteimg.cn/test.jpg'), true);
  for (const url of ['data:image/svg+xml,<svg onload=alert(1)>', 'javascript:alert(1)', 'https://evil.test/x.jpg', 'https://p3.douyinpic.com.evil.test/x', 'http://p3.douyinpic.com/x']) {
    assert.equal(isCoverUrl(url), false);
  }
});

test('normalization exposes stable fields, seconds and original signed URLs', () => {
  const result = parseVideoData({ aweme_detail: item() }, { id: ID, sourceUrl: PAGE });
  assert.deepEqual(result, {
    id: ID, title: '真实视频标题 <b>保持纯文本</b>', author: '视频作者', cover: COVER,
    duration: 12.345, width: 1080, height: 1920, quality: '1080P', sourceUrl: PAGE,
    watermark: null, urls: [MEDIA]
  });
});

test('exact ID is required: recommendations, nested video IDs and lossy numeric IDs cannot win', () => {
  const other = item({ aweme_id: OTHER_ID, desc: '推荐视频不能下载' });
  const exact = item({ desc: '正确作品' });
  assert.equal(parseVideoData({ item_list: [other, exact] }, { id: ID }).title, '正确作品');
  assert.equal(parseVideoData({ item_list: [other] }, { id: ID }), null);
  assert.equal(parseVideoData({ item_list: [exact] }, {}), null);
  assert.equal(parseVideoData(exact, { id: OTHER_ID, sourceUrl: PAGE }), null);
  assert.equal(parseVideoData(item({ aweme_id: Number(ID) }), { id: ID }), null);
  assert.equal(parseVideoData({ aweme_id: OTHER_ID, video: { id: ID, play_addr: { url_list: [MEDIA] } } }, { id: ID }), null);
  assert.equal(parseVideoData(exact, { sourceUrl: PAGE }).id, ID);
});

test('hydration handles ROUTER_DATA assignments and encoded RENDER_DATA safely', () => {
  const raw = { loaderData: { 'video_(id)/page': { videoInfoRes: { item_list: [item()] } } } };
  assert.equal(parseVideoData(html(raw), { id: ID }).id, ID);
  const render = '<script nonce="a" type="application/json" id="RENDER_DATA">' + encodeURIComponent(JSON.stringify(raw)) + '</script>';
  assert.equal(parseVideoData(render, { id: ID }).id, ID);
  assert.equal(parseVideoData('<script id="_ROUTER_DATA">' + JSON.stringify(raw) + '</script>', { id: ID }).id, ID);
  assert.equal(parseVideoData('<script type="application/json">' + JSON.stringify(raw) + '</script>', { id: ID }).id, ID);
  assert.equal(parseVideoData(JSON.stringify(raw), { id: ID }).id, ID);
  assert.equal(parseVideoData(encodeURIComponent(JSON.stringify(raw)), { id: ID }).id, ID);
  assert.equal(parseVideoData('<script>window.RENDER_DATA = ' + JSON.stringify(encodeURIComponent(JSON.stringify(raw))) + ';</script>', { id: ID }).id, ID);
});

test('camelCase page variants, ranked bitrates and fallback sources are supported', () => {
  const low = 'https://v3.douyinvod.com/low.mp4?sign=low';
  const high = 'https://v3.douyinvod.com/high.mp4?sign=high%2Fopaque';
  const camel = {
    awemeId: ID, description: 'camel case', author: { nickName: '作者' },
    video: {
      duration: 1001, width: 720, height: 1280,
      playAddr: { urlList: [low, 'https://evil.test/evil.mp4'] },
      bitRateList: [
        { bitRate: 100, playAddr: { urlList: [low], width: 720, height: 1280 } },
        { bitRate: 900, playAddr: { urlList: [high], width: 1080, height: 1920 } }
      ], originCover: { urlList: [COVER] }
    }
  };
  const result = parseVideoData({ awemeInfo: camel }, { id: ID });
  assert.deepEqual(result.urls, [high, low]);
  assert.equal(result.width, 1080);
  assert.equal(result.quality, '1080P');
  assert.equal(result.duration, 1.001);
  assert.equal(result.author, '作者');
});

test('snake-case bitrate, direct playAddr and optional metadata variants are supported', () => {
  const result = parseVideoData({ itemInfo: { itemStruct: {
    id: ID, title: '一个视频', author: '作者', video: {
      durationSeconds: 3.5,
      bit_rate: [{ bit_rate: 900, gear_name: 'adapt_720_1', play_addr: { url_list: [MEDIA] } }],
      playAddr: MEDIA, cover: COVER
    }
  } } }, { id: ID });
  assert.deepEqual(result.urls, [MEDIA]);
  assert.equal(result.duration, 3.5);
  assert.equal(result.width, 0);
  assert.equal(result.quality, 'adapt_720_1');
  assert.equal(result.author, '作者');
  assert.equal(result.cover, COVER);
});

test('desktop RENDER_DATA supports src records in playAddr arrays and authorInfo', () => {
  const data = { aweme: { detail: {
    awemeId: ID, desc: '桌面数据', authorInfo: { nickname: '桌面作者' },
    video: {
      duration: 5000, width: 720, height: 1280, cover: [{ src: COVER }],
      playAddr: [{ src: MEDIA, type: 'video/mp4' }],
      bitRateList: [{ bitRate: 800, width: 1080, height: 1920, playAddr: [{ src: MEDIA, type: 'video/mp4' }] }]
    }
  } } };
  const raw = '<script id="RENDER_DATA">' + encodeURIComponent(JSON.stringify(data)) + '</script>';
  const result = parseVideoData(raw, { id: ID });
  assert.deepEqual(result.urls, [MEDIA]);
  assert.equal(result.author, '桌面作者');
  assert.equal(result.cover, COVER);
  assert.equal(result.width, 1080);
  assert.equal(result.duration, 5);
});

test('watermarked official playback URLs are preserved, not rewritten or forged', () => {
  const playwm = 'https://aweme.snssdk.com/aweme/v1/playwm/?video_id=opaque&signature=a%2Fb&ratio=720p';
  const result = parseVideoData(item({ video: { play_addr: { url_list: [playwm] } } }), { id: ID });
  assert.deepEqual(result.urls, [playwm]);
  assert.equal(result.watermark, true);
  const explicit = parseVideoData(item({ video: { play_addr: { url_list: [MEDIA] }, has_watermark: false } }), { id: ID });
  assert.equal(explicit.watermark, false);
});

test('albums and live data are never mislabeled as videos, including teaser MP4s', () => {
  for (const change of [
    { aweme_type: 68 }, { awemeType: 150, aweme_type: undefined }, { aweme_type: 2 },
    { images: [{ url_list: [COVER] }] }, { image_post_info: { images: [{}] } },
    { aweme_type: 101 }, { is_live: true }, { isLive: 1 }, { liveRoomInfo: { roomId: '123' } }
  ]) assert.throws(() => parseVideoData(item(change), { id: ID }), hasCode('NOT_VIDEO'));
  assert.equal(parseVideoData({ item_list: [item({ aweme_id: OTHER_ID, aweme_type: 68 }), item()] }, { id: ID }).id, ID);
});

test('explicit privacy, friends-only and paid-video flags are rejected without guessing chargeInfo', () => {
  for (const change of [
    { isPrivate: true }, { isFriendLimit: true }, { is_private: 1 },
    { status: { is_private: true } }, { status: { is_private: 1 } },
    { status: { isFriendLimit: true } }, { isChargeVideo: true },
    { is_pay_video: 1 }, { isPaidVideo: true }
  ]) assert.throws(() => parseVideoData(item(change), { id: ID }), hasCode('NOT_PUBLIC'));
  assert.equal(parseVideoData(item({
    isPrivate: false, isFriendLimit: false, status: { is_private: 0 },
    chargeInfo: { chargeType: 0, hasPaid: false }, charge_info: {}
  }), { id: ID }).id, ID);
  assert.equal(parseVideoData({ item_list: [item({ aweme_id: OTHER_ID, isPrivate: true }), item()] }, { id: ID }).id, ID);
});

test('malicious JSON, JS, HTML, prototype pollution and getters are not executed', () => {
  global.__douyinParserExecuted = false;
  const bad = [
    '<script>window._ROUTER_DATA = (() => {global.__douyinParserExecuted=true;return ' + JSON.stringify(item()) + '})();</script>',
    '<script>window._ROUTER_DATA = {"aweme_id":"' + ID + '", "video": (global.__douyinParserExecuted=true)};</script>',
    '<img src=x onerror="global.__douyinParserExecuted=true">',
    '<script id="RENDER_DATA">%E0%A4%A</script>',
    '<script id="RENDER_DATA">{"broken":</script>',
    '<script>eval(' + JSON.stringify(JSON.stringify(item())) + ')</script>',
    '<script>'.repeat(5000), '<script '.repeat(16000),
    '<script ' + 'a'.repeat(128 * 1024) + '></script>',
    '<script>' + '\n'.repeat(128 * 1024) + '</script>'
  ];
  for (const raw of bad) assert.equal(parseVideoData(raw, { id: ID }), null);
  const poison = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  assert.equal(parseVideoData(poison, { id: ID }), null);
  assert.equal({}.polluted, undefined);
  const withGetter = { aweme_id: ID };
  Object.defineProperty(withGetter, 'video', { enumerable: true, get() { throw new Error('Getter must not execute'); } });
  assert.equal(parseVideoData(withGetter, { id: ID }), null);
  assert.equal(global.__douyinParserExecuted, false);
  delete global.__douyinParserExecuted;
});

test('unsafe media and covers are excluded, huge and circular raw data are bounded', () => {
  const unsafe = item({ video: { play_addr: { url_list: ['http://v3.douyinvod.com/x', 'https://evil.test/x'] } } });
  assert.equal(parseVideoData(unsafe, { id: ID }), null);
  const noCover = item({ video: { play_addr: MEDIA, cover: 'data:image/svg+xml,x' } });
  assert.equal(parseVideoData(noCover, { id: ID }).cover, '');
  assert.equal(parseVideoData(' '.repeat(4 * 1024 * 1024 + 1), { id: ID }), null);
  const circular = { data: item() };
  circular.self = circular;
  assert.equal(parseVideoData(circular, { id: ID }).id, ID);
});

test('HTTP helper reads public pages without cookies and exposes response metadata', async () => {
  const body = html({ item_list: [item()] });
  const request = transport([{ body, headers: { 'content-length': String(Buffer.byteLength(body)) } }]);
  const response = await _fetchPage(PAGE, { request });
  assert.equal(response.body, body);
  assert.equal(response.url, PAGE);
  assert.equal(response.statusCode, 200);
  assert.equal(request.calls[0].options.method, 'GET');
  assert.match(request.calls[0].options.headers['User-Agent'], /Mobile/);
  for (const name of Object.keys(request.calls[0].options.headers)) assert.ok(!/cookie|authorization/i.test(name));
});

test('every redirect is checked before a request is made', async () => {
  const request = transport([
    { status: 302, headers: { location: MOBILE } },
    { status: 307, headers: { location: PAGE } },
    { body: 'ok' }
  ]);
  assert.equal((await _fetchPage('https://v.douyin.com/Ab123/', { request })).url, PAGE);
  assert.deepEqual(request.calls.map((call) => call.url), ['https://v.douyin.com/Ab123/', MOBILE, PAGE]);
  for (const target of [
    'https://evil.test/video/' + ID, 'https://127.0.0.1/video/' + ID,
    'http://www.douyin.com/video/' + ID, 'https://www.douyin.com:443/video/' + ID,
    '//user@www.douyin.com/video/' + ID, '//www.douyin.com:443/video/' + ID,
    'https://www.douyin.com/recommend', 'file:///secret', '/user/abc'
  ]) {
    const blocked = transport([{ status: 301, headers: { location: target } }]);
    await assert.rejects(_fetchPage(PAGE, { request: blocked }), hasCode('INVALID_URL'), target);
    assert.equal(blocked.calls.length, 1);
  }
});

test('relative public video redirects work and loops are bounded', async () => {
  const relative = transport([{ status: 303, headers: { location: '/video/' + ID + '?from=short' } }, { body: 'ok' }]);
  assert.equal((await _fetchPage(PAGE, { request: relative })).url, PAGE + '?from=short');
  const loop = transport(() => ({ status: 302, headers: { location: PAGE } }));
  await assert.rejects(_fetchPage(PAGE, { request: loop }), hasCode('REDIRECT_LIMIT'));
  assert.equal(loop.calls.length, 6);
  const login = transport([{ status: 302, headers: { location: 'https://www.douyin.com/passport/login' } }]);
  await assert.rejects(_fetchPage(PAGE, { request: login }), hasCode('LOGIN_REQUIRED'));
  assert.equal(login.calls.length, 1);
});

test('HTTP 404/410, access challenge and other status failures have concrete codes', async () => {
  for (const status of [404, 410]) await assert.rejects(_fetchPage(PAGE, { request: transport([{ status }]) }), hasCode('VIDEO_NOT_FOUND'));
  for (const status of [401, 403]) await assert.rejects(_fetchPage(PAGE, { request: transport([{ status }]) }), hasCode('BROWSER_REQUIRED'));
  await assert.rejects(_fetchPage(PAGE, { request: transport([{ status: 500 }]) }), hasCode('HTTP_ERROR'));
  await assert.rejects(_fetchPage(PAGE, { request: transport([{ error: new Error('network down') }]) }), hasCode('NETWORK_ERROR'));
});

test('response limits cover declared, chunked and decompressed lengths', async () => {
  await assert.rejects(_fetchPage(PAGE, { maxResponseBytes: 10, request: transport([{ body: 'abc', headers: { 'content-length': '1000' } }]) }), hasCode('RESPONSE_TOO_LARGE'));
  await assert.rejects(_fetchPage(PAGE, { maxResponseBytes: 10, request: transport([{ chunks: ['123456', '78901'] }]) }), hasCode('RESPONSE_TOO_LARGE'));
  const compressed = zlib.gzipSync('x'.repeat(10000));
  await assert.rejects(_fetchPage(PAGE, { maxResponseBytes: 100, request: transport([{ body: compressed, headers: { 'content-encoding': 'gzip', 'content-length': String(compressed.length) } }]) }), hasCode('RESPONSE_TOO_LARGE'));
});

test('truncated, malformed length, bad compression and unsupported encoding are rejected', async () => {
  for (const config of [
    { body: 'abc', headers: { 'content-length': '10' } },
    { body: 'abcdef', headers: { 'content-length': '3' } },
    { body: 'abc', headers: { 'content-length': 'nope' } },
    { aborted: true },
    { body: 'not gzip', headers: { 'content-encoding': 'gzip' } }
  ]) await assert.rejects(_fetchPage(PAGE, { request: transport([config]) }), hasCode('RESPONSE_TRUNCATED'));
  await assert.rejects(_fetchPage(PAGE, { request: transport([{ body: 'x', headers: { 'content-encoding': 'unknown' } }]) }), hasCode('BROWSER_REQUIRED'));
});

test('gzip, deflate and brotli HTML responses are decoded without fetch', async () => {
  const body = html({ aweme_detail: item() });
  for (const [encoding, compress] of [['gzip', zlib.gzipSync], ['deflate', zlib.deflateSync], ['br', zlib.brotliCompressSync]]) {
    const encoded = compress(body);
    const response = await _fetchPage(PAGE, { request: transport([{ body: encoded, headers: { 'content-encoding': encoding, 'content-length': String(encoded.length) } }]) });
    assert.equal(response.body, body);
  }
});

test('AbortSignal cancels before sending or while receiving and removes listeners', async () => {
  const before = new AbortController();
  before.abort();
  const notCalled = transport([{ body: 'unused' }]);
  await assert.rejects(_fetchPage(PAGE, { signal: before.signal, request: notCalled }), hasCode('CANCELLED'));
  assert.equal(notCalled.calls.length, 0);
  const controller = new AbortController();
  const hanging = transport([{ hold: true }]);
  const pending = _fetchPage(PAGE, { signal: controller.signal, request: hanging });
  await new Promise((resolve) => process.nextTick(resolve));
  assert.ok(hanging.calls[0].req.response, 'response has started before cancellation');
  controller.abort();
  await assert.rejects(pending, hasCode('CANCELLED'));
  assert.equal(hanging.calls[0].req.destroyed, true);
  assert.equal(hanging.calls[0].req.response.destroyed, true);
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener(name, fn) { listeners.add(fn); },
    removeEventListener(name, fn) { listeners.delete(fn); }
  };
  await _fetchPage(PAGE, { signal, request: transport([{ body: 'ok' }]) });
  assert.equal(listeners.size, 0);
});

test('timeout spans redirect chains and stops requests without leaking hangs', async () => {
  const hanging = transport([{ noResponse: true }]);
  await assert.rejects(_fetchPage(PAGE, { timeoutMs: 15, request: hanging }), hasCode('TIMEOUT'));
  assert.equal(hanging.calls[0].req.destroyed, true);
  const redirectThenHang = transport([{ status: 302, headers: { location: MOBILE } }, { hold: true }]);
  await assert.rejects(_fetchPage(PAGE, { timeoutMs: 15, request: redirectThenHang }), hasCode('TIMEOUT'));
  assert.equal(redirectThenHang.calls.length, 2);
});

test('helper options and initial URL validation fail before a request', async () => {
  const request = transport([]);
  await assert.rejects(_fetchPage('https://evil.test/', { request }), hasCode('INVALID_URL'));
  for (const timeoutMs of [0, -1, NaN, Infinity, '100', 120001]) await assert.rejects(_fetchPage(PAGE, { request, timeoutMs }), hasCode('INVALID_OPTIONS'));
  for (const maxResponseBytes of [0, -1, 1.5, Infinity, 4 * 1024 * 1024 + 1]) await assert.rejects(_fetchPage(PAGE, { request, maxResponseBytes }), hasCode('INVALID_OPTIONS'));
  assert.equal(request.calls.length, 0);
});

test('fetchVideo tries the mobile share page first and desktop only if necessary', async () => {
  const mobile = transport([{ body: html({ item_list: [item()] }) }]);
  const result = await withRequests(mobile, () => fetchVideo(PAGE));
  assert.equal(result.id, ID);
  assert.equal(mobile.calls.length, 1);
  assert.equal(mobile.calls[0].url, MOBILE);
  const fallback = transport([{ body: '<html>请在浏览器打开</html>' }, { body: html({ aweme_detail: item() }) }]);
  const resolved = await withRequests(fallback, () => fetchVideo(PAGE));
  assert.equal(resolved.id, ID);
  assert.deepEqual(fallback.calls.map((call) => call.url), [MOBILE, PAGE]);
  assert.match(fallback.calls[1].options.headers['User-Agent'], /Windows/);
});

test('fetchVideo resolves a short link and never returns a recommended video', async () => {
  const request = transport([
    { status: 302, headers: { location: MOBILE } },
    { body: html({ item_list: [item({ aweme_id: OTHER_ID }), item()] }) }
  ]);
  const result = await withRequests(request, () => fetchVideo('https://v.douyin.com/Ab123/'));
  assert.equal(result.id, ID);
  assert.equal(request.calls.length, 2);
  const mismatch = transport(() => ({ body: html({ item_list: [item({ aweme_id: OTHER_ID })] }) }));
  await withRequests(mismatch, () => assert.rejects(fetchVideo(PAGE), hasCode('BROWSER_REQUIRED')));
});

test('short-page canonical URL supplies an exact ID, conflicting canonical IDs are refused', async () => {
  const body = '<link rel="canonical" href="' + PAGE + '">' + html({ aweme_detail: item() });
  const request = transport([{ body }]);
  const result = await withRequests(request, () => fetchVideo('https://v.douyin.com/Ab123/'));
  assert.equal(result.id, ID);
  const conflict = transport([{ body: '<link rel="canonical" href="' + PAGE + '"><meta property="og:url" content="https://www.douyin.com/video/' + OTHER_ID + '">' + html({ aweme_detail: item() }) }]);
  await withRequests(conflict, () => assert.rejects(fetchVideo('https://v.douyin.com/Ab123/'), hasCode('BROWSER_REQUIRED')));
});

test('fetchVideo failure exposes known final URL/id and distinguishes login, deletion, album', async () => {
  const login = transport(() => ({ body: '<h1>请先登录，登录后查看此视频</h1>' }));
  await withRequests(login, () => assert.rejects(fetchVideo(PAGE), (error) => {
    hasCode('LOGIN_REQUIRED')(error);
    assert.equal(error.videoId, ID);
    assert.equal(error.sourceUrl, PAGE);
    return true;
  }));
  const removed = transport(() => ({ body: JSON.stringify({ status_msg: '视频已删除' }) }));
  await withRequests(removed, () => assert.rejects(fetchVideo(PAGE), hasCode('VIDEO_NOT_FOUND')));
  const album = transport([{ body: html({ aweme_detail: item({ images: [{}], aweme_type: 68 }) }) }]);
  await withRequests(album, () => assert.rejects(fetchVideo(PAGE), hasCode('NOT_VIDEO')));
  assert.equal(album.calls.length, 1);
  const privateVideo = transport([{ body: html({ aweme_detail: item({ isPrivate: true }) }) }]);
  await withRequests(privateVideo, () => assert.rejects(fetchVideo(PAGE), hasCode('NOT_PUBLIC')));
  assert.equal(privateVideo.calls.length, 1, 'privacy failure must not trigger another page variant');
});

test('production fetchVideo ignores injected transport/options and honors cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  const request = transport([]);
  await withRequests(request, () => assert.rejects(fetchVideo(PAGE, { signal: controller.signal, timeoutMs: 100 }), hasCode('CANCELLED')));
  assert.equal(request.calls.length, 0);
  const actual = transport([{ body: html(item()) }]);
  let injectedCalled = false;
  await withRequests(actual, () => fetchVideo(PAGE, { request() { injectedCalled = true; }, maxResponseBytes: 1 }));
  assert.equal(injectedCalled, false);
});

test('redirect to a different exact video is refused before requesting the other video', async () => {
  const request = transport(() => ({ status: 302, headers: { location: 'https://www.douyin.com/video/' + OTHER_ID } }));
  await withRequests(request, () => assert.rejects(fetchVideo(PAGE), (error) => {
    hasCode('VIDEO_NOT_FOUND')(error);
    assert.equal(error.videoId, ID);
    return true;
  }));
  assert.ok(request.calls.every((call) => !call.url.includes(OTHER_ID)));
});

test('short-link page failure retains the resolved ID and tries the desktop variant', async () => {
  const request = transport([
    { status: 302, headers: { location: MOBILE } },
    { status: 404 },
    { body: html({ aweme_detail: item() }) }
  ]);
  const result = await withRequests(request, () => fetchVideo('https://v.douyin.com/Ab123/'));
  assert.equal(result.id, ID);
  assert.deepEqual(request.calls.map((call) => call.url), ['https://v.douyin.com/Ab123/', MOBILE, PAGE]);
  const challenge = transport([
    { status: 302, headers: { location: MOBILE } },
    { hold: true }
  ]);
  await withRequests(challenge, () => assert.rejects(fetchVideo('https://v.douyin.com/Ab123/', { timeoutMs: 15 }), (error) => {
    hasCode('TIMEOUT')(error);
    assert.equal(error.sourceUrl, MOBILE);
    assert.equal(error.videoId, ID);
    return true;
  }));
});

test('fetchVideo cancellation after response start destroys the active stream', async () => {
  const controller = new AbortController();
  const request = transport([{ hold: true }]);
  await withRequests(request, async () => {
    const pending = fetchVideo(PAGE, { signal: controller.signal });
    await new Promise((resolve) => process.nextTick(resolve));
    assert.ok(request.calls[0].req.response);
    controller.abort();
    await assert.rejects(pending, (error) => {
      hasCode('CANCELLED')(error);
      assert.equal(error.sourceUrl, MOBILE);
      assert.equal(error.videoId, ID);
      return true;
    });
  });
  assert.equal(request.calls.length, 1);
  assert.equal(request.calls[0].req.response.destroyed, true);
});
