'use strict';

// This module is main/preload-only. Never pass renderer-supplied options to
// createDownloader: allowUrl and timeoutMs are construction-time test hooks.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
// Electron's renderer URL is a DOM object, not the node:url instance expected
// by older Node transports. Do not depend on renderer-provided Node globals.
const { URL } = require('node:url');
const { Buffer } = require('node:buffer');

const MEDIA_DOMAINS = Object.freeze([
  'douyinvod.com', 'douyinvodmp.com', 'bytecdn.cn', 'bytecdn.com',
  'ibytedtos.com', 'ibytedtos.cn', 'zjcdn.com', 'ixigua.com', 'byteimg.com',
]);
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 150;
const MAX_REDIRECTS = 5;

class DownloadError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DownloadError';
    this.code = code;
  }
}
const fail = (code, message, cause) => new DownloadError(code, message, cause);

function isAllowedMediaUrl(input) {
  try {
    const url = input instanceof URL ? input : new URL(input);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password &&
      !url.port &&
      (MEDIA_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`)) ||
       (['aweme.snssdk.com', 'www.douyin.com'].includes(host) && /^\/aweme\/v1\/play(?:wm)?\/?$/.test(url.pathname)));
  } catch { return false; }
}

function safeFilename(filename, extension) {
  let stem = String(filename || 'douyin-video').normalize('NFC')
    .replace(/\.(?:mp4|webm)$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!stem) stem = 'douyin-video';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  stem = Array.from(stem).slice(0, 100).join('').replace(/[.\s]+$/g, '');
  return `${stem}${extension}`;
}

function sniffMedia(header) {
  if (header.length >= 16 && header.toString('ascii', 4, 8) === 'ftyp') {
    const size = header.readUInt32BE(0);
    const boxSize = size === 1 ? Number(header.readBigUInt64BE(8)) : size;
    if (Number.isSafeInteger(boxSize) && boxSize >= (size === 1 ? 24 : 16)) {
      return { mime: 'video/mp4', extension: '.mp4', minimumBytes: boxSize };
    }
  }
  if (header.length >= 4 && header.readUInt32BE(0) === 0x1a45dfa3) {
    return { mime: 'video/webm', extension: '.webm' };
  }
  throw fail('INVALID_MEDIA', '响应不是有效的 MP4/WebM 视频头');
}

function createDownloader({ allowUrl = isAllowedMediaUrl, timeoutMs = 15000 } = {}) {
  if (typeof allowUrl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw fail('INVALID_ARGUMENT', '下载器配置无效');
  }

  function validateUrl(input) {
    let url;
    try { url = new URL(input); } catch { throw fail('INVALID_URL', '媒体地址无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw fail('URL_NOT_ALLOWED', '仅支持无内嵌凭据的 HTTP(S) 媒体地址');
    }
    let allowed = false;
    try { allowed = allowUrl(url) === true; } catch { /* deny on policy errors */ }
    if (!allowed) throw fail('URL_NOT_ALLOWED', '媒体地址不在允许的 CDN 域名范围');
    return url;
  }

  function checkAbort(signal) {
    if (signal && signal.aborted) throw fail('ABORTED', '下载已取消');
  }

  function request(url, headers, signal, control) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      let response;
      const req = transport.get(url, { headers, agent: false }, res => {
        clearTimeout(headerTimer);
        response = res;
        // An abort can arrive while the destination directory is being opened,
        // before the async iterator attaches its own error listener.
        res.on('error', () => {});
        res.once('close', cleanup);
        resolve(res);
      });
      const onAbort = () => {
        control.error = fail('ABORTED', '下载已取消');
        req.destroy(control.error);
      };
      function cleanup() {
        clearTimeout(headerTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        req.setTimeout(0);
      }
      const onTimeout = () => {
        control.error = fail('TIMEOUT', '下载连接或接收数据超时');
        req.destroy(control.error);
      };
      // Socket inactivity alone does not bound DNS/TCP/TLS/header negotiation.
      const headerTimer = setTimeout(onTimeout, timeoutMs);
      req.setTimeout(timeoutMs, onTimeout);
      req.once('error', error => {
        if (!response) cleanup();
        reject(control.error || fail('NETWORK_ERROR', '无法连接媒体服务器', error));
      });
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
    });
  }

  async function fetchResponse(input, headers, signal, control) {
    let url = validateUrl(input);
    for (let hop = 0; ; hop++) {
      checkAbort(signal);
      const res = await request(url, headers, signal, control);
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const location = res.headers.location;
        res.destroy();
        if (hop >= MAX_REDIRECTS) throw fail('TOO_MANY_REDIRECTS', '媒体地址重定向次数过多');
        if (!location) throw fail('INVALID_REDIRECT', '重定向缺少目标地址');
        let target;
        try { target = new URL(location, url); } catch { throw fail('INVALID_REDIRECT', '重定向地址无效'); }
        url = validateUrl(target); // Re-apply policy before every network hop.
        continue;
      }
      if (res.statusCode !== 200) {
        const error = fail('HTTP_STATUS', `媒体服务器返回 HTTP ${res.statusCode}`);
        error.statusCode = res.statusCode;
        res.destroy();
        throw error;
      }
      return res;
    }
  }

  async function publish(tempPath, outputDir, filename) {
    const extension = path.extname(filename);
    const stem = filename.slice(0, -extension.length);
    for (let suffix = 1; suffix <= 10000; suffix++) {
      const destination = path.join(outputDir, suffix === 1 ? filename : `${stem} (${suffix})${extension}`);
      try {
        // Atomic no-clobber publication: rename() can overwrite on POSIX.
        await fs.link(tempPath, destination);
        return destination;
      } catch (error) {
        if (error.code !== 'EEXIST') throw fail('FILE_WRITE_ERROR', '无法保存下载文件（需要支持硬链接的本地文件系统）', error);
      }
    }
    throw fail('FILE_WRITE_ERROR', '同名文件过多，请更换文件名');
  }

  async function downloadMedia(options = {}) {
    const { urls, outputDir, filename, referer, userAgent, signal, onProgress,
      maxBytes = DEFAULT_MAX_BYTES } = options;
    if (!Array.isArray(urls) || !urls.length || urls.length > 50 ||
        urls.some(url => typeof url !== 'string') ||
        typeof outputDir !== 'string' || !outputDir.trim() ||
        !Number.isSafeInteger(maxBytes) || maxBytes <= 0 ||
        (filename != null && typeof filename !== 'string') ||
        (onProgress != null && typeof onProgress !== 'function') ||
        (signal != null && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))) {
      throw fail('INVALID_ARGUMENT', '请提供媒体地址、保存目录及有效下载参数');
    }
    const headers = {
      'User-Agent': userAgent || 'Mozilla/5.0 DouyinLocalDownloader/1.0',
      Accept: 'video/mp4,video/webm,application/octet-stream;q=0.9',
      'Accept-Encoding': 'identity',
    };
    if (referer) headers.Referer = referer;
    for (const value of Object.values(headers)) {
      if (typeof value !== 'string' || /[^\t\x20-\x7e\x80-\xff]/.test(value)) {
        throw fail('INVALID_ARGUMENT', '请求头格式无效');
      }
    }
    if (referer) {
      try {
        const ref = new URL(referer);
        if (!['http:', 'https:'].includes(ref.protocol) || ref.username || ref.password) throw new Error('invalid');
      } catch { throw fail('INVALID_ARGUMENT', 'Referer 地址无效'); }
    }
    checkAbort(signal);
    const directory = path.resolve(outputDir);
    const attempts = [];
    for (const candidate of urls) {
      let res;
      let file;
      let tempPath;
      let received = 0;
      let total = null;
      const control = { error: null };
      const started = Date.now();
      let lastProgress = started;
      const emit = force => {
        const now = Date.now();
        if (!onProgress || (!force && now - lastProgress < PROGRESS_INTERVAL_MS)) return;
        lastProgress = now;
        const progress = {
          received, total,
          speed: received / Math.max((now - started) / 1000, 0.001),
          percent: total == null ? null : Math.min(100, received / total * 100),
        };
        try { onProgress(progress); } catch { /* UI listeners cannot corrupt a completed file. */ }
      };
      try {
        res = await fetchResponse(candidate, headers, signal, control);
        const contentType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (contentType && !['video/mp4', 'video/webm', 'application/mp4', 'application/octet-stream', 'binary/octet-stream'].includes(contentType)) {
          throw fail('INVALID_CONTENT_TYPE', '媒体服务器返回了非视频内容');
        }
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
          throw fail('INVALID_CONTENT_ENCODING', '媒体服务器返回了不支持的压缩内容');
        }
        if (res.headers['content-length'] != null) {
          const length = String(res.headers['content-length']);
          if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) <= 0) {
            throw fail('LENGTH_MISMATCH', '媒体文件长度无效');
          }
          total = Number(length);
          if (total > maxBytes) throw fail('TOO_LARGE', '视频超过允许的最大文件大小');
        }
        try {
          await fs.mkdir(directory, { recursive: true });
          tempPath = path.join(directory, `.douyin-${randomUUID()}.part`);
          file = await fs.open(tempPath, 'wx', 0o600);
        } catch (error) { throw fail('FILE_WRITE_ERROR', '无法创建下载临时文件，请检查保存目录', error); }
        let header = Buffer.alloc(0);
        let media;
        try {
          for await (const chunk of res) {
            checkAbort(signal);
            received += chunk.length;
            if (received > maxBytes) throw fail('TOO_LARGE', '视频超过允许的最大文件大小');
            if (total != null && received > total) throw fail('LENGTH_MISMATCH', '媒体数据长度与声明不符');
            if (header.length < 16) header = Buffer.concat([header, chunk.subarray(0, 16 - header.length)]);
            if (!media && header.length >= 16) media = sniffMedia(header);
            try { await file.writeFile(chunk); }
            catch (error) { throw fail('FILE_WRITE_ERROR', '写入视频文件失败', error); }
            emit(false);
          }
        } catch (error) {
          if (control.error) throw control.error;
          if (error instanceof DownloadError) throw error;
          if (total != null && received !== total) throw fail('LENGTH_MISMATCH', '视频未完整接收', error);
          throw fail('NETWORK_ERROR', '视频传输中断', error);
        }
        checkAbort(signal);
        if (!received || (total != null && received !== total) || !res.complete) {
          throw fail('LENGTH_MISMATCH', '视频未完整接收');
        }
        media ||= sniffMedia(header);
        if (media.minimumBytes && received < media.minimumBytes) {
          throw fail('INVALID_MEDIA', 'MP4 文件头中的 ftyp 数据块不完整');
        }
        if ((contentType === 'video/webm' && media.mime !== contentType) ||
            (['video/mp4', 'application/mp4'].includes(contentType) && media.mime !== 'video/mp4')) {
          throw fail('INVALID_MEDIA', '视频类型与文件头不一致');
        }
        try { await file.sync(); await file.close(); file = null; }
        catch (error) { throw fail('FILE_WRITE_ERROR', '视频文件落盘失败', error); }
        checkAbort(signal);
        const destination = await publish(tempPath, directory, safeFilename(filename, media.extension));
        // Publication is the commit point. Cancellation after it does not undo a successful download.
        await fs.unlink(tempPath).catch(() => {});
        tempPath = null;
        emit(true); // Final progress is delivered even for downloads shorter than the throttle window.
        return { path: destination, bytes: received, mime: media.mime };
      } catch (caught) {
        // Keep raw exceptions/URLs (possibly signed) backend-only. A synchronous
        // host API/type failure is not an auth error and retrying every CDN does
        // not repair the runtime. Preserve a safe diagnostic tag for the UI.
        const tag = caught && typeof caught.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(caught.code)
          ? caught.code : caught && ['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError'].includes(caught.name) ? caught.name : 'UNKNOWN';
        const error = control.error || (caught instanceof DownloadError ? caught : fail('HOST_RUNTIME_ERROR', `下载运行环境异常（${tag}），请更新并重新加载插件后重试。`, caught));
        if (received) emit(true);
        attempts.push(error.code);
        if (['ABORTED', 'INVALID_ARGUMENT', 'FILE_WRITE_ERROR', 'HOST_RUNTIME_ERROR'].includes(error.code)) throw error;
        if (candidate === urls[urls.length - 1] && attempts.length === urls.length) {
          error.attempts = attempts;
          throw error;
        }
      } finally {
        if (res && !res.destroyed) res.destroy();
        if (file) await file.close().catch(() => {});
        if (tempPath) await fs.unlink(tempPath).catch(() => {});
      }
    }
    throw fail('DOWNLOAD_FAILED', '所有候选媒体地址均下载失败');
  }
  return Object.freeze({ downloadMedia });
}

module.exports = createDownloader;
module.exports.createDownloader = createDownloader;
module.exports.DownloadError = DownloadError;
module.exports.safeFilename = safeFilename;
module.exports.isAllowedMediaUrl = isAllowedMediaUrl;
module.exports.MEDIA_DOMAINS = MEDIA_DOMAINS;
