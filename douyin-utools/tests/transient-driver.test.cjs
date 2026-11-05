'use strict';

// Offline only: all filesystem, child processes, process-tree signals, and WebSockets
// used by launch() below are injected fakes. No browser/network/profile is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Buffer } = require('node:buffer');
const { EventEmitter } = require('node:events');
const { createDriver, DiagnosticError, _internals: helpers } = require('../core/transient-driver.cjs');
const _internals={...helpers,profileRoot:path.resolve(__dirname,'virtual-profiles')};

let sequence = 0;
const SECRET = 'PRIVATE_COOKIE_SIGNED_URL_NATIVE_ERROR';
const nativeError = (code) => Object.assign(new Error(SECRET), { code });

function environment(settings = {}) {
  const name = `offline-${++sequence}`;
  const profile = path.join(_internals.profileRoot, name);
  const executable = path.resolve(__dirname, 'mock-installed-browser.exe');
  const entries = new Map();
  const changes = [], spawns = [], syncSpawns = [], probes = [], wires = [], sockets = [], signals = [];
  const directory = (p) => entries.set(p, { kind: 'directory' });
  const file = (p, text = '') => entries.set(p, { kind: 'file', text });
  const info = (p) => {
    const entry = entries.get(p);
    if (!entry) throw nativeError('ENOENT');
    return {
      isFile: () => entry.kind === 'file',
      isDirectory: () => entry.kind === 'directory',
      isSymbolicLink: () => entry.kind === 'symlink',
      size: Buffer.byteLength(entry.text || ''), dev: 1, ino: entry.ino || 1,
    };
  };
  directory(__dirname);
  file(executable);
  if (settings.existingProfile || settings.symlinkProfile || settings.existingLock || settings.stalePort) {
    directory(_internals.profileRoot);
    directory(profile);
    if (!settings.unmarkedProfile) file(path.join(profile, '.transient-cdp-owner.json'),
      JSON.stringify({ owner: 'shiying-transient-chromium-v1', profile: name }));
  }
  if (settings.symlinkProfile) entries.set(profile, { kind: 'symlink' });
  if (settings.existingLock) file(path.join(profile, '.transient-cdp.lock'), 'another-owner');
  if (settings.stalePort) file(path.join(profile, 'DevToolsActivePort'), '12345\n/devtools/browser/old\n');
  const io = {
    async stat(p) { if (settings.pendingStat) await settings.pendingStat; if (settings.statError) throw nativeError('EACCES'); return info(p); },
    async lstat(p) { return info(p); },
    async mkdir(p) {
      changes.push(['mkdir', p]);
      if (entries.has(p)) throw nativeError('EEXIST');
      directory(p);
    },
    async realpath(p) { info(p); return p; },
    async readFile(p) {
      info(p);
      if (settings.readPortError && p.endsWith('DevToolsActivePort')) throw nativeError('EACCES');
      return entries.get(p).text;
    },
    async writeFile(p, text, options) {
      if (options?.flag === 'wx' && entries.has(p)) throw nativeError('EEXIST');
      file(p, text);
    },
    async open(p, flags) {
      changes.push(['open-lock', p]);
      if (settings.pendingLock) await settings.pendingLock;
      if (flags !== 'wx') throw new Error('Test expected exclusive lock creation.');
      if (entries.has(p)) throw nativeError('EEXIST');
      file(p);
      return {
        async writeFile(text) { if (settings.pendingLockWrite) await settings.pendingLockWrite; file(p, text); },
        async close() { changes.push(['close-handle', p]); },
      };
    },
    async unlink(p) {
      info(p);
      changes.push(['unlink', p]);
      entries.delete(p);
    },
  };
  class Child extends EventEmitter {
    constructor(pid = 43210) { super(); this.pid = pid; this.exitCode = null; this.signalCode = null; }
    exit(code = 0) {
      if (this.exitCode !== null || this.signalCode !== null) return;
      this.exitCode = code;
      this.emit('exit', code, null);
    }
    kill() { changes.push(['helper-kill', this.pid]); this.exit(1); return true; }
  }
  let child;
  function spawn(command, args, options) {
    spawns.push({ command, args, options });
    if (command.endsWith('taskkill.exe')) {
      const helper = new Child(54321);
      queueMicrotask(() => {
        if (!settings.killNoExit) child.exit(1);
        helper.exit(0);
      });
      return helper;
    }
    if (settings.spawnThrows) throw nativeError('EACCES');
    osGone = false;
    child = new Child(settings.invalidPid ? undefined : 43210);
    if (settings.invalidPid) child.pid = undefined;
    if (!settings.noPort) file(path.join(profile, 'DevToolsActivePort'), settings.badPort || '55555\n/devtools/browser/owned-test\n');
    if (settings.spawnError) queueMicrotask(() => child.emit('error', nativeError('EACCES')));
    if (settings.exitAtStartup) queueMicrotask(() => child.exit(1));
    return child;
  }
  class Socket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.events = new EventEmitter();
      sockets.push(this);
      if (settings.socketThrows) throw nativeError('ECONNREFUSED');
      if (!settings.neverOpen) queueMicrotask(() => {
        if (settings.socketError) { this.emit('error', { message: SECRET }); return; }
        if (this.readyState === 3) return;
        this.readyState = 1;
        this.emit('open', {});
      });
    }
    addEventListener(type, fn) { this.events.on(type, fn); }
    removeEventListener(type, fn) { this.events.off(type, fn); }
    emit(type, event) { this.events.emit(type, event); }
    response(request, payload) {
      this.emit('message', { data: JSON.stringify({ id: request.id,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}), ...payload }) });
    }
    send(raw) {
      if (settings.sendThrows) throw nativeError('EPIPE');
      const request = JSON.parse(raw);
      wires.push(request);
      if (settings.noReply === request.method) return;
      queueMicrotask(() => {
        if (request.method === 'Browser.close') {
          if (settings.ignoreBrowserClose) return;
          this.response(request, { result: {} });
          child.exit(0);
          return;
        }
        if (settings.protocolError === request.method) {
          this.response(request, { error: { code: -32000, message: SECRET, data: SECRET } });
          return;
        }
        if (request.method === 'Target.createTarget') return this.response(request, { result: { targetId: 'owned-target' } });
        if (request.method === 'Target.attachToTarget') return this.response(request, { result: { sessionId: 'owned-session' } });
        if (request.method === 'Runtime.evaluate') {
          return this.response(request, { result: settings.evaluationError
            ? { exceptionDetails: { text: SECRET, stackTrace: SECRET } }
            : { result: { type: 'number', value: 42 } } });
        }
        if (request.method === 'Page.navigate' && settings.navigationError) {
          return this.response(request, { result: { errorText: SECRET } });
        }
        this.response(request, { result: {} });
      });
    }
    close() { this.readyState = 3; changes.push(['socket-close']); }
  }
  let osGone = false;
  const syncIO = {
    lstatSync(p) { changes.push(['sync-lstat', p]); return info(p); },
    realpathSync(p) { info(p); return settings.syncRealpathMismatch ? p + '-changed' : p; },
    readFileSync(p) {
      info(p);
      if (settings.syncReadThrows) throw nativeError('EACCES');
      const text = entries.get(p).text;
      if (settings.syncSwapInode) entries.get(p).ino = 2;
      return text;
    },
    unlinkSync(p) { info(p); changes.push(['sync-unlink', p]); entries.delete(p); },
  };
  const driverOptions = { profileRoot:_internals.profileRoot, fs: io, fsSync: syncIO, spawn, WebSocket: Socket, platform: settings.platform || 'win32',
    spawnSync(command,args,options) {
      syncSpawns.push({command,args,options});
      if (settings.syncKillThrows) throw nativeError('ETIMEDOUT');
      const status = settings.syncKillStatus === undefined ? 0 : settings.syncKillStatus;
      if (status === 0 && !settings.killNoExit) osGone = true;
      return {status,error:settings.syncKillError ? nativeError('EACCES') : undefined};
    },
    isOwnedPidGone(pid) { probes.push(['pid',pid]); if(settings.probeThrows)throw nativeError('EPERM');return osGone && !settings.pidStillExists; },
    isOwnedGroupGone(pid) { probes.push(['group',pid]); return osGone && !settings.groupStillExists; },
    killGroup(pid) { signals.push(pid); if (!settings.killNoExit) {osGone=true;if(!settings.groupNoExitEvent)child.exit(1);} } };
  const driver = createDriver(driverOptions);
  const options = { executablePath: executable, userDataDir: profile,
    startupTimeoutMs: 200, commandTimeoutMs: 30, totalTimeoutMs: 2000,
    closeTimeoutMs: 15, killTimeoutMs: 15 };
  return { driver, options, entries, changes, spawns, syncSpawns, probes, wires, sockets, signals,
    newDriver: () => createDriver(driverOptions), get child() { return child; } };
}

