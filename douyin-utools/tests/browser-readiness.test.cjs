'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { capturePage, videoFromSnapshot, createBrowserResolver } = require('../core/browser.cjs');
const parser = require('../core/parse.cjs');
const ID = '7652553551402503466';
const PAGE = `https://www.douyin.com/video/${ID}`;
const MEDIA = 'https://v3-web.douyinvod.com/test.mp4?synthetic=unchanged';
const item = () => ({ aweme_id: ID, desc: 'readiness fixture', video: { play_addr: { url_list: [MEDIA] }, duration: 12000, width: 720, height: 1280 } });
function fixture({ href = PAGE, videos = [], scripts = [], state = {} } = {}) {
  const context = vm.createContext({ location: new URL(href), URL, innerHeight: 760, innerWidth: 1060, window: state,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    document: { scripts, readyState: 'complete', title: 'fixture', visibilityState: 'hidden', body: { innerText: '登录' }, querySelector: () => null, querySelectorAll: () => videos } });
  return { context, ready: () => vm.runInContext(`(${capturePage})('ready', '${ID}')`, context),
    capture: () => JSON.parse(JSON.stringify(vm.runInContext(`(${capturePage})()`, context))) };
}
function native({ zero = false, src = MEDIA, info } = {}) {
  const video = { currentSrc: src, src: '', poster: '', videoWidth: 720, videoHeight: 1280, duration: 12,
    getBoundingClientRect: () => ({ width: zero ? 0 : 400, height: zero ? 0 : 500, left: 0, top: 0, right: 400, bottom: 500 }), querySelectorAll: () => [] };
  if (info) video.parentElement = { '__reactFiber$fixture': { memoizedProps: { awemeInfo: info } }, parentElement: null };
  return video;
}
function script(value, id = 'RENDER_DATA', type = '') { return { id, type, textContent: value, outerHTML: `<script id="${id}" type="${type}">${value}</script>` }; }
// Execute the ACTUAL serialized callbacks. Match installed 7.8's strict-true,
// 500ms polling and error.data containing only preceding evaluate results.
function pollingHost(f, { beforeProbe, beforeFinal } = {}) {
  let clock = 0, queue = [];
  const requests = [], captures = [];
  f.context.performance = { now: () => clock };
  f.context.document.hidden = true; f.context.document.hasFocus = () => false;
  const execute = (fn, args) => vm.runInContext(`(${fn})(...${JSON.stringify(args)})`, f.context);
  const chain = {
    goto(...args) { queue.push({ method: 'goto', args }); return chain; },
    evaluate(fn, ...args) { queue.push({ method: 'evaluate', fn, args }); return chain; },
    wait(fn, timeout, ...args) { queue.push({ method: 'wait', fn, timeout, args }); return chain; },
    show() { assert.fail('must not show'); }, focus() { assert.fail('must not focus'); },
    async run(options) {
      assert.equal(options.show, false);
      const operations = queue; queue = []; requests.push({ options, operations });
      const values = [];
      try {
        for (const op of operations) {
          if (op.method === 'goto') f.context.location = new URL(op.args[0]);
          if (op.method === 'evaluate') {
            if (op.args[0] === 'final' && beforeFinal) beforeFinal(clock);
            const value = execute(op.fn, op.args); values.push(value); captures.push(value);
          }
          if (op.method === 'wait') {
            let ready = false;
            for (let elapsed = 500; elapsed <= op.timeout; elapsed += 500) {
              clock += 500; if (beforeProbe) beforeProbe(clock);
              if (execute(op.fn, op.args) === true) { ready = true; break; }
            }
            if (!ready) throw new Error('synthetic native wait failsafe');
          }
        }
      } catch (error) { error.data = values; throw error; }
      return values;
    }
  };
  return { host: { ubrowser: chain }, requests, captures, get clock() { return clock; } };
}

