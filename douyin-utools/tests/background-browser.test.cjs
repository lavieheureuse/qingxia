'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserResolver, capturePage } = require('../core/browser.cjs');
const parser = require('../core/parse.cjs');
const ID = '7678695071319841723';
const PAGE = `https://www.douyin.com/video/${ID}`;
const MEDIA = 'https://v3-web.douyinvod.com/video.mp4?signature=kept-in-backend';
const raw = { aweme_id: ID, desc: '公开视频', author: { nickname: '作者' }, video: { duration: 10000, width: 1920, height: 1080, play_addr: { url_list: [MEDIA] } } };
function snapshot(extra = {}) { return { kind: 'shiying-page', href: PAGE, html: '', media: [], publicVideo: raw, ...extra }; }

// Commands queue eagerly on the shared host, including commands queued before a
// failed run. Hidden windows disappear at completion; only explicit visible runs
// enter idle-window lookup. Native wait failures retain preceding evaluate data.
function makeHost({ hidden = snapshot(), early = hidden, visible = snapshot(), wait = true, idle = true, legacy = false, hiddenMetadata = null, defer = false, waitFailure = false } = {}) {
  let queue = [];
  let nextId = 7;
  let hiddenRuns = 0;
  const windows = new Map();
  const calls = [], requests = [], deferred = [];
  let idleLookups = 0;
  const chain = {
    goto(url, headers, timeout) { calls.push(['goto', url]); queue.push(['goto', url, headers, timeout]); return chain; },
    evaluate(fn, ...args) { assert.equal(fn, capturePage); calls.push(['evaluate', ...args]); queue.push(['evaluate', fn, ...args]); return chain; },
    show(...args) { calls.push(['show', ...args]); return chain; },
    focus(...args) { calls.push(['focus', ...args]); return chain; },
    run(options) {
      const operations = queue; queue = [];
      const isHidden = typeof options === 'object' && options.show === false;
      const request = { options, operations, hidden: isHidden };
      requests.push(request); calls.push(['run', options]);
      if (typeof options === 'number') assert.ok(windows.has(options), 'cannot recreate a missing owned window');
      let window = null;
      if (!isHidden) {
        const id = typeof options === 'number' ? options : nextId++;
        const url = operations.find(op => op[0] === 'goto')?.[1] || windows.get(id)?.url || PAGE;
        window = { id, url }; windows.set(id, window);
      }
      const values = [];
      let failure = isHidden && hidden instanceof Error ? hidden : null;
      let captures = 0;
      if (!failure) for (const operation of operations) {
        if (operation[0] === 'wait' && isHidden && waitFailure) {
          failure = waitFailure instanceof Error ? waitFailure : new Error('native predicate wait timed out');
          failure.data = [...values];
          break;
        }
        if (operation[0] === 'evaluate') {
          const source = isHidden ? captures++ === 0 ? early : hidden : visible;
          const value = typeof source === 'function' ? source(...operation.slice(2)) : source;
          values.push(value?.kind === 'shiying-page' ? { ...value, diagnostics: { ...value.diagnostics, provenance: operation[2] === 'early' ? 'early' : 'final' } } : value);
        }
      }
      const result = [...values, ...(legacy ? [] : [isHidden ? hiddenMetadata : window])];
      if (isHidden && defer && hiddenRuns++ === 0) return new Promise((resolve, reject) => deferred.push({ resolve: () => resolve(result), reject }));
      return failure ? Promise.reject(failure) : Promise.resolve(result);
    }
  };
  if (wait) chain.wait = (fn, timeout, ...args) => {
    assert.equal(fn, capturePage, 'wait must use the capture predicate, never a numeric sleep');
    assert.equal(typeof timeout, 'number');
    assert.equal(args[0], 'ready');
    calls.push(['wait', fn, timeout, ...args]); queue.push(['wait', fn, timeout, ...args]); return chain;
  };
  const host = { ubrowser: chain };
  if (idle) host.getIdleUBrowsers = () => { idleLookups++; return [...windows.values()]; };
  return { host, calls, requests, deferred, windows, get idleLookups() { return idleLookups; }, get queued() { return queue.length; } };
}
const resolver = (fake, extra = {}) => createBrowserResolver(fake.host, { parser, pollMs: 1, waitMs: 1, ...extra });
const settled = () => new Promise(resolve => setImmediate(resolve));
const diagnosticCodes = ['BACKGROUND_NOT_READY', 'BACKGROUND_WAIT_FAILED', 'BROWSER_REQUIRED'];
function cleanDiagnostic(error) {
  assert.ok(diagnosticCodes.includes(error.code), `expected clean background diagnostic, got ${error.code}`);
  assert.doesNotMatch(JSON.stringify({ message: error.message, ...error }), /DO_NOT_EXPORT|example\.test|signature=|kept-in-backend/);
  return true;
}
function onlyHidden(fake) {
  assert.equal(fake.calls.some(call => ['show', 'focus'].includes(call[0])), false, 'resolve must not show or focus a window');
  assert.ok(fake.requests.every(request => request.hidden), 'resolve must never create/show a visible window');
  assert.equal(fake.windows.size, 0);
  assert.equal(fake.queued, 0);
}

