'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the unmodified renderer with an in-memory DOM and a fake host only.
// These tests never load Electron, use the network, or touch user downloads.
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const video = { id: 'fixture-video', title: '测试视频', author: '测试作者', duration: 12, sourceUrl: 'https://www.douyin.com/video/123' };
const saved = { path: path.resolve('fixture-video.mp4'), bytes: 1024 };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    async emit(type, event = {}) {
      event.type = type;
      event.preventDefault ||= () => {};
      await Promise.all((listeners.get(type) || []).map(callback => callback(event)));
    }
  };
}
function element(tag = 'div') {
  const attributes = new Map();
  const classes = new Set();
  const node = Object.assign(eventTarget(), {
    tagName: tag.toUpperCase(), value: '', textContent: '', hidden: false,
    disabled: false, children: [], className: '', open: false, returnValue: '',
    classList: {
      add(...names) { names.forEach(name => classes.add(name)); },
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      }
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    removeAttribute(name) { attributes.delete(name); },
    replaceChildren(...nodes) { this.children = nodes; },
    append(...nodes) { this.children.push(...nodes.flatMap(child => child && child.tagName === 'FRAGMENT' ? child.children : [child])); },
    focus() { this.focused = true; },
    showModal() { this.open = true; }
  });
  // Dynamic host strings must never be interpreted as HTML.
  Object.defineProperty(node, 'innerHTML', { set() { throw new Error('Unsafe innerHTML assignment'); } });
  return node;
}

async function createUI(options = {}) {
  const nodes = new Map();
  const calls = {};
  let stateListener;
  const implementations = {
    bootstrap: async () => ({ capabilities: { host: true, browser: true }, settings: { outputDir: path.resolve('fixture-downloads') }, history: [], version: 'test' }),
    resolve: async () => ({ ...video }),
    download: async () => ({ ...saved }),
    cancel: async () => undefined,
    getHistory: async () => [],
    clearHistory: async () => [],
    readClipboard: async () => 'fixture clipboard text',
    chooseDirectory: async () => null,
    openLogin: async () => {},
    openFile: async () => {},
    revealFile: async () => {},
    ...options.bridge
  };
  const bridge = {};
  for (const [name, implementation] of Object.entries(implementations)) {
    calls[name] = [];
    bridge[name] = (...args) => { calls[name].push(args); return implementation(...args); };
  }
  bridge.onState = callback => { stateListener = callback; return () => { stateListener = undefined; }; };
  const document = Object.assign(eventTarget(), {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    createElement: element,
    createElementNS(_namespace, name) { return element(name); },
    createDocumentFragment() { return element('fragment'); },
    createTextNode(value) { return { textContent: value }; },
    querySelector() { return document.getElementById('tablist'); }
  });
  const window = Object.assign(eventTarget(), { location: { search: options.search || '' } });
  if (!options.absent) window.douyin = bridge;
  const context = { window, document, URL, URLSearchParams, console, setTimeout() { return 1; }, clearTimeout() {} };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'app.js' });
  await flush();
  return {
    calls, bridge, document, window,
    node: id => document.getElementById(id),
    state(event) { assert.equal(typeof stateListener, 'function'); stateListener(event); },
    async resolve() {
      document.getElementById('share-input').value = 'https://www.douyin.com/video/123';
      await document.getElementById('share-input').emit('input');
      await document.getElementById('resolve-form').emit('submit');
    }
  };
}

test('static preview has no fabricated tasks and disables host actions', async () => {
  const ui = await createUI({ absent: true });
  assert.equal(ui.node('environment-text').textContent, '界面预览');
  assert.match(ui.node('host-notice-text').textContent, /请在 uTools 中运行/);
  for (const id of ['resolve-button', 'paste-button', 'login-button', 'choose-directory', 'clear-history']) assert.equal(ui.node(id).disabled, true, id);
  assert.equal(ui.node('phase-badge').textContent, '等待解析');
  assert.equal(ui.node('empty-preview').hidden, false);
  assert.equal(ui.node('history-list').children.length, 0);
  assert.equal(ui.calls.bootstrap.length, 0);
});