test('readiness ignores document complete, login button text and bare video elements', () => {
  assert.equal(fixture().ready(), false);
  assert.equal(fixture({ videos: [native({ src: 'blob:https://www.douyin.com/unusable' })] }).ready(), false);
});
test('hidden document can be ready without playing video when exact public component data exists', () => {
  const info = { awemeId: ID, video: { playAddr: [{ src: MEDIA }] }, accountToken: 'do-not-export' };
  const f = fixture({ videos: [native({ src: 'blob:https://www.douyin.com/blob', info })] });
  assert.equal(f.ready(), true);
  assert.equal(JSON.stringify(f.capture()).includes('do-not-export'), false);
  assert.equal(videoFromSnapshot(f.capture(), ID, parser).id, ID);
});
test('zero and multiple geometrically eligible videos are not accepted as native/component fallback', () => {
  assert.equal(fixture({ videos: [native({ zero: true })] }).ready(), false);
  assert.equal(fixture({ videos: [native(), native()] }).ready(), false);
});
test('known different component identity cannot be relabeled as the route ID through native media fallback', () => {
  const video = native({ info: { awemeId: '7652553551402503467', video: { playAddr: [{ src: MEDIA }] } } });
  const f = fixture({ videos: [video] });
  assert.equal(f.ready(), false); assert.equal(f.capture().media.length, 0);
  assert.equal(videoFromSnapshot(f.capture(), ID, parser), null);
});
test('usable native dimensions, duration and allowed HTTPS address can satisfy readiness', () => {
  assert.equal(fixture({ videos: [native()] }).ready(), true);
  assert.equal(fixture({ videos: [native({ src: 'https://evil.test/file.mp4' })] }).ready(), false);
});
test('delayed exact hydration becomes ready after earlier attempts remain false, without visible geometry', () => {
  const f = fixture();
  for (let tick = 0; tick < 4; tick++) assert.equal(f.ready(), false);
  f.context.document.scripts.push(script(encodeURIComponent(JSON.stringify({ data: item() }))));
  assert.equal(f.ready(), true);
  assert.equal(videoFromSnapshot(f.capture(), ID, parser).id, ID);
});
test('readiness recognizes assigned router data and global hydration without requiring native playback', () => {
  assert.equal(fixture({ scripts: [script(`window._ROUTER_DATA = ${JSON.stringify({ data: item() })};`, '')] }).ready(), true);
  assert.equal(fixture({ state: { _ROUTER_DATA: { data: item() } } }).ready(), true);
});
test('a recommendation or exact-ID object with only a cover is not ready', () => {
  assert.equal(fixture({ state: { _ROUTER_DATA: { data: { ...item(), aweme_id: '7652553551402503467' } } } }).ready(), false);
  assert.equal(fixture({ state: { _ROUTER_DATA: { data: { aweme_id: ID, video: { cover: { url_list: [MEDIA] } } } } } }).ready(), false);
});
test('bounded hydration walks ignore getters and cycles', () => {
  let reads = 0;
  const data = {};
  Object.defineProperty(data, 'accountSecret', { enumerable: true, get() { reads++; throw new Error('must not read'); } });
  data.cycle = data; data.publicItem = item();
  assert.equal(fixture({ state: { _ROUTER_DATA: data } }).ready(), true);
  assert.equal(reads, 0);
});
test('wrong-video and unsafe pages stop readiness waiting so final validation rejects them', () => {
  const other = fixture({ href: 'https://www.douyin.com/video/7652553551402503467' });
  assert.equal(other.ready(), true);
  assert.throws(() => videoFromSnapshot(other.capture(), ID, parser), { code: 'VIDEO_MISMATCH' });
  const unsafe = fixture({ href: 'https://evil.test/' });
  assert.equal(unsafe.ready(), true);
  assert.throws(() => videoFromSnapshot(unsafe.capture(), ID, parser), { code: 'UNSAFE_REDIRECT' });
});
test('personal homepage never becomes the requested work merely because a recommendation video exists', () => {
  assert.equal(fixture({ href: 'https://www.douyin.com/user/synthetic-user', videos: [native()], state: { _ROUTER_DATA: item() } }).ready(), false);
});
test('incomplete component data cannot suppress valid exact-ID hydration, but terminal privacy still wins', () => {
  const snapshot = { kind: 'shiying-page', href: PAGE, media: [], publicVideo: { aweme_id: ID, video: {} }, html: JSON.stringify(item()) };
  assert.equal(videoFromSnapshot(snapshot, ID, parser).id, ID);
  assert.throws(() => videoFromSnapshot({ ...snapshot, publicVideo: { ...item(), is_private: true } }, ID, parser), { code: 'NOT_PUBLIC' });
});
test('safe diagnostics disclose page category and bounded counts, never native errors or snapshot secrets', async () => {
  const snapshot = { kind: 'shiying-page', href: 'https://www.douyin.com/user/private-route?token=SECRET', title: 'SECRET', html: 'SECRET', media: [],
    diagnostics: { videos: 0, eligible: 0, hydration: false, component: false, provenance: 'final',
      state: 'SECRET', visibility: 'SECRET', hidden: 'SECRET', focused: 'SECRET', stop: 'SECRET', scripts: 1000000, elapsedMs: 1000000, probes: 1000000 } };
  const chain = { goto() { return this; }, evaluate() { return this; }, wait() { return this; },
    run() { return Promise.reject(Object.assign(new Error('SECRET'), { data: [snapshot] })); } };
  const resolver = createBrowserResolver({ ubrowser: chain }, { parser });
  await assert.rejects(resolver.resolve(PAGE), error => {
    assert.equal(error.code, 'BACKGROUND_WAIT_FAILED'); assert.equal(error.diagnostics.provenance, 'early');
    assert.match(error.message, /仅早期观察，非结束时页面/); assert.match(error.message, /个人主页/);
    assert.equal(error.diagnostics.state, 'unknown'); assert.equal(error.diagnostics.visibility, 'unknown');
    for (const key of ['hidden', 'focused', 'scripts', 'elapsedMs', 'probes']) assert.equal(error.diagnostics[key], null);
    assert.equal(error.diagnostics.stop, 'unknown');
    assert.match(error.message, /视频节点 0/); assert.equal(error.message.includes('SECRET'), false);
    assert.equal(JSON.stringify(error).includes('SECRET'), false); return true;
  });
});
test('hydration root accessors are not executed by readiness or final capture', () => {
  let reads = 0;
  const state = {};
  Object.defineProperty(state, '_ROUTER_DATA', { enumerable: true, get() { reads++; throw new Error('must not read'); } });
  const f = fixture({ state });
  assert.equal(f.ready(), false); assert.equal(f.capture().html, ''); assert.equal(reads, 0);
});
test('usable early metadata is not reported as final success after a native callback failure', async () => {
  const snapshot = { kind: 'shiying-page', href: PAGE, publicVideo: item(), html: '', media: [] };
  let runs = 0;
  const chain = { goto() { return this; }, evaluate() { return this; }, wait() { return this; },
    run(options) { runs++; assert.equal(options.show, false); return Promise.reject(Object.assign(new Error('synthetic wait failure'), { data: [snapshot] })); } };
  const resolver = createBrowserResolver({ ubrowser: chain }, { parser });
  await assert.rejects(resolver.resolve(PAGE), error => {
    assert.equal(error.code, 'BACKGROUND_WAIT_FAILED'); assert.equal(error.diagnostics.provenance, 'early');
    assert.match(error.message, /仅早期观察，非结束时页面/); return true;
  });
  assert.equal(runs, 1);
});
test('usable component metadata cannot mask negative privacy or type evidence in hydration', () => {
  for (const [extra, code] of [[{ is_private: true }, 'NOT_PUBLIC'], [{ aweme_type: 68 }, 'NOT_VIDEO'], [{ is_live: true }, 'NOT_VIDEO']]) {
    const snapshot = { kind: 'shiying-page', href: PAGE, publicVideo: item(), media: [], html: JSON.stringify({ ...item(), ...extra }) };
    assert.throws(() => videoFromSnapshot(snapshot, ID, parser), { code });
  }
});
test('recognized JSON script shapes remain consumable regardless of their original type or identifier', () => {
  for (const [id, type] of [['__INITIAL_STATE__', ''], ['RENDER_DATA', 'application/json'], ['public-data', 'application/ld+json']]) {
    const f = fixture({ scripts: [script(JSON.stringify(item()), id, type)] });
    assert.equal(f.ready(), true); assert.equal(videoFromSnapshot(f.capture(), ID, parser).id, ID);
  }
});
test('both known global hydration roots produce consumable JSON snapshots after readiness', () => {
  for (const key of ['_ROUTER_DATA', '__INITIAL_STATE__']) {
    const f = fixture({ state: { [key]: { data: item() } } });
    assert.equal(f.ready(), true); assert.equal(videoFromSnapshot(f.capture(), ID, parser).id, ID);
  }
});
test('final global extraction never invokes nested getters/toJSON or exports unrelated account fields', () => {
  let reads = 0;
  const account = { token: 'account-secret', toJSON() { reads++; return 'account-secret'; } };
  Object.defineProperty(account, 'session', { enumerable: true, get() { reads++; return 'account-secret'; } });
  const f = fixture({ state: { _ROUTER_DATA: { account, publicItem: { ...item(), accountToken: 'account-secret' } } } });
  const snapshot = f.capture();
  assert.equal(reads, 0); assert.equal(JSON.stringify(snapshot).includes('account-secret'), false);
  assert.equal(videoFromSnapshot(snapshot, ID, parser).id, ID);
});
test('large unrelated and cyclic global state is bounded before serialization and does not hide public target', () => {
  const data = { unrelated: { huge: 'x'.repeat(4 * 1024 * 1024) }, publicItem: item() }; data.loop = data;
  const f = fixture({ state: { __INITIAL_STATE__: data } });
  const snapshot = f.capture();
  assert.ok(snapshot.html.length < 10000); assert.equal(videoFromSnapshot(snapshot, ID, parser).id, ID);
});
test('global public projection preserves privacy, albums, images and live negative gates', () => {
  for (const [extra, code] of [[{ is_private: true }, 'NOT_PUBLIC'], [{ status: { is_friend_limit: 1 } }, 'NOT_PUBLIC'],
    [{ aweme_type: 68 }, 'NOT_VIDEO'], [{ images: [{}] }, 'NOT_VIDEO'], [{ image_post_info: { image_list: [{}] } }, 'NOT_VIDEO'],
    [{ is_live: '1' }, 'NOT_VIDEO'], [{ liveRoomInfo: {} }, 'NOT_VIDEO']]) {
    const f = fixture({ state: { __INITIAL_STATE__: { data: { ...item(), ...extra } } } });
    assert.throws(() => videoFromSnapshot(f.capture(), ID, parser), { code });
  }
});