test('background parse navigates, captures early, predicate-waits and captures final in ONE hidden queue', async () => {
  const fake = makeHost({ early: snapshot({ publicVideo: null, verification: true }) });
  const events = [];
  const video = await resolver(fake).resolve(PAGE, { onState: event => events.push(event) });
  assert.equal(video.id, ID); assert.equal(video.urls[0], MEDIA);
  assert.equal(fake.requests.length, 1);
  const request = fake.requests[0];
  assert.deepEqual(request.operations.map(op => op[0]), ['goto', 'evaluate', 'wait', 'evaluate']);
  assert.deepEqual(request.operations[0], ['goto', PAGE, {}, 12000]);
  const nonce = request.operations[1][4];
  assert.match(nonce, /^__shiying_obs_[a-f0-9]{24}$/);
  assert.deepEqual(request.operations[1], ['evaluate', capturePage, 'early', ID, nonce, 8000]);
  assert.deepEqual(request.operations[2], ['wait', capturePage, 10000, 'ready', ID, nonce, 8000]);
  assert.deepEqual(request.operations[3], ['evaluate', capturePage, 'final', ID, nonce, 8000]);
  onlyHidden(fake); assert.equal(fake.idleLookups, 0);
  assert.deepEqual(events.map(e => e.phase), ['resolving']);
  assert.doesNotMatch(JSON.stringify(events), /signature|kept-in-backend/);
});

test('backgroundWaitMs overrides predicate timeout rather than adding a numeric sleep', async () => {
  const fake = makeHost();
  await resolver(fake, { backgroundWaitMs: 4 }).resolve(PAGE);
  const nonce = fake.requests[0].operations[1][4];
  assert.deepEqual(fake.requests[0].operations.find(op => op[0] === 'wait'), ['wait', capturePage, 2004, 'ready', ID, nonce, 4]);
  onlyHidden(fake);
});

test('repeat parsing after explicit login never navigates or recreates the visible target', async () => {
  const fake = makeHost(); const browser = resolver(fake);
  browser.setTarget(PAGE); await browser.openLogin();
  assert.equal(fake.requests[0].options.show, true);
  assert.deepEqual(fake.requests[0].operations.map(op => op[0]), ['goto']);
  const beforeRead = fake.calls.length;
  await browser.resolve(PAGE); await browser.resolve(PAGE);
  assert.equal(fake.calls.slice(beforeRead).some(call => ['show', 'focus'].includes(call[0])), false);
  assert.equal(fake.requests.length, 3);
  for (const request of fake.requests.slice(1)) {
    assert.ok(request.hidden || request.options === 7, 'only a fresh hidden run or owned numeric read is allowed');
    if (!request.hidden) assert.ok(request.operations.every(op => op[0] === 'evaluate'), 'owned visible target must not be navigated');
  }
  assert.equal(fake.windows.size, 1); assert.equal(fake.windows.get(7).url, PAGE);
});

for (const options of [{ legacy: true }, { idle: false }, { hiddenMetadata: { id: 999, url: PAGE } }]) {
  test(`hidden results do not require or remember window metadata: ${JSON.stringify(options)}`, async () => {
    const fake = makeHost(options); const browser = resolver(fake);
    assert.equal((await browser.resolve(PAGE)).id, ID);
    browser.setTarget(PAGE); await browser.openLogin();
    assert.equal(fake.requests[1].options.show, true);
    assert.equal(typeof fake.requests[1].options, 'object');
  });
}