async function reached(predicate) {
  for (let attempt = 0; attempt < 30 && !predicate(); attempt++) await new Promise(setImmediate);
  assert.equal(!!predicate(), true, 'offline fixture did not reach expected phase');
}

function safeError(code) {
  return (e) => {
    assert.ok(e instanceof DiagnosticError);
    if (code) assert.equal(e.code, code);
    assert.ok(!`${e}\n${e.stack}\n${JSON.stringify(e)}`.includes(SECRET));
    assert.equal(e.cause, undefined);
    return true;
  };
}

test('port parser pins loopback and rejects URL/host/query/path injection', () => {
  assert.equal(_internals.parseActivePort('9234\r\n/devtools/browser/abc-123\r\n'),
    'ws://127.0.0.1:9234/devtools/browser/abc-123');
  for (const value of ['0\n/devtools/browser/x', '65536\n/devtools/browser/x',
    '9222\nws://external/devtools/browser/x', '9222\n/devtools/browser/x?secret=1',
    '9222\n/devtools/browser/../other', '9222\n/devtools/page/x', 'x'.repeat(1000)]) {
    assert.throws(() => _internals.parseActivePort(value), safeError('CONNECT'));
  }
});

test('fixed launch flags have no anti-detection, extension, signature, or arbitrary flags', () => {
  assert.deepEqual(_internals.launchArguments('OWN'), ['--user-data-dir=OWN', '--headless=new', '--window-size=1060,760',
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--disable-background-mode',
    '--disable-extensions', '--no-first-run', '--no-default-browser-check', 'about:blank']);
});

