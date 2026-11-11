'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createService } = require('../core/service.cjs');
const { createStore } = require('../core/store.cjs');
const runnerlib = require('../core/runner.cjs');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-service-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 5000);
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  throw new Error(`等待超时：${label || '条件'}`);
}

/** Server deliverable: INI text, no trailing newline, no webServer. */
function iniConfig(options) {
  const opts = options || {};
  const proxies = opts.proxies || [
    { name: 'echo', localPort: 18080, remotePort: 20022 },
    { name: 'web', localPort: 18081, remotePort: 20023 },
  ];
  const lines = [
    '[common]',
    'server_addr = 127.0.0.1',
    `server_port = ${opts.serverPort === undefined ? 7200 : opts.serverPort}`,
    'token = frps-test-token',
    '',
  ];
  for (const proxy of proxies) {
    lines.push(`[${proxy.name}]`, 'type = tcp', 'local_ip = 127.0.0.1',
      `local_port = ${proxy.localPort}`, `remote_port = ${proxy.remotePort}`, '');
  }
  return lines.join('\n');
}

/** Server-side publish result: same shape as server/frp_config_api.py proxies_to_toml. */
function serverIniFromProxies(proxies) {
  const lines = ['[common]', 'server_addr = 127.0.0.1', 'server_port = 7200', 'token = frps-test-token', ''];
  for (const proxy of proxies) {
    if (proxy.enabled === false) continue;
    lines.push(`[${proxy.name}]`, 'type = tcp', `local_ip = ${proxy.localIp}`,
      `local_port = ${proxy.localPort}`, `remote_port = ${proxy.remotePort}`, '');
  }
  return lines.join('\n');
}

function createFakeApi(t, options) {
  const opts = options || {};
  const state = {
    token: opts.token || 'good-token',
    config: opts.config === undefined
      ? { version: 1, config: iniConfig(), updatedAt: '2026-11-05T00:00:00Z' }
      : opts.config,
    healthStatus: opts.healthStatus || 200,
    statusReports: [],
    configRequests: 0,
    healthRequests: 0,
    publishRequests: [],
    publishStatus: opts.publishStatus || 0,
    publishError: opts.publishError || '',
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const send = (code, payload) => {
        res.statusCode = code;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      const authOk = req.headers.authorization === `Bearer ${state.token}`;
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/health') {
        state.healthRequests += 1;
        if (state.healthStatus !== 200) return send(state.healthStatus, { error: 'health down' });
        return send(200, { ok: true });
      }
      if (url.pathname === '/frp/config' && req.method === 'GET') {
        state.configRequests += 1;
        if (!authOk) return send(401, { error: '未授权' });
        if (!state.config) return send(404, { error: '这台电脑还没有发布过的配置' });
        return send(200, {
          pcId: url.searchParams.get('pcId'),
          version: state.config.version,
          config: state.config.config,
          updatedAt: state.config.updatedAt,
        });
      }
      if (url.pathname === '/frp/config' && req.method === 'POST') {
        if (!authOk) return send(401, { error: '未授权' });
        let body = null;
        try { body = JSON.parse(bodyText || '{}'); } catch (_) { body = null; }
        if (!body || !Array.isArray(body.proxies)) return send(400, { error: 'proxies 必须是数组' });
        if (state.publishStatus) return send(state.publishStatus, { error: state.publishError || '发布失败' });
        const version = ((state.config && Number(state.config.version)) || 0) + 1;
        const updatedAt = new Date().toISOString();
        state.config = { version, config: serverIniFromProxies(body.proxies), updatedAt };
        state.publishRequests.push({ pcId: body.pcId, proxies: body.proxies, version });
        return send(200, { pcId: body.pcId, version });
      }
      if (url.pathname === '/frp/status' && req.method === 'POST') {
        if (!authOk) return send(401, { error: '未授权' });
        let body = null;
        try { body = JSON.parse(bodyText || '{}'); } catch (_) { body = null; }
        state.statusReports.push(body);
        return send(200, { ok: true });
      }
      return send(404, { error: '未知路径' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(done);
      }));
      resolve({ baseUrl: `http://127.0.0.1:${server.address().port}`, state, server });
    });
  });
}

function makeStubRunnerFactory(state) {
  return () => {
    const exitListeners = new Set();
    const logListeners = new Set();
    const runner = {
      pid: null,
      hints: { loggedIn: true, startedProxies: ['echo'], lastError: null },
      startCount: 0,
      stopCount: 0,
      start() {
        this.startCount += 1;
        this.pid = (state.nextPid || 4242424) + (state.runners.length - 1);
        state.startCount = this.startCount;
        return { pid: this.pid };
      },
      adopt(existing) { this.pid = existing; this.adopted = existing; state.adopted = existing; },
      async stop() { this.stopCount += 1; state.stopCount = this.stopCount; this.pid = null; return { stopped: true }; },
      getPid() { return this.pid; },
      isAlive() { return !!this.pid; },
      hasExited() { return false; },
      getExitInfo() { return null; },
      getHints() { return { loggedIn: this.hints.loggedIn, startedProxies: this.hints.startedProxies.slice(), lastError: this.hints.lastError }; },
      isOnline() { return !!this.pid && this.hints.loggedIn && state.online !== false; },
      getRecentLines() { return []; },
      onExit(listener) { exitListeners.add(listener); return () => exitListeners.delete(listener); },
      onLog(listener) { logListeners.add(listener); return () => logListeners.delete(listener); },
      dispose() {},
      emitExit(info) { for (const listener of Array.from(exitListeners)) listener(info); },
      emitLog(entries) { for (const listener of Array.from(logListeners)) listener(entries); },
      setHints(next) { this.hints = Object.assign({}, this.hints, next); },
    };
    state.runners.push(runner);
    return runner;
  };
}

