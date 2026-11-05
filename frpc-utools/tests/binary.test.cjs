'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const binary = require('../core/binary.cjs');
const zip = require('../core/zip.cjs');

const BIN_DIR = process.env.FRPC_E2E_BIN_DIR
  || path.join(__dirname, '..', '..', '.work', 'bin', 'frp_0.71.1_windows_amd64');
const FRPC = path.join(BIN_DIR, 'frpc.exe');
const REAL_ZIP = path.join(__dirname, '..', '..', '.work', 'bin', 'frp_0.71.1_windows_amd64.zip');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-binary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const compressed = zlib.deflateRawSync(raw);
    const crc = zip.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const centralStart = offset;
  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

function fakeResponse(bytes, options) {
  const opts = options || {};
  const total = opts.withLength === false ? null : bytes.length;
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'content-length') return total === null ? null : String(total);
        return null;
      },
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }),
  };
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => payload,
    body: new ReadableStream({ start(controller) { controller.close(); } }),
  };
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('resolveArch() maps Node archs to frp release archs', () => {
  assert.equal(binary.resolveArch('x64'), 'amd64');
  assert.equal(binary.resolveArch('ia32'), '386');
  assert.equal(binary.resolveArch('arm64'), 'arm64');
  assert.equal(binary.resolveArch('mips'), null);
  assert.equal(binary.resolveArch(undefined), null);
});

test('buildDownloadUrl()/buildDownloadUrls() build the GitHub URL and mirror fallbacks', () => {
  const url = binary.buildDownloadUrl('0.71.1', 'amd64');
  assert.equal(url, 'https://github.com/fatedier/frp/releases/download/v0.71.1/frp_0.71.1_windows_amd64.zip');
  assert.equal(binary.buildDownloadUrl('v0.71.1', 'amd64'), url, '版本号允许带 v 前缀');
  const urls = binary.buildDownloadUrls('0.71.1', 'amd64');
  assert.equal(urls.length, 3);
  assert.equal(urls[0], url);
  assert.equal(urls[1], 'https://ghproxy.net/' + url);
  assert.equal(urls[2], 'https://gh-proxy.com/' + url);
});

test('parseVersionOutput() handles frpc -v output variants', () => {
  assert.equal(binary.parseVersionOutput('0.71.1\n'), '0.71.1');
  assert.equal(binary.parseVersionOutput('v0.72.0'), '0.72.0');
  assert.equal(binary.parseVersionOutput('frpc version 0.71.1'), '0.71.1');
  assert.equal(binary.parseVersionOutput('garbage'), null);
  assert.equal(binary.parseVersionOutput(''), null);
});

test('compareVersions()/pickRecommended() prefer the 0.71.x line', () => {
  assert.ok(binary.compareVersions('0.72.0', '0.71.1') > 0);
  assert.ok(binary.compareVersions('0.9.9', '0.71.0') < 0);
  assert.equal(binary.compareVersions('v0.71.1', '0.71.1'), 0);
  assert.equal(binary.pickRecommended(['0.72.0', '0.71.1', '0.71.0']), '0.71.1');
  assert.equal(binary.pickRecommended(['0.72.0', '0.70.0']), '0.72.0');
  assert.equal(binary.pickRecommended([]), null);
});

// ---------------------------------------------------------------------------
// listVersions
// ---------------------------------------------------------------------------

test('listVersions() parses GitHub releases, sorts descending and recommends 0.71.x', async () => {
  const requested = [];
  const result = await binary.listVersions({
    fetchImpl: async (url) => {
      requested.push(url);
      return jsonResponse([
        { tag_name: 'v0.72.0' },
        { tag_name: 'v0.71.1' },
        { tag_name: 'v0.71.0' },
        { tag_name: 'v0.70.0', draft: true },
        { tag_name: 'v0.69.0', prerelease: true },
        { tag_name: 'not-a-version' },
      ]);
    },
  });
  assert.equal(requested[0], binary.RELEASES_API);
  assert.deepEqual(result.versions, ['0.72.0', '0.71.1', '0.71.0']);
  assert.equal(result.latest, '0.72.0');
  assert.equal(result.recommended, '0.71.1');
  assert.equal(result.source, 'github');
});