test('configuration rejects arbitrary args, external endpoint/PID, missing executable, and foreign profile', async () => {
  const env = environment();
  for (const extra of [{ args: ['--anything'] }, { endpoint: 'ws://127.0.0.1:1' }, { pid: 1234 },
    { executablePath: 'chrome' }, { userDataDir: path.resolve(__dirname, 'foreign') },
    { commandTimeoutMs: Infinity }, { totalTimeoutMs: 600001 }]) {
    await assert.rejects(env.driver.launch({ ...env.options, ...extra }), safeError());
  }
  assert.equal(env.spawns.length, 0);
  assert.equal(env.changes.length, 0);
});

test('ordinary lifecycle: own target/session, enable domains, navigate/evaluate, events, graceful idempotent close', async () => {
  const env = environment();
  const browser = await env.driver.launch(env.options);
  try {
    assert.equal(env.spawns.length, 1);
    assert.deepEqual(env.spawns[0].options, { shell: false, windowsHide: true, stdio: 'ignore', detached: false });
    assert.equal(env.spawns[0].command, env.options.executablePath);
    assert.equal(env.sockets[0].url, 'ws://127.0.0.1:55555/devtools/browser/owned-test');
    const page = await browser.createTarget();
    const enabled = env.wires.filter((wire) => /\.enable$/.test(wire.method));
    assert.deepEqual(enabled.map((wire) => wire.method).sort(), ['Network.enable', 'Page.enable', 'Runtime.enable']);
    assert.ok(enabled.every((wire) => wire.sessionId === 'owned-session'));
    await page.navigate('https://www.douyin.com/diagnostic?input=private');
    assert.deepEqual(await page.evaluate('6 * 7'), { type: 'number', value: 42 });
    let observed = 0;
    const off = page.on('Network.responseReceived', (params) => { observed += params.marker; });
    env.sockets[0].emit('message', { data: JSON.stringify({ sessionId: 'foreign', method: 'Network.responseReceived', params: { marker: 100 } }) });
    env.sockets[0].emit('message', { data: JSON.stringify({ sessionId: 'owned-session', method: 'Network.responseReceived', params: { marker: 1 } }) });
    off();
    env.sockets[0].emit('message', { data: JSON.stringify({ sessionId: 'owned-session', method: 'Network.responseReceived', params: { marker: 100 } }) });
    assert.equal(observed, 1);
    await assert.rejects(page.send('Browser.close'), safeError('CONFIG'));
    await assert.rejects(page.evaluate('x', null), safeError('CONFIG'));
    await assert.rejects(page.evaluate('x', { get awaitPromise() { throw nativeError('EACCES'); } }), safeError('CONFIG'));
    assert.throws(() => page.on(Symbol('not-a-method'), () => {}), safeError('CONFIG'));
    await assert.rejects(page.navigate('file:///private/account'), safeError('CONFIG'));
    await assert.rejects(page.navigate('https://user:password@example.invalid/'), safeError('CONFIG'));
    await page.close();
    await page.close();
    await assert.rejects(page.send('Page.enable'), safeError('CLOSED'));
  } finally { await browser.close(); }
  const firstClose = browser.close();
  assert.equal(firstClose, browser.close());
  await firstClose;
  assert.equal(env.spawns.length, 1);
  assert.equal(env.wires.filter((wire) => wire.method === 'Browser.close').length, 1);
  assert.ok(!env.entries.has(path.join(env.options.userDataDir, '.transient-cdp.lock')));
  assert.ok(env.entries.has(path.join(env.options.userDataDir, '.transient-cdp-owner.json')));
});

