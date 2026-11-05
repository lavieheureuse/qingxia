'use strict';

// frpc binary management: version detection, release listing, download + install.
// Zero npm dependencies: https/fetch (injected or global) for network, zlib via zip.cjs.

const { execFile, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { createError } = require('./store.cjs');
const zip = require('./zip.cjs');

const RELEASES_API = 'https://api.github.com/repos/fatedier/frp/releases?per_page=20';
const RELEASE_DOWNLOAD = 'https://github.com/fatedier/frp/releases/download';
const MIRROR_PREFIXES = ['https://ghproxy.net/', 'https://gh-proxy.com/'];
const ARCH_MAP = { x64: 'amd64', ia32: '386', arm64: 'arm64' };
// Fallback list only matters when GitHub is unreachable; keep the recommended
// 0.71.x line and also expose 0.72.0 for users who want it.
const FALLBACK_VERSIONS = ['0.72.0', '0.71.1', '0.71.0', '0.70.0', '0.69.3', '0.68.1'];
const PREFERRED_MINOR = 71;
const USER_AGENT = 'frpc-utools/0.1.0';
const DOWNLOAD_TIMEOUT_MS = 120000;
const MAX_REDIRECTS = 5;

function resolveArch(arch) {
  const value = typeof arch === 'string' ? arch : '';
  return ARCH_MAP[value] || null;
}

function normalizeVersion(version) {
  return String(version === null || version === undefined ? '' : version).trim().replace(/^v/i, '');
}

function parseVersionOutput(text) {
  const match = /v?(\d+\.\d+\.\d+)/.exec(String(text || ''));
  return match ? match[1] : null;
}

function compareVersions(a, b) {
  const pa = normalizeVersion(a).split('.').map(Number);
  const pb = normalizeVersion(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function buildDownloadUrl(version, arch) {
  const v = normalizeVersion(version);
  return `${RELEASE_DOWNLOAD}/v${v}/frp_${v}_windows_${arch}.zip`;
}

/** Primary GitHub URL followed by the configured mirrors (in fallback order). */
function buildDownloadUrls(version, arch) {
  const primary = buildDownloadUrl(version, arch);
  return [primary, ...MIRROR_PREFIXES.map((prefix) => prefix + primary)];
}

function pickRecommended(versions) {
  if (!Array.isArray(versions) || !versions.length) return null;
  const preferred = versions.find((version) => {
    const parts = normalizeVersion(version).split('.').map(Number);
    return parts[0] === 0 && parts[1] === PREFERRED_MINOR;
  });
  return preferred || versions[0];
}

function sortVersionsDesc(versions) {
  return Array.from(new Set(versions)).sort((a, b) => compareVersions(b, a));
}

function getJsonViaHttps(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' }, timeout: timeoutMs }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        getJsonViaHttps(new URL(response.headers.location, url).toString(), timeoutMs).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(new Error('返回内容不是有效 JSON')); }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', reject);
  });
}

