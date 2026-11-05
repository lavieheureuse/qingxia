'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const apiNames = ['bootstrap', 'resolve', 'download', 'cancel', 'chooseDirectory', 'getHistory', 'clearHistory', 'openFile', 'revealFile', 'openLogin', 'readClipboard', 'onState'];
const share = '视频分享 https://www.douyin.com/video/123';

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, callback, options = {}) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ callback, once: !!options.once });
    },
    dispatchEvent(event) {
      for (const registration of [...(listeners.get(event.type) || [])]) {
        if (registration.once) listeners.set(event.type, (listeners.get(event.type) || []).filter(item => item !== registration));
        registration.callback(event);
      }
      return true;
    }
  };
}

function loadPreload(options = {}) {
  const calls = { require: [], parse: [], store: [], browser: [], service: [], downloadFactory: 0, dispose: 0, clipboard: 0, heights: [], legacyHeights: [], enter: [], out: [], input: [] };
  const apiCalls = Object.fromEntries(apiNames.map(name => [name, []]));
  const store = Object.freeze({ marker: 'in-memory store' });
  const downloader = Object.freeze({ marker: 'in-memory downloader' });
  const browser = Object.freeze({ marker: 'in-memory browser', dispose() { calls.dispose += 1; } });
  const clipboard = Object.freeze({ readText() { calls.clipboard += 1; throw new Error('Tests must never read clipboard'); } });
  const parser = Object.freeze({
    parseShareInput(input) {
      calls.parse.push(input);
      if (!input.includes('douyin.com/')) throw new Error('Invalid share input');
      return { url: 'https://www.douyin.com/video/123' };
    }
  });
  const service = {};
  for (const name of apiNames) {
    service[name] = (...args) => {
      apiCalls[name].push(args);
      if (name === 'onState') return () => {};
      return Promise.resolve(name === 'getHistory' ? [] : undefined);
    };
  }
  Object.freeze(service);
  const host = {
    getPath(name) {
      if (options.pathThrows) throw new Error('Host path unavailable');
      return options.relativePaths ? 'relative-not-accepted' : `C:\\fixture\\${name}`;
    },
    onPluginEnter(callback) { calls.enter.push(callback); },
    onPluginOut(callback) { calls.out.push(callback); }
  };
  if (!options.noHeightAPI) {
    if (!options.legacyHeight) host.setExpandHeight = height => calls.heights.push(height);
    host.setExpendHeight = height => calls.legacyHeights.push(height);
  }
  const window = eventTarget();
  const document = Object.assign(eventTarget(), { readyState: options.loading ? 'loading' : 'complete' });
  window.addEventListener('douyin:input', event => calls.input.push(event.detail));
  if (options.windowHost) window.utools = host;
  function mockRequire(name) {
    calls.require.push(name);
    switch (name) {
      case 'node:path': return path.win32;
      case 'node:os': return { homedir: () => 'C:\\fixture\\home' };
      case './core/storage.cjs': return { createStore(directory) {
        calls.store.push(directory);
        if (options.storeError) throw new Error(options.storeError);
        return store;
      } };
      case './core/download.cjs': return { createDownloader() { calls.downloadFactory += 1; return downloader; } };
      case './core/parse.cjs': return parser;
      case './core/transient.cjs': return { createTransientResolver(dependencies) { calls.browser.push(dependencies); return browser; } };
      case './core/service.cjs': return { createService(dependencies) { calls.service.push(dependencies); if (options.serviceError) throw new Error(options.serviceError); return service; } };
      case 'electron': if (options.noElectron) throw new Error('Electron is not available'); else return { clipboard };
      default: throw new Error(`Unexpected dependency: ${name}`);
    }
  }
  const context = { window, document, require: mockRequire, CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } } };
  if (!options.windowHost && !options.noHost) context.utools = host;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'preload.js' });
  return {
    calls, apiCalls, window, document, host, service, store, downloader, browser, parser, clipboard,
    enter(action) { calls.enter.forEach(callback => callback(action)); },
    out() { calls.out.forEach(callback => callback()); },
    domReady() { document.readyState = 'interactive'; document.dispatchEvent({ type: 'DOMContentLoaded' }); }
  };
}

test('preload exposes only the narrow service, not Node/core capabilities', () => {
  const fixture = loadPreload();
  assert.equal(fixture.window.douyin, fixture.service);
  assert.deepEqual(Object.keys(fixture.window.douyin).sort(), [...apiNames].sort());
  assert.equal(Object.isFrozen(fixture.window.douyin), true);
  for (const name of ['require', 'fs', 'parser', 'store', 'browser', 'clipboard', 'downloader', 'fetch', 'shell']) assert.equal(name in fixture.window.douyin, false, name);
  assert.equal('require' in fixture.window, false);
  const dependencies = fixture.calls.service[0];
  assert.equal(dependencies.host, fixture.host);
  assert.equal(dependencies.store, fixture.store);
  assert.equal(dependencies.browser, fixture.browser);
  assert.equal(dependencies.downloader, fixture.downloader);
  assert.equal(dependencies.clipboard, fixture.clipboard);
  assert.equal(dependencies.parser, fixture.parser);
  assert.equal(dependencies.defaultDirectory, 'C:\\fixture\\downloads\\拾影');
  assert.equal(fixture.calls.store[0], 'C:\\fixture\\userData\\shiying-douyin-plugin');
  assert.equal(fixture.calls.browser[0].dataDirectory, fixture.calls.store[0]);
  assert.equal(fixture.calls.browser[0].parser, fixture.parser);
  assert.equal(dependencies.version, '0.2.0');
  assert.ok(!fixture.calls.require.includes('./core/browser.cjs'));
  assert.equal(fixture.calls.clipboard, 0);
});

