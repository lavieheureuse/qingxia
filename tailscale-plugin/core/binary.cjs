'use strict';

// Tailscale Windows 官方内核管理：查询最新版本、下载 MSI、SHA-256 校验、msiexec /a 无服务解包、PE/版本校验与本地目录检测。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { finished } = require('node:stream/promises');
const { writeJsonAtomicSync, readJsonSafe } = require('./config.cjs');

const STABLE_MANIFEST_URL = 'https://pkgs.tailscale.com/stable/?mode=json';
const STABLE_BASE_URL = 'https://pkgs.tailscale.com/stable/';
const ARCH_MAP = { x64: 'amd64', arm64: 'arm64', ia32: 'x86' };
const PE_MACHINE_MAP = { amd64: 0x8664, arm64: 0xaa64, x86: 0x14c };
const REQUIRED_FILES = ['tailscaled.exe', 'tailscale.exe', 'wintun.dll'];
const USER_AGENT = 'qingxia-tailscale-plugin/1.0.0';

function createBinaryError(code, message, options) {
  const err = new Error(message, options);
  err.code = code;
  return err;
}

function resolveArch(arch) {
  return ARCH_MAP[String(arch || '')] || null;
}

function parseSha256Text(text) {
  const match = /\b([0-9a-fA-F]{64})\b/.exec(String(text || ''));
  return match ? match[1].toLowerCase() : null;
}

function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', reject);
  });
}

