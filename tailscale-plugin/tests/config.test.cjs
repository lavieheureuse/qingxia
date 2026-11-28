'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_CONFIG,
  validateConfig,
  validateAuthUrl,
  createStore,
} = require('../core/config.cjs');

test('validateConfig accepts valid defaults and custom values', () => {
  const cfg = validateConfig({
    ...DEFAULT_CONFIG,
    hostname: 'home-pc-01',
    udpPort: 41641,
    loginServer: 'https://hs.example.com/',
    autoConnect: true,
  });
  assert.equal(cfg.hostname, 'home-pc-01');
  assert.equal(cfg.udpPort, 41641);
  assert.equal(cfg.loginServer, 'https://hs.example.com');
  assert.equal(cfg.autoConnect, true);
});

test('validateConfig rejects invalid hostname, port, loginServer, and relative path', () => {
  assert.throws(() => validateConfig({ hostname: '-bad-host' }), /主机名/);
  assert.throws(() => validateConfig({ udpPort: 70000 }), /UDP 监听端口/);
  assert.throws(() => validateConfig({ loginServer: 'http://insecure.local' }), /https:\/\//);
  assert.throws(() => validateConfig({ customBinaryDir: 'relative/bin' }), /绝对路径/);
});

test('validateAuthUrl allows tailscale.com and matching custom loginServer, rejects untrusted hosts', () => {
  assert.equal(
    validateAuthUrl('https://login.tailscale.com/a/0123456789abcdef'),
    'https://login.tailscale.com/a/0123456789abcdef',
  );
  assert.equal(
    validateAuthUrl('https://hs.example.com:8443/register/mkey123', 'https://hs.example.com:8443'),
    'https://hs.example.com:8443/register/mkey123',
  );
  assert.throws(() => validateAuthUrl('http://login.tailscale.com/a/123'), /https:\/\//);
  assert.throws(() => validateAuthUrl('https://evil.example.net/phish'), /未受信任的授权域名/);
  assert.throws(() => validateAuthUrl('https://login.tailscale.com/a/123&calc'), /非法字符/);
});

test('createStore persists DPAPI-protected authKey without plaintext on disk', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-cfg-'));
  try {
    const store = createStore({
      dataDir: tmpDir,
      protectSecret: async (plain) => Buffer.from(`ENC:${plain}`, 'utf8').toString('base64'),
      unprotectSecret: async (cipher) => Buffer.from(cipher, 'base64').toString('utf8').replace(/^ENC:/, ''),
    });

    const saved = await store.save({
      saveAuthKey: true,
      authKey: 'tskey-auth-kSecretValue999',
      hostname: 'office-win',
    });
    assert.equal(saved.hasSavedAuthKey, true);

    const diskRaw = fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8');
    assert.equal(diskRaw.includes('tskey-auth-kSecretValue999'), false);
    assert.equal(JSON.parse(diskRaw).authKeyProtected.length > 0, true);

    const loaded = await store.load({ includeSecret: true });
    assert.equal(loaded.authKey, 'tskey-auth-kSecretValue999');
    assert.equal(loaded.config.hostname, 'office-win');

    const cleared = await store.save({ saveAuthKey: false, clearAuthKey: true });
    assert.equal(cleared.hasSavedAuthKey, false);
    const reloaded = await store.load({ includeSecret: true });
    assert.equal(reloaded.authKey, '');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