test('plugin entry dispatches validated input only, without parsing/downloading it through the service', () => {
  const fixture = loadPreload();
  fixture.enter({ payload: share });
  assert.deepEqual(fixture.calls.input, [share]);
  assert.deepEqual(fixture.calls.parse, [share]);
  assert.equal(fixture.apiCalls.resolve.length, 0);
  assert.equal(fixture.apiCalls.download.length, 0);
  assert.equal(fixture.calls.clipboard, 0);
  assert.deepEqual(fixture.calls.heights, [600]);
  assert.deepEqual(fixture.calls.legacyHeights, []);
});

test('non-string, empty and rejected plugin payloads never reach the renderer', () => {
  const fixture = loadPreload();
  for (const payload of [undefined, null, {}, ['text'], 42, '', 'not a video share']) fixture.enter({ payload });
  fixture.enter(undefined);
  assert.deepEqual(fixture.calls.input, []);
  assert.equal(fixture.apiCalls.resolve.length, 0);
  assert.equal(fixture.apiCalls.download.length, 0);
});

test('input waits for DOMContentLoaded and only the latest pending text is delivered once', () => {
  const fixture = loadPreload({ loading: true });
  const second = `${share} 第二次输入`;
  fixture.enter({ payload: share });
  fixture.enter({ payload: second });
  assert.deepEqual(fixture.calls.input, []);
  fixture.domReady();
  assert.deepEqual(fixture.calls.input, [second]);
  fixture.domReady();
  assert.deepEqual(fixture.calls.input, [second]);
  fixture.enter({ payload: share });
  assert.deepEqual(fixture.calls.input, [second, share]);
  assert.equal(fixture.apiCalls.resolve.length, 0);
  assert.equal(fixture.apiCalls.download.length, 0);
});

test('delivered plugin input is bounded to 20000 characters', () => {
  const fixture = loadPreload();
  fixture.enter({ payload: `${share}${'x'.repeat(25000)}` });
  assert.equal(fixture.calls.input.length, 1);
  assert.equal(fixture.calls.input[0].length, 20000);
});

test('legacy 7.x host height API and window.utools host discovery are supported', () => {
  const fixture = loadPreload({ legacyHeight: true, windowHost: true });
  fixture.enter({ payload: share });
  assert.deepEqual(fixture.calls.heights, []);
  assert.deepEqual(fixture.calls.legacyHeights, [600]);
  assert.equal(fixture.calls.service[0].host, fixture.host);
  assert.deepEqual(fixture.calls.input, [share]);
});

test('plugin entry works when optional height APIs are absent', () => {
  const fixture = loadPreload({ noHeightAPI: true });
  fixture.enter({ payload: share });
  assert.deepEqual(fixture.calls.input, [share]);
  assert.deepEqual(fixture.calls.heights, []);
  assert.deepEqual(fixture.calls.legacyHeights, []);
});

test('hiding the plugin never cancels; unloading the renderer cancels once', () => {
  const fixture = loadPreload();
  assert.equal(fixture.calls.out.length, 0, 'preload must not register an onPluginOut cancellation');
  fixture.out();
  assert.equal(fixture.apiCalls.cancel.length, 0);
  fixture.window.dispatchEvent({ type: 'beforeunload' });
  assert.equal(fixture.apiCalls.cancel.length, 1);
  assert.equal(fixture.calls.dispose, 1);
  fixture.window.dispatchEvent({ type: 'beforeunload' });
  assert.equal(fixture.apiCalls.cancel.length, 1);
  assert.equal(fixture.calls.dispose, 1);
});

for (const option of ['relativePaths', 'pathThrows']) {
  test(`hostPath uses in-memory home fallbacks when ${option}`, () => {
    const fixture = loadPreload({ [option]: true });
    assert.equal(fixture.calls.store[0], 'C:\\fixture\\home\\.config\\shiying-douyin-plugin');
    assert.equal(fixture.calls.service[0].defaultDirectory, 'C:\\fixture\\home\\Downloads\\拾影');
  });
}

test('missing Electron clipboard is optional and never triggers a real clipboard read', () => {
  const fixture = loadPreload({ noElectron: true });
  assert.equal(fixture.window.douyin, fixture.service);
  assert.equal(fixture.calls.service[0].clipboard, undefined);
  assert.equal(fixture.calls.clipboard, 0);
});

for (const option of ['storeError', 'serviceError']) {
  test(`initialization ${option} produces a safe bootstrap error bridge`, async () => {
    const fixture = loadPreload({ [option]: `fixture initialization failure${'x'.repeat(500)}` });
    assert.deepEqual(Object.keys(fixture.window.douyin).sort(), ['bootstrap', 'onState']);
    assert.equal(Object.isFrozen(fixture.window.douyin), true);
    await assert.rejects(fixture.window.douyin.bootstrap(), error => {
      assert.equal(error.code, 'INITIALIZATION_FAILED');
      assert.match(error.message, /^插件初始化失败：fixture initialization failure/);
      assert.ok(error.message.length <= '插件初始化失败：'.length + 400);
      return true;
    });
    const unsubscribe = fixture.window.douyin.onState(() => {});
    assert.equal(typeof unsubscribe, 'function');
    assert.doesNotThrow(unsubscribe);
    assert.equal(fixture.calls.enter.length, 0);
    assert.equal(fixture.calls.out.length, 0);
    assert.equal(fixture.calls.clipboard, 0);
  });
}
