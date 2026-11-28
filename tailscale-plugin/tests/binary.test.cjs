'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolveArch,
  verifyFileSha256,
  verifyPeArch,
  inspectBinaryDir,
  downloadAndInstall,
} = require('../core/binary.cjs');

function makeFakePeBuffer(machine) {
  const buf = Buffer.alloc(128, 0);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(64, 0x3c);
  buf.writeUInt32LE(0x00004550, 64); // PE\0\0
  buf.writeUInt16LE(machine, 68);
  return buf;
}

test('resolveArch maps Node architectures to Tailscale Windows MSI arches', () => {
  assert.equal(resolveArch('x64'), 'amd64');
  assert.equal(resolveArch('arm64'), 'arm64');
  assert.equal(resolveArch('ia32'), 'x86');
  assert.equal(resolveArch('mips'), null);
});

test('verifyFileSha256 validates matching and rejects mismatched hashes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-sha-'));
  try {
    const file = path.join(tmpDir, 'payload.bin');
    const content = Buffer.from('tailscale-msi-test-content');
    fs.writeFileSync(file, content);
    const expected = crypto.createHash('sha256').update(content).digest('hex');

    assert.equal(await verifyFileSha256(file, `${expected}  tailscale.msi\n`), expected);
    await assert.rejects(
      () => verifyFileSha256(file, '0'.repeat(64)),
      /SHA-256 校验失败/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('inspectBinaryDir detects missing wintun.dll and reports ready when all 3 files exist', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-dir-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'tailscaled.exe'), makeFakePeBuffer(0x8664));
    fs.writeFileSync(path.join(tmpDir, 'tailscale.exe'), makeFakePeBuffer(0x8664));

    const incomplete = await inspectBinaryDir(tmpDir);
    assert.equal(incomplete.ready, false);
    assert.deepEqual(incomplete.missing, ['wintun.dll']);

    fs.writeFileSync(path.join(tmpDir, 'wintun.dll'), makeFakePeBuffer(0x8664));
    const complete = await inspectBinaryDir(tmpDir);
    assert.equal(complete.ready, true);
    assert.deepEqual(complete.missing, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('downloadAndInstall fetches manifest, verifies MSI SHA-256, extracts PE files, and writes manifest.json', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-dl-'));
  try {
    const binDir = path.join(tmpDir, 'bin');
    const msiPayload = Buffer.from('FAKE_MSI_STREAM_CONTENT');
    const msiSha = crypto.createHash('sha256').update(msiPayload).digest('hex');

    const mockFetch = async (url) => {
      if (url.includes('?mode=json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            MSIsVersion: '1.104.7',
            MSIs: { amd64: 'tailscale-setup-1.104.7-amd64.msi' },
          }),
        };
      }
      if (url.endsWith('.sha256')) {
        return { ok: true, status: 200, text: async () => `${msiSha}\n` };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(msiPayload.length) },
        body: (async function* () {
          yield msiPayload;
        })(),
      };
    };

    const msiexecRunner = async (_msiPath, extractDir) => {
      const sub = path.join(extractDir, 'PFiles64', 'Tailscale');
      fs.mkdirSync(sub, { recursive: true });
      const pe = makeFakePeBuffer(0x8664);
      fs.writeFileSync(path.join(sub, 'tailscaled.exe'), pe);
      fs.writeFileSync(path.join(sub, 'tailscale.exe'), pe);
      fs.writeFileSync(path.join(sub, 'wintun.dll'), pe);
    };

    const result = await downloadAndInstall({
      binDir,
      arch: 'x64',
      fetchImpl: mockFetch,
      msiexecRunner,
      detectVersion: async () => '1.104.7',
    });

    assert.equal(result.version, '1.104.7');
    assert.equal(verifyPeArch(path.join(binDir, 'tailscaled.exe'), 'amd64'), true);
    assert.equal(fs.existsSync(path.join(binDir, 'wintun.dll')), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(binDir, 'manifest.json'), 'utf8')).msiSha256, msiSha);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