async function getJson(url, options) {
  const opts = options || {};
  if (typeof opts.fetchImpl === 'function') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 10000);
    try {
      const response = await opts.fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
        signal: controller.signal,
      });
      if (!response || response.ok === false || (response.status && response.status >= 400)) {
        throw new Error(`HTTP ${response ? response.status : 'unknown'}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
  return getJsonViaHttps(url, opts.timeoutMs || 10000);
}

/**
 * listVersions({fetchImpl, timeoutMs}) -> { versions, latest, recommended, source }
 * Falls back to a built-in list when GitHub is unreachable.
 */
async function listVersions(options) {
  const opts = options || {};
  try {
    const payload = await getJson(RELEASES_API, opts);
    const releases = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.releases) ? payload.releases : []);
    const versions = sortVersionsDesc(releases
      .filter((release) => release && !release.draft && !release.prerelease)
      .map((release) => normalizeVersion(release.tag_name || release.name || ''))
      .filter((version) => /^\d+\.\d+\.\d+$/.test(version)));
    if (!versions.length) throw new Error('没有可用的 release');
    return {
      versions,
      latest: versions[0],
      recommended: pickRecommended(versions),
      source: 'github',
    };
  } catch (_) {
    const versions = sortVersionsDesc(FALLBACK_VERSIONS);
    return {
      versions,
      latest: versions[0],
      recommended: pickRecommended(versions),
      source: 'fallback',
    };
  }
}

/** detectVersion(exePath) -> Promise<string|null> via `<exe> -v` (8s timeout). */
function detectVersion(exePath, options) {
  const opts = options || {};
  const timeout = Number.isInteger(opts.timeout) ? opts.timeout : 8000;
  return new Promise((resolve) => {
    if (!exePath) { resolve(null); return; }
    execFile(exePath, ['-v'], { timeout, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) { resolve(null); return; }
      resolve(parseVersionOutput(`${stdout || ''}\n${stderr || ''}`));
    });
  });
}

function reportProgress(onProgress, progress) {
  if (typeof onProgress !== 'function') return;
  try { onProgress(progress); } catch (_) { /* UI progress must never break a download. */ }
}

async function streamToFileViaFetch(url, destPath, options) {
  const opts = options || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || DOWNLOAD_TIMEOUT_MS);
  let writeStream = null;
  try {
    const response = await opts.fetchImpl(url, { redirect: 'follow', headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    const status = response && typeof response.status === 'number' ? response.status : 0;
    if (!response || (status && status >= 400)) throw new Error(`HTTP ${status || 'unknown'}`);
    if (!response.ok && response.ok !== undefined) throw new Error(`HTTP ${status}`);
    const totalHeader = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('content-length')
      : null;
    const totalBytes = Number(totalHeader) > 0 ? Number(totalHeader) : 0;
    const body = response.body;
    if (!body) throw new Error('响应没有数据流');
    writeStream = fs.createWriteStream(destPath);
    let receivedBytes = 0;
    const writeChunk = async (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.length;
      if (!writeStream.write(buffer)) {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            writeStream.off('drain', onDrain);
            writeStream.off('error', onError);
          };
          const onDrain = () => { cleanup(); resolve(); };
          const onError = (error) => { cleanup(); reject(error); };
          writeStream.once('drain', onDrain);
          writeStream.once('error', onError);
        });
      }
      reportProgress(opts.onProgress, {
        receivedBytes,
        totalBytes,
        percent: totalBytes > 0 ? Math.min(99, Math.floor((receivedBytes / totalBytes) * 100)) : -1,
      });
    };
    if (typeof body.getReader === 'function') {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writeChunk(value);
      }
    } else if (typeof body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of body) await writeChunk(chunk);
    } else if (typeof response.arrayBuffer === 'function') {
      await writeChunk(Buffer.from(await response.arrayBuffer()));
    } else {
      throw new Error('无法读取响应数据');
    }
    await new Promise((resolve, reject) => {
      writeStream.end((error) => (error ? reject(error) : resolve()));
      writeStream.once('error', reject);
    });
    return { receivedBytes, totalBytes };
  } finally {
    clearTimeout(timer);
    if (writeStream) {
      try { writeStream.destroy(); } catch (_) { /* ignore */ }
    }
  }
}

function streamToFileViaHttps(url, destPath, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || DOWNLOAD_TIMEOUT_MS;
  const onProgress = opts.onProgress;
  const redirects = Number.isInteger(opts.redirects) ? opts.redirects : MAX_REDIRECTS;
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = https.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: timeoutMs }, (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirects <= 0) { reject(new Error('重定向次数过多')); return; }
          streamToFileViaHttps(new URL(response.headers.location, url).toString(), destPath, Object.assign({}, opts, { redirects: redirects - 1 })).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const totalHeader = response.headers['content-length'];
        const totalBytes = Number(totalHeader) > 0 ? Number(totalHeader) : 0;
        let receivedBytes = 0;
        const writeStream = fs.createWriteStream(destPath);
        response.on('data', (chunk) => {
          receivedBytes += chunk.length;
          reportProgress(onProgress, {
            receivedBytes,
            totalBytes,
            percent: totalBytes > 0 ? Math.min(99, Math.floor((receivedBytes / totalBytes) * 100)) : -1,
          });
          if (!writeStream.write(chunk)) response.pause();
        });
        writeStream.on('drain', () => response.resume());
        response.on('end', () => {
          writeStream.end(() => resolve({ receivedBytes, totalBytes }));
        });
        response.on('error', (error) => {
          writeStream.destroy();
          reject(error);
        });
        writeStream.on('error', (error) => {
          response.destroy();
          reject(error);
        });
      });
    } catch (error) {
      reject(error);
      return;
    }
    request.on('timeout', () => request.destroy(new Error('下载超时')));
    request.on('error', reject);
  });
}

async function downloadToFile(url, destPath, options) {
  const opts = options || {};
  if (typeof opts.fetchImpl === 'function') return streamToFileViaFetch(url, destPath, opts);
  return streamToFileViaHttps(url, destPath, opts);
}

function isFile(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch (_) { return false; }
}

/**
 * download({version, arch, binDir, fetchImpl, onProgress, platform}) ->
 *   Promise<{ path, version, source: 'downloaded' }>
 * Streams the release zip, extracts frpc.exe with zip.cjs, atomically installs it
 * as <binDir>/frpc.exe and proves it runs with `-v`.
 */
async function download(options) {
  const opts = options || {};
  const version = normalizeVersion(opts.version);
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw createError('DOWNLOAD_FAILED', `版本号无效：${opts.version}`);
  }
  const arch = resolveArch(opts.arch);
  if (!arch) {
    throw createError('DOWNLOAD_FAILED', `当前系统架构不受支持：${opts.arch || process.arch}`);
  }
  const binDir = path.resolve(opts.binDir);
  fs.mkdirSync(binDir, { recursive: true });
  const targetPath = path.join(binDir, 'frpc.exe');
  const workDir = fs.mkdtempSync(path.join(binDir, '.download-'));
  const zipPath = path.join(workDir, `frp_${version}_windows_${arch}.zip`);
  const urls = buildDownloadUrls(version, arch);
  const errors = [];

  try {
    let downloaded = false;
    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index];
      reportProgress(opts.onProgress, { phase: 'download', url, mirrorIndex: index, receivedBytes: 0, totalBytes: 0, percent: -1 });
      try {
        await downloadToFile(url, zipPath, Object.assign({}, opts, {
          onProgress: (progress) => reportProgress(opts.onProgress, Object.assign({ phase: 'download', url, mirrorIndex: index }, progress)),
        }));
        if (!isFile(zipPath) || fs.statSync(zipPath).size < 64) throw new Error('下载内容为空');
        downloaded = true;
        break;
      } catch (error) {
        errors.push(`${index === 0 ? 'GitHub' : `镜像 ${index}`}：${error.message}`);
        try { fs.rmSync(zipPath, { force: true }); } catch (_) { /* ignore */ }
      }
    }
    if (!downloaded) {
      throw createError('DOWNLOAD_FAILED', `下载 frpc ${version} 失败：${errors.join('；') || '未知错误'}。请检查网络后重试，或手动指定已下载的 frpc.exe 路径`);
    }

    reportProgress(opts.onProgress, { phase: 'extract', percent: 100, receivedBytes: 0, totalBytes: 0 });
    const archive = zip.readZipFile(zipPath);
    const entry = zip.findEntry(archive, 'frpc.exe');
    if (!entry) throw createError('DOWNLOAD_FAILED', '下载的压缩包中未找到 frpc.exe，请换一个镜像重试');
    const data = zip.extractEntry(archive, entry);
    const stagedPath = path.join(workDir, 'frpc.exe');
    fs.writeFileSync(stagedPath, data);
    try { fs.chmodSync(stagedPath, 0o755); } catch (_) { /* Windows: no-op */ }

    reportProgress(opts.onProgress, { phase: 'verify', percent: 100, receivedBytes: data.length, totalBytes: data.length });
    const detect = typeof opts.detectVersion === 'function' ? opts.detectVersion : detectVersion;
    const detected = await detect(stagedPath);
    if (!detected) {
      throw createError('DOWNLOAD_FAILED', '下载的 frpc.exe 无法运行，文件可能已损坏，请重试或换一个镜像');
    }

    try {
      fs.renameSync(stagedPath, targetPath);
    } catch (error) {
      if (error && (error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EACCES')) {
        throw createError('DOWNLOAD_FAILED', '目标 frpc.exe 正在使用中，请先停止 frpc 后再下载');
      }
      throw createError('DOWNLOAD_FAILED', `安装 frpc 失败：${error.message}`, { cause: error });
    }
    reportProgress(opts.onProgress, { phase: 'done', percent: 100, receivedBytes: data.length, totalBytes: data.length });
    return { path: targetPath, version: detected, source: 'downloaded' };
  } catch (error) {
    if (error && error.code) throw error;
    throw createError('DOWNLOAD_FAILED', `下载 frpc ${version} 失败：${error.message}`, { cause: error });
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

module.exports = {
  RELEASES_API,
  FALLBACK_VERSIONS,
  resolveArch,
  normalizeVersion,
  parseVersionOutput,
  compareVersions,
  buildDownloadUrl,
  buildDownloadUrls,
  pickRecommended,
  listVersions,
  detectVersion,
  download,
};