test('withBrowser closes in finally when consumer throws', async () => {
  const env = environment();
  const consumer = new Error('consumer-only');
  await assert.rejects(env.driver.withBrowser(env.options, async () => { throw consumer; }), (e) => e === consumer);
  assert.equal(env.child.exitCode, 0);
  assert.ok(env.wires.some((wire) => wire.method === 'Browser.close'));
});

test('existing own profile is reusable; only verified fixed control files are removed', async () => {
  const env = environment({ stalePort: true });
  const browser = await env.driver.launch(env.options);
  await browser.close();
  const removals = env.changes.filter(([operation]) => operation === 'unlink').map(([, filename]) => filename);
  assert.deepEqual(removals, [path.join(env.options.userDataDir, 'DevToolsActivePort'),
    path.join(env.options.userDataDir, '.transient-cdp.lock')]);
  assert.ok(!env.sockets[0].url.includes('12345'));
  const second = await env.driver.launch(env.options);
  await second.close();
});

test('unmarked existing profile, symlink profile, and existing lock fail without spawning', async () => {
  for (const settings of [{ existingProfile: true, unmarkedProfile: true }, { symlinkProfile: true }, { existingLock: true }]) {
    const env = environment(settings);
    await assert.rejects(env.driver.launch(env.options), safeError(settings.existingLock ? 'PROFILE_BUSY' : undefined));
    assert.equal(env.spawns.length, 0);
    assert.equal(env.changes.filter(([operation]) => operation === 'unlink').length, 0);
  }
});

test('same-process concurrent launch cannot share a profile', async () => {
  const env = environment();
  const browser = await env.driver.launch(env.options);
  try { await assert.rejects(env.driver.launch(env.options), safeError('PROFILE_BUSY')); }
  finally { await browser.close(); }
});