test('listVersions() falls back to the built-in list when the network fails', async () => {
  const result = await binary.listVersions({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(result.source, 'fallback');
  assert.ok(result.versions.includes('0.72.0'));
  assert.ok(result.versions.includes('0.71.1'));
  assert.equal(result.recommended, '0.71.1');
  assert.equal(result.latest, result.versions[0]);
});

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

test('download() streams a zip, extracts frpc.exe and installs it atomically', async (t) => {
  if (!fs.existsSync(REAL_ZIP)) {
    t.skip('本机没有真实 frp zip，跳过真实下载安装测试');
    return;
  }
  const dir = tempDir(t);
  const binDir = path.join(dir, 'bin');
  const zipBytes = fs.readFileSync(REAL_ZIP);
  const progress = [];
  let requestedUrl = null;
  const result = await binary.download({
    version: '0.71.1',
    arch: 'x64',
    binDir,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return fakeResponse(zipBytes);
    },
    onProgress: (item) => progress.push(item),
  });
  assert.equal(requestedUrl, 'https://github.com/fatedier/frp/releases/download/v0.71.1/frp_0.71.1_windows_amd64.zip');
  assert.equal(result.path, path.join(binDir, 'frpc.exe'));
  assert.equal(result.source, 'downloaded');
  assert.equal(result.version, '0.71.1', '安装后应能通过 -v 读到真实版本');
  assert.ok(fs.statSync(result.path).size > 10 * 1024 * 1024);
  assert.ok(progress.some((item) => item.phase === 'download' && item.percent >= 0), '应报告下载进度');
  assert.ok(progress.some((item) => item.phase === 'done' && item.percent === 100));
  const leftovers = fs.readdirSync(binDir).filter((name) => name.startsWith('.download-'));
  assert.deepEqual(leftovers, [], '下载临时目录必须清理');
});

test('download() reports percent=-1 when content-length is absent and tries mirrors in order', async (t) => {
  const dir = tempDir(t);
  const binDir = path.join(dir, 'bin');
  const synthetic = buildZip([{ name: 'frpc.exe', data: Buffer.from('MZ-fake-frpc-binary') }]);
  const calls = [];
  const progress = [];
  let attempt = 0;
  const result = await binary.download({
    version: '0.71.1',
    arch: 'x64',
    binDir,
    fetchImpl: async (url) => {
      calls.push(url);
      attempt += 1;
      if (attempt <= 2) throw new Error('mirror down');
      return fakeResponse(synthetic, { withLength: false });
    },
    detectVersion: async () => '0.71.1',
    onProgress: (item) => progress.push(item),
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0], binary.buildDownloadUrl('0.71.1', 'amd64'));
  assert.equal(calls[1], 'https://ghproxy.net/' + binary.buildDownloadUrl('0.71.1', 'amd64'));
  assert.equal(calls[2], 'https://gh-proxy.com/' + binary.buildDownloadUrl('0.71.1', 'amd64'));
  assert.ok(progress.some((item) => item.phase === 'download' && item.percent === -1), '无 content-length 时 percent 应为 -1');
  assert.equal(fs.readFileSync(result.path).toString('utf8'), 'MZ-fake-frpc-binary');
});

test('download() replaces an existing frpc.exe and rejects a zip without frpc.exe', async (t) => {
  const dir = tempDir(t);
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'frpc.exe'), 'old-broken-binary');

  const synthetic = buildZip([{ name: 'frps.exe', data: Buffer.from('MZ-frps') }]);
  await assert.rejects(
    binary.download({
      version: '0.71.1', arch: 'x64', binDir,
      fetchImpl: async () => fakeResponse(synthetic),
      detectVersion: async () => '0.71.1',
    }),
    (error) => {
      assert.equal(error.code, 'DOWNLOAD_FAILED');
      assert.match(error.message, /未找到 frpc\.exe/);
      return true;
    },
  );

  const withFrpc = buildZip([{ name: 'frpc.exe', data: Buffer.from('MZ-new-frpc') }]);
  const result = await binary.download({
    version: '0.71.1', arch: 'x64', binDir,
    fetchImpl: async () => fakeResponse(withFrpc),
    detectVersion: async () => '0.71.1',
  });
  assert.equal(fs.readFileSync(result.path).toString('utf8'), 'MZ-new-frpc');
});

test('download() fails with an actionable message when every mirror fails', async (t) => {
  const dir = tempDir(t);
  await assert.rejects(
    binary.download({
      version: '0.71.1', arch: 'x64', binDir: path.join(dir, 'bin'),
      fetchImpl: async () => { throw new Error('network unreachable'); },
    }),
    (error) => {
      assert.equal(error.code, 'DOWNLOAD_FAILED');
      assert.match(error.message, /手动指定/);
      assert.match(error.message, /network unreachable/);
      return true;
    },
  );
  assert.deepEqual(fs.readdirSync(path.join(dir, 'bin')), []);
});

test('download() validates version and architecture', async (t) => {
  const dir = tempDir(t);
  await assert.rejects(
    binary.download({ version: 'latest', arch: 'x64', binDir: path.join(dir, 'bin'), fetchImpl: async () => fakeResponse(Buffer.from('x')) }),
    (error) => {
      assert.equal(error.code, 'DOWNLOAD_FAILED');
      assert.match(error.message, /版本号无效/);
      return true;
    },
  );
  await assert.rejects(
    binary.download({ version: '0.71.1', arch: 'mips', binDir: path.join(dir, 'bin'), fetchImpl: async () => fakeResponse(Buffer.from('x')) }),
    (error) => {
      assert.equal(error.code, 'DOWNLOAD_FAILED');
      assert.match(error.message, /架构不受支持/);
      return true;
    },
  );
});

test('download() verifies the extracted binary actually runs', async (t) => {
  const dir = tempDir(t);
  const binDir = path.join(dir, 'bin');
  const synthetic = buildZip([{ name: 'frpc.exe', data: Buffer.from('MZ-corrupt') }]);
  await assert.rejects(
    binary.download({
      version: '0.71.1', arch: 'x64', binDir,
      fetchImpl: async () => fakeResponse(synthetic),
      detectVersion: async () => null,
    }),
    /无法运行/,
  );
});

// ---------------------------------------------------------------------------
// detectVersion
// ---------------------------------------------------------------------------

test('detectVersion() reads the version from a real frpc binary', async (t) => {
  if (!fs.existsSync(FRPC)) {
    t.skip('本机没有 frpc 测试二进制，跳过 detectVersion 真实测试');
    return;
  }
  assert.equal(await binary.detectVersion(FRPC), '0.71.1');
  assert.equal(await binary.detectVersion(path.join(os.tmpdir(), 'no-such-frpc.exe')), null);
});
