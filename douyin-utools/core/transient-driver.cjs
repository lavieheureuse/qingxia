'use strict';

// Private Node16+ transient Chromium lifecycle. No browser/session is accessed on import.
// Own marked profile only; no user/default profile attachment, credential export, SDK or signature work.
// Normal close is bounded and confirmed. Hard OS/plugin crashes are not a process containment guarantee.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { URL } = require('node:url');
const { LocalWebSocket } = require('./cdp-socket.cjs');

const MARKER = '.transient-cdp-owner.json';
const LOCK = '.transient-cdp.lock';
const PORT_FILE = 'DevToolsActivePort';
const OWNER = 'shiying-transient-chromium-v1';
const activeProfiles = new Set();
const MESSAGES = Object.freeze({
  CONFIG: 'Invalid diagnostic configuration.',
  RUNTIME: 'Node 16 or newer is required.',
  PROFILE: 'The isolated diagnostic profile could not be verified.',
  PROFILE_BUSY: 'The isolated diagnostic profile is already in use.',
  STARTUP: 'The diagnostic browser could not start.',
  STARTUP_TIMEOUT: 'Diagnostic browser startup timed out.',
  EXITED: 'The spawned diagnostic browser exited.',
  CONNECT: 'The local diagnostic connection failed.',
  CLOSED: 'The diagnostic session is closed.',
  COMMAND_TIMEOUT: 'The diagnostic command timed out.',
  PROTOCOL: 'The diagnostic protocol operation failed.',
  EVALUATION: 'The diagnostic page evaluation failed.',
  TOTAL_TIMEOUT: 'The diagnostic lifetime limit was reached.',
  CLEANUP: 'The spawned diagnostic process did not confirm exit.',
});

class DiagnosticError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.PROTOCOL);
    this.name = 'DiagnosticError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'PROTOCOL';
    // No native error, cause, page URL, protocol error message, or remote stack.
  }
}
const error = (code) => new DiagnosticError(code);
const sanitized = (e, fallback) => e instanceof DiagnosticError ? e : error(fallback);

function parseActivePort(text) {
  if (typeof text !== 'string' || text.length > 512) throw error('CONNECT');
  const match = /^(\d{1,5})\r?\n(\/devtools\/browser\/[a-zA-Z0-9_-]{1,100})\r?\n?$/.exec(text);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw error('CONNECT');
  return `ws://127.0.0.1:${Number(match[1])}${match[2]}`;
}

function launchArguments(userDataDir, headless = true) {
  return [
    `--user-data-dir=${userDataDir}`,
    ...(headless ? ['--headless=new'] : []),
    '--window-size=1060,760',
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--disable-background-mode',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];
}

function validateOptions(options, ROOT) {
  const allowed = new Set(['executablePath', 'userDataDir', 'startupTimeoutMs',
    'commandTimeoutMs', 'totalTimeoutMs', 'closeTimeoutMs', 'killTimeoutMs', 'headless']);
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !allowed.has(key))) throw error('CONFIG');
  const config = { headless: true, ...options };
  if (typeof config.headless !== 'boolean') throw error('CONFIG');
  for (const key of ['executablePath', 'userDataDir']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key]) ||
        config[key].includes('\0')) throw error('CONFIG');
    config[key] = path.resolve(config[key]);
  }
  const name = path.basename(config.userDataDir);
  if (path.dirname(config.userDataDir) !== ROOT || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw error('PROFILE');
  }
  const settings = {
    startupTimeoutMs: [15000, 60000], commandTimeoutMs: [10000, 30000],
    totalTimeoutMs: [120000, 600000], closeTimeoutMs: [3000, 15000], killTimeoutMs: [3000, 15000],
  };
  for (const [key, [value, max]] of Object.entries(settings)) {
    if (config[key] === undefined) config[key] = value;
    if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > max) throw error('CONFIG');
  }
  return config;
}

function validateNavigation(url) {
  if (url === 'about:blank') return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port && !parsed.hash &&
        ['www.douyin.com','douyin.com','m.douyin.com','v.douyin.com','www.iesdouyin.com','iesdouyin.com','m.iesdouyin.com'].includes(parsed.hostname) && typeof url === 'string') return url;
  } catch { /* Native errors can include the input; never propagate them. */ }
  throw error('CONFIG');
}