test('native spawn/fs/socket/protocol/evaluation/navigation errors are redacted', async () => {
  for (const settings of [{ statError: true }, { spawnThrows: true }, { socketThrows: true },
    { socketError: true }, { spawnError: true }, { exitAtStartup: true }]) {
    const env = environment(settings);
    await assert.rejects(env.driver.launch(env.options), safeError());
  }
  for (const settings of [{ protocolError: 'Page.navigate' }, { evaluationError: true }, { navigationError: true }, { sendThrows: true }]) {
    const env = environment(settings);
    const browser = await env.driver.launch(env.options);
    try {
      if (settings.sendThrows) await assert.rejects(browser.createTarget(), safeError('CONNECT'));
      else {
        const page = await browser.createTarget();
        await assert.rejects(settings.evaluationError ? page.evaluate('private()') : page.navigate('https://www.douyin.com/'), safeError());
      }
    } finally { await browser.close(); }
  }
});

test('startup timeout never attaches through absent, malformed, or unreadable port file; cleanup is bounded', async () => {
  for (const settings of [{ noPort: true }, { badPort: '55555\nws://external/forbidden' }, { readPortError: true }, { neverOpen: true }]) {
    const env = environment(settings);
    const before = Date.now();
    await assert.rejects(env.driver.launch({ ...env.options, startupTimeoutMs: 25 }), safeError('STARTUP_TIMEOUT'));
    assert.ok(Date.now() - before < 1000);
    assert.equal(env.child.exitCode, 1);
    assert.equal(env.spawns[1].command.endsWith('taskkill.exe'), true);
    assert.deepEqual(env.spawns[1].args, ['/PID', '43210', '/T', '/F']);
    assert.ok(!env.entries.has(path.join(env.options.userDataDir, '.transient-cdp.lock')));
  }
});

test('command timeout ignores wrong-session replies and malformed JSON without leaking payload', async () => {
  const env = environment({ noReply: 'Runtime.evaluate' });
  const browser = await env.driver.launch(env.options);
  try {
    const page = await browser.createTarget();
    const command = page.evaluate('private()');
    const request = env.wires.at(-1);
    env.sockets[0].emit('message', { data: '{bad json ' + SECRET });
    env.sockets[0].emit('message', { data: JSON.stringify({ id: request.id, sessionId: 'other', result: { value: SECRET } }) });
    await assert.rejects(command, safeError('COMMAND_TIMEOUT'));
  } finally { await browser.close(); }
});

test('graceful close fallback kills only proven spawned Windows PID subtree', async () => {
  const env = environment({ ignoreBrowserClose: true });
  const browser = await env.driver.launch(env.options);
  await browser.close();
  assert.equal(env.spawns.length, 2);
  assert.deepEqual(env.spawns[1].args, ['/PID', '43210', '/T', '/F']);
  assert.deepEqual(env.spawns[1].options, { shell: false, windowsHide: true, stdio: 'ignore' });
  assert.ok(!env.spawns[1].args.some((arg) => /chrome|\/IM/i.test(arg)));
});

test('POSIX fallback signals only own detached process group', async () => {
  const env = environment({ ignoreBrowserClose: true, platform: 'linux' });
  const browser = await env.driver.launch(env.options);
  await browser.close();
  assert.equal(env.spawns[0].options.detached, true);
  assert.deepEqual(env.signals, [43210]);
  assert.equal(env.spawns.length, 1);
});

test('a process already observed exited is never tree-killed', async () => {
  const env = environment();
  const browser = await env.driver.launch(env.options);
  env.child.exit(1);
  await browser.close();
  assert.equal(env.spawns.length, 1);
});

test('failed forced cleanup reports sanitized error rather than claiming guaranteed OS exit', async () => {
  const env = environment({ ignoreBrowserClose: true, killNoExit: true });
  const browser = await env.driver.launch(env.options);
  await assert.rejects(browser.close(), safeError('CLEANUP'));
  assert.equal(env.spawns.length, 2);
  assert.ok(env.entries.has(path.join(env.options.userDataDir, '.transient-cdp.lock')));
  await assert.rejects(env.driver.launch(env.options), safeError('PROFILE_BUSY'));
});

