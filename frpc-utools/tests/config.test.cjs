'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../core/config.cjs');

const BIN_DIR = process.env.FRPC_E2E_BIN_DIR
  || path.join(__dirname, '..', '..', '.work', 'bin', 'frp_0.71.1_windows_amd64');
const FRPC = path.join(BIN_DIR, 'frpc.exe');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Exactly what the iostool server sends: INI text, no trailing newline, no webServer. */
function serverIni(overrides) {
  const opts = overrides || {};
  const lines = [
    '[common]',
    `server_addr = ${opts.serverAddr || '127.0.0.1'}`,
    `server_port = ${opts.serverPort === undefined ? 7200 : opts.serverPort}`,
  ];
  if (opts.token !== null) lines.push(`token = ${opts.token || 'frps-test-token'}`);
  lines.push('');
  const proxies = opts.proxies || [
    { name: 'echo', localPort: 18080, remotePort: 20022 },
    { name: 'web', localPort: 18081, remotePort: 20023 },
  ];
  for (const proxy of proxies) {
    lines.push(`[${proxy.name}]`);
    lines.push('type = tcp');
    lines.push(`local_ip = ${proxy.localIp || '127.0.0.1'}`);
    lines.push(`local_port = ${proxy.localPort}`);
    lines.push(`remote_port = ${proxy.remotePort}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// parseIni
// ---------------------------------------------------------------------------

test('parseIni() parses the server-delivered INI into common + proxies', () => {
  const parsed = config.parseIni(serverIni());
  assert.equal(parsed.common.serverAddr, '127.0.0.1');
  assert.equal(parsed.common.serverPort, 7200);
  assert.equal(parsed.common.token, 'frps-test-token');
  assert.equal(parsed.proxies.length, 2);
  assert.deepEqual(parsed.proxies[0], {
    name: 'echo', type: 'tcp', localIp: '127.0.0.1', localPort: 18080, remotePort: 20022, enabled: true,
  });
  assert.equal(parsed.proxies[1].name, 'web');
  assert.equal(parsed.proxies[1].remotePort, 20023);
});

test('parseIni() tolerates BOM, CRLF, comments, blank lines and missing token', () => {
  const text = '\uFEFF# comment\r\n[common]\r\nserver_addr = 10.0.0.1\r\n'
    + 'server_port = 7000\r\n\r\n; another\r\n[only]\r\ntype = tcp\r\nlocal_ip = 127.0.0.1\r\nlocal_port = 22\r\nremote_port = 6000\r\n';
  const parsed = config.parseIni(text);
  assert.equal(parsed.common.serverAddr, '10.0.0.1');
  assert.equal(parsed.common.token, '');
  assert.equal(parsed.proxies.length, 1);
  assert.equal(parsed.proxies[0].name, 'only');
});

test('parseIni() returns empty results for empty/garbage input', () => {
  assert.deepEqual(config.parseIni(''), { common: { serverAddr: '', serverPort: 0, token: '' }, proxies: [] });
  assert.deepEqual(config.parseIni('just some text\nnot ini'), { common: { serverAddr: '', serverPort: 0, token: '' }, proxies: [] });
  assert.deepEqual(config.parseIni(undefined), { common: { serverAddr: '', serverPort: 0, token: '' }, proxies: [] });
});

test('friendlyVerifyMessage() maps frpc output to Chinese messages', () => {
  assert.equal(config.friendlyVerifyMessage('json: unknown field "nope"'), '配置项未知：nope');
  assert.match(config.friendlyVerifyMessage('toml: line 3: expected value'), /^配置格式错误：/);
  assert.match(config.friendlyVerifyMessage('open C:\\x\\y.toml: The system cannot find the file specified.'), /^无法读取配置文件：/);
  assert.equal(config.friendlyVerifyMessage('\x1b[31mfrpc: boom\x1b[0m'), 'boom');
  assert.equal(config.friendlyVerifyMessage(''), '');
});

// ---------------------------------------------------------------------------
// config file operations
// ---------------------------------------------------------------------------

test('installConfig() backs up the old config and replaces atomically (no BOM)', (t) => {
  const dir = tempDir(t);
  const runDir = path.join(dir, 'run');
  const first = config.installConfig(runDir, serverIni());
  assert.equal(first.configPath, path.join(runDir, 'frpc.toml'));
  assert.equal(first.backupPath, null, '首次安装没有旧配置可备份');
  assert.ok(!fs.readFileSync(first.configPath).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));

  const second = config.installConfig(runDir, serverIni({ serverPort: 7201 }));
  assert.equal(second.backupPath, path.join(runDir, 'frpc.toml.bak'));
  assert.ok(fs.readFileSync(second.backupPath, 'utf8').includes('server_port = 7200'));
  assert.ok(fs.readFileSync(second.configPath, 'utf8').includes('server_port = 7201'));

  // installed config keeps the server text verbatim (no trailing newline added)
  assert.equal(fs.readFileSync(second.configPath, 'utf8'), serverIni({ serverPort: 7201 }));
});

test('staging file + applied version marker helpers', (t) => {
  const dir = tempDir(t);
  const runDir = path.join(dir, 'run');
  const staging = config.writeTempConfig(runDir, serverIni());
  assert.equal(staging, path.join(runDir, 'frpc.toml.new'));
  assert.ok(fs.existsSync(staging));
  assert.equal(config.readConfigFile(runDir), null);
  config.removeTempConfig(runDir);
  assert.equal(fs.existsSync(staging), false);

  assert.equal(config.readAppliedVersion(runDir), null);
  config.writeAppliedVersion(runDir, 3);
  assert.equal(config.readAppliedVersion(runDir), 3);
  assert.equal(fs.readFileSync(config.versionPathFor(runDir), 'utf8'), '3');
  config.clearAppliedVersion(runDir);
  assert.equal(config.readAppliedVersion(runDir), null);

  fs.writeFileSync(config.versionPathFor(runDir), 'not-a-number', 'utf8');
  assert.equal(config.readAppliedVersion(runDir), null);
});

// ---------------------------------------------------------------------------
// real frpc verify (skip when the test binary is absent)
// ---------------------------------------------------------------------------

test('real frpc verify accepts server-style INI in frpc.toml and frpc.toml.new', async (t) => {
  if (!fs.existsSync(FRPC)) {
    t.skip('本机没有 frpc 0.71.1 测试二进制，跳过真实 verify');
    return;
  }
  const dir = tempDir(t);
  const runDir = path.join(dir, 'run');
  fs.mkdirSync(runDir, { recursive: true });

  const configPath = config.configPathFor(runDir);
  fs.writeFileSync(configPath, serverIni(), 'utf8');
  const applied = await config.verifyConfig(configPath, FRPC);
  assert.equal(applied.ok, true, `真实配置 verify 失败：${applied.message}`);

  // The staging filename `frpc.toml.new` is unknown to frpc; format is detected by content.
  const stagingPath = config.writeTempConfig(runDir, serverIni());
  const staging = await config.verifyConfig(stagingPath, FRPC);
  assert.equal(staging.ok, true, `暂存文件 verify 失败：${staging.message}`);

  const noProxyPath = path.join(runDir, 'no-proxy.toml');
  fs.writeFileSync(noProxyPath, serverIni({ proxies: [] }), 'utf8');
  const noProxy = await config.verifyConfig(noProxyPath, FRPC);
  assert.equal(noProxy.ok, true, `无代理配置 verify 失败：${noProxy.message}`);
});

test('real frpc verify reports friendly errors for invalid content', async (t) => {
  if (!fs.existsSync(FRPC)) {
    t.skip('本机没有 frpc 测试二进制，跳过真实 verify');
    return;
  }
  const dir = tempDir(t);
  const bad = path.join(dir, 'frpc.toml');
  fs.writeFileSync(bad, '[common]\nserver_addr = 127.0.0.1\nserver_port = 7000\n[broken\n', 'utf8');
  const result = await config.verifyConfig(bad, FRPC);
  assert.equal(result.ok, false);
  assert.ok(result.message.length > 0);
  assert.match(result.message, /配置格式错误|配置校验失败/);

  const missing = await config.verifyConfig(path.join(dir, 'nope.toml'), FRPC);
  assert.equal(missing.ok, false);

  const bogusExe = await config.verifyConfig(bad, path.join(dir, 'no-such-frpc.exe'));
  assert.equal(bogusExe.ok, false);
  assert.match(bogusExe.message, /找不到 frpc 可执行文件/);

  const noExe = await config.verifyConfig(bad, '');
  assert.equal(noExe.ok, false);
  assert.match(noExe.message, /尚未安装 frpc/);
});