function setup(t, overrides) {
  const options = overrides || {};
  const dataDir = tempDir(t);
  const state = { nextPid: 4242424, online: true, runners: [], startCount: 0, stopCount: 0, adopted: null };
  const host = {
    opened: [],
    copied: [],
    dialogs: [],
    showOpenDialog() { return host.dialogs.length ? host.dialogs.shift() : null; },
    shellOpenPath(target) { host.opened.push(target); return ''; },
    copyText(text) { host.copied.push(text); },
  };
  const internals = {
    createRunner: makeStubRunnerFactory(state),
    detectVersion: async () => '0.71.1',
    verifyConfig: options.verifyConfig || (async () => ({ ok: true, message: '配置校验通过' })),
    listVersions: async () => ({ versions: ['0.72.0', '0.71.1'], latest: '0.72.0', recommended: '0.71.1' }),
    downloadBinary: options.downloadBinary,
  };
  const service = createService({ dataDir, host, appVersion: '0.1.0', platform: 'win32', arch: 'x64', internals });
  t.after(() => { try { service.dispose(); } catch (_) { /* ignore */ } });
  return { service, dataDir, state, host, internals };
}

async function prime(service, api, dataDir) {
  await service.bootstrap();
  const fakeExe = path.join(dataDir, 'bin', 'frpc.exe');
  fs.mkdirSync(path.dirname(fakeExe), { recursive: true });
  fs.writeFileSync(fakeExe, 'MZ-fake-frpc');
  await service.setBinaryPath(fakeExe);
  await service.saveConnection({ apiBase: api.baseUrl, pcId: 'pc-home', pcToken: api.state.token });
  return { fakeExe };
}

function latestRunner(state) {
  return state.runners[state.runners.length - 1];
}

function assertStateShape(state) {
  const required = ['phase', 'connection', 'remote', 'applied', 'frpc', 'autoSync', 'lastSync', 'lastError'];
  for (const key of required) assert.ok(key in state, `State 缺少字段 ${key}`);
  assert.ok(['unconfigured', 'idle', 'syncing', 'applying', 'online', 'offline', 'error'].includes(state.phase));
  for (const key of ['apiBase', 'pcId', 'hasToken', 'tokenHint']) assert.ok(key in state.connection, `connection 缺少 ${key}`);
  assert.equal(typeof state.connection.hasToken, 'boolean');
  for (const key of ['reachable', 'version', 'updatedAt', 'fetchedAt', 'proxies', 'error']) assert.ok(key in state.remote, `remote 缺少 ${key}`);
  assert.ok(Array.isArray(state.remote.proxies));
  for (const proxy of state.remote.proxies) {
    for (const key of ['name', 'type', 'localIp', 'localPort', 'remotePort', 'enabled']) {
      assert.ok(key in proxy, `Proxy 缺少字段 ${key}`);
    }
  }
  for (const key of ['version', 'at', 'configPath', 'backupPath']) assert.ok(key in state.applied, `applied 缺少 ${key}`);
  for (const key of ['running', 'pid', 'startedAt', 'exitedAt', 'exitCode', 'logHints', 'binary']) assert.ok(key in state.frpc, `frpc 缺少 ${key}`);
  for (const key of ['loggedIn', 'startedProxies', 'lastError']) assert.ok(key in state.frpc.logHints, `logHints 缺少 ${key}`);
  for (const key of ['status', 'path', 'version', 'source', 'download']) assert.ok(key in state.frpc.binary, `binary 缺少 ${key}`);
  for (const key of ['enabled', 'intervalSec', 'nextAt']) assert.ok(key in state.autoSync, `autoSync 缺少 ${key}`);
  for (const key of ['at', 'ok', 'action', 'version', 'error']) assert.ok(key in state.lastSync, `lastSync 缺少 ${key}`);
  if (state.lastError) {
    for (const key of ['code', 'message', 'at']) assert.ok(key in state.lastError, `lastError 缺少 ${key}`);
  }
}

// ---------------------------------------------------------------------------
// bootstrap / connection
// ---------------------------------------------------------------------------

test('bootstrap() exposes the SPEC-SYNC State shape and starts unconfigured', async (t) => {
  const { service, dataDir } = setup(t);
  assert.equal(service.getState().phase, 'boot');
  const first = await service.bootstrap();
  const second = await service.bootstrap();
  assert.equal(first.phase, 'unconfigured');
  assert.equal(second.phase, 'unconfigured');
  assert.equal(first.connection.hasToken, false);
  assert.equal(first.connection.tokenHint, '');
  assert.equal(first.frpc.binary.status, 'missing');
  assert.equal(first.applied.version, null);
  assert.equal(first.frpc.running, false);
  assert.equal(first.autoSync.enabled, false);
  assert.equal(first.autoSync.intervalSec, 45);
  assertStateShape(first);
  assert.ok(fs.existsSync(path.join(dataDir, 'settings.json')));
  assert.ok(fs.existsSync(path.join(dataDir, 'logs', 'sync.log')), 'bootstrap 应写同步日志');
});

test('saveConnection() validates, persists obfuscated token and updates phase', async (t) => {
  const { service, dataDir } = setup(t);
  await service.bootstrap();
  await assert.rejects(service.saveConnection({ apiBase: 'not-a-url' }), (error) => {
    assert.equal(error.code, 'VALIDATION');
    assert.match(error.message, /http/);
    return true;
  });
  await assert.rejects(service.saveConnection({ pcId: 'bad id!' }), /电脑 ID/);
  await assert.rejects(service.saveConnection({ pcToken: 42 }), /字符串/);

  const state = await service.saveConnection({
    apiBase: 'http://127.0.0.1:18081/',
    pcId: 'pc-lab',
    pcToken: 'token-abcd-1234',
  });
  assert.equal(state.connection.apiBase, 'http://127.0.0.1:18081');
  assert.equal(state.connection.pcId, 'pc-lab');
  assert.equal(state.connection.hasToken, true);
  assert.equal(state.connection.tokenHint, '••••1234');
  assert.equal(state.phase, 'idle');

  // Partial update contract: omitted fields keep their previous value; only an
  // explicit empty string clears the token (UI leaves the token field blank).
  const addressOnly = await service.saveConnection({ apiBase: 'http://localhost:9999' });
  assert.equal(addressOnly.connection.apiBase, 'http://localhost:9999');
  assert.equal(addressOnly.connection.pcId, 'pc-lab', '缺省 pcId 应保留');
  assert.equal(addressOnly.connection.hasToken, true, '改地址不能清掉 token');
  assert.equal(addressOnly.connection.tokenHint, '••••1234');
  const cleared = await service.saveConnection({ pcToken: '' });
  assert.equal(cleared.connection.hasToken, false, '显式空字符串才清空 token');
  await service.saveConnection({ pcToken: 'token-abcd-1234', pcId: 'pc-lab', apiBase: 'http://127.0.0.1:18081' });

  const raw = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8');
  assert.ok(!raw.includes('token-abcd-1234'), '磁盘不能出现明文 pcToken');
  const loaded = createStore(dataDir).read();
  assert.equal(loaded.connection.pcToken, 'token-abcd-1234');
});