test('total lifetime timeout initiates close without resident browser requirement', async () => {
  const env = environment();
  const browser = await env.driver.launch({ ...env.options, totalTimeoutMs: 30 });
  await new Promise((resolve) => env.child.once('exit', resolve));
  await browser.close();
  await assert.rejects(browser.createTarget(), safeError('TOTAL_TIMEOUT'));
  assert.equal(env.child.exitCode, 0);
});

test('late pending filesystem preparation cannot spawn after timeout or retain a late lock', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const env = environment({ pendingLock: held });
  await assert.rejects(env.driver.launch({ ...env.options, startupTimeoutMs: 15 }), safeError('CLEANUP'));
  assert.equal(env.spawns.length, 0);
  await assert.rejects(env.driver.launch(env.options), safeError('PROFILE_BUSY'));
  release();
  await new Promise(setImmediate);
  assert.ok(!env.entries.has(path.join(env.options.userDataDir, '.transient-cdp.lock')));
  assert.equal(env.spawns.length, 0);
  const browser = await env.driver.launch(env.options);
  await browser.close();
});

test('sync and async event callback failures cannot become unhandled remote-data errors', async () => {
  const env = environment();
  const browser = await env.driver.launch(env.options);
  try {
    const page = await browser.createTarget();
    page.on('Network.responseReceived', () => { throw new Error(SECRET); });
    page.on('Network.responseReceived', async () => { throw new Error(SECRET); });
    env.sockets[0].emit('message', { data: JSON.stringify({ sessionId: 'owned-session',
      method: 'Network.responseReceived', params: { secret: SECRET } }) });
    await new Promise(setImmediate);
  } finally { await browser.close(); }
});

test('withBrowser total deadline bounds an otherwise never-settling consumer callback', async () => {
  const env = environment();
  const began = Date.now();
  await assert.rejects(env.driver.withBrowser({ ...env.options, totalTimeoutMs: 30 },
    () => new Promise(() => {})), safeError('TOTAL_TIMEOUT'));
  assert.ok(Date.now() - began < 1000);
  assert.equal(env.child.exitCode, 0);
});

test('a child error is not proof of exit and cannot bypass bounded owned-tree cleanup', async () => {
  const env = environment({ ignoreBrowserClose: true });
  const browser = await env.driver.launch(env.options);
  env.child.emit('error', nativeError('EIO'));
  await browser.close();
  assert.equal(env.spawns.length, 2);
  assert.equal(env.child.exitCode, 1);
});

test('driver disposal before launch is terminal and performs no IO or process discovery',async()=>{
  const env=environment();
  assert.equal(env.driver.disposeSync(),true);
  await assert.rejects(env.driver.launch(env.options),safeError('CLOSED'));
  assert.deepEqual(env.spawns,[]);assert.deepEqual(env.syncSpawns,[]);assert.deepEqual(env.probes,[]);assert.deepEqual(env.changes,[]);
});

test('disposal wakes pending executable stat and late IO cannot start preparation or spawn',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});
  const env=environment({pendingStat:held});const launching=env.driver.launch(env.options);
  assert.equal(env.driver.disposeSync(),true);
  await assert.rejects(launching,safeError('CLOSED'));
  release();await new Promise(setImmediate);
  assert.deepEqual(env.changes,[]);assert.deepEqual(env.spawns,[]);assert.equal(env.driver.disposeSync(),true);
});

for(const stage of ['open','write'])test(`disposal during pending lock ${stage} fails closed and cannot spawn later`,async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});
  const env=environment(stage==='open'?{pendingLock:held}:{pendingLockWrite:held});
  const lockPath=path.join(env.options.userDataDir,'.transient-cdp.lock');
  const launching=env.driver.launch(env.options);
  await reached(()=>stage==='open'?env.changes.some(([op])=>op==='open-lock'):env.entries.has(lockPath));
  assert.equal(env.driver.disposeSync(),false);
  assert.equal(env.changes.some(([op])=>op==='sync-unlink'),false);
  await assert.rejects(launching,safeError('CLEANUP'));
  release();await reached(()=>!env.entries.has(lockPath));await new Promise(setImmediate);
  assert.equal(env.spawns.length,0);assert.equal(env.driver.disposeSync(),true);
  await assert.rejects(env.driver.launch(env.options),safeError('CLOSED'));
});

