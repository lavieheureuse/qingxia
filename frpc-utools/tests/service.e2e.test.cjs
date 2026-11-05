'use strict';

// Real end-to-end test for the v2 sync-proxy core (SPEC-SYNC §8):
//   local fake iostool API server -> service.syncNow() -> real frpc 0.71.1
//   -> real local frps on 127.0.0.1:7200 -> TCP roundtrip through the published
//   remotePort -> POST /frp/status back to the fake server.
//
// Covered scenarios:
//   1. first sync (v1, two tcp proxies) applies + connects + reports;
//   2. published v2 changes a remote port -> re-sync applies it;
//   3. invalid config -> verify fails, old config + old frpc process kept,
//      status reports applied=false + error;
//   4. wrong pcToken -> UNAUTHORIZED, no run/* files written.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { createService } = require('../core/service.cjs');
const runnerlib = require('../core/runner.cjs');

const BIN_DIR = process.env.FRPC_E2E_BIN_DIR
  || path.join(__dirname, '..', '..', '.work', 'bin', 'frp_0.71.1_windows_amd64');
const FRPC = path.join(BIN_DIR, 'frpc.exe');
const FRPS = path.join(BIN_DIR, 'frps.exe');
const FRPS_PORT = 7200;
const FRPS_TOKEN = 'e2e-frps-token';
const PC_TOKEN = 'e2e-pc-token-9f3a';
const PC_ID = 'pc-e2e';
const TEST_TIMEOUT_MS = 180000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 10000);
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`等待超时：${label || '条件'}${lastError ? `（${lastError.message}）` : ''}`);
}

function tryConnect(port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners('connect');
      socket.removeAllListeners('timeout');
      socket.on('error', () => { /* expected reset after probe */ });
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs || 400, () => done(false));
  });
}

async function waitPortOpen(port, timeoutMs) {
  await waitFor(() => tryConnect(port, 300), timeoutMs, `端口 ${port} 监听`);
}

async function waitPortClosed(port, timeoutMs) {
  await waitFor(async () => !(await tryConnect(port, 300)), timeoutMs, `端口 ${port} 关闭`);
}

async function tcpEcho(port, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let received = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接 127.0.0.1:${port} 超时`));
    }, timeoutMs || 5000);
    socket.on('connect', () => socket.write(message));
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      if (received.length >= message.length) {
        clearTimeout(timer);
        socket.end();
        resolve(received);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitEcho(port, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const echoed = await tcpEcho(port, message, 2000);
      if (echoed === message) return true;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`端口 ${port} 未能真实打通：${lastError ? lastError.message : '无响应'}`);
}

function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function createEchoServer() {
  const server = net.createServer((socket) => {
    socket.on('error', () => { /* clients (frpc probes) may reset abruptly */ });
    socket.pipe(socket);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function listeningPids(port) {
  const result = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
  const pids = new Set();
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const match = line.match(new RegExp(`[.:]${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i'));
    if (match) pids.add(Number(match[1]));
  }
  return Array.from(pids);
}

function processImage(pid) {
  const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const match = /^"([^"]+)"/.exec(String(result.stdout || ''));
  return match ? match[1].toLowerCase() : '';
}

/** Kill leftover frpc/frps listeners from a previous aborted run (test ports only). */
function cleanupStaleFrpListeners(port) {
  for (const pid of listeningPids(port)) {
    const image = processImage(pid);
    if (image.includes('frpc') || image.includes('frps')) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    }
  }
}

function killTree(pid) {
  if (!pid || !runnerlib.isProcessAlive(pid)) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
}