async function verifyFileSha256(filePath, expectedHex) {
  const normalized = parseSha256Text(expectedHex);
  if (!normalized) throw createBinaryError('INVALID_SHA256', '官方 SHA-256 校验值格式无效');
  const actual = await computeFileSha256(filePath);
  if (actual !== normalized) {
    throw createBinaryError('SHA256_MISMATCH', `文件 SHA-256 校验失败（期望 ${normalized.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
  }
  return actual;
}

function verifyPeArch(filePath, arch) {
  const expectedMachine = PE_MACHINE_MAP[arch];
  if (!expectedMachine) throw createBinaryError('UNSUPPORTED_ARCH', `不支持的系统架构：${arch}`);
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(64);
    const pe = Buffer.alloc(6);
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length || header.toString('ascii', 0, 2) !== 'MZ') {
      return false;
    }
    const offset = header.readUInt32LE(0x3c);
    if (offset > 1024 * 1024) return false;
    if (fs.readSync(fd, pe, 0, pe.length, offset) !== pe.length) return false;
    return pe.readUInt32LE(0) === 0x00004550 && pe.readUInt16LE(4) === expectedMachine;
  } finally {
    fs.closeSync(fd);
  }
}

function detectBinaryVersion(exePath, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (!exePath || !fs.existsSync(exePath)) return resolve(null);
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    try {
      const child = execFile(exePath, ['--version'], { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error && !stdout && !stderr) return finish(null);
        const output = `${stdout || ''}\n${stderr || ''}`;
        const match = /\b(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)\b/.exec(output);
        finish(match ? match[1] : null);
      });
      if (child && typeof child.on === 'function') {
        child.on('error', () => finish(null));
      }
    } catch (_) {
      finish(null);
    }
  });
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
}

async function inspectBinaryDir(dir) {
  if (!dir) {
    return { ready: false, dir: '', missing: [...REQUIRED_FILES], tailscaledPath: '', tailscalePath: '', wintunPath: '', version: null, manifest: null };
  }
  const resolved = path.resolve(dir);
  const tailscaledPath = path.join(resolved, 'tailscaled.exe');
  const tailscalePath = path.join(resolved, 'tailscale.exe');
  const wintunPath = path.join(resolved, 'wintun.dll');
  const missing = [];
  if (!isFile(tailscaledPath)) missing.push('tailscaled.exe');
  if (!isFile(tailscalePath)) missing.push('tailscale.exe');
  if (!isFile(wintunPath)) missing.push('wintun.dll');
  const ready = missing.length === 0;
  const manifest = readJsonSafe(path.join(resolved, 'manifest.json'), null);
  const version = ready ? (await detectBinaryVersion(tailscalePath)) || (manifest && manifest.version) || null : null;
  return {
    ready,
    dir: resolved,
    missing,
    tailscaledPath: isFile(tailscaledPath) ? tailscaledPath : '',
    tailscalePath: isFile(tailscalePath) ? tailscalePath : '',
    wintunPath: isFile(wintunPath) ? wintunPath : '',
    version,
    manifest,
  };
}

function findFilesRecursive(rootDir, targetNames) {
  const want = new Set(targetNames.map((n) => n.toLowerCase()));
  const found = new Map();
  const stack = [rootDir];
  while (stack.length > 0 && found.size < want.size) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (want.has(lower) && !found.has(lower)) {
          found.set(lower, full);
        }
      }
    }
  }
  return found;
}

async function fetchTextOrJson(url, { fetchImpl, timeoutMs = 15000, json = false }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: json ? 'application/json' : 'text/plain' },
      signal: controller.signal,
    });
    if (!response || response.ok === false || (response.status && response.status >= 400)) {
      throw new Error(`HTTP ${response ? response.status : 'unknown'}`);
    }
    return json ? await response.json() : await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLatestRelease({ arch, fetchImpl, timeoutMs = 15000 }) {
  const resolvedArch = resolveArch(arch);
  if (!resolvedArch) {
    throw createBinaryError('UNSUPPORTED_ARCH', `当前系统架构不受支持：${arch}`);
  }
  const manifest = await fetchTextOrJson(STABLE_MANIFEST_URL, { fetchImpl, timeoutMs, json: true });
  const msiName = manifest && manifest.MSIs && manifest.MSIs[resolvedArch];
  const version = manifest && (manifest.MSIsVersion || manifest.TarballsVersion);
  if (!msiName || !version) {
    throw createBinaryError('MANIFEST_INVALID', '无法从 Tailscale 官方清单读取 Windows MSI 下载地址');
  }
  const msiUrl = new URL(msiName, STABLE_BASE_URL).toString();
  const shaUrl = `${msiUrl}.sha256`;
  const shaText = await fetchTextOrJson(shaUrl, { fetchImpl, timeoutMs, json: false });
  const sha256 = parseSha256Text(shaText);
  if (!sha256) {
    throw createBinaryError('INVALID_SHA256', '无法解析官方 MSI 的 SHA-256 校验值');
  }
  return { version, arch: resolvedArch, msiName, msiUrl, shaUrl, sha256 };
}

async function streamDownload(url, destPath, { fetchImpl, timeoutMs = 180000, onProgress }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!response || response.ok === false || (response.status && response.status >= 400)) {
      throw new Error(`下载失败（HTTP ${response ? response.status : 'unknown'}）`);
    }
    const totalBytes = Number(response.headers.get('content-length')) || 0;
    let receivedBytes = 0;
    const out = fs.createWriteStream(destPath);
    if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of response.body) {
        receivedBytes += chunk.length;
        if (!out.write(chunk)) {
          await new Promise((resolve) => out.once('drain', resolve));
        }
        if (typeof onProgress === 'function') {
          onProgress({
            phase: 'download',
            receivedBytes,
            totalBytes,
            percent: totalBytes > 0 ? Math.min(99, Math.round((receivedBytes / totalBytes) * 100)) : -1,
          });
        }
      }
      out.end();
      await finished(out);
    } else {
      const buf = Buffer.from(await response.text(), 'binary');
      fs.writeFileSync(destPath, buf);
      receivedBytes = buf.length;
    }
    return receivedBytes;
  } finally {
    clearTimeout(timer);
  }
}

function defaultMsiexecRunner(msiPath, extractDir) {
  const msiexec = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'msiexec.exe');
  return new Promise((resolve, reject) => {
    execFile(
      msiexec,
      ['/a', msiPath, '/qn', `TARGETDIR=${extractDir}`],
      { windowsHide: true, timeout: 120000 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(createBinaryError('EXTRACT_FAILED', `MSI 解包失败：${String(stderr || error.message).trim().slice(0, 200)}`));
        } else {
          resolve();
        }
      },
    );
  });
}

function replaceFileSync(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
      return;
    }
    throw error;
  }
}

async function downloadAndInstall(options = {}) {
  const { binDir, arch, fetchImpl, msiexecRunner = defaultMsiexecRunner, detectVersion = detectBinaryVersion, onProgress } = options;
  if (!binDir) throw createBinaryError('INVALID_ARG', '缺少目标安装目录 binDir');
  const resolvedArch = resolveArch(arch);
  if (!resolvedArch) throw createBinaryError('UNSUPPORTED_ARCH', `不支持的系统架构：${arch}`);

  fs.mkdirSync(binDir, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(binDir, '.ts-download-'));
  try {
    if (typeof onProgress === 'function') onProgress({ phase: 'manifest', percent: 0 });
    const release = await fetchLatestRelease({ arch, fetchImpl });

    const msiPath = path.join(workDir, release.msiName);
    await streamDownload(release.msiUrl, msiPath, { fetchImpl, onProgress });

    if (typeof onProgress === 'function') onProgress({ phase: 'verify', percent: 100 });
    await verifyFileSha256(msiPath, release.sha256);

    if (typeof onProgress === 'function') onProgress({ phase: 'extract', percent: 100 });
    const extractDir = path.join(workDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    await msiexecRunner(msiPath, extractDir);

    const located = findFilesRecursive(extractDir, REQUIRED_FILES);
    for (const fileName of REQUIRED_FILES) {
      if (!located.has(fileName.toLowerCase())) {
        throw createBinaryError('EXTRACT_MISSING', `官方安装包中未找到必需文件：${fileName}`);
      }
    }

    const staged = {};
    const fileHashes = {};
    for (const fileName of REQUIRED_FILES) {
      const src = located.get(fileName.toLowerCase());
      if (!verifyPeArch(src, resolvedArch)) {
        throw createBinaryError('PE_ARCH_MISMATCH', `${fileName} 不是有效的 ${resolvedArch} Windows 二进制文件`);
      }
      staged[fileName] = src;
      fileHashes[fileName] = await computeFileSha256(src);
    }

    const detected = (await detectVersion(staged['tailscale.exe'])) || release.version;

    try {
      for (const fileName of REQUIRED_FILES) {
        replaceFileSync(staged[fileName], path.join(binDir, fileName));
      }
    } catch (error) {
      if (error && (error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EACCES')) {
        throw createBinaryError('BINARY_IN_USE', '内核文件正在被占用，请先停止 Tailscale 隧道后再更新');
      }
      throw error;
    }

    const manifest = {
      version: detected,
      officialVersion: release.version,
      arch: resolvedArch,
      msiName: release.msiName,
      msiSha256: release.sha256,
      files: fileHashes,
      installedAt: new Date().toISOString(),
    };
    writeJsonAtomicSync(path.join(binDir, 'manifest.json'), manifest);
    if (typeof onProgress === 'function') onProgress({ phase: 'done', percent: 100 });
    return {
      binDir,
      version: detected,
      manifest,
    };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = {
  STABLE_MANIFEST_URL,
  STABLE_BASE_URL,
  REQUIRED_FILES,
  resolveArch,
  parseSha256Text,
  computeFileSha256,
  verifyFileSha256,
  verifyPeArch,
  detectBinaryVersion,
  inspectBinaryDir,
  findFilesRecursive,
  fetchLatestRelease,
  downloadAndInstall,
};