test('testConnection() maps success / 401 / 404 / network failures', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir } = setup(t);
  await prime(service, api, dataDir);
  const ok = await service.testConnection();
  assert.equal(ok.ok, true);
  assert.equal(ok.version, 1);
  assert.match(ok.message, /连接成功/);
  const state = service.getState();
  assert.equal(state.remote.reachable, true);
  assert.equal(state.remote.version, 1);
  assert.equal(state.remote.proxies.length, 2);

  api.state.token = 'other-token';
  await service.saveConnection({ pcToken: 'wrong-token' });
  const unauthorized = await service.testConnection();
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.code, 'UNAUTHORIZED');
  assert.match(unauthorized.message, /401|Token/);

  api.state.token = 'good-token';
  await service.saveConnection({ pcToken: 'good-token' });
  api.state.config = null;
  const notFound = await service.testConnection();
  assert.equal(notFound.code, 'NOT_FOUND');
  assert.match(notFound.message, /还没有发布/);

  api.state.config = { version: 1, config: iniConfig(), updatedAt: null };
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const deadPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  await service.saveConnection({ apiBase: `http://127.0.0.1:${deadPort}` });
  const network = await service.testConnection();
  assert.equal(network.ok, false);
  assert.equal(network.code, 'NETWORK');
  assert.match(network.message, /无法连接|请求超时/);
});

test('testConnection() requires a token and health endpoint', async (t) => {
  const api = await createFakeApi(t, { healthStatus: 500 });
  const { service } = setup(t);
  await service.bootstrap();
  const noToken = await service.testConnection();
  assert.equal(noToken.ok, false);
  assert.equal(noToken.code, 'VALIDATION');
  await service.saveConnection({ apiBase: api.baseUrl, pcId: 'pc-home', pcToken: api.state.token });
  const healthDown = await service.testConnection();
  assert.equal(healthDown.ok, false);
  assert.equal(healthDown.code, 'NETWORK');
  assert.match(healthDown.message, /health down|HTTP 500/);
});

// ---------------------------------------------------------------------------
// sync happy path / skip / version bump
// ---------------------------------------------------------------------------

test('syncNow() fetches, verifies, backs up, applies, restarts and reports status', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir, state } = setup(t);
  await prime(service, api, dataDir);

  const result = await service.syncNow();
  assert.equal(result.phase, 'online');
  assert.equal(result.frpc.running, true);
  assert.equal(result.frpc.pid, 4242424);
  assert.equal(result.applied.version, 1);
  assert.ok(result.applied.at > 0);
  assert.equal(result.applied.backupPath, null, '首次应用没有旧配置');
  assert.equal(result.remote.version, 1);
  assert.equal(result.remote.reachable, true);
  assert.equal(result.remote.proxies.length, 2);
  assert.deepEqual(result.lastSync.action, 'apply');
  assert.equal(result.lastSync.ok, true);
  assert.equal(result.lastSync.version, 1);
  assert.equal(result.lastError, null);
  assertStateShape(result);

  const runDir = path.join(dataDir, 'run');
  const configText = fs.readFileSync(path.join(runDir, 'frpc.toml'), 'utf8');
  assert.equal(configText, iniConfig());
  assert.ok(!fs.readFileSync(path.join(runDir, 'frpc.toml')).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  assert.equal(fs.readFileSync(path.join(runDir, 'frpc.toml.version'), 'utf8'), '1');
  assert.equal(fs.existsSync(path.join(runDir, 'frpc.toml.new')), false, '暂存文件应清理');
  assert.equal(fs.existsSync(path.join(runDir, 'frpc.pid')), true);

  assert.equal(api.state.statusReports.length, 1);
  const report = api.state.statusReports[0];
  assert.equal(report.pcId, 'pc-home');
  assert.equal(report.version, 1);
  assert.equal(report.applied, true);
  assert.equal(report.frpcRunning, true);
  assert.equal(report.error, null);
  assert.match(report.checkedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);

  const logs = await service.getLogs();
  assert.ok(logs.some((entry) => entry.source === 'sync' && /已生效/.test(entry.text)));
  assert.ok(logs.every((entry) => !entry.text.includes(api.state.token)), '日志不能出现明文 pcToken');
  assert.ok(logs.every((entry) => !entry.text.includes('frps-test-token')), '日志不能出现明文 frps token');
});

test('syncNow() skips when the version is unchanged and frpc is running', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir, state } = setup(t);
  await prime(service, api, dataDir);
  await service.syncNow();
  const reportsAfterFirst = api.state.statusReports.length;
  const runner = latestRunner(state);
  const startsAfterFirst = runner.startCount;

  const skipped = await service.syncNow();
  assert.equal(skipped.lastSync.action, 'skip');
  assert.equal(skipped.lastSync.version, 1);
  assert.equal(skipped.phase, 'online');
  assert.equal(runner.startCount, startsAfterFirst, '跳过时不应重启 frpc');
  assert.equal(api.state.statusReports.length, reportsAfterFirst, '跳过时无需重复回传');
});