test('short share URL uses null readiness ID and resolves the trusted final public video identity', async () => {
  const fake = makeHost({ early: snapshot({ href: 'https://v.douyin.com/omcSav7QtFs/', publicVideo: null }) });
  const video = await resolver(fake).resolve('https://v.douyin.com/omcSav7QtFs/');
  assert.equal(video.id, ID);
  assert.equal(fake.requests[0].operations[0][1], 'https://v.douyin.com/omcSav7QtFs/');
  const wait = fake.requests[0].operations.find(op => op[0] === 'wait');
  assert.deepEqual(wait.slice(3, 5), ['ready', null]);
  assert.equal(wait[5], fake.requests[0].operations[1][4]);
  assert.equal(wait[6], 8000);
  onlyHidden(fake);
});

for (const [name, hidden] of [
  ['verification without public data', snapshot({ publicVideo: null, verification: true })],
  ['empty snapshot', null],
  ['settled host exception', new Error('private https://example.test/?token=DO_NOT_EXPORT')]
]) {
  test(`${name} fails cleanly on repeated attempts without an automatic popup`, async () => {
    const fake = makeHost({ hidden }); const browser = resolver(fake); const events = [];
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(browser.resolve(PAGE, { onState: e => events.push(e) }), cleanDiagnostic);
    assert.equal(fake.requests.length, 2);
    onlyHidden(fake);
    assert.doesNotMatch(JSON.stringify(events), /DO_NOT_EXPORT|example\.test|signature|kept-in-backend|正在打开|已打开/);
  });
}

test('native predicate timeout retains one early capture for a clean diagnostic, never a visible fallback', async () => {
  const fake = makeHost({ early: snapshot({ publicVideo: null, verification: true }), waitFailure: new Error('https://example.test/?token=DO_NOT_EXPORT') });
  await assert.rejects(resolver(fake).resolve(PAGE), cleanDiagnostic);
  assert.equal(fake.requests.length, 1);
  onlyHidden(fake);
});

for (const [code, value] of [
  ['UNSAFE_REDIRECT', snapshot({ href: 'https://example.test/video/' + ID })],
  ['VIDEO_MISMATCH', snapshot({ href: 'https://www.douyin.com/video/7604129988555574538' })],
  ['NOT_PUBLIC', snapshot({ restricted: true })]
]) {
  for (const waitFailure of [false, true]) test(`terminal hidden ${code} ${waitFailure ? 'in early native error.data' : 'in final capture'} does not open another browser`, async () => {
    const fake = makeHost({ hidden: value, waitFailure });
    await assert.rejects(resolver(fake).resolve(PAGE), { code });
    assert.equal(fake.requests.length, 1); onlyHidden(fake);
  });
}

for (const [code, visible] of [
  ['UNSAFE_REDIRECT', snapshot({ href: 'https://example.test/' })],
  ['VIDEO_MISMATCH', snapshot({ href: 'https://www.douyin.com/video/7604129988555574538' })],
  ['NOT_PUBLIC', snapshot({ restricted: true })]
]) {
  test(`terminal ${code} from an owned exact-target read is not repaired by another navigation`, async () => {
    const fake = makeHost({ visible }); const browser = resolver(fake);
    browser.setTarget(PAGE); await browser.openLogin();
    await assert.rejects(browser.resolve(PAGE), { code });
    assert.equal(fake.requests.length, 2); assert.equal(fake.requests[1].options, 7);
    assert.deepEqual(fake.requests[1].operations.map(op => op[0]), ['evaluate']);
  });
}

test('older host without predicate wait capability returns a clean explicit error without queuing a visible fallback', async () => {
  const fake = makeHost({ wait: false }); const events = [];
  await assert.rejects(resolver(fake).resolve(PAGE, { onState: e => events.push(e) }), error => {
    assert.ok(['BROWSER_REQUIRED', 'BACKGROUND_UNSUPPORTED'].includes(error.code)); return true;
  });
  assert.deepEqual(fake.calls, []); assert.equal(fake.queued, 0); assert.equal(fake.windows.size, 0);
  assert.doesNotMatch(JSON.stringify(events), /正在打开|已打开/);
});