test('design preview never bootstraps a present host or simulates success', async () => {
  const ui = await createUI({ search: '?design=1' });
  assert.equal(ui.node('environment-text').textContent, 'UI 设计预览');
  assert.equal(ui.node('host-notice').hidden, true);
  assert.equal(ui.calls.bootstrap.length, 0);
  assert.equal(ui.node('resolve-button').disabled, true);
  assert.equal(ui.node('phase-badge').textContent, '等待解析');
});

test('plugin input fills text but never resolves or downloads automatically', async () => {
  const ui = await createUI();
  const input = '分享文本 https://v.douyin.com/fixture/';
  await ui.window.emit('douyin:input', { detail: input });
  assert.equal(ui.node('share-input').value, input);
  assert.equal(ui.calls.resolve.length, 0);
  assert.equal(ui.calls.download.length, 0);
  assert.equal(ui.node('download-panel').hidden, false);
  assert.equal(ui.node('share-input').focused, true);
});

test('resolve only previews; explicit download preserves the host warning', async () => {
  const warning = '文件已保存，但记录写入失败。';
  const ui = await createUI({ bridge: { download: async () => ({ ...saved, warning }) } });
  await ui.resolve();
  assert.equal(ui.node('phase-badge').textContent, '已解析');
  assert.equal(ui.calls.resolve.length, 1);
  assert.equal(ui.calls.download.length, 0);
  await ui.node('download-button').emit('click');
  assert.equal(ui.calls.download.length, 1);
  assert.equal(ui.calls.download[0][0], video.id);
  assert.equal(ui.node('phase-badge').textContent, '已保存');
  assert.match(ui.node('status-message').textContent, /记录写入失败/);
  assert.equal(ui.node('open-file-button').hidden, false);
  assert.equal(ui.node('reveal-button').hidden, false);
  assert.match(ui.node('saved-path').textContent, /fixture-video\.mp4/);
});

test('download runtime failures preserve the preview and do not imply login is required', async () => {
  const message = '下载运行环境异常（ERR_INVALID_ARG_TYPE），请更新并重新加载插件后重试。';
  const ui = await createUI({ bridge: { download: async () => { throw Object.assign(new Error(message), { code: 'HOST_RUNTIME_ERROR' }); } } });
  await ui.resolve();
  await ui.node('download-button').emit('click');
  assert.equal(ui.node('phase-badge').textContent, '未能完成');
  assert.equal(ui.node('status-message').textContent, message);
  assert.equal(ui.node('video-title').textContent, video.title);
  assert.equal(ui.node('download-button').disabled, false);
  assert.match(ui.node('login-hint').textContent, /不一定与登录有关/);
  assert.doesNotMatch(ui.node('login-hint').textContent, /登录后再重试/);
});

for (const [phase, label] of [['ready', '已解析'], ['complete', '已保存'], ['error', '未能完成'], ['cancelled', '已停止']]) {
  test(`cancel honors the host's ${phase} terminal snapshot and ignores a late download result`, async () => {
    const download = deferred();
    const snapshot = { phase, message: `host:${phase}`, video: { ...video }, result: phase === 'complete' ? { ...saved } : undefined };
    const ui = await createUI({ bridge: { download: () => download.promise, cancel: async () => snapshot } });
    await ui.resolve();
    const pending = ui.node('download-button').emit('click');
    await flush();
    assert.equal(ui.node('phase-badge').textContent, '正在下载');
    await ui.node('cancel-button').emit('click');
    assert.equal(ui.node('phase-badge').textContent, label);
    assert.equal(ui.node('status-message').textContent, `host:${phase}`);
    download.resolve({ ...saved });
    await pending;
    assert.equal(ui.node('phase-badge').textContent, label);
    assert.equal(ui.node('status-message').textContent, `host:${phase}`);
  });
}