test('a new published version replaces the config, keeps a backup and restarts frpc', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir, state } = setup(t);
  await prime(service, api, dataDir);
  await service.syncNow();
  const firstRunner = latestRunner(state);
  const firstPid = firstRunner.pid;

  api.state.config = {
    version: 2,
    config: iniConfig({ proxies: [{ name: 'echo', localPort: 18080, remotePort: 20024 }] }),
    updatedAt: '2026-11-05T01:00:00Z',
  };
  const result = await service.syncNow();
  assert.equal(result.applied.version, 2);
  assert.equal(result.remote.version, 2);
  assert.equal(result.remote.updatedAt, '2026-11-05T01:00:00Z');
  assert.equal(result.remote.proxies.length, 1);
  assert.equal(result.remote.proxies[0].remotePort, 20024);
  assert.equal(result.lastSync.action, 'apply');
  assert.equal(state.runners.length, 2, '新版本应重启 frpc');
  const secondRunner = latestRunner(state);
  assert.equal(secondRunner.startCount, 1);
  assert.notEqual(secondRunner.pid, firstPid);

  const runDir = path.join(dataDir, 'run');
  assert.ok(fs.readFileSync(path.join(runDir, 'frpc.toml'), 'utf8').includes('remote_port = 20024'));
  assert.ok(fs.readFileSync(path.join(runDir, 'frpc.toml.bak'), 'utf8').includes('remote_port = 20022'), '旧配置应备份');
  assert.equal(fs.readFileSync(path.join(runDir, 'frpc.toml.version'), 'utf8'), '2');
  assert.equal(result.applied.backupPath, path.join(runDir, 'frpc.toml.bak'));

  const report = api.state.statusReports[api.state.statusReports.length - 1];
  assert.equal(report.version, 2);
  assert.equal(report.applied, true);
  assert.equal(report.frpcRunning, true);
});

// ---------------------------------------------------------------------------
// sync failure paths
// ---------------------------------------------------------------------------

test('invalid config keeps the old config and the old frpc process, reports applied=false', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir, state } = setup(t, {
    verifyConfig: async (stagingPath) => {
      const text = fs.readFileSync(stagingPath, 'utf8');
      return text.includes('[broken')
        ? { ok: false, message: '配置格式错误：simulated syntax error' }
        : { ok: true, message: '配置校验通过' };
    },
  });
  await prime(service, api, dataDir);
  await service.syncNow();
  const runner = latestRunner(state);
  const goodConfig = fs.readFileSync(path.join(dataDir, 'run', 'frpc.toml'), 'utf8');
  const goodPid = runner.pid;

  api.state.config = {
    version: 3,
    config: '[common]\nserver_addr = 127.0.0.1\nserver_port = 7200\n[broken\n',
    updatedAt: null,
  };
  await assert.rejects(service.syncNow(), (error) => {
    assert.equal(error.code, 'CONFIG_INVALID');
    assert.match(error.message, /配置校验失败/);
    return true;
  });

  const current = service.getState();
  assert.equal(current.applied.version, 1, '校验失败不应更新已应用版本');
  assert.equal(current.lastSync.action, 'fail');
  assert.equal(current.lastSync.ok, false);
  assert.equal(current.lastSync.version, 3);
  assert.equal(current.lastError.code, 'CONFIG_INVALID');
  assert.match(current.lastError.message, /simulated syntax error/);
  assert.equal(fs.readFileSync(path.join(dataDir, 'run', 'frpc.toml'), 'utf8'), goodConfig, '旧配置必须保留');
  assert.equal(runner.pid, goodPid, '旧 frpc 进程必须保留');
  assert.equal(runner.startCount, 1, '校验失败不应重启 frpc');
  assert.equal(fs.existsSync(path.join(dataDir, 'run', 'frpc.toml.new')), false, '失败后暂存文件应清理');

  const report = api.state.statusReports[api.state.statusReports.length - 1];
  assert.equal(report.version, 3);
  assert.equal(report.applied, false);
  assert.equal(report.frpcRunning, true);
  assert.match(report.error, /配置校验失败/);
});

test('a 401 token failure returns UNAUTHORIZED and writes no config files', async (t) => {
  const api = await createFakeApi(t, { token: 'good-token' });
  const { service, dataDir, state } = setup(t);
  await prime(service, api, dataDir);
  await service.saveConnection({ pcToken: 'wrong-token' });
  const runDir = path.join(dataDir, 'run');
  const before = fs.readdirSync(runDir);

  await assert.rejects(service.syncNow(), (error) => {
    assert.equal(error.code, 'UNAUTHORIZED');
    assert.match(error.message, /401/);
    return true;
  });

  assert.deepEqual(fs.readdirSync(runDir), before, '错误 token 不应写入任何 run 目录文件');
  const current = service.getState();
  assert.equal(current.applied.version, null);
  assert.equal(current.remote.reachable, false);
  assert.equal(current.lastSync.action, 'fail');
  assert.equal(current.lastSync.ok, false);
  assert.equal(api.state.statusReports.length, 0, '鉴权失败时无法回传状态');
  assert.ok(!JSON.stringify(current.lastError).includes('wrong-token'), '错误信息不能包含明文 token');
});

test('a 404 (nothing published) is a friendly NOT_FOUND failure', async (t) => {
  const api = await createFakeApi(t, { config: null });
  const { service, dataDir } = setup(t);
  await prime(service, api, dataDir);
  await assert.rejects(service.syncNow(), (error) => {
    assert.equal(error.code, 'NOT_FOUND');
    assert.match(error.message, /还没有发布/);
    return true;
  });
  assert.equal(service.getState().applied.version, null);
});

test('syncNow() requires configuration and a binary before touching the network', async (t) => {
  const api = await createFakeApi(t);
  const { service } = setup(t);
  await service.bootstrap();
  await assert.rejects(service.syncNow(), (error) => {
    assert.equal(error.code, 'VALIDATION');
    return true;
  });
  assert.equal(api.state.configRequests, 0);

  await service.saveConnection({ apiBase: api.baseUrl, pcId: 'pc-home', pcToken: api.state.token });
  await assert.rejects(service.syncNow(), (error) => {
    assert.equal(error.code, 'BINARY_MISSING');
    return true;
  });
  assert.equal(api.state.configRequests, 0, '缺二进制的检查应早于网络请求');
});