/** Fake iostool server implementing /health, GET /frp/config, POST /frp/status. */
function createFakeIostoolServer(t) {
  const state = {
    token: PC_TOKEN,
    published: null, // {version, config, updatedAt}
    statusReports: [],
    configRequests: 0,
    publishRequests: [],
    publishAttempts: 0,
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
      const authorized = req.headers.authorization === `Bearer ${state.token}`;
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/health') return send(200, { ok: true });
      if (url.pathname === '/frp/config' && req.method === 'GET') {
        state.configRequests += 1;
        if (!authorized) return send(401, { error: '未授权' });
        if (!state.published) return send(404, { error: '这台电脑还没有发布过的配置' });
        return send(200, {
          pcId: url.searchParams.get('pcId'),
          version: state.published.version,
          config: state.published.config,
          updatedAt: state.published.updatedAt,
        });
      }
      if (url.pathname === '/frp/config' && req.method === 'POST') {
        state.publishAttempts += 1;
        if (!authorized) return send(401, { error: '未授权' });
        let body = null;
        try { body = JSON.parse(bodyText || 'null'); } catch (_) { body = null; }
        if (!body || !Array.isArray(body.proxies)) return send(400, { error: 'proxies 必须是数组' });
        const version = (state.published ? Number(state.published.version) : 0) + 1;
        const updatedAt = new Date().toISOString();
        state.published = { version, config: publishedIni(body.proxies), updatedAt };
        state.publishRequests.push({ pcId: body.pcId, proxies: body.proxies, version });
        return send(200, { pcId: body.pcId, version });
      }
      if (url.pathname === '/frp/status' && req.method === 'POST') {
        if (!authorized) return send(401, { error: '未授权' });
        let body = null;
        try { body = JSON.parse(bodyText || 'null'); } catch (_) { body = null; }
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
      resolve({ server, state, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/** Server-delivered INI: [common] + token + enabled [name] tcp proxies, no webServer. */
function publishedIni(proxies) {
  const lines = ['[common]', 'server_addr = 127.0.0.1', `server_port = ${FRPS_PORT}`, `token = ${FRPS_TOKEN}`, ''];
  for (const proxy of proxies) {
    if (proxy.enabled === false) continue;
    lines.push(`[${proxy.name}]`, 'type = tcp', 'local_ip = 127.0.0.1',
      `local_port = ${proxy.localPort}`, `remote_port = ${proxy.remotePort}`, '');
  }
  return lines.join('\n');
}

test('e2e: 真实 frps + frpc 同步代理全流程', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  if (!fs.existsSync(FRPC) || !fs.existsSync(FRPS)) {
    t.skip(`本机没有 frp 测试二进制（${BIN_DIR}），跳过 e2e`);
    return;
  }

  const e2eDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-e2e-'));
  const dataDir = path.join(e2eDir, 'data');
  const frpsLogPath = path.join(e2eDir, 'frps.log');
  let frpsLogFd = null;
  let frpsProcess = null;
  let echo1 = null;
  let echo2 = null;
  let service = null;
  let fake = null;

  try {
    // --- clean ports from a previous aborted run --------------------------
    for (const port of [FRPS_PORT, ...Array.from({ length: 4 }, (_, i) => 0)]) {
      if (port) cleanupStaleFrpListeners(port);
    }
    if (listeningPids(FRPS_PORT).length) {
      throw new Error(`端口 ${FRPS_PORT} 被非 frp 进程占用，无法运行 e2e`);
    }

    // --- local services + remote ports ------------------------------------
    echo1 = await createEchoServer();
    echo2 = await createEchoServer();
    const remotePort1 = await reserveFreePort();
    const remotePort2 = await reserveFreePort();
    const remotePort3 = await reserveFreePort();
    const remotePort4 = await reserveFreePort();

    // --- real frps --------------------------------------------------------
    const frpsConfigPath = path.join(e2eDir, 'frps.toml');
    fs.writeFileSync(frpsConfigPath, [
      `bindPort = ${FRPS_PORT}`,
      'auth.method = "token"',
      `auth.token = "${FRPS_TOKEN}"`,
      'log.to = "./frps.log"',
      'log.level = "info"',
      '',
    ].join('\n'), 'utf8');
    frpsLogFd = fs.openSync(frpsLogPath, 'a');
    frpsProcess = spawn(FRPS, ['-c', frpsConfigPath], {
      cwd: e2eDir,
      windowsHide: true,
      stdio: ['ignore', frpsLogFd, frpsLogFd],
    });
    frpsProcess.on('error', () => { /* surfaced by waitPortOpen */ });
    await waitPortOpen(FRPS_PORT, 15000);

    // --- fake iostool API + v1 published config ---------------------------
    fake = await createFakeIostoolServer(t);
    fake.state.published = {
      version: 1,
      config: publishedIni([
        { name: 'echo1', localPort: echo1.port, remotePort: remotePort1 },
        { name: 'echo2', localPort: echo2.port, remotePort: remotePort2 },
      ]),
      updatedAt: '2026-11-05T00:00:00Z',
    };

    // --- service bootstrap / binary / connection --------------------------
    service = createService({ dataDir, appVersion: '0.1.0', platform: process.platform, arch: process.arch });
    const bootstrapped = await service.bootstrap();
    assert.equal(bootstrapped.phase, 'unconfigured');
    const withBinary = await service.setBinaryPath(FRPC);
    assert.equal(withBinary.frpc.binary.status, 'ready');
    assert.equal(withBinary.frpc.binary.version, '0.71.1');
    await service.saveConnection({ apiBase: fake.baseUrl, pcId: PC_ID, pcToken: PC_TOKEN });

    // === scenario 1: first sync ==========================================
    const synced = await service.syncNow();
    assert.equal(synced.phase, 'online', '首次同步后应在线');
    assert.equal(synced.frpc.running, true);
    assert.ok(Number.isInteger(synced.frpc.pid) && synced.frpc.pid > 0);
    assert.equal(synced.applied.version, 1);
    assert.equal(synced.remote.version, 1);
    assert.equal(synced.remote.reachable, true);
    assert.equal(synced.remote.proxies.length, 2);
    assert.equal(synced.lastSync.action, 'apply');
    assert.equal(synced.lastSync.ok, true);

    const runDir = path.join(dataDir, 'run');
    const configText = fs.readFileSync(path.join(runDir, 'frpc.toml'), 'utf8');
    assert.ok(configText.startsWith('[common]'), '下发配置是 INI 文本');
    assert.ok(configText.includes(`remote_port = ${remotePort1}`));
    assert.equal(fs.readFileSync(path.join(runDir, 'frpc.toml.version'), 'utf8'), '1');
    assert.ok(fs.existsSync(path.join(runDir, 'frpc.pid')));
    assert.equal(fs.existsSync(path.join(runDir, 'frpc.toml.new')), false);

    const report1 = fake.state.statusReports[fake.state.statusReports.length - 1];
    assert.ok(report1, '同步成功必须回传状态');
    assert.equal(report1.pcId, PC_ID);
    assert.equal(report1.version, 1);
    assert.equal(report1.applied, true);
    assert.equal(report1.frpcRunning, true);
    assert.equal(report1.error, null);
    assert.match(report1.checkedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);

    await waitEcho(remotePort1, 'ping-v1-1', 12000);
    await waitEcho(remotePort2, 'ping-v1-2', 12000);

    const logs = await service.getLogs();
    assert.ok(logs.some((entry) => entry.source === 'frpc' && /login to server success/.test(entry.text)), '应捕获 login 日志');
    assert.ok(logs.some((entry) => entry.source === 'frpc' && /start proxy success/.test(entry.text)), '应捕获 proxy start 日志');
    assert.ok(logs.some((entry) => entry.source === 'sync'), '应有同步日志');
    for (const entry of logs) {
      assert.ok(!entry.text.includes(PC_TOKEN), '日志不能出现明文 pcToken');
      assert.ok(!entry.text.includes(FRPS_TOKEN), '日志不能出现明文 frps token');
    }

    // === scenario 2: v2 changes a remote port ============================
    fake.state.published = {
      version: 2,
      config: publishedIni([
        { name: 'echo1', localPort: echo1.port, remotePort: remotePort3 },
      ]),
      updatedAt: '2026-11-05T01:00:00Z',
    };
    const syncedV2 = await service.syncNow();
    assert.equal(syncedV2.applied.version, 2);
    assert.equal(syncedV2.remote.version, 2);
    assert.equal(syncedV2.remote.updatedAt, '2026-11-05T01:00:00Z');
    assert.equal(syncedV2.remote.proxies.length, 1);
    assert.equal(syncedV2.remote.proxies[0].remotePort, remotePort3);
    assert.equal(syncedV2.lastSync.action, 'apply');
    assert.equal(fs.readFileSync(path.join(runDir, 'frpc.toml.version'), 'utf8'), '2');
    assert.ok(fs.readFileSync(path.join(runDir, 'frpc.toml.bak'), 'utf8').includes(`remote_port = ${remotePort1}`), '旧配置应备份');
    assert.ok(fs.readFileSync(path.join(runDir, 'frpc.toml'), 'utf8').includes(`remote_port = ${remotePort3}`));
    await waitEcho(remotePort3, 'ping-v2', 12000);
    await waitPortClosed(remotePort1, 10000);
    const report2 = fake.state.statusReports[fake.state.statusReports.length - 1];
    assert.equal(report2.version, 2);
    assert.equal(report2.applied, true);
    assert.equal(report2.frpcRunning, true);

    // === scenario 3: invalid config keeps old config + old process =======
    const configBeforeBad = fs.readFileSync(path.join(runDir, 'frpc.toml'), 'utf8');
    const pidBeforeBad = service.getState().frpc.pid;
    fake.state.published = {
      version: 3,
      config: '[common]\nserver_addr = 127.0.0.1\nserver_port = 7200\n[broken\n',
      updatedAt: null,
    };
    await assert.rejects(service.syncNow(), (error) => {
      assert.equal(error.code, 'CONFIG_INVALID');
      assert.match(error.message, /配置校验失败/);
      return true;
    });
    const afterBad = service.getState();
    assert.equal(afterBad.applied.version, 2, '校验失败不能更新已应用版本');
    assert.equal(afterBad.lastSync.action, 'fail');
    assert.equal(afterBad.lastError.code, 'CONFIG_INVALID');
    assert.equal(fs.readFileSync(path.join(runDir, 'frpc.toml'), 'utf8'), configBeforeBad, '旧配置必须保留');
    assert.equal(afterBad.frpc.pid, pidBeforeBad, '旧 frpc 进程必须保留');
    assert.equal(runnerlib.isProcessAlive(pidBeforeBad), true);
    assert.equal(fs.existsSync(path.join(runDir, 'frpc.toml.new')), false, '失败后暂存文件应清理');
    await waitEcho(remotePort3, 'still-alive', 12000);
    const report3 = fake.state.statusReports[fake.state.statusReports.length - 1];
    assert.equal(report3.version, 3);
    assert.equal(report3.applied, false);
    assert.equal(report3.frpcRunning, true);
    assert.ok(report3.error && report3.error.length > 0, '失败必须回传 error');

    // === process control: stop / start ===================================
    const stopped = await service.stopFrpc();
    assert.equal(stopped.frpc.running, false);
    assert.equal(runnerlib.isProcessAlive(pidBeforeBad), false);
    assert.equal(fs.existsSync(path.join(runDir, 'frpc.pid')), false);
    const reportStopped = fake.state.statusReports[fake.state.statusReports.length - 1];
    assert.equal(reportStopped.frpcRunning, false);

    const restarted = await service.startFrpc();
    assert.equal(restarted.frpc.running, true);
    assert.equal(restarted.phase, 'online');
    assert.equal(fake.state.statusReports[fake.state.statusReports.length - 1].frpcRunning, true);
    await waitEcho(remotePort3, 'after-restart', 12000);

    // === scenario 4: publishProxies() adds a proxy / new remote port ======
    const proxiesToPublish = [
      { name: 'echo1', type: 'tcp', localIp: '127.0.0.1', localPort: echo1.port, remotePort: remotePort3, enabled: true },
      { name: 'extra', type: 'tcp', localIp: '127.0.0.1', localPort: echo2.port, remotePort: remotePort4, enabled: true },
    ];
    const published = await service.publishProxies(proxiesToPublish);
    assert.equal(fake.state.publishRequests.length, 1, 'publish 应调用 POST /frp/config');
    assert.equal(fake.state.publishRequests[0].pcId, PC_ID);
    assert.deepEqual(fake.state.publishRequests[0].proxies, proxiesToPublish);
    assert.equal(fake.state.publishRequests[0].version, 4);
    assert.equal(published.applied.version, 4);
    assert.equal(published.remote.version, 4);
    assert.equal(published.lastSync.action, 'apply');
    assert.equal(published.frpc.running, true);
    assert.ok(published.applied.proxies.some((proxy) => proxy.name === 'extra' && proxy.remotePort === remotePort4));
    const publishedConfig = fs.readFileSync(path.join(runDir, 'frpc.toml'), 'utf8');
    assert.ok(publishedConfig.includes('[extra]'));
    assert.ok(publishedConfig.includes(`remote_port = ${remotePort4}`));
    assert.equal(fs.readFileSync(path.join(runDir, 'frpc.toml.version'), 'utf8'), '4');
    const reportPublish = fake.state.statusReports[fake.state.statusReports.length - 1];
    assert.equal(reportPublish.version, 4);
    assert.equal(reportPublish.applied, true);
    assert.equal(reportPublish.frpcRunning, true);
    await waitEcho(remotePort4, 'ping-publish', 15000);

    // === scenario 5: syncNow({force:true}) re-applies the same version ====
    const pidBeforeForce = service.getState().frpc.pid;
    await sleep(20);
    const forced = await service.syncNow({ force: true });
    assert.equal(forced.lastSync.action, 'apply', 'force 不能走 skip 分支');
    assert.equal(forced.applied.version, 4);
    assert.equal(forced.phase, 'online');
    assert.notEqual(forced.frpc.pid, pidBeforeForce, 'force 应重启 frpc');
    assert.equal(fake.state.publishAttempts, 1, 'force sync 不应重新发布');
    await waitEcho(remotePort4, 'ping-force', 15000);
    const skipped = await service.syncNow();
    assert.equal(skipped.lastSync.action, 'skip', '无参 sync 版本相同应跳过');

    // === scenario 6: wrong token -> UNAUTHORIZED and no file writes ======
    const filesBefore = fs.readdirSync(runDir).sort();
    const contentBefore = fs.readFileSync(path.join(runDir, 'frpc.toml'), 'utf8');
    const reportsBefore = fake.state.statusReports.length;
    await service.saveConnection({ pcToken: 'definitely-wrong-token' });
    await assert.rejects(service.syncNow(), (error) => {
      assert.equal(error.code, 'UNAUTHORIZED');
      assert.match(error.message, /401|Token/);
      return true;
    });
    assert.deepEqual(fs.readdirSync(runDir).sort(), filesBefore, '错误 token 不应写入任何 run 文件');
    assert.equal(fs.readFileSync(path.join(runDir, 'frpc.toml'), 'utf8'), contentBefore);
    assert.equal(fake.state.statusReports.length, reportsBefore, '鉴权失败时无法回传状态');

    const publishAttemptsBefore = fake.state.publishAttempts;
    await assert.rejects(service.publishProxies(proxiesToPublish), (error) => {
      assert.equal(error.code, 'UNAUTHORIZED');
      assert.match(error.message, /Token|401/);
      return true;
    });
    assert.equal(fake.state.publishAttempts, publishAttemptsBefore + 1, '错误 token 的发布请求应到达服务器并被拒绝');
    assert.equal(fake.state.publishRequests.length, 1, '错误 token 不应产生成功的发布记录');
    assert.deepEqual(fs.readdirSync(runDir).sort(), filesBefore, '错误 token 的发布也不应写 run 文件');
    assert.equal(fs.readFileSync(path.join(runDir, 'frpc.toml'), 'utf8'), contentBefore);

    const afterToken = service.getState();
    assert.equal(afterToken.applied.version, 4);
    assert.ok(!JSON.stringify(afterToken.lastError).includes('definitely-wrong-token'), '错误文案不能泄露 token');
    const syncLogText = fs.readFileSync(path.join(dataDir, 'logs', 'sync.log'), 'utf8');
    assert.ok(!syncLogText.includes('definitely-wrong-token'));
    assert.ok(!syncLogText.includes(PC_TOKEN));
    assert.ok(!syncLogText.includes(FRPS_TOKEN), 'sync.log 不能出现 frps token');
  } finally {
    // --- cleanup: never leave listeners on FRPS_PORT / remote ports -------
    try {
      if (service) {
        const pid = service.getState().frpc.pid;
        service.dispose();
        if (pid) killTree(pid);
      }
    } catch (_) { /* ignore */ }
    if (frpsProcess) {
      try { frpsProcess.kill(); } catch (_) { /* ignore */ }
      killTree(frpsProcess.pid);
    }
    if (frpsLogFd !== null) {
      try { fs.closeSync(frpsLogFd); } catch (_) { /* ignore */ }
    }
    for (const closeable of [echo1, echo2]) {
      if (closeable) await new Promise((resolve) => closeable.server.close(resolve));
    }
    if (frpsProcess) {
      try { await waitPortClosed(FRPS_PORT, 10000); } catch (_) { /* force kill below */ }
    }
    cleanupStaleFrpListeners(FRPS_PORT);
    for (const port of [FRPS_PORT]) {
      const remaining = listeningPids(port);
      assert.deepEqual(remaining, [], `清理后端口 ${port} 不应仍有监听进程`);
    }
    try { fs.rmSync(e2eDir, { recursive: true, force: true }); } catch (_) { /* Windows may briefly lock files */ }
  }
});