for (const [name, change] of [
  ['closed', fake => fake.windows.delete(7)],
  ['changed video', fake => fake.windows.set(7, { id: 7, url: 'https://www.douyin.com/video/7604129988555574538' })],
  ['nonexact homepage', fake => fake.windows.set(7, { id: 7, url: 'https://www.douyin.com/' })],
  ['unsafe page', fake => fake.windows.set(7, { id: 7, url: 'https://example.test/' })],
  ['unverifiable window', fake => { delete fake.host.getIdleUBrowsers; }]
]) {
  test(`${name} manually-owned window causes a fresh hidden attempt, never visible recreation or hijacking`, async () => {
    const fake = makeHost(); const browser = resolver(fake);
    browser.setTarget(PAGE); await browser.openLogin(); change(fake);
    const before = [...fake.windows.entries()], beforeRead = fake.calls.length;
    assert.equal((await browser.resolve(PAGE)).id, ID);
    assert.equal(fake.calls.slice(beforeRead).some(call => ['show', 'focus'].includes(call[0])), false);
    assert.equal(fake.requests.length, 2);
    assert.equal(fake.requests[1].hidden, true);
    assert.deepEqual([...fake.windows.entries()], before);
    assert.equal(fake.requests.filter(request => !request.hidden).length, 1);
  });
}

test('unowned exact-target idle window is not read or hijacked', async () => {
  const fake = makeHost(); fake.windows.set(42, { id: 42, url: PAGE });
  assert.equal((await resolver(fake).resolve(PAGE)).id, ID);
  assert.equal(fake.requests.length, 1); assert.equal(fake.requests[0].hidden, true);
  assert.deepEqual([...fake.windows.keys()], [42]);
});

test('already aborted request adds no uBrowser operations', async () => {
  const fake = makeHost(); const controller = new AbortController(); controller.abort();
  await assert.rejects(resolver(fake).resolve(PAGE, { signal: controller.signal }), { code: 'CANCELLED' });
  assert.deepEqual(fake.calls, []);
});

for (const outcome of ['resolve', 'reject']) {
  test(`cancel keeps native queue locked; late ${outcome} cannot pop up or publish state`, async () => {
    const fake = makeHost({ defer: true }); const browser = resolver(fake); const events = [];
    const controller = new AbortController();
    const work = browser.resolve(PAGE, { signal: controller.signal, onState: e => events.push(e) });
    const rejected = assert.rejects(work, { code: 'CANCELLED' }); controller.abort(); await rejected;
    const count = fake.calls.length;
    await assert.rejects(browser.resolve(PAGE), { code: 'BROWSER_BUSY' });
    await assert.rejects(browser.openLogin(), { code: 'BROWSER_BUSY' });
    assert.equal(fake.calls.length, count); assert.equal(fake.queued, 0);
    const states = events.length;
    fake.deferred[0][outcome](new Error('late failure')); await settled();
    assert.equal(events.length, states); assert.equal(fake.requests.length, 1); onlyHidden(fake);
    assert.equal((await browser.resolve(PAGE)).id, ID); onlyHidden(fake);
  });

  test(`outer timeout keeps native lock until late ${outcome}, never starts visible work`, async () => {
    const fake = makeHost({ defer: true }); const browser = resolver(fake, { runTimeoutMs: 8 }); const events = [];
    await assert.rejects(browser.resolve(PAGE, { onState: e => events.push(e) }), { code: 'BROWSER_TIMEOUT' });
    const count = fake.calls.length;
    await assert.rejects(browser.resolve(PAGE), { code: 'BROWSER_BUSY' });
    await assert.rejects(browser.openLogin(), { code: 'BROWSER_BUSY' });
    assert.equal(fake.calls.length, count); assert.equal(fake.requests.length, 1); assert.equal(fake.queued, 0);
    const states = events.length;
    fake.deferred[0][outcome](new Error('late failure')); await settled();
    assert.equal(events.length, states); assert.equal(fake.requests.length, 1);
    assert.equal((await browser.resolve(PAGE)).id, ID); onlyHidden(fake);
  });
}