test('verify error messages are redacted so tokens never leak', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir, state } = setup(t, {
    verifyConfig: async () => ({ ok: false, message: '配置格式错误：token = frps-test-token 非法' }),
  });
  await prime(service, api, dataDir);
  await assert.rejects(service.syncNow(), (error) => {
    assert.equal(error.code, 'CONFIG_INVALID');
    assert.ok(!error.message.includes('frps-test-token'), '错误信息必须脱敏');
    return true;
  });
  const current = service.getState();
  assert.ok(!JSON.stringify(current.lastError).includes('frps-test-token'));
  const logs = await service.getLogs();
  assert.ok(logs.every((entry) => !entry.text.includes('frps-test-token')), '同步日志必须脱敏');
});

// ---------------------------------------------------------------------------
// manual frpc control
// ---------------------------------------------------------------------------

test('stopFrpc()/startFrpc()/restartFrpc() drive the process and report status', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir, state } = setup(t);
  await prime(service, api, dataDir);
  await service.syncNow();
  const runner = latestRunner(state);
  assert.equal(runner.startCount, 1);

  const stopped = await service.stopFrpc();
  assert.equal(stopped.frpc.running, false);
  assert.equal(stopped.phase, 'offline');
  assert.equal(stopped.lastSync.action, 'report');
  assert.equal(fs.existsSync(path.join(dataDir, 'run', 'frpc.pid')), false);
  assert.equal(api.state.statusReports[api.state.statusReports.length - 1].frpcRunning, false);
  await assert.rejects(service.stopFrpc(), (error) => {
    assert.equal(error.code, 'NOT_RUNNING');
    return true;
  });

  const started = await service.startFrpc();
  assert.equal(started.frpc.running, true);
  assert.equal(started.phase, 'online');
  assert.equal(api.state.statusReports[api.state.statusReports.length - 1].frpcRunning, true);
  assert.equal(state.runners.length, 2, 'startFrpc 应新建 runner');

  const restarted = await service.restartFrpc();
  assert.equal(restarted.frpc.running, true);
  assert.equal(state.runners.length, 3, '重启应停止并重新启动一次');
  assert.equal(latestRunner(state).startCount, 1);
  assert.equal(api.state.statusReports[api.state.statusReports.length - 1].frpcRunning, true);
});

test('shutdown() stops the running frpc and keeps saved settings', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir, state } = setup(t);
  await prime(service, api, dataDir);
  await service.syncNow();
  const runner = latestRunner(state);
  assert.equal(runner.startCount, 1);
  await service.shutdown();
  assert.equal(runner.stopCount, 1);
  assert.equal(fs.existsSync(path.join(dataDir, 'run', 'frpc.pid')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'settings.json')), true);
  await service.shutdown();
});

test('shutdown() reports a stop failure and allows retry', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir, state } = setup(t);
  await prime(service, api, dataDir);
  await service.syncNow();
  const runner = latestRunner(state);
  const stop = runner.stop;
  runner.stop = async () => { throw new Error('stop failed'); };
  await assert.rejects(service.shutdown(), /stop failed/);
  assert.equal(fs.existsSync(path.join(dataDir, 'run', 'frpc.pid')), true);
  runner.stop = stop;
  await service.shutdown();
  assert.equal(fs.existsSync(path.join(dataDir, 'run', 'frpc.pid')), false);
});

test('startFrpc() requires a config and a binary; unexpected exits set phase=error', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir, state } = setup(t);
  await prime(service, api, dataDir);
  await assert.rejects(service.startFrpc(), (error) => {
    assert.equal(error.code, 'CONFIG_INVALID');
    assert.match(error.message, /还没有生效配置/);
    return true;
  });

  await service.syncNow();
  const runner = latestRunner(state);
  runner.setHints({ loggedIn: false, lastError: 'login to server failed: authorization failed' });
  runner.emitExit({ code: 1, signal: null, at: Date.now() });
  await waitFor(() => service.getState().frpc.running === false, 2000, '退出事件处理');
  const current = service.getState();
  assert.equal(current.phase, 'error');
  assert.equal(current.lastError.code, 'SPAWN_FAILED');
  assert.match(current.lastError.message, /已退出/);
  assert.equal(current.frpc.exitedAt > 0, true);
  assert.equal(fs.existsSync(path.join(dataDir, 'run', 'frpc.pid')), false);
  await waitFor(() => api.state.statusReports.some((report) => report.frpcRunning === false), 2000, '退出回传');
});

// ---------------------------------------------------------------------------
// auto sync
// ---------------------------------------------------------------------------

test('启动时自动同步设置持久化，并在下次启动时立即同步', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir, internals } = setup(t);
  await prime(service, api, dataDir);
  await service.setStartOnLaunch(true);
  await service.setAutoSync(false, 45);
  service.dispose();

  const restarted = createService({ dataDir, internals });
  t.after(() => restarted.dispose());
  const initial = await restarted.bootstrap();
  assert.equal(initial.autoSync.startOnLaunch, true);
  assert.equal(initial.autoSync.enabled, true);
  await waitFor(() => restarted.getState().lastSync.ok === true, 4000, '启动时同步');
  assert.equal(api.state.configRequests, 1);
  assert.ok(restarted.getState().autoSync.nextAt > Date.now());
  await restarted.setStartOnLaunch(false);
  assert.equal(createStore(dataDir).read().autoSync.startOnLaunch, false);
});

test('setAutoSync() schedules polling, skips unchanged versions and can be disabled', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir } = setup(t);
  await prime(service, api, dataDir);
  await service.syncNow();
  const requestsBefore = api.state.configRequests;

  const enabled = await service.setAutoSync(true, 1);
  assert.equal(enabled.autoSync.enabled, true);
  assert.equal(enabled.autoSync.intervalSec, 1);
  assert.ok(enabled.autoSync.nextAt > Date.now() - 5000);

  await waitFor(() => api.state.configRequests > requestsBefore, 4000, '自动同步轮询');
  await waitFor(() => service.getState().lastSync.action === 'skip', 4000, '自动同步跳过');
  assert.equal(service.getState().phase, 'online');

  const disabled = await service.setAutoSync(false);
  assert.equal(disabled.autoSync.enabled, false);
  assert.equal(disabled.autoSync.nextAt, null);
  const requestsAfterDisable = api.state.configRequests;
  await sleep(1300);
  assert.equal(api.state.configRequests, requestsAfterDisable, '关闭后不应继续轮询');

  await service.setAutoSync(true, 45);
  assert.equal(service.getState().autoSync.intervalSec, 45);
  await service.setAutoSync(false);
  await assert.rejects(service.setAutoSync(true, 0), (error) => {
    assert.equal(error.code, 'VALIDATION');
    return true;
  });

  // dispose() must cancel the polling timer (no background requests afterwards).
  await service.setAutoSync(true, 1);
  service.dispose();
  const requestsAtDispose = api.state.configRequests;
  await sleep(1300);
  assert.equal(api.state.configRequests, requestsAtDispose, 'dispose 后自动同步轮询必须停止');
});