for(const stage of ['port','websocket'])test(`registry disposal reaches an already-spawned child before ${stage} startup completes`,async()=>{
  const env=environment(stage==='port'?{noPort:true}:{neverOpen:true});
  const lockPath=path.join(env.options.userDataDir,'.transient-cdp.lock');
  const launching=env.driver.launch(env.options);
  await reached(()=>stage==='port'?!!env.child:env.sockets.length===1);
  assert.equal(env.driver.disposeSync(),true);
  assert.equal(env.syncSpawns.length,1);assert.deepEqual(env.syncSpawns[0].args,['/PID','43210','/T','/F']);
  assert.deepEqual(env.probes,[['pid',43210]]);assert.equal(env.entries.has(lockPath),false);
  await assert.rejects(launching,safeError('CLOSED'));
  assert.equal(env.spawns.length,1);assert.equal(env.driver.disposeSync(),true);
});

test('confirmed Windows sync exit unlinks only its verified own token and permits fresh driver reentry',async()=>{
  const env=environment();const browser=await env.driver.launch(env.options);
  const lockPath=path.join(env.options.userDataDir,'.transient-cdp.lock');
  assert.equal(env.driver.disposeSync(),true);
  assert.equal(env.child.exitCode,null,'test deliberately withholds asynchronous child exit event');
  assert.equal(env.entries.has(lockPath),false);
  assert.deepEqual(env.changes.filter(([op])=>op==='sync-unlink'),[['sync-unlink',lockPath]]);
  assert.equal(env.syncSpawns[0].command,path.join(process.env.SystemRoot,'System32','taskkill.exe'));
  assert.deepEqual(env.syncSpawns[0].options,{shell:false,windowsHide:true,stdio:'ignore',timeout:3000});
  assert.equal(env.driver.disposeSync(),true);assert.equal(env.syncSpawns.length,1);
  const reentered=env.newDriver();const second=await reentered.launch(env.options);
  await browser.close();assert.equal(env.entries.has(lockPath),true,'old async cleanup cannot remove the new lock');
  const third=env.newDriver();await assert.rejects(third.launch(env.options),safeError('PROFILE_BUSY'));
  await second.close();assert.equal(env.entries.has(lockPath),false);
});

test('disposal registry never touches a separate driver or discovers arbitrary processes',async()=>{
  const first=environment(),foreign=environment();const a=await first.driver.launch(first.options),b=await foreign.driver.launch(foreign.options);
  try{
    assert.equal(first.driver.disposeSync(),true);assert.equal(foreign.syncSpawns.length,0);assert.equal(foreign.probes.length,0);
    assert.equal(foreign.child.exitCode,null);const page=await b.createTarget();assert.equal((await page.evaluate('42')).value,42);
    assert.deepEqual(first.probes,[['pid',43210]]);
  }finally{await a.close();await b.close();}
});

for(const settings of [{syncKillStatus:1},{syncKillStatus:null},{syncKillThrows:true},{syncKillError:true},{pidStillExists:true},{probeThrows:true}]){
  test(`sync termination uncertainty preserves lock (${Object.keys(settings)[0]}=${Object.values(settings)[0]})`,async()=>{
    const env=environment({...settings,killNoExit:true});const browser=await env.driver.launch(env.options);
    assert.equal(env.driver.disposeSync(),false);
    assert.equal(env.entries.has(path.join(env.options.userDataDir,'.transient-cdp.lock')),true);
    assert.equal(env.changes.some(([op])=>op==='sync-unlink'),false);
    assert.equal(env.syncSpawns.length,1);assert.deepEqual(env.syncSpawns[0].args,['/PID','43210','/T','/F']);
    await assert.rejects(browser.close(),safeError('CLEANUP'));
    assert.equal(env.entries.has(path.join(env.options.userDataDir,'.transient-cdp.lock')),true);
  });
}