function createDriver(injected = {}) {
  const ROOT = injected.profileRoot;
  if (typeof ROOT !== 'string' || !path.isAbsolute(ROOT) || ROOT !== path.resolve(ROOT)) throw error('CONFIG');
  // This factory is the explicit offline-test seam. The exported launch uses only real built-ins.
  const io = injected.fs || fs;
  const syncIO = injected.fsSync || fsSync;
  const spawn = injected.spawn || childProcess.spawn;
  const spawnSync = injected.spawnSync || childProcess.spawnSync;
  const Socket = injected.WebSocket || LocalWebSocket;
  const platform = injected.platform || process.platform;
  const killGroup = injected.killGroup || ((pid) => process.kill(-pid, 'SIGKILL'));
  const isOwnedPidGone = injected.isOwnedPidGone || ((pid) => {
    try { process.kill(pid, 0); return false; } catch (e) { return e?.code === 'ESRCH'; }
  });
  const isOwnedGroupGone = injected.isOwnedGroupGone || ((pid) => {
    try { process.kill(-pid, 0); return false; } catch (e) { return e?.code === 'ESRCH'; }
  });
  const now = injected.now || Date.now;
  const lifecycles = new Set();
  let disposed = false;

  function bounded(promise, timeoutMs, code) {
    let timer;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(error(code)), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
  }
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function launch(options) {
    if (disposed) throw error('CLOSED');
    if (Number(process.versions.node.split('.')[0]) < 16 || typeof Socket !== 'function') throw error('RUNTIME');
    let config;
    try { config = validateOptions(options, ROOT); } catch (e) { throw sanitized(e, 'CONFIG'); }
    if (activeProfiles.has(config.userDataDir)) throw error('PROFILE_BUSY');
    activeProfiles.add(config.userDataDir);

    const started = now();
    let child, socket, connection, lock, lockToken, closing = false, closePromise;
    let exited = false, childFailed = false, resolveExit, totalExpired = false;
    let profileVerified = false, profilePreparation, preparationSettled = false;
    let lockAcquired = false, lockReleased = false, profileClaimReleased = false, resolveStopped;
    const stopped = new Promise((resolve) => { resolveStopped = resolve; });
    const exitPromise = new Promise((resolve) => { resolveExit = resolve; });
    const sessions = new Map();
    const claimedTargets = new Set();
    const pending = new Map();
    let nextId = 0;
    const listeners = [];
    const totalTimer = setTimeout(() => {
      totalExpired = true;
      void close().catch(() => {});
    }, config.totalTimeoutMs);

    // Registered before the first await: disposal can reach a child even while
    // launch() is still reading DevToolsActivePort or connecting the transport.
    const lifecycle = { disposeSync: terminateSync };
    lifecycles.add(lifecycle);

    function assertOpen() {
      if (totalExpired) throw error('TOTAL_TIMEOUT');
      if (disposed || closing) throw error('CLOSED');
      if (childFailed || (child && exited)) throw error('EXITED');
    }
    function startupBudget() {
      assertOpen();
      const remaining = Math.min(config.startupTimeoutMs, config.totalTimeoutMs) - (now() - started);
      if (remaining <= 0) throw error('STARTUP_TIMEOUT');
      return remaining;
    }
    async function startupStep(promise) {
      const operation = Promise.resolve(promise);
      operation.catch(() => {}); // A late rejected IO must remain handled after disposal.
      const budget = startupBudget();
      const result = await bounded(Promise.race([operation, stopped.then(() => {
        throw error(totalExpired ? 'TOTAL_TIMEOUT' : 'CLOSED');
      })]), budget, 'STARTUP_TIMEOUT');
      assertOpen();
      return result;
    }
    async function ensureDirectory(directory) {
      let made = false;
      try { await io.mkdir(directory); made = true; }
      catch (e) { if (e?.code !== 'EEXIST') throw error('PROFILE'); }
      const stat = await io.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('PROFILE');
      return made;
    }
    async function verifyParent() {
      const [base, root, profile] = await Promise.all([
        io.realpath(path.dirname(ROOT)), io.realpath(ROOT), io.realpath(config.userDataDir),
      ]);
      if (base !== path.dirname(ROOT) || root !== ROOT || profile !== config.userDataDir ||
          root !== path.join(base, path.basename(ROOT)) || profile !== path.join(root, path.basename(config.userDataDir))) {
        throw error('PROFILE');
      }
    }
    async function readSmall(filename, max = 512) {
      const info = await io.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw error('PROFILE');
      const contents = await io.readFile(filename, 'utf8');
      if (contents.length > max) throw error('PROFILE');
      return contents;
    }
    async function removeOwnFile(name, missingAllowed = false) {
      // The only deletions are fixed control files inside this verified owned profile.
      if (!profileVerified || ![LOCK, PORT_FILE].includes(name)) throw error('PROFILE');
      await verifyParent();
      const filename = path.join(config.userDataDir, name);
      try {
        const info = await io.lstat(filename);
        if (!info.isFile() || info.isSymbolicLink()) throw error('PROFILE');
        const resolved = await io.realpath(filename);
        if (resolved !== filename) throw error('PROFILE');
        await io.unlink(filename);
      } catch (e) {
        if (!(missingAllowed && e?.code === 'ENOENT')) throw sanitized(e, 'PROFILE');
      }
    }
    async function releaseLock() {
      if (!lock) return;
      const handle = lock;
      lock = undefined;
      try {
        const current = await readSmall(path.join(config.userDataDir, LOCK));
        if (current !== lockToken) throw error('PROFILE');
        await removeOwnFile(LOCK);
        lockReleased = true;
      } finally { await handle.close().catch(() => {}); }
    }
    async function prepareProfile() {
      await ensureDirectory(ROOT);
      assertOpen();
      const made = await ensureDirectory(config.userDataDir);
      await verifyParent();
      assertOpen();
      const markerPath = path.join(config.userDataDir, MARKER);
      const marker = JSON.stringify({ owner: OWNER, profile: path.basename(config.userDataDir) });
      if (made) await io.writeFile(markerPath, marker, { flag: 'wx', mode: 0o600 });
      if (await readSmall(markerPath) !== marker) throw error('PROFILE');
      assertOpen();
      profileVerified = true;
      lockToken = `${OWNER}:${randomUUID()}`;
      try { lock = await io.open(path.join(config.userDataDir, LOCK), 'wx', 0o600); }
      catch (e) { throw error(e?.code === 'EEXIST' ? 'PROFILE_BUSY' : 'PROFILE'); }
      lockAcquired = true;
      await lock.writeFile(lockToken, 'utf8');
      assertOpen(); // Teardown waits for preparation; never race a pending lock write.
      await removeOwnFile(PORT_FILE, true); // Never attach through a stale port file.
      assertOpen();
    }
    function failPending(code) {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(error(code));
      }
      pending.clear();
    }
    function listen(target, type, handler) {
      target.addEventListener(type, handler);
      listeners.push(() => target.removeEventListener(type, handler));
    }
    function send(method, params = {}, sessionId, internal = false) {
      try {
        if (!internal) assertOpen();
        if (!socket || socket.readyState !== 1) throw error('CONNECT');
        if (!params || typeof params !== 'object' || Array.isArray(params)) throw error('CONFIG');
        const id = ++nextId;
        let wire;
        try { wire = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }); }
        catch { throw error('CONFIG'); }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(error('COMMAND_TIMEOUT')); }, config.commandTimeoutMs);
          pending.set(id, { resolve, reject, timer, sessionId });
          try { socket.send(wire); }
          catch { pending.delete(id); clearTimeout(timer); reject(error('CONNECT')); }
        });
      } catch (e) { return Promise.reject(sanitized(e, 'PROTOCOL')); }
    }
    function onMessage(event) {
      let message;
      try {
        if (typeof event.data !== 'string' || event.data.length > 8 * 1024 * 1024) return;
        message = JSON.parse(event.data);
      } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (Number.isSafeInteger(message.id)) {
        const item = pending.get(message.id);
        if (!item || (message.sessionId || undefined) !== item.sessionId) return;
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) item.reject(error('PROTOCOL'));
        else item.resolve(message.result || {});
      } else if (typeof message.method === 'string') {
        const session = sessions.get(message.sessionId);
        if (session) session.dispatch(message.method, message.params || {});
      }
    }
    function provenLiveChild() {
      return child && !exited && Number.isSafeInteger(child.pid) &&
        child.pid > 0 && child.exitCode === null && child.signalCode === null;
    }
    async function waitForExit(ms) {
      if (!child || exited) return true;
      try { await bounded(exitPromise, ms, 'CLEANUP'); return true; }
      catch { return false; }
    }
    async function killOwnedTree() {
      if (!provenLiveChild()) return;
      const pid = child.pid; // Never accepts a caller PID or enumerates unrelated processes.
      if (platform === 'win32') {
        const windowsRoot = process.env.SystemRoot;
        if (!windowsRoot || !path.isAbsolute(windowsRoot)) throw error('CLEANUP');
        let killer;
        try {
          killer = spawn(path.join(windowsRoot, 'System32', 'taskkill.exe'),
            ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        } catch { throw error('CLEANUP'); }
        const complete = new Promise((resolve) => {
          killer.once('error', () => resolve(false));
          killer.once('exit', (code) => resolve(code === 0));
        });
        try { await bounded(complete, config.killTimeoutMs, 'CLEANUP'); }
        catch { try { killer.kill(); } catch { /* Only our own helper handle. */ } }
      } else {
        try { killGroup(pid); } catch { if (!exited) throw error('CLEANUP'); }
      }
    }
    function observedExit() {
      if (!child || exited) return true;
      if (child.exitCode != null || child.signalCode != null) {
        exited = true;
        resolveExit();
        return true;
      }
      return false;
    }
    function terminateOwnedSync() {
      if (observedExit()) return true;
      if (!provenLiveChild()) return false;
      const pid = child.pid;
      let confirmed = false;
      try {
        if (platform === 'win32') {
          const windowsRoot = process.env.SystemRoot;
          if (!windowsRoot || !path.isAbsolute(windowsRoot)) return false;
          const result = spawnSync(path.join(windowsRoot, 'System32', 'taskkill.exe'),
            ['/PID', String(pid), '/T', '/F'],
            { shell: false, windowsHide: true, stdio: 'ignore', timeout: 3000 });
          // A kill request/timeout is not proof. Probe only our recorded PID,
          // never enumerate or inspect other processes/profiles.
          confirmed = result?.status === 0 && !result.error && !result.signal && isOwnedPidGone(pid) === true;
        } else {
          killGroup(pid);
          // SIGKILL delivery is not exit confirmation (zombies can remain until
          // the event loop reaps them). Unconfirmed groups retain their lock.
          confirmed = isOwnedGroupGone(pid) === true;
        }
      } catch { /* Native process details never leave this private boundary. */ }
      if (confirmed) { exited = true; resolveExit(); }
      return observedExit();
    }
    function forgetLifecycle() {
      // An async close may finish after synchronous disposal allowed a new
      // driver to claim this profile. Never remove that newer driver's claim.
      if (!profileClaimReleased) {
        activeProfiles.delete(config.userDataDir);
        profileClaimReleased = true;
      }
      lifecycles.delete(lifecycle);
    }
    function releaseLockSync() {
      if (child && !observedExit()) return false;
      // A pending open/write can acquire a lock after this stack returns. Leave
      // it to the bounded asynchronous preparation cleanup, never guess here.
      if (profilePreparation && !preparationSettled) return false;
      if (!lockAcquired || lockReleased) {
        forgetLifecycle();
        return true;
      }
      if (!profileVerified || !lock || typeof lockToken !== 'string') return false;
      try {
        for (const directory of [path.dirname(ROOT), ROOT, config.userDataDir]) {
          const info = syncIO.lstatSync(directory);
          if (!info.isDirectory() || info.isSymbolicLink() || syncIO.realpathSync(directory) !== directory) return false;
        }
        const filename = path.join(config.userDataDir, LOCK);
        const before = syncIO.lstatSync(filename);
        if (!before.isFile() || before.isSymbolicLink() || before.size > 512 || syncIO.realpathSync(filename) !== filename) return false;
        const contents = syncIO.readFileSync(filename, 'utf8');
        if (typeof contents !== 'string' || contents.length > 512 || contents !== lockToken) return false;
        const after = syncIO.lstatSync(filename);
        if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
            before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
            syncIO.realpathSync(filename) !== filename || syncIO.readFileSync(filename, 'utf8') !== lockToken) return false;
        syncIO.unlinkSync(filename);
        lockReleased = true;
        const handle = lock;
        lock = undefined;
        forgetLifecycle();
        // Do not close a managed FileHandle's raw fd with closeSync: a later
        // finalizer could close a reused fd. Unlink is synchronous; this handle
        // belongs only to the already-unlinked inode and is safely closed later.
        try { Promise.resolve(handle.close()).catch(() => {}); } catch { /* No native error exposure. */ }
        return true;
      } catch { return false; }
    }
    function terminateSync() {
      closing = true;
      resolveStopped();
      clearTimeout(totalTimer);
      failPending(totalExpired ? 'TOTAL_TIMEOUT' : 'CLOSED');
      const confirmed = terminateOwnedSync();
      const unlocked = confirmed && releaseLockSync();
      try { socket?.close(); } catch { /* Transport may already have been disposed. */ }
      void close().catch(() => {}); // Best effort only; synchronous result stays honest.
      return !!unlocked;
    }
    function close() {
      if (closePromise) return closePromise;
      closing = true;
      resolveStopped();
      clearTimeout(totalTimer);
      closePromise = (async () => {
        let cleanupFailed = false;
        try {
          if (socket?.readyState === 1 && !exited) {
            await bounded(send('Browser.close', {}, undefined, true), config.closeTimeoutMs, 'CLEANUP').catch(() => {});
          }
          if (!await waitForExit(config.closeTimeoutMs)) {
            try { await killOwnedTree(); } catch { cleanupFailed = true; }
            if (!await waitForExit(config.killTimeoutMs)) cleanupFailed = true;
          }
        } finally {
          failPending(totalExpired ? 'TOTAL_TIMEOUT' : 'CLOSED');
          for (const unlisten of listeners.splice(0)) {
            try { unlisten(); } catch { cleanupFailed = true; }
          }
          try { socket?.close(); } catch { /* Never log transport errors. */ }
          sessions.clear();
          if (profilePreparation && !preparationSettled) {
            try { await bounded(profilePreparation.catch(() => {}), config.closeTimeoutMs, 'CLEANUP'); }
            catch { cleanupFailed = true; }
          }
          const unlock = async () => {
            // An unconfirmed live process keeps its lock: never permit a second launch into it.
            if (child && !exited) {
              const handle = lock;
              lock = undefined; // Keep the on-disk lock, but do not leak our file handle.
              if (handle) await handle.close().catch(() => {});
              throw error('CLEANUP');
            }
            await releaseLock();
            forgetLifecycle();
          };
          if (!profilePreparation || preparationSettled) {
            try { await bounded(unlock(), config.closeTimeoutMs, 'CLEANUP'); }
            catch { cleanupFailed = true; }
          } else {
            // A delayed filesystem completion must not leave a late-acquired lock behind.
            void profilePreparation.catch(() => {}).then(unlock).catch(() => {});
          }
        }
        if (cleanupFailed) throw error('CLEANUP');
      })();
      return closePromise;
    }

    async function createTarget() {
      assertOpen();
      let targetId, attachedSessionId;
      try {
        const listed = await send('Target.getTargets');
        const initial = Array.isArray(listed.targetInfos) && listed.targetInfos.find(t => t.type === 'page' && t.url === 'about:blank' && !claimedTargets.has(t.targetId));
        targetId = initial ? initial.targetId : (await send('Target.createTarget', { url: 'about:blank' })).targetId;
        claimedTargets.add(targetId);
        if (typeof targetId !== 'string' || !targetId) throw error('PROTOCOL');
        const attached = await send('Target.attachToTarget', { targetId, flatten: true });
        if (typeof attached.sessionId !== 'string' || !attached.sessionId) throw error('PROTOCOL');
        const sessionId = attached.sessionId;
        attachedSessionId = sessionId;
        const subscriptions = new Map();
        let targetClosed = false;
        const session = {
          dispatch(method, params) {
            for (const fn of subscriptions.get(method) || []) {
              try { Promise.resolve(fn(params)).catch(() => {}); }
              catch { /* Consumer exceptions must not leak remote payloads. */ }
            }
          },
        };
        sessions.set(sessionId, session);
        const api = Object.freeze({
          send(method, params = {}) {
            if (targetClosed || !sessions.has(sessionId)) return Promise.reject(error('CLOSED'));
            if (typeof method !== 'string' || !/^(Page|Runtime|Network)\.[A-Za-z][A-Za-z0-9]*$/.test(method)) {
              return Promise.reject(error('CONFIG'));
            }
            return send(method, params, sessionId);
          },
          async navigate(url) {
            const result = await api.send('Page.navigate', { url: validateNavigation(url) });
            if (result.errorText) throw error('PROTOCOL');
            return result; // Navigation started; callers must await their own load predicate/event.
          },
          async evaluate(expression, options = {}) {
            try {
              if (!options || typeof options !== 'object' || Array.isArray(options) ||
                  Object.keys(options).some((key) => !['awaitPromise', 'returnByValue'].includes(key))) throw error('CONFIG');
              const { awaitPromise = true, returnByValue = true } = options;
              if (typeof expression !== 'string' || typeof awaitPromise !== 'boolean' || typeof returnByValue !== 'boolean') {
                throw error('CONFIG');
              }
              const result = await api.send('Runtime.evaluate', { expression, awaitPromise, returnByValue });
              if (result.exceptionDetails) throw error('EVALUATION');
              return result.result; // Explicit diagnostic result, never logged by the harness.
            } catch (e) { throw sanitized(e, 'CONFIG'); }
          },
          on(method, handler) {
            assertOpen();
            if (targetClosed || typeof method !== 'string' ||
                !/^(Page|Runtime|Network)\.[A-Za-z][A-Za-z0-9]*$/.test(method) || typeof handler !== 'function') {
              throw error('CONFIG');
            }
            if (!subscriptions.has(method)) subscriptions.set(method, new Set());
            subscriptions.get(method).add(handler);
            return () => subscriptions.get(method)?.delete(handler);
          },
          async close() {
            if (targetClosed) return;
            targetClosed = true;
            subscriptions.clear();
            sessions.delete(sessionId);
            if (!closing && !exited) await send('Target.closeTarget', { targetId });
          },
        });
        await Promise.all([api.send('Page.enable'), api.send('Runtime.enable'), api.send('Network.enable')]);
        return api;
      } catch (e) {
        if (attachedSessionId) sessions.delete(attachedSessionId);
        if (targetId && !closing && !exited) await send('Target.closeTarget', { targetId }).catch(() => {});
        throw sanitized(e, 'PROTOCOL');
      }
    }

    try {
      const executable = await startupStep(io.stat(config.executablePath));
      if (!executable.isFile()) throw error('CONFIG');
      profilePreparation = prepareProfile().finally(() => { preparationSettled = true; });
      await startupStep(profilePreparation);
      assertOpen();
      try {
        child = spawn(config.executablePath, launchArguments(config.userDataDir, config.headless), {
          shell: false, windowsHide: true, stdio: 'ignore', detached: platform !== 'win32',
        });
      } catch { throw error('STARTUP'); }
      child.once('exit', () => { exited = true; resolveExit(); failPending('EXITED'); });
      child.once('error', () => {
        childFailed = true;
        if (!Number.isSafeInteger(child.pid) || child.pid <= 0) { exited = true; resolveExit(); }
        failPending('STARTUP');
      });
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw error('STARTUP');
      let endpoint;
      while (!endpoint) {
        startupBudget();
        try { endpoint = parseActivePort(await startupStep(readSmall(path.join(config.userDataDir, PORT_FILE)))); }
        catch (e) {
          if (e instanceof DiagnosticError && ['STARTUP_TIMEOUT', 'TOTAL_TIMEOUT', 'CLOSED', 'EXITED'].includes(e.code)) throw e;
          // A partial write/temporarily absent file is normal. Never disclose its contents.
        }
        if (!endpoint) await startupStep(delay(Math.min(40, startupBudget())));
      }
      assertOpen();
      try { socket = new Socket(endpoint); } catch { throw error('CONNECT'); }
      connection = new Promise((resolve, reject) => {
        listen(socket, 'open', resolve);
        listen(socket, 'error', () => { failPending('CONNECT'); reject(error('CONNECT')); });
        listen(socket, 'close', () => { failPending('CONNECT'); reject(error('CONNECT')); });
      });
      listen(socket, 'message', onMessage);
      await startupStep(connection);
      return Object.freeze({ createTarget, close,
        waitForExit: () => bounded(exitPromise, Math.max(1, config.totalTimeoutMs - (now() - started)), 'TOTAL_TIMEOUT'),
        get pid() { return child.pid; },
        terminateSync,
      });
    } catch (e) {
      // Do not hide unconfirmed cleanup behind an otherwise ordinary startup failure.
      await close();
      throw sanitized(e, 'STARTUP');
    }
  }

  async function withBrowser(options, callback) {
    if (typeof callback !== 'function') throw error('CONFIG');
    let config;
    try { config = validateOptions(options, ROOT); } catch (e) { throw sanitized(e, 'CONFIG'); }
    const began = now();
    const browser = await launch(config);
    try {
      return await bounded(Promise.resolve().then(() => callback(browser)),
        Math.max(1, config.totalTimeoutMs - (now() - began)), 'TOTAL_TIMEOUT');
    } finally { await browser.close(); }
  }
  function disposeSync() {
    disposed = true; // Terminal even if there is no returned browser yet.
    let complete = true;
    for (const lifecycle of [...lifecycles]) {
      try { if (!lifecycle.disposeSync()) complete = false; }
      catch { complete = false; }
    }
    return complete;
  }
  return Object.freeze({ launch, withBrowser, disposeSync });
}

module.exports = Object.freeze({ createDriver, DiagnosticError,
  _internals: Object.freeze({ parseActivePort, launchArguments, validateOptions, validateNavigation }) });
