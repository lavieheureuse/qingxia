'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const zip = require('../core/zip.cjs');

const REAL_ZIP = path.join(__dirname, '..', '..', '.work', 'bin', 'frp_0.71.1_windows_amd64.zip');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frpc-zip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Build an in-memory ZIP (stored/deflate) so tests never need network access. */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data === undefined ? '' : entry.data);
    const method = entry.method === undefined ? 8 : entry.method;
    const methodCode = method === 'deflate' ? 8 : (method === 'stored' ? 0 : method);
    const compressed = methodCode === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = zip.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(methodCode, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(methodCode, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);

    offset += local.length + nameBuffer.length + compressed.length;
  }
  const centralStart = offset;
  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

test('synthetic zip: lists and extracts stored + deflated entries', (t) => {
  const text = 'hello frpc zip\n第二行';
  const buffer = buildZip([
    { name: 'dir/', data: '', method: 'stored' },
    { name: 'dir/a.txt', data: text, method: 'stored' },
    { name: 'b.bin', data: Buffer.from([0, 1, 2, 255]), method: 'deflate' },
  ]);
  const archive = zip.readBuffer(buffer);
  const entries = zip.listEntries(archive);
  assert.deepEqual(entries.map((entry) => entry.name), ['dir/', 'dir/a.txt', 'b.bin']);
  assert.equal(entries[0].isDirectory, true);
  assert.equal(entries[2].method, 8);
  assert.equal(zip.extractEntry(archive, 'dir/a.txt').toString('utf8'), text);
  assert.deepEqual([...zip.extractEntry(archive, 'b.bin')], [0, 1, 2, 255]);
  assert.equal(zip.findEntry(archive, 'a.txt').name, 'dir/a.txt', '可按 basename 查找');
  assert.equal(zip.findEntry(archive, /\.bin$/).name, 'b.bin');
  assert.equal(zip.findEntry(archive, 'missing.txt'), null);

  const target = tempDir(t);
  const written = zip.extractToDirectory(archive, path.join(target, 'out'));
  assert.equal(written.length, 2);
  assert.equal(fs.readFileSync(path.join(target, 'out', 'dir', 'a.txt'), 'utf8'), text);
});

test('zip reader rejects path traversal, unsupported methods and corrupt data', () => {
  const traversal = zip.readBuffer(buildZip([{ name: '../evil.txt', data: 'x' }]));
  assert.throws(() => zip.extractToDirectory(traversal, os.tmpdir()), /路径非法/);

  const absolute = zip.readBuffer(buildZip([{ name: '/abs/evil.txt', data: 'x' }]));
  assert.throws(() => zip.extractToDirectory(absolute, os.tmpdir()), /路径非法/);

  const unsupported = buildZip([{ name: 'weird.bin', data: 'x', method: 12 }]);
  assert.throws(() => zip.readBuffer(unsupported), /不支持的压缩方法/);

  assert.throws(() => zip.readBuffer(Buffer.from('definitely not a zip')), /不是有效的 ZIP/);
  assert.throws(() => zip.readZipFile(path.join(os.tmpdir(), 'nope-does-not-exist.zip')), /无法读取 ZIP/);
});

test('zip reader verifies CRC-32', () => {
  const buffer = buildZip([{ name: 'a.txt', data: 'payload', method: 'stored' }]);
  const nameLength = Buffer.byteLength('a.txt', 'utf8');
  const dataOffset = 30 + nameLength;
  const corrupted = Buffer.from(buffer);
  corrupted[dataOffset] ^= 0xff;
  const archive = zip.readBuffer(corrupted);
  assert.throws(() => zip.extractEntry(archive, 'a.txt'), /CRC 校验失败/);
});

test('real GitHub release zip contains a working frpc.exe', (t) => {
  if (!fs.existsSync(REAL_ZIP)) {
    t.skip('本机没有 frp_0.71.1_windows_amd64.zip，跳过真实 zip 测试');
    return;
  }
  const archive = zip.readZipFile(REAL_ZIP);
  const names = zip.listEntries(archive).map((entry) => entry.name);
  assert.ok(names.some((name) => path.posix.basename(name) === 'frpc.exe'), '真实 zip 应包含 frpc.exe');

  const entry = zip.findEntry(archive, 'frpc.exe');
  const data = zip.extractEntry(archive, entry);
  assert.ok(data.length > 10 * 1024 * 1024, 'frpc.exe 应大于 10MB');
  assert.equal(data.subarray(0, 2).toString('ascii'), 'MZ', 'Windows 可执行文件应以 MZ 开头');

  const target = tempDir(t);
  const written = zip.extractToDirectory(archive, target, {
    filter: (item) => path.posix.basename(item.name) === 'frpc.exe',
  });
  assert.equal(written.length, 1);
  const result = spawnSync(written[0].path, ['-v'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /0\.71\.1/);
});