// ---------------------------------------------------------------------------
// binary management
// ---------------------------------------------------------------------------

test('binary management: listVersions, download progress, pick/set path, busy guards', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir, host, state } = setup(t, {
    downloadBinary: async (options) => {
      options.onProgress({ phase: 'download', receivedBytes: 50, totalBytes: 100, percent: 50 });
      return { path: path.join(options.binDir, 'frpc.exe'), version: '0.72.0', source: 'downloaded' };
    },
  });
  await service.bootstrap();
  const versions = await service.listVersions();
  assert.equal(versions.recommended, '0.71.1');

  const downloaded = await service.downloadBinary('v0.72.0');
  assert.equal(downloaded.frpc.binary.status, 'ready');
  assert.equal(downloaded.frpc.binary.version, '0.72.0');
  assert.equal(downloaded.frpc.binary.source, 'downloaded');
  assert.equal(downloaded.frpc.binary.download.active, false);
  assert.equal(downloaded.frpc.binary.download.percent, 100);

  const realFile = path.join(dataDir, 'picked-frpc.exe');
  fs.writeFileSync(realFile, 'MZ');
  host.dialogs.push([realFile]);
  const picked = await service.pickBinary();
  assert.equal(picked.frpc.binary.path, realFile);
  assert.equal(picked.frpc.binary.source, 'custom');
  host.dialogs.push(null);
  assert.equal((await service.pickBinary()).frpc.binary.path, realFile);

  await assert.rejects(service.setBinaryPath(path.join(dataDir, 'missing.exe')), /不存在/);
  await assert.rejects(service.downloadBinary('latest'), /版本号/);

  // Busy guard while frpc runs.
  const fakeApi = await api;
  await service.saveConnection({ apiBase: fakeApi.baseUrl, pcId: 'pc-home', pcToken: fakeApi.state.token });
  await service.setBinaryPath(realFile);
  await service.syncNow();
  assert.equal(service.getState().frpc.running, true);
  await assert.rejects(service.downloadBinary('0.71.1'), (error) => {
    assert.equal(error.code, 'BUSY');
    return true;
  });
  await assert.rejects(service.setBinaryPath(realFile), (error) => {
    assert.equal(error.code, 'BUSY');
    return true;
  });
  await service.stopFrpc();
  assert.ok(state.startCount >= 1);
});

// ---------------------------------------------------------------------------
// files / logs / host utilities
// ---------------------------------------------------------------------------

test('getConfigText()/verifyConfig()/openConfigFile()/openFolder()/copyText() behave per contract', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir, host } = setup(t);
  await prime(service, api, dataDir);

  const emptyConfig = await service.getConfigText();
  assert.deepEqual(emptyConfig, {
    text: '',
    path: path.join(dataDir, 'run', 'frpc.toml'),
    version: null,
    format: 'ini',
  });
  await assert.rejects(service.openConfigFile(), (error) => {
    assert.equal(error.code, 'NOT_FOUND');
    return true;
  });

  const noConfigVerify = await service.verifyConfig();
  assert.equal(noConfigVerify.ok, false);
  assert.match(noConfigVerify.message, /还没有生效配置/);

  await service.syncNow();
  const config = await service.getConfigText();
  assert.equal(config.version, 1);
  assert.equal(config.format, 'ini');
  assert.ok(config.text.includes('[common]'));

  const verified = await service.verifyConfig();
  assert.equal(verified.ok, true);
  assert.equal(verified.message, '配置校验通过');

  await service.openConfigFile();
  assert.equal(host.opened[0], path.join(dataDir, 'run', 'frpc.toml'));

  await service.openFolder('data');
  await service.openFolder('bin');
  await service.openFolder('log');
  await service.openFolder('run');
  assert.deepEqual(host.opened.slice(1), [
    dataDir,
    path.join(dataDir, 'bin'),
    path.join(dataDir, 'logs'),
    path.join(dataDir, 'run'),
  ]);
  await assert.rejects(service.openFolder('nope'), /data\/bin\/log\/run/);

  await service.copyText('127.0.0.1:20022');
  assert.deepEqual(host.copied, ['127.0.0.1:20022']);
  await assert.rejects(service.copyText(42), /字符串/);
});

test('logs: sync/frpc sources, filtering, redaction, copies and clearLogs', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir, state } = setup(t);
  await prime(service, api, dataDir);
  await service.syncNow();
  const runner = latestRunner(state);
  const token = api.state.token;
  runner.emitLog([{ at: Date.now(), level: 'info', text: `login to server success token ${token}`, source: 'frpc' }]);

  const all = await service.getLogs();
  assert.ok(all.some((entry) => entry.source === 'sync'));
  assert.ok(all.some((entry) => entry.source === 'frpc'));
  for (const entry of all) {
    for (const key of ['id', 'at', 'source', 'level', 'text']) assert.ok(key in entry, `LogEntry 缺少 ${key}`);
    assert.ok(['sync', 'frpc'].includes(entry.source));
    assert.ok(['debug', 'info', 'warn', 'error'].includes(entry.level));
    assert.ok(!entry.text.includes(token), '日志必须脱敏');
  }

  const frpcLogs = await service.getLogs('frpc');
  assert.ok(frpcLogs.length >= 1);
  assert.ok(frpcLogs.every((entry) => entry.source === 'frpc'));
  const syncLogs = await service.getLogs('sync');
  assert.ok(syncLogs.every((entry) => entry.source === 'sync'));
  await assert.rejects(service.getLogs('other'), (error) => {
    assert.equal(error.code, 'VALIDATION');
    return true;
  });

  const copy = await service.getLogs();
  copy[0].text = 'mutated';
  assert.notEqual((await service.getLogs())[0].text, 'mutated');

  const cleared = await service.clearLogs();
  assert.deepEqual(await service.getLogs(), []);
  assert.ok(cleared.phase);
});