test('all-false readiness reaches a fresh final capture at the soft deadline in one hidden run', async () => {
  const f = fixture(); const fake = pollingHost(f);
  const resolver = createBrowserResolver(fake.host, { parser });
  await assert.rejects(resolver.resolve(PAGE), error => {
    assert.equal(error.code, 'BACKGROUND_NOT_READY'); assert.equal(error.diagnostics.provenance, 'final');
    assert.equal(error.diagnostics.stop, 'deadline'); assert.equal(error.diagnostics.elapsedMs, 8000);
    assert.equal(error.diagnostics.probes, 16); assert.equal(error.diagnostics.state, 'complete');
    assert.equal(error.diagnostics.visibility, 'hidden'); assert.equal(error.diagnostics.hidden, true);
    assert.equal(error.diagnostics.focused, false); assert.equal(error.diagnostics.scripts, 0);
    assert.match(error.message, /最终观察/); assert.doesNotMatch(error.message, /仅早期观察/); return true;
  });
  assert.equal(fake.requests.length, 1); assert.equal(fake.captures.length, 2);
  assert.deepEqual(fake.captures.map(s => s.diagnostics.provenance), ['early', 'final']);
  assert.equal(fake.captures[0].diagnostics.elapsedMs, 0); assert.equal(fake.captures[0].diagnostics.probes, 0);
  assert.deepEqual(Object.getOwnPropertyNames(f.context.window), [], 'final capture removes its own stopwatch');
});
test('data arriving after the soft deadline but before final capture is read, not replaced by early data', async () => {
  const currentId = '7702774431202267850', page = `https://www.douyin.com/video/${currentId}`;
  const f = fixture({ href: page });
  const fake = pollingHost(f, { beforeFinal(clock) {
    assert.equal(clock, 8000); f.context.window._ROUTER_DATA = { ...item(), aweme_id: currentId };
  } });
  const video = await createBrowserResolver(fake.host, { parser }).resolve(page);
  assert.equal(video.id, currentId); assert.equal(video.urls[0], MEDIA);
  assert.equal(fake.captures[0].html, ''); assert.equal(fake.captures[1].diagnostics.stop, 'deadline');
  assert.equal(fake.captures[1].diagnostics.hydration, true); assert.equal(fake.requests.length, 1);
});
test('usable data exits on the first 500ms host probe rather than waiting for the soft deadline', async () => {
  const f = fixture({ scripts: [script(JSON.stringify(item()))] }); const fake = pollingHost(f);
  assert.equal((await createBrowserResolver(fake.host, { parser }).resolve(PAGE)).id, ID);
  assert.equal(fake.clock, 500); assert.equal(fake.captures[1].diagnostics.probes, 1);
  assert.equal(fake.captures[1].diagnostics.stop, 'ready');
});
test('immediate native callback error exposes early-only provenance, not a fabricated final observation', async () => {
  const f = fixture({ scripts: [script(JSON.stringify(item()))] });
  const fake = pollingHost(f, { beforeProbe() {
    Object.defineProperty(f.context.document, 'scripts', { get() { throw new Error('DO_NOT_EXPORT_COOKIE_ACCOUNT_TEXT'); } });
  } });
  await assert.rejects(createBrowserResolver(fake.host, { parser }).resolve(PAGE), error => {
    assert.equal(error.code, 'BACKGROUND_WAIT_FAILED'); assert.equal(error.diagnostics.provenance, 'early');
    assert.equal(error.diagnostics.elapsedMs, 0); assert.equal(error.diagnostics.probes, 0);
    assert.equal(error.diagnostics.stop, 'waiting'); assert.equal(error.diagnostics.hydration, true);
    assert.match(error.message, /仅早期观察，非结束时页面/);
    assert.doesNotMatch(JSON.stringify({ message: error.message, ...error }), /DO_NOT_EXPORT|COOKIE|ACCOUNT_TEXT/); return true;
  });
  assert.equal(fake.captures.length, 1); assert.equal(fake.requests.length, 1);
});
test('all stages forward the same nonce and exact target, and native failsafe fits the default outer budget', async () => {
  for (const [configured, softMs] of [[0, 0], [1250, 1250], [8000, 8000], [100000, 8000], [NaN, 8000]]) {
    const fake = pollingHost(fixture({ scripts: [script(JSON.stringify(item()))] }));
    await createBrowserResolver(fake.host, { parser, backgroundWaitMs: configured }).resolve(PAGE);
    const [go, early, wait, final] = fake.requests[0].operations;
    assert.deepEqual(go.args, [PAGE, {}, 12000]);
    assert.equal(early.fn, capturePage); assert.equal(wait.fn, capturePage); assert.equal(final.fn, capturePage);
    const nonce = early.args[2]; assert.match(nonce, /^__shiying_obs_[a-f0-9]{24}$/);
    assert.deepEqual(early.args, ['early', ID, nonce, softMs]); assert.deepEqual(wait.args, ['ready', ID, nonce, softMs]);
    assert.deepEqual(final.args, ['final', ID, nonce, softMs]); assert.equal(wait.timeout, softMs + 2000);
    assert.ok(go.args[2] + wait.timeout <= 22000); assert.equal(fake.requests[0].options.show, false);
  }
});
test('document replacement cannot restart or extend the nonce-scoped deadline', async () => {
  const f = fixture(); const fake = pollingHost(f, { beforeProbe() { f.context.window = {}; } });
  await assert.rejects(createBrowserResolver(fake.host, { parser }).resolve(PAGE), error => {
    assert.equal(error.code, 'BACKGROUND_NOT_READY'); assert.equal(error.diagnostics.provenance, 'final');
    assert.equal(error.diagnostics.stop, 'lost'); assert.equal(error.diagnostics.elapsedMs, null); return true;
  });
  assert.equal(fake.clock, 500); assert.equal(fake.captures.length, 2);
});
test('soft expiry still subjects the FINAL snapshot to exact-ID, privacy and official-page gates', async () => {
  for (const [code, mutate] of [
    ['VIDEO_MISMATCH', f => { f.context.location = new URL('https://www.douyin.com/video/7702774431202267850'); }],
    ['NOT_PUBLIC', f => { f.context.window._ROUTER_DATA = { ...item(), is_private: true }; }],
    ['UNSAFE_REDIRECT', f => { f.context.location = new URL('https://example.test/private?DO_NOT_EXPORT'); }]
  ]) {
    const f = fixture(); const fake = pollingHost(f, { beforeFinal() { mutate(f); } });
    await assert.rejects(createBrowserResolver(fake.host, { parser }).resolve(PAGE), { code });
    assert.equal(fake.captures.length, 2); assert.equal(fake.requests.length, 1);
  }
});
test('a fulfilled partial result with only an early capture cannot masquerade as final success', async () => {
  const early = { kind: 'shiying-page', href: PAGE, publicVideo: item(), html: '', media: [], diagnostics: { provenance: 'early' } };
  const chain = { goto() { return this; }, evaluate() { return this; }, wait() { return this; }, run() { return Promise.resolve([early]); } };
  await assert.rejects(createBrowserResolver({ ubrowser: chain }, { parser }).resolve(PAGE), error => {
    assert.equal(error.code, 'BACKGROUND_NOT_READY'); assert.equal(error.diagnostics.page, 'none'); return true;
  });
});
