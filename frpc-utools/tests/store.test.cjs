'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createStore,
  defaultSettings,
  normalizeSettings,
  encodeSecret,
  decodeSecret,
  writeFileAtomicSync,
  createError,
  DEFAULT_API_BASE,
  DEFAULT_INTERVAL_SEC,
} = require('../core/store.cjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('first read persists v2 defaults (connection / autoSync)', (t) => {
  const dir = tempDir(t);
  const store = createStore(dir);
  const first = store.read();
  assert.equal(first.version, 2);
  assert.equal(first.connection.apiBase, DEFAULT_API_BASE);
  assert.equal(first.connection.pcId, 'pc-home');
  assert.equal(first.connection.pcToken, '');
  assert.equal(first.frpc.path, '');
  assert.equal(first.frpc.source, 'downloaded');
  assert.deepEqual(first.autoSync, { enabled: false, intervalSec: DEFAULT_INTERVAL_SEC });
  assert.equal(first.ui.autoScroll, true);
  assert.ok(fs.existsSync(store.settingsPath));

  const raw = JSON.parse(fs.readFileSync(store.settingsPath, 'utf8'));
  assert.equal(raw.version, 2);
  assert.ok('pcTokenEnc' in raw.connection, '磁盘字段名必须是 pcTokenEnc');
  assert.ok(!('pcToken' in raw.connection), '桌面设置不能明文写 pcToken');
});

test('write/read roundtrip obfuscates pcToken, no BOM, atomic', (t) => {
  const dir = tempDir(t);
  const store = createStore(dir);
  const settings = defaultSettings();
  settings.connection = { apiBase: 'http://127.0.0.1:18081/', pcId: 'pc-lab', pcToken: 'secret-token-abcd' };
  settings.frpc = { path: 'C:\\tools\\frpc.exe', version: '0.71.1', source: 'custom' };
  settings.autoSync = { enabled: true, intervalSec: 60 };
  settings.ui.autoScroll = false;
  store.write(settings);

  const rawBytes = fs.readFileSync(store.settingsPath);
  assert.notEqual(rawBytes[0], 0xef, '文件不能带 UTF-8 BOM');
  const raw = rawBytes.toString('utf8');
  assert.ok(!raw.includes('secret-token-abcd'), '磁盘上不能出现明文 pcToken');
  assert.ok(raw.includes('utf8:'), 'pcToken 应有 utf8: base64 混淆前缀');

  const loaded = store.read();
  assert.equal(loaded.connection.apiBase, 'http://127.0.0.1:18081', '写入时应去掉末尾斜杠');
  assert.equal(loaded.connection.pcId, 'pc-lab');
  assert.equal(loaded.connection.pcToken, 'secret-token-abcd');
  assert.equal(loaded.frpc.path, 'C:\\tools\\frpc.exe');
  assert.equal(loaded.frpc.source, 'custom');
  assert.deepEqual(loaded.autoSync, { enabled: true, intervalSec: 60 });
  assert.equal(loaded.ui.autoScroll, false);

  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '原子写不应留下临时文件');
});

test('corrupt settings are backed up and replaced by defaults', (t) => {
  const dir = tempDir(t);
  const store = createStore(dir);
  fs.writeFileSync(store.settingsPath, '{ not json ', 'utf8');
  const recovered = store.read();
  assert.equal(recovered.connection.pcId, 'pc-home');
  const backups = fs.readdirSync(dir).filter((name) => name.startsWith('settings.json.broken-'));
  assert.equal(backups.length, 1);
  assert.ok(fs.readFileSync(path.join(dir, backups[0]), 'utf8').includes('not json'));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(store.settingsPath, 'utf8')));
});

test('normalizeSettings repairs invalid values and decodes legacy plaintext token', () => {
  const normalized = normalizeSettings({
    version: 1,
    connection: { apiBase: 42, pcId: '', pcToken: 'legacy-plain-token' },
    frpc: { path: '', version: [], source: 'weird' },
    autoSync: { enabled: 'yes', intervalSec: 'nope' },
    ui: { autoScroll: 'no' },
  });
  assert.equal(normalized.version, 2);
  assert.equal(normalized.connection.apiBase, DEFAULT_API_BASE);
  assert.equal(normalized.connection.pcId, 'pc-home');
  assert.equal(normalized.connection.pcToken, 'legacy-plain-token');
  assert.equal(normalized.frpc.source, 'downloaded');
  assert.deepEqual(normalized.autoSync, { enabled: false, intervalSec: DEFAULT_INTERVAL_SEC });
  assert.equal(normalized.ui.autoScroll, true);

  const badInterval = normalizeSettings({ autoSync: { enabled: true, intervalSec: 0 } });
  assert.equal(badInterval.autoSync.intervalSec, DEFAULT_INTERVAL_SEC);
});

test('secret helpers roundtrip unicode', () => {
  const encoded = encodeSecret('凭证-你好');
  assert.ok(encoded.startsWith('utf8:'));
  assert.equal(decodeSecret(encoded), '凭证-你好');
  assert.equal(decodeSecret('plain'), 'plain');
  assert.equal(decodeSecret(''), '');
  assert.equal(encodeSecret(''), '');
});

test('writeFileAtomicSync replaces content and cleans temp files', (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'nested', 'file.txt');
  writeFileAtomicSync(target, 'first');
  writeFileAtomicSync(target, 'second');
  assert.equal(fs.readFileSync(target, 'utf8'), 'second');
  assert.deepEqual(fs.readdirSync(path.dirname(target)).filter((name) => name.endsWith('.tmp')), []);
});

test('createError carries code and extra fields', () => {
  const error = createError('UNAUTHORIZED', '未授权', { status: 401 });
  assert.equal(error.code, 'UNAUTHORIZED');
  assert.equal(error.message, '未授权');
  assert.equal(error.status, 401);
});