test('dispose() is sync, idempotent and rejects further operations', async (t) => {
  const { service } = setup(t);
  await service.bootstrap();
  service.dispose();
  service.dispose();
  await assert.rejects(service.saveConnection({ pcToken: 'x' }), (error) => {
    assert.equal(error.code, 'INTERNAL');
    return true;
  });
  await assert.rejects(async () => service.bootstrap(), (error) => {
    assert.equal(error.code, 'INTERNAL');
    return true;
  });
});

// ---------------------------------------------------------------------------
// pid takeover
// ---------------------------------------------------------------------------

test('bootstrap() re-attaches to a live frpc pid and stopFrpc() terminates it', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir, state } = setup(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => {
    if (runnerlib.isProcessAlive(child.pid)) {
      try { require('node:child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch (_) { /* ignore */ }
    }
  });
  await waitFor(() => runnerlib.isProcessAlive(child.pid), 3000, '子进程启动');
  fs.mkdirSync(path.join(dataDir, 'run'), { recursive: true });
  runnerlib.writePidFile(path.join(dataDir, 'run', 'frpc.pid'), { pid: child.pid, startedAt: Date.now() - 1000, version: '0.71.1' });
  fs.writeFileSync(path.join(dataDir, 'run', 'frpc.toml'), iniConfig(), 'utf8');
  const store = createStore(dataDir);
  const settings = store.read();
  settings.connection = { apiBase: api.baseUrl, pcId: 'pc-home', pcToken: api.state.token };
  store.write(settings);

  const bootstrapped = await service.bootstrap();
  assert.equal(bootstrapped.frpc.running, true);
  assert.equal(bootstrapped.frpc.pid, child.pid);
  assert.equal(state.adopted, child.pid, 'runner 应接管已有 pid');

  const stopped = await service.stopFrpc();
  assert.equal(stopped.frpc.running, false);
  assert.equal(runnerlib.isProcessAlive(child.pid), false, '接管进程应被真正终止');
  assert.equal(fs.existsSync(path.join(dataDir, 'run', 'frpc.pid')), false);

  // A stale pid file is cleaned up on bootstrap.
  const { service: second } = setup(t);
  fs.mkdirSync(path.join(second.dataDir, 'run'), { recursive: true });
  runnerlib.writePidFile(path.join(second.dataDir, 'run', 'frpc.pid'), { pid: 999999, startedAt: Date.now() });
  const fresh = await second.bootstrap();
  assert.equal(fresh.frpc.running, false);
  assert.equal(fs.existsSync(path.join(second.dataDir, 'run', 'frpc.pid')), false);
});

// ---------------------------------------------------------------------------
// v3: publishProxies + forced sync
// ---------------------------------------------------------------------------

const VALID_PROXY = {
  name: 'echo', type: 'tcp', localIp: '127.0.0.1', localPort: 18080, remotePort: 20022, enabled: true,
};

test('publishProxies() validates the proxy payload locally', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir } = setup(t);
  await prime(service, api, dataDir);
  const cases = [
    ['not-an-array', /数组/],
    [[{ ...VALID_PROXY, name: 'bad name!' }], /无效/],
    [[VALID_PROXY, { ...VALID_PROXY, remotePort: 20023 }], /重复/],
    [[{ ...VALID_PROXY, type: 'udp' }], /只支持 tcp/],
    [[{ ...VALID_PROXY, localIp: '   ' }], /本地地址/],
    [[{ ...VALID_PROXY, localPort: 0 }], /本地端口/],
    [[{ ...VALID_PROXY, localPort: 65536 }], /本地端口/],
    [[{ ...VALID_PROXY, localPort: '80' }], /本地端口/],
    [[{ ...VALID_PROXY, remotePort: 0 }], /远程端口/],
    [[{ ...VALID_PROXY, remotePort: 1.5 }], /远程端口/],
    [[VALID_PROXY, { ...VALID_PROXY, name: 'other' }], /共用/],
    [[{ ...VALID_PROXY, enabled: 'yes' }], /启用状态/],
  ];
  for (const [proxies, pattern] of cases) {
    await assert.rejects(service.publishProxies(proxies), (error) => {
      assert.equal(error.code, 'VALIDATION');
      assert.match(error.message, pattern);
      return true;
    });
  }
  assert.equal(api.state.publishRequests.length, 0, '本地校验失败不应发请求');
});

test('publishProxies() requires a configured connection before any request', async (t) => {
  const api = await createFakeApi(t);
  const { service } = setup(t);
  await service.bootstrap();
  await assert.rejects(service.publishProxies([VALID_PROXY]), (error) => {
    assert.equal(error.code, 'VALIDATION');
    return true;
  });
  assert.equal(api.state.publishRequests.length, 0);
  assert.equal(api.state.configRequests, 0);
});