test('legacy cancel returning undefined still stops the current task', async () => {
  const download = deferred();
  const ui = await createUI({ bridge: { download: () => download.promise } });
  await ui.resolve();
  const pending = ui.node('download-button').emit('click');
  await ui.node('cancel-button').emit('click');
  assert.equal(ui.node('phase-badge').textContent, '已停止');
  assert.equal(ui.node('cancel-button').hidden, true);
  download.resolve({ ...saved });
  await pending;
  assert.equal(ui.node('phase-badge').textContent, '已停止');
});

test('authoritative complete snapshot corrects a cancelled event after the file was committed', async () => {
  const download = deferred();
  let ui;
  ui = await createUI({ bridge: {
    download: () => download.promise,
    cancel: async () => {
      ui.state({ phase: 'cancelled', message: 'intermediate' });
      return { phase: 'complete', message: '已保存文件', video: { ...video }, result: { ...saved } };
    }
  } });
  await ui.resolve();
  const pending = ui.node('download-button').emit('click');
  await ui.node('cancel-button').emit('click');
  assert.equal(ui.node('phase-badge').textContent, '已保存');
  assert.equal(ui.node('open-file-button').hidden, false);
  assert.equal(ui.node('status-message').textContent, '已保存文件');
  download.resolve({ ...saved });
  await pending;
});

test('background resolution remains busy without opening login or fabricating download progress', async () => {
  const resolving = deferred();
  const ui = await createUI({ bridge: { resolve: () => resolving.promise } });
  assert.match(ui.node('login-hint').textContent, /优先后台解析/);
  const work = ui.resolve(); await flush();
  ui.state({ phase: 'resolving', message: '正在后台读取抖音网页，沿用此插件已有的登录会话…' });
  assert.equal(ui.node('phase-badge').textContent, '正在解析');
  assert.equal(ui.node('resolve-button').disabled, true);
  assert.equal(ui.node('login-button').disabled, true);
  assert.equal(ui.node('cancel-button').hidden, false);
  assert.equal(ui.node('download-progress').hidden, true);
  assert.equal(ui.calls.openLogin.length, 0); assert.equal(ui.calls.download.length, 0);
  resolving.resolve({ ...video }); await work;
  assert.equal(ui.node('phase-badge').textContent, '已解析');
  assert.equal(ui.calls.openLogin.length, 0);
});

test('manual login button only opens the page, never automatically parses or downloads', async () => {
  const ui = await createUI();
  await ui.node('login-button').emit('click');
  assert.equal(ui.calls.openLogin.length, 1);
  assert.equal(ui.calls.resolve.length, 0); assert.equal(ui.calls.download.length, 0);
});

test('waiting events do not invent progress and switching tabs never cancels', async () => {
  const resolving = deferred();
  const ui = await createUI({ bridge: { resolve: () => resolving.promise } });
  ui.node('share-input').value = 'https://www.douyin.com/video/123';
  const pending = ui.node('resolve-form').emit('submit');
  ui.state({ phase: 'waiting', message: '等待真实页面', progress: { percent: 70 } });
  assert.equal(ui.node('download-progress').hidden, true);
  assert.equal(ui.node('download-progress').getAttribute('value'), null);
  assert.equal(ui.node('progress-detail').hidden, true);
  await ui.node('history-tab').emit('click');
  assert.equal(ui.node('active-task-banner').hidden, false);
  await ui.node('download-tab').emit('click');
  assert.equal(ui.calls.cancel.length, 0);
  assert.equal(ui.node('phase-badge').textContent, '等待页面');
  resolving.resolve({ ...video });
  await pending;
});

test('JSON titles and source strings remain text; untrusted cover domains are rejected', async () => {
  const title = '<img src=x onerror=alert(1)>';
  const ui = await createUI({ bridge: { resolve: async () => ({ ...video, title, sourceUrl: 'javascript:alert(1)', cover: 'https://example.invalid/cover.jpg' }) } });
  await ui.resolve();
  assert.equal(ui.node('video-title').textContent, title);
  assert.equal(ui.node('video-source').textContent, '来源：javascript:alert(1)');
  assert.equal(ui.node('video-cover').getAttribute('src'), null);
  assert.equal(ui.node('video-cover').hidden, true);
  assert.equal(ui.node('cover-fallback').hidden, false);
});