for(const kind of ['token','symlink','realpath','read-error','inode-swap','oversize'])test(`sync lock cleanup refuses changed or unverifiable own lock: ${kind}`,async()=>{
  const settings=kind==='realpath'?{syncRealpathMismatch:true}:kind==='read-error'?{syncReadThrows:true}:kind==='inode-swap'?{syncSwapInode:true}:{};
  const env=environment(settings);const browser=await env.driver.launch(env.options);
  const lockPath=path.join(env.options.userDataDir,'.transient-cdp.lock');
  if(kind==='token')env.entries.get(lockPath).text='different-owner-'+SECRET;
  if(kind==='symlink')env.entries.get(lockPath).kind='symlink';
  if(kind==='oversize')env.entries.get(lockPath).text='x'.repeat(513);
  assert.equal(env.driver.disposeSync(),false);assert.equal(env.entries.has(lockPath),true);
  assert.equal(env.changes.some(([op])=>op==='sync-unlink'),false);
  try{await browser.close();}catch(error){safeError('CLEANUP')(error);}
  if(['token','symlink','oversize'].includes(kind))assert.equal(env.entries.has(lockPath),true);
});

test('already observed exit does not kill or probe any PID during synchronous lock cleanup',async()=>{
  const env=environment();const browser=await env.driver.launch(env.options);env.child.exit(0);
  assert.equal(env.driver.disposeSync(),true);assert.equal(env.syncSpawns.length,0);assert.equal(env.probes.length,0);
  assert.equal(env.entries.has(path.join(env.options.userDataDir,'.transient-cdp.lock')),false);await browser.close();
});

test('POSIX sync disposal targets only owned group and confirms group absence before unlocking',async()=>{
  const env=environment({platform:'linux',groupNoExitEvent:true});const browser=await env.driver.launch(env.options);
  assert.equal(env.driver.disposeSync(),true);assert.deepEqual(env.signals,[43210]);assert.deepEqual(env.probes,[['group',43210]]);
  assert.equal(env.syncSpawns.length,0);assert.equal(env.entries.has(path.join(env.options.userDataDir,'.transient-cdp.lock')),false);
  await browser.close();
});

test('POSIX kill delivery alone is not exit proof and leaves persistent lock',async()=>{
  const env=environment({platform:'linux',groupNoExitEvent:true,groupStillExists:true});const browser=await env.driver.launch(env.options);
  assert.equal(env.driver.disposeSync(),false);assert.equal(env.entries.has(path.join(env.options.userDataDir,'.transient-cdp.lock')),true);
  assert.deepEqual(env.signals,[43210]);await assert.rejects(browser.close(),safeError('CLEANUP'));
});

test('synchronous driver disposal does not require DOM Buffer, URL or WebSocket globals',async()=>{
  const env=environment();const browser=await env.driver.launch(env.options);
  const previous={Buffer:globalThis.Buffer,URL:globalThis.URL,WebSocket:globalThis.WebSocket};
  try{globalThis.Buffer=undefined;globalThis.URL=undefined;globalThis.WebSocket=undefined;assert.equal(env.driver.disposeSync(),true);}
  finally{Object.assign(globalThis,previous);}
  await browser.close();
});

test('headed login omits headless but retains own-profile and no-background flags',()=>{const flags=_internals.launchArguments('OWN',false);assert.ok(!flags.some(x=>x.startsWith('--headless')));assert.ok(flags.includes('--disable-background-mode'));assert.ok(flags.includes('--user-data-dir=OWN'));});
test('navigation admits only ordinary HTTPS on fixed Douyin hosts',()=>{for(const value of ['http://www.douyin.com/','https://evil.example/','https://www.douyin.com:444/','https://www.douyin.com/#fragment'])assert.throws(()=>_internals.validateNavigation(value),safeError('CONFIG'));assert.equal(_internals.validateNavigation('https://www.douyin.com/video/7702774431202267850'),'https://www.douyin.com/video/7702774431202267850');});