test('publishProxies() publishes then force-applies the new version and restarts frpc', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir, state } = setup(t);
  await prime(service, api, dataDir);
  const before = await service.syncNow();
  assert.equal(before.applied.version, 1);
  assert.ok(Array.isArray(before.applied.proxies));
  const runnersBefore = state.runners.length;

  const proxies = [
    { name: 'echo', type: 'tcp', localIp: '127.0.0.1', localPort: 18080, remotePort: 20024, enabled: true },
    { name: 'extra', type: 'tcp', localIp: '127.0.0.1', localPort: 18081, remotePort: 20025, enabled: true },
  ];
  const published = await service.publishProxies(proxies);
  assert.equal(api.state.publishRequests.length, 1);
  const request = api.state.publishRequests[0];
  assert.equal(request.pcId, 'pc-home');
  assert.deepEqual(request.proxies, proxies);
  assert.equal(published.applied.version, 2);
  assert.equal(published.remote.version, 2);
  assert.equal(published.lastSync.action, 'apply');
  assert.equal(published.lastSync.ok, true);
  assert.equal(state.runners.length, runnersBefore + 1, '发布后应重启 frpc');

  const runDir = path.join(dataDir, 'run');
  const configText = fs.readFileSync(path.join(runDir, 'frpc.toml'), 'utf8');
  assert.ok(configText.includes('remote_port = 20024'));
  assert.ok(configText.includes('[extra]'));
  assert.equal(fs.readFileSync(path.join(runDir, 'frpc.toml.version'), 'utf8'), '2');
  assert.ok(published.applied.proxies.some((proxy) => proxy.name === 'extra' && proxy.remotePort === 20025));

  const report = api.state.statusReports[api.state.statusReports.length - 1];
  assert.equal(report.version, 2);
  assert.equal(report.applied, true);
  assert.equal(report.frpcRunning, true);

  const syncLogs = await service.getLogs('sync');
  assert.ok(syncLogs.some((entry) => /已发布 v2/.test(entry.text)));
});

test('publishProxies() keeps disabled duplicate ports legal and omits them from the applied config', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir } = setup(t);
  await prime(service, api, dataDir);
  await service.syncNow();
  const proxies = [
    { name: 'echo', type: 'tcp', localIp: '127.0.0.1', localPort: 18080, remotePort: 20026, enabled: true },
    { name: 'paused', type: 'tcp', localIp: '127.0.0.1', localPort: 18082, remotePort: 20026, enabled: false },
  ];
  const published = await service.publishProxies(proxies);
  assert.equal(published.applied.version, 2);
  const configText = fs.readFileSync(path.join(dataDir, 'run', 'frpc.toml'), 'utf8');
  assert.ok(configText.includes('[echo]'));
  assert.ok(!configText.includes('[paused]'), '禁用代理不应进入运行配置');
  assert.equal(published.applied.proxies.length, 1);
});

test('publishProxies() maps 401 to UNAUTHORIZED without writing config files', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir } = setup(t);
  await prime(service, api, dataDir);
  await service.syncNow();
  api.state.token = 'rotated-token'; // 服务端 token 已轮换，插件仍持旧 token
  const runDir = path.join(dataDir, 'run');
  const filesBefore = fs.readdirSync(runDir).sort();
  const configBefore = fs.readFileSync(path.join(runDir, 'frpc.toml'), 'utf8');
  const reportsBefore = api.state.statusReports.length;

  await assert.rejects(service.publishProxies([{ ...VALID_PROXY, remotePort: 20030 }]), (error) => {
    assert.equal(error.code, 'UNAUTHORIZED');
    assert.match(error.message, /Token|401/);
    return true;
  });
  assert.deepEqual(fs.readdirSync(runDir).sort(), filesBefore, '401 不应写任何 run 文件');
  assert.equal(fs.readFileSync(path.join(runDir, 'frpc.toml'), 'utf8'), configBefore);
  assert.equal(api.state.statusReports.length, reportsBefore);
  assert.equal(service.getState().applied.version, 1);
  assert.equal(service.getState().lastError.code, 'UNAUTHORIZED');
});

test('publishProxies() maps 400 to VALIDATION using the server error text', async (t) => {
  const api = await createFakeApi(t, { publishStatus: 400, publishError: '代理名 echo 重复了' });
  const { service, dataDir } = setup(t);
  await prime(service, api, dataDir);
  const runDir = path.join(dataDir, 'run');
  const filesBefore = fs.readdirSync(runDir).sort();
  await assert.rejects(service.publishProxies([VALID_PROXY]), (error) => {
    assert.equal(error.code, 'VALIDATION');
    assert.equal(error.message, '代理名 echo 重复了');
    return true;
  });
  assert.deepEqual(fs.readdirSync(runDir).sort(), filesBefore);
  assert.equal(service.getState().applied.version, null);
});

test('publishProxies() maps network failures to NETWORK', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir } = setup(t);
  await prime(service, api, dataDir);
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const deadPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  await service.saveConnection({ apiBase: `http://127.0.0.1:${deadPort}` });
  await assert.rejects(service.publishProxies([VALID_PROXY]), (error) => {
    assert.equal(error.code, 'NETWORK');
    return true;
  });
});

test('syncNow({force:true}) re-applies an unchanged version instead of skipping', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir, state } = setup(t);
  await prime(service, api, dataDir);
  const first = await service.syncNow();
  assert.equal(first.lastSync.action, 'apply');
  const runnersAfterFirst = state.runners.length;
  const appliedAt = first.applied.at;

  const skipped = await service.syncNow();
  assert.equal(skipped.lastSync.action, 'skip');
  assert.equal(state.runners.length, runnersAfterFirst, '无 force 时版本相同应跳过');

  await sleep(20);
  const forced = await service.syncNow({ force: true });
  assert.equal(forced.lastSync.action, 'apply');
  assert.equal(forced.lastSync.ok, true);
  assert.equal(forced.applied.version, 1);
  assert.equal(state.runners.length, runnersAfterFirst + 1, 'force 应重新应用并重启 frpc');
  assert.ok(forced.applied.at >= appliedAt);
  assert.equal(api.state.statusReports[api.state.statusReports.length - 1].version, 1);
});

test('service network calls never use the renderer global fetch (node-fetch.cjs only)', async (t) => {
  const api = await createFakeApi(t);
  const { service, dataDir } = setup(t);
  const originalFetch = globalThis.fetch;
  let globalCalls = 0;
  globalThis.fetch = () => {
    globalCalls += 1;
    return Promise.reject(new Error('global fetch must not be used'));
  };
  try {
    await prime(service, api, dataDir);
    const synced = await service.syncNow();
    assert.equal(synced.phase, 'online');
    const published = await service.publishProxies([{ ...VALID_PROXY, remotePort: 20031 }]);
    assert.equal(published.applied.version, 2);
    assert.equal(globalCalls, 0, 'core 不应调用渲染进程全局 fetch');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
