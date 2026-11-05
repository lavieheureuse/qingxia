'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserResolver, videoFromSnapshot, pageId, safePage, capturePage } = require('../core/browser.cjs');
const vm = require('node:vm');
const parser = require('../core/parse.cjs');
const ID = '7604129988555574538';
const URL = `https://www.douyin.com/video/${ID}`;
const MEDIA = 'https://v3-web.douyinvod.com/real.mp4?signed=unchanged';
const raw = { aweme_id: ID, desc: '测试标题', author: { nickname: '测试作者' }, video: { duration: 12000, width: 720, height: 1280, play_addr: { url_list: [MEDIA] } } };
function snap(extra = {}) { return { kind: 'shiying-page', href: URL, title: '标题', html: '', media: [], ...extra }; }
function hostWith(snapshot, { legacy = false, never = false } = {}) {
  const calls = [], requests = [], windows = new Map();
  let queue = [], nextId = 7;
  // uBrowser's queue is shared and eager, not local to a newly accessed chain.
  const chain = {
    goto(url, headers, timeout) { calls.push(['goto', url, headers, timeout]); queue.push(['goto', url]); return chain; },
    evaluate(fn, ...args) { assert.equal(fn, capturePage); calls.push(['evaluate', ...args]); queue.push(['evaluate', ...args]); return chain; },
    wait(fn, timeout, ...args) {
      assert.equal(fn, capturePage, 'readiness is a predicate, not a numeric sleep');
      assert.equal(typeof timeout, 'number'); assert.equal(args[0], 'ready');
      calls.push(['wait', timeout, ...args]); queue.push(['wait', timeout, ...args]); return chain;
    },
    run(options) {
      const operations = queue; queue = []; calls.push(['run', options]); requests.push({ options, operations });
      const hidden = typeof options === 'object' && options.show === false;
      if (typeof options === 'number') assert.ok(windows.has(options), 'numeric reads must target an existing owned window');
      let window = null;
      if (!hidden) {
        const id = typeof options === 'number' ? options : nextId++;
        window = { id, url: operations.find(op => op[0] === 'goto')?.[1] || windows.get(id)?.url || URL };
        windows.set(id, window);
      }
      if (never && operations.some(op => op[0] === 'evaluate')) return new Promise(() => {});
      const values = operations.filter(op => op[0] === 'evaluate').map(op => {
        const value = typeof snapshot === 'function' ? snapshot(...op.slice(1)) : snapshot;
        return value && value.kind === 'shiying-page' ? { ...value, diagnostics: { ...value.diagnostics, provenance: op[1] === 'early' ? 'early' : 'final' } } : value;
      });
      return Promise.resolve([...values, ...(legacy ? [] : [window])]);
    }
  };
  const host = { getIdleUBrowsers: () => [...windows.values()], ubrowser: chain };
  return { host, calls, requests, windows, get queued() { return queue.length; } };
}
function captureFixture({ id = ID, privateVideo = false, duplicate = false, flags = {} } = {}) {
  const visible = { currentSrc: 'blob:https://www.douyin.com/session', src: '', poster: '', videoWidth: 720, videoHeight: 1280, duration: 12,
    getBoundingClientRect: () => ({ width: 400, height: 500, left: 0, top: 0, right: 400, bottom: 500 }), querySelectorAll: () => [] };
  const info = { awemeId: id, desc: '公开标题</script>', isPrivate: privateVideo, ...flags,
    authorInfo: { nickname: '公开作者', accountSecrets: 'must-not-export' },
    cookie: 'must-not-export', video: { width: 720, height: 1280, duration: 12000,
      playAddr: [{ src: MEDIA }], playerAccessKey: 'must-not-export',
      bitRateList: [{ bitRate: 800000, gearName: 'normal', playAddr: [{ src: MEDIA }], playerAccessKey: 'must-not-export' }] } };
  visible.parentElement = { __reactFiber$test: { memoizedProps: { awemeInfo: info, user: { secret: 'must-not-export' } } }, parentElement: null };
  const context = { location: new globalThis.URL(URL), URL: globalThis.URL, innerHeight: 600, innerWidth: 800,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }), window: {},
    document: { scripts: [], title: '公开页面', body: { innerText: '' }, querySelector: () => null,
      querySelectorAll: () => duplicate ? [visible, visible] : [visible] } };
  return JSON.parse(JSON.stringify(vm.runInNewContext('(' + capturePage.toString() + ')()', context)));
}
test('actual desktop component shape survives blob playback without exporting account/runtime fields', () => {
  const snapshot = captureFixture();
  assert.equal(snapshot.publicVideo.aweme_id, ID);
  assert.equal(snapshot.publicVideo.desc, '公开标题</script>');
  assert.equal(snapshot.publicVideo.video.playAddr[0], MEDIA);
  assert.equal(JSON.stringify(snapshot).includes('must-not-export'), false);
  const video = videoFromSnapshot(snapshot, ID, parser);
  assert.equal(video.author, '公开作者'); assert.equal(video.urls[0], MEDIA);
});
test('component metadata refuses private, mismatched, or multiple visible videos', () => {
  assert.throws(() => videoFromSnapshot(captureFixture({ privateVideo: true }), ID, parser), { code: 'NOT_PUBLIC' });
  assert.equal(videoFromSnapshot(captureFixture({ id: '7604129988555574539' }), ID, parser), null);
  assert.equal(videoFromSnapshot(captureFixture({ duplicate: true }), ID, parser), null);
});
test('every known explicit private, friends-only or paid marker survives the component projection gate', () => {
  for (const field of ['isPrivate', 'is_private', 'isFriendLimit', 'is_friend_limit', 'isChargeVideo', 'is_charge_video', 'isPayVideo', 'is_pay_video', 'isPaidVideo', 'is_paid_video']) {
    assert.throws(() => videoFromSnapshot(captureFixture({ flags: { [field]: 1 } }), ID, parser), { code: 'NOT_PUBLIC' }, field);
  }
  for (const field of ['is_private', 'isPrivate', 'is_friend_limit', 'isFriendLimit']) {
    assert.throws(() => videoFromSnapshot(captureFixture({ flags: { status: { [field]: true } } }), ID, parser), { code: 'NOT_PUBLIC' }, 'status.' + field);
  }
});
test('trusted page policy and exact page IDs reject credential/port/lookalike origins', () => {
  assert.equal(pageId(URL), ID);
  assert.equal(pageId(`https://www.iesdouyin.com/share/video/${ID}/`), ID);
  assert.equal(pageId(`https://www.douyin.com/?modal_id=${ID}`), ID);
  for (const bad of ['http://www.douyin.com/video/' + ID, 'https://www.douyin.com.evil.test/video/' + ID, 'https://u:p@www.douyin.com/video/' + ID, 'https://www.douyin.com:444/video/' + ID]) {
    assert.equal(safePage(bad), false); assert.equal(pageId(bad), null);
  }
});
test('hydration parsing is tied to the exact requested ID', () => {
  const page = snap({ html: '<script>window._ROUTER_DATA=' + JSON.stringify(raw) + '</script>' });
  const video = videoFromSnapshot(page, ID, parser);
  assert.equal(video.id, ID); assert.equal(video.duration, 12); assert.equal(video.urls[0], MEDIA);
  assert.throws(() => videoFromSnapshot({ ...page, href: 'https://www.douyin.com/video/7604129988555574539' }, ID, parser), { code: 'VIDEO_MISMATCH' });
});
test('DOM fallback only accepts the single visible actual video and an exact route', () => {
  const media = { urls: [MEDIA], width: 720, height: 1280, duration: 12, poster: '' };
  assert.equal(videoFromSnapshot(snap({ media: [media] }), ID, parser).id, ID);
  assert.equal(videoFromSnapshot(snap({ media: [media, media] }), ID, parser), null);
  assert.equal(videoFromSnapshot(snap({ media: [{ ...media, urls: ['blob:https://www.douyin.com/x'] }] }), ID, parser), null);
  assert.equal(videoFromSnapshot(snap({ href: 'https://www.douyin.com/', media: [media] }), ID, parser), null);
  assert.equal(videoFromSnapshot(snap({ ogUrl: 'https://www.douyin.com/video/7604129988555574539', media: [media] }), ID, parser), null);
  assert.equal(videoFromSnapshot(snap({ media: [{ ...media, duration: 0 }] }), ID, parser), null);
});
test('recommendations, unsafe navigation, and unknown shortlink identity are never guessed', () => {
  assert.equal(videoFromSnapshot(snap({ href: 'https://v.douyin.com/AbCd/', html: JSON.stringify(raw) }), undefined, parser), null);
  assert.equal(videoFromSnapshot(snap({ html: JSON.stringify({ ...raw, aweme_id: '7604129988555574539' }) }), ID, parser), null);
  assert.throws(() => videoFromSnapshot(snap({ href: 'https://example.com/' }), ID, parser), { code: 'UNSAFE_REDIRECT' });
});
for (const legacy of [false, true]) {
  test(`uBrowser ${legacy ? 'legacy result array' : 'new result + window metadata'} reads hydration from an explicitly opened exact target`, async () => {
    const { host, calls } = hostWith(snap({ html: JSON.stringify(raw) }), { legacy });
    const browser = createBrowserResolver(host, { parser, pollMs: 1, waitMs: 20 });
    assert.equal(browser.available(), true);
    browser.setTarget(URL); await browser.openLogin();
    assert.equal(calls.filter(c => c[0] === 'run')[0][1].show, true);
    assert.equal((await browser.resolve(URL)).id, ID);
    assert.equal(calls.filter(c => c[0] === 'goto').length, 1);
    assert.equal(calls.filter(c => c[0] === 'run')[1][1], 7, 'reads its already-owned visible window by numeric ID');
    assert.equal((await browser.resolve(URL)).id, ID);
    assert.deepEqual(calls.filter(c => c[0] === 'run').slice(1).map(c => c[1]), [7, 7]);
    assert.equal(calls.filter(c => c[0] === 'goto').length, 1, 'resolve never reloads a usable exact target');
  });
}
test('shortlink must resolve to a concrete public video identity first', async () => {
  const { host } = hostWith(snap({ html: JSON.stringify(raw) }));
  const browser = createBrowserResolver(host, { parser, pollMs: 1, waitMs: 20 });
  assert.equal((await browser.resolve('https://v.douyin.com/AbCd/')).id, ID);
});
test('verification in an explicitly opened window fails finitely without visible navigation or invented success', async () => {
  const { host, calls, requests } = hostWith(snap({ verification: true }));
  const events = [];
  const browser = createBrowserResolver(host, { parser, pollMs: 1, waitMs: 8 });
  browser.setTarget(URL); await browser.openLogin();
  await assert.rejects(browser.resolve(URL, { onState: e => events.push(e) }), error => {
    assert.ok(['BROWSER_REQUIRED', 'BACKGROUND_NOT_READY', 'BACKGROUND_WAIT_FAILED'].includes(error.code)); return true;
  });
  assert.ok(events.length > 0); assert.ok(events.every(event => !('progress' in event)));
  for (const request of requests.slice(1)) {
    if (typeof request.options === 'number') assert.ok(request.operations.every(op => op[0] === 'evaluate'));
    else assert.equal(request.options.show, false, 'only a fresh hidden attempt may navigate during resolve');
  }
  assert.equal(calls.filter(c => c[0] === 'run' && typeof c[1] === 'object' && c[1].show === true).length, 1);
});
test('cancelling pending read of an explicitly opened window preserves the eager native lock', async () => {
  const fake = hostWith(null, { never: true });
  const browser = createBrowserResolver(fake.host, { parser, runTimeoutMs: 30 });
  browser.setTarget(URL); await browser.openLogin();
  const controller = new AbortController();
  const work = browser.resolve(URL, { signal: controller.signal });
  const rejected = assert.rejects(work, { code: 'CANCELLED' }); controller.abort(); await rejected;
  const count = fake.calls.length;
  await assert.rejects(browser.resolve(URL), { code: 'BROWSER_BUSY' });
  await assert.rejects(browser.openLogin(), { code: 'BROWSER_BUSY' });
  assert.equal(fake.calls.length, count); assert.equal(fake.queued, 0);
  assert.deepEqual(fake.calls.filter(c => c[0] === 'run').map(c => c[1]).slice(1), [7]);
  assert.equal(fake.calls.filter(c => c[0] === 'goto').length, 1);
});
test('unresponsive owned read is bounded without a popup; missing capability is explicit', async () => {
  const fake = hostWith(null, { never: true });
  const browser = createBrowserResolver(fake.host, { parser, runTimeoutMs: 8 });
  browser.setTarget(URL); await browser.openLogin();
  await assert.rejects(browser.resolve(URL), { code: 'BROWSER_TIMEOUT' });
  const count = fake.calls.length;
  await assert.rejects(browser.resolve(URL), { code: 'BROWSER_BUSY' });
  await assert.rejects(browser.openLogin(), { code: 'BROWSER_BUSY' });
  assert.equal(fake.calls.length, count); assert.equal(fake.queued, 0);
  assert.equal(fake.calls.filter(c => c[0] === 'goto').length, 1);
  const unavailable = createBrowserResolver({}, { parser });
  assert.equal(unavailable.available(), false);
  await assert.rejects(unavailable.resolve(URL), { code: 'BROWSER_UNAVAILABLE' });
});
test('a failed hidden resolve requires explicit openLogin before visible navigation and can then read the owned target', async () => {
  let value = snap({ verification: true });
  const fake = hostWith(() => value);
  const browser = createBrowserResolver(fake.host, { parser, pollMs: 1, waitMs: 8 });
  await assert.rejects(browser.resolve(URL), error => {
    assert.ok(['BROWSER_REQUIRED', 'BACKGROUND_NOT_READY', 'BACKGROUND_WAIT_FAILED'].includes(error.code)); return true;
  });
  assert.equal(fake.windows.size, 0);
  assert.ok(fake.requests.every(request => request.options.show === false));
  browser.setTarget(URL); await browser.openLogin();
  value = snap({ html: JSON.stringify(raw) });
  assert.equal((await browser.resolve(URL)).id, ID);
  const visibleRuns = fake.requests.filter(request => typeof request.options === 'object' && request.options.show === true);
  assert.equal(visibleRuns.length, 1); assert.deepEqual(visibleRuns[0].operations.map(op => op[0]), ['goto']);
  assert.equal(fake.requests.at(-1).options, 7);
  assert.deepEqual(fake.requests.at(-1).operations.map(op => op[0]), ['evaluate']);
});
test('login opener does not trigger parsing or download and only accepts known hosts', async () => {
  const { host, calls } = hostWith(snap());
  const browser = createBrowserResolver(host, { parser });
  assert.throws(() => browser.setTarget('https://evil.test/'), { code: 'INVALID_URL' });
  browser.setTarget(URL); await browser.openLogin();
  assert.equal(calls.filter(c => c[0] === 'goto')[0][1], URL);
  assert.equal(calls.some(c => c[0] === 'evaluate'), false);
});
