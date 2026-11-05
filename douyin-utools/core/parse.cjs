'use strict';

// Public-page parser only. No cookies, account sessions, eval, signature rewriting,
// challenge-solving, or third-party parsing services are used here.
const https = require('node:https');
const zlib = require('node:zlib');
// Preload can run in a renderer realm with a DOM URL and no global Buffer.
const { URL } = require('node:url');
const { Buffer } = require('node:buffer');

const MAX_INPUT_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_URL_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_REDIRECTS = 5;
const PAGE_HOSTS = new Set([
  'v.douyin.com', 'douyin.com', 'www.douyin.com', 'm.douyin.com',
  'iesdouyin.com', 'www.iesdouyin.com', 'm.iesdouyin.com'
]);
const MEDIA_DOMAINS = [
  'douyinvod.com', 'douyinvodmp.com', 'bytecdn.cn', 'bytecdn.com',
  'ibytedtos.com', 'ibytedtos.cn', 'zjcdn.com', 'ixigua.com', 'byteimg.com'
];
const COVER_DOMAINS = MEDIA_DOMAINS.concat([
  'douyinpic.com', 'douyinpic.net', 'pstatp.com', 'byteimg.cn',
  'toutiaoimg.com', 'toutiaovod.com'
]);
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function secureUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_BYTES || /[\s\u0000-\u001f\u007f\\]/u.test(value)) return null;
  // Inspect the original authority: URL silently removes default ports and
  // normalizes backslashes, encoded hosts and credentials otherwise.
  const authority = /^https:\/\/([^/?#]+)/i.exec(value);
  if (!authority || !/^[A-Za-z0-9.-]+$/.test(authority[1])) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    return url;
  } catch (_) {
    return null;
  }
}

function hasDomain(hostname, domains) {
  return domains.some((domain) => hostname === domain || hostname.endsWith('.' + domain));
}

function isMediaUrl(value) {
  const url = secureUrl(value);
  if (!url) return false;
  if (hasDomain(url.hostname, MEDIA_DOMAINS)) return true;
  // Some first-party play_addr values are official playback endpoints rather
  // than CDN URLs. Keep only these exact routes, including their signatures.
  return (url.hostname === 'aweme.snssdk.com' || url.hostname === 'www.douyin.com') &&
    /^\/aweme\/v1\/play(?:wm)?\/?$/.test(url.pathname);
}

function isCoverUrl(value) {
  const url = secureUrl(value);
  return Boolean(url && hasDomain(url.hostname, COVER_DOMAINS));
}

function pageUrl(value) {
  const url = secureUrl(value);
  if (!url || !PAGE_HOSTS.has(url.hostname)) throw failure('INVALID_URL', '请使用有效的 HTTPS 抖音视频分享链接。');
  if (url.hostname === 'v.douyin.com') {
    if (!/^\/[A-Za-z0-9_-]{2,80}\/?$/.test(url.pathname)) throw failure('INVALID_URL', '抖音短链接格式不正确。');
    return { url: url.href };
  }
  if (url.hostname === 'www.douyin.com' && url.pathname === '/' && url.searchParams.has('modal_id')) {
    const ids = url.searchParams.getAll('modal_id');
    if (ids.length !== 1 || !/^\d{1,30}$/.test(ids[0]) || url.searchParams.has('recommend')) throw failure('INVALID_URL', '请使用指向单个作品的视频链接。');
    return { url: 'https://www.douyin.com/video/' + ids[0], id: ids[0] };
  }
  if (/^\/(?:note|share\/(?:slides|note))\/\d{1,30}\/?$/.test(url.pathname)) {
    throw failure('NOT_VIDEO', '此链接为图集，不是可下载的视频。');
  }
  const match = /^\/(?:video|share\/video)\/(\d{1,30})\/?$/.exec(url.pathname);
  if (!match) throw failure('INVALID_URL', '请分享具体的视频链接，不支持推荐页、个人主页或直播。');
  return { url: url.href, id: match[1] };
}

function trimSharePunctuation(value) {
  return value.replace(/[，。！？、；：）》】」』“”‘’.,!;:)\]}]+$/u, '');
}

function parseShareInput(text) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw failure('INVALID_URL', '请输入不超过 16 KB 的抖音视频分享链接或分享文本。');
  }
  const input = text.trim();
  if (/^(?:data|javascript|file|ftp|blob|chrome|about):/i.test(input)) throw failure('INVALID_URL', '不支持此链接协议。');
  const matches = input.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  // Also accept an unambiguous pasted hostname without its HTTPS scheme.
  if (!matches.length && /^(?:v\.douyin\.com|(?:www\.)?douyin\.com|(?:(?:www|m)\.)?iesdouyin\.com)\//i.test(input)) {
    matches.push('https://' + input);
  }
  if (!matches.length || matches.length > 8) throw failure('INVALID_URL', '没有找到有效的抖音视频分享链接。');
  const accepted = [];
  let lastError;
  for (const match of matches) {
    try {
      const result = pageUrl(trimSharePunctuation(match));
      if (!accepted.some((item) => item.url === result.url)) accepted.push(result);
    } catch (error) {
      if (error.code === 'NOT_VIDEO') throw error;
      lastError = error;
    }
  }
  if (accepted.length !== 1) {
    throw accepted.length ? failure('INVALID_URL', '一次只能解析一个视频，请仅保留一个分享链接。') :
      (lastError || failure('INVALID_URL', '抖音视频链接格式不正确。'));
  }
  return accepted[0];
}

function own(object, key) {
  if (!object || typeof object !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
}

function first(object, keys) {
  for (const key of keys) {
    const value = own(object, key);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function jsonValueAt(text, offset) {
  while (/\s/.test(text[offset] || '') && offset < text.length) offset += 1;
  const start = offset;
  if (text[start] !== '{' && text[start] !== '[' && text[start] !== '"') return null;
  let quoted = text[start] === '"';
  let escaped = false;
  let depth = quoted ? 0 : 1;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        quoted = false;
        if (depth === 0) return safeJson(text.slice(start, index + 1));
      }
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      depth += 1;
      if (depth > 100) return null;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return safeJson(text.slice(start, index + 1));
    }
  }
  return null;
}

function decodedJson(text) {
  let value = safeJson(text.trim());
  if (value !== null) return value;
  try {
    value = safeJson(decodeURIComponent(text.trim()));
  } catch (_) {
    value = null;
  }
  return value;
}

function attributes(text) {
  const result = Object.create(null);
  const wanted = ['id', 'type', 'rel', 'href', 'property', 'name', 'content'];
  let index = 0;
  while (index < text.length) {
    if (!/[A-Za-z_:]/.test(text[index])) { index += 1; continue; }
    const start = index++;
    while (index < text.length && /[\w:.-]/.test(text[index])) index += 1;
    const name = text.slice(start, index).toLowerCase();
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (text[index] !== '=') continue;
    index += 1;
    while (index < text.length && /\s/.test(text[index])) index += 1;
    const quote = text[index];
    let value;
    if (quote === '"' || quote === "'") {
      const end = text.indexOf(quote, index + 1);
      if (end < 0) break;
      value = text.slice(index + 1, end);
      index = end + 1;
    } else {
      const valueStart = index;
      while (index < text.length && !/[\s>]/.test(text[index])) index += 1;
      value = text.slice(valueStart, index);
    }
    if (wanted.includes(name)) result[name] = value;
  }
  return result;
}

function extractRoots(raw) {
  if (raw && typeof raw === 'object') return [raw];
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) return [];
  const trimmed = raw.trim();
  const direct = decodedJson(trimmed);
  if (direct && typeof direct === 'object') return [direct];
  const roots = [];
  const lower = raw.toLowerCase();
  const scripts = /<script\b/gi;
  let match;
  while ((match = scripts.exec(raw)) && roots.length < 64) {
    const openingEnd = raw.indexOf('>', scripts.lastIndex);
    if (openingEnd < 0) break;
    const closing = lower.indexOf('</script', openingEnd + 1);
    if (closing < 0) break;
    const closingEnd = lower.indexOf('>', closing + 8);
    if (closingEnd < 0) break;
    const content = raw.slice(openingEnd + 1, closing).trim();
    const attrs = attributes(raw.slice(scripts.lastIndex, openingEnd));
    scripts.lastIndex = closingEnd + 1;
    if (/^(?:RENDER_DATA|_ROUTER_DATA|__NEXT_DATA__)$/i.test(attrs.id || '') || /^(?:application|text)\/json(?:\s*;|$)/i.test(attrs.type || '')) {
      const parsed = decodedJson(content);
      if (parsed && typeof parsed === 'object') roots.push(parsed);
    }
    const assignment = /(?:^|[;\r\n])[ \t]*(?:window[ \t]*\.[ \t]*)?(?:_ROUTER_DATA|RENDER_DATA|__INITIAL_STATE__)[ \t]*=\s*/g;
    let assigned;
    while ((assigned = assignment.exec(content)) && roots.length < 64) {
      let parsed = jsonValueAt(content, assignment.lastIndex);
      if (typeof parsed === 'string') parsed = decodedJson(parsed);
      if (parsed && typeof parsed === 'object') roots.push(parsed);
    }
  }
  return roots;
}

function walk(roots, callback) {
  const stack = roots.map((value) => ({ value, depth: 0 }));
  const visited = new Set();
  let count = 0;
  while (stack.length && count < 30000) {
    const current = stack.pop();
    const value = current.value;
    if (!value || typeof value !== 'object' || visited.has(value) || current.depth > 80) continue;
    visited.add(value);
    count += 1;
    callback(value);
    const keys = Object.keys(value);
    // Bound very wide attacker-controlled objects as well as recursion depth.
    for (let index = Math.min(keys.length, 30000) - 1; index >= 0 && stack.length < 30000; index -= 1) {
      const key = keys[index];
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const child = own(value, key);
      if (child && typeof child === 'object') stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function idString(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  return (typeof value === 'string' || typeof value === 'number') && /^\d{1,30}$/.test(String(value)) ? String(value) : '';
}

function itemId(item) {
  const explicit = first(item, ['aweme_id', 'awemeId', 'item_id', 'itemId']);
  if (explicit !== undefined) return idString(explicit);
  if (own(item, 'video') || own(item, 'videoInfo') || own(item, 'images') || own(item, 'aweme_type') !== undefined) return idString(own(item, 'id'));
  return '';
}

function isNotVideo(item) {
  const type = first(item, ['aweme_type', 'awemeType']);
  const images = own(item, 'images');
  const post = first(item, ['image_post_info', 'imagePostInfo']);
  const postImages = first(post, ['images', 'image_list']);
  const live = first(item, ['is_live', 'isLive']);
  return ((typeof type === 'number' || typeof type === 'string') && [2, 68, 101, 150].includes(Number(type))) ||
    (Array.isArray(images) && images.length > 0) ||
    (Array.isArray(postImages) && postImages.length > 0) ||
    live === true || live === 1 || live === '1' ||
    Boolean(first(item, ['live_room', 'liveRoom', 'liveRoomInfo']));
}

function isNotPublic(item) {
  const flags = ['isPrivate', 'is_private', 'isFriendLimit', 'is_friend_limit',
    'isChargeVideo', 'is_charge_video', 'isPayVideo', 'is_pay_video', 'isPaidVideo', 'is_paid_video'];
  const enabled = (value) => value === true || value === 1;
  if (flags.some((key) => enabled(own(item, key)))) return true;
  const status = own(item, 'status');
  return ['is_private', 'isPrivate', 'is_friend_limit', 'isFriendLimit'].some((key) => enabled(own(status, key)));
}

function stringValue(value, limit) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(0, limit) : '';
}

function numeric(value, max) {
  if (typeof value !== 'number' && typeof value !== 'string') return 0;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= max ? number : 0;
}

function arrayData(value, limit) {
  const result = [];
  for (let index = 0; index < Math.min(own(value, 'length'), limit); index += 1) {
    const item = own(value, String(index));
    if (item !== undefined) result.push(item);
  }
  return result;
}

function addressUrls(address, predicate) {
  let values;
  if (typeof address === 'string') values = [address];
  else if (Array.isArray(address)) values = address;
  else values = first(address, ['url_list', 'urlList', 'urls']);
  if (typeof values === 'string') values = [values];
  if (!Array.isArray(values)) {
    const url = first(address, ['url', 'src', 'main_url', 'mainUrl']);
    values = typeof url === 'string' ? [url] : [];
  }
  const urls = [];
  for (const entry of arrayData(values, 128)) {
    const value = typeof entry === 'string' ? entry : first(entry, ['url', 'src', 'main_url', 'mainUrl']);
    if (typeof value === 'string' && predicate(value)) urls.push(value);
  }
  return urls;
}

function normalizeItem(item, id, sourceUrl) {
  const video = first(item, ['video', 'videoInfo']);
  if (!video || typeof video !== 'object') return null;
  const bitrates = first(video, ['bit_rate', 'bitRateList', 'bitrate', 'bitRate']);
  const ranked = Array.isArray(bitrates) ? arrayData(bitrates, 128).filter((entry) => entry && typeof entry === 'object') : [];
  ranked.sort((a, b) => numeric(first(b, ['bit_rate', 'bitRate', 'bitrate']), 1e10) - numeric(first(a, ['bit_rate', 'bitRate', 'bitrate']), 1e10));
  const fields = ['play_addr', 'playAddr', 'play_addr_h264', 'play_addr_265', 'playAddrH264', 'playAddrH265', 'download_addr', 'downloadAddr'];
  const variants = [];
  for (const entry of ranked) for (const key of fields) {
    const address = own(entry, key);
    if (address !== undefined) variants.push({ address, metadata: entry, quality: first(entry, ['gear_name', 'gearName', 'quality_type', 'qualityType']) });
  }
  for (const key of fields) {
    const address = own(video, key);
    if (address !== undefined) variants.push({ address });
  }
  const urls = [];
  let selected;
  for (const variant of variants) {
    const candidates = addressUrls(variant.address, isMediaUrl);
    if (candidates.length && !selected) selected = variant;
    for (const url of candidates) if (!urls.includes(url) && urls.length < 32) urls.push(url);
  }
  if (!urls.length) return null;
  const address = selected.address;
  const width = Math.round(numeric(own(address, 'width'), 32768) || numeric(own(selected.metadata, 'width'), 32768) || numeric(own(video, 'width'), 32768));
  const height = Math.round(numeric(own(address, 'height'), 32768) || numeric(own(selected.metadata, 'height'), 32768) || numeric(own(video, 'height'), 32768));
  const durationSeconds = first(video, ['duration_sec', 'durationSeconds']);
  const duration = durationSeconds !== undefined ? numeric(durationSeconds, 172800) :
    numeric(first(video, ['duration', 'duration_ms', 'durationMs']) || own(item, 'duration'), 172800000) / 1000;
  const author = first(item, ['author', 'authorInfo', 'author_info']);
  let cover = '';
  for (const key of ['origin_cover', 'originCover', 'cover', 'dynamic_cover', 'dynamicCover']) {
    const candidates = addressUrls(own(video, key), isCoverUrl);
    if (candidates.length) { cover = candidates[0]; break; }
  }
  let quality = width && height ? Math.min(width, height) + 'P' : '';
  if (!quality) {
    const label = stringValue(selected.quality, 64) || stringValue(own(video, 'ratio'), 32);
    quality = /^[\w\s.-]{1,64}$/.test(label) ? label : '';
  }
  let watermark = first(video, ['has_watermark', 'hasWatermark', 'watermark']);
  if (typeof watermark !== 'boolean') watermark = first(item, ['has_watermark', 'hasWatermark', 'watermark']);
  if (typeof watermark !== 'boolean') watermark = /\/playwm\/?(?:\?|$)/.test(urls[0]) ? true : null;
  return {
    id,
    title: stringValue(first(item, ['desc', 'description', 'title']), 2000),
    author: stringValue(typeof author === 'string' ? author : first(author, ['nickname', 'nickName', 'name']), 200),
    cover,
    duration,
    width,
    height,
    quality,
    sourceUrl,
    watermark,
    urls
  };
}

function parseVideoData(raw, options) {
  const opts = options || {};
  let id = idString(opts.id);
  let sourceUrl = '';
  if (opts.sourceUrl) {
    let parsed;
    try { parsed = pageUrl(opts.sourceUrl); } catch (_) { return null; }
    if (id && parsed.id && id !== parsed.id) return null;
    id = id || parsed.id;
    sourceUrl = parsed.url;
  }
  // Never guess from the first recommendation or an arbitrary aweme object.
  if (!id) return null;
  sourceUrl = sourceUrl || 'https://www.douyin.com/video/' + id;
  const matches = [];
  walk(extractRoots(raw), (item) => { if (itemId(item) === id && matches.length < 128) matches.push(item); });
  if (matches.some(isNotPublic)) throw failure('NOT_PUBLIC', '此作品为私密、好友限定或付费视频，仅支持公开可访问的视频。');
  if (matches.some(isNotVideo)) throw failure('NOT_VIDEO', '此作品为图集或直播，不是可下载的视频。');
  for (const item of matches) {
    const video = normalizeItem(item, id, sourceUrl);
    if (video) return video;
  }
  return null;
}

function timeoutValue(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0 || value > 120000) throw failure('INVALID_OPTIONS', 'timeoutMs 必须为 1 到 120000 毫秒。');
  return Math.max(1, Math.floor(value));
}

// An isolated HTTP helper exported for deterministic tests. Its injectable
// request function is NOT exposed through the production fetchVideo interface.
function _fetchPage(inputUrl, options) {
  const opts = options || {};
  let initial;
  let timeoutMs;
  let maxBytes;
  try {
    initial = pageUrl(inputUrl).url;
    timeoutMs = timeoutValue(opts.timeoutMs);
    maxBytes = opts.maxResponseBytes === undefined ? MAX_RESPONSE_BYTES : opts.maxResponseBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE_BYTES) throw failure('INVALID_OPTIONS', '响应大小限制无效。');
  } catch (error) {
    return Promise.reject(error);
  }
  const signal = opts.signal;
  return new Promise((resolve, reject) => {
    let finished = false;
    let currentUrl = initial;
    let expectedId = pageUrl(initial).id;
    let activeRequest;
    let activeResponse;
    let activeDecoder;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
    };
    const settle = (error, result) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) {
        error.sourceUrl = currentUrl;
        if (expectedId) error.videoId = expectedId;
        if (activeDecoder) activeDecoder.destroy();
        if (activeResponse) activeResponse.destroy();
        if (activeRequest) activeRequest.destroy();
        reject(error);
      } else resolve(result);
    };
    const onAbort = () => settle(failure('CANCELLED', '解析已取消。'));
    if (signal && signal.aborted) { onAbort(); return; }
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => settle(failure('TIMEOUT', '解析超时，请稍后重试或在浏览器中打开。')), timeoutMs);
    const request = typeof opts.request === 'function' ? opts.request : https.request;
    function visit(url, redirects) {
      if (finished) return;
      currentUrl = url;
      let superseded = false;
      const headers = {
        'User-Agent': opts.desktop ? DESKTOP_UA : MOBILE_UA,
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br'
      };
      try {
        const req = request(new URL(url), { method: 'GET', headers, maxHeaderSize: 16384 }, (response) => {
          if (finished || superseded) { response.destroy(); return; }
          activeResponse = response;
          const status = Number(response.statusCode);
          if ([301, 302, 303, 307, 308].includes(status)) {
            superseded = true;
            response.on('error', () => {});
            response.destroy();
            if (redirects >= MAX_REDIRECTS) { settle(failure('REDIRECT_LIMIT', '分享链接重定向次数过多。')); return; }
            const location = response.headers.location;
            if (typeof location !== 'string' || /[\\\u0000-\u0020\u007f]/u.test(location)) {
              settle(failure('INVALID_URL', '分享链接返回了无效的跳转地址。')); return;
            }
            let next;
            try {
              if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(location) && !secureUrl(location)) throw failure('INVALID_URL', '分享链接跳转到不受信任的地址。');
              if (location.startsWith('//') && !secureUrl('https:' + location)) throw failure('INVALID_URL', '分享链接跳转到不受信任的地址。');
              const resolved = new URL(location, url).href;
              const target = secureUrl(resolved);
              if (!target || !PAGE_HOSTS.has(target.hostname)) throw failure('INVALID_URL', '分享链接跳转到不受信任的地址。');
              if (/\/(?:passport|login)(?:\/|$)/i.test(target.pathname)) throw failure('LOGIN_REQUIRED', '此视频需要在抖音页面中登录后查看。');
              const parsed = pageUrl(resolved);
              if (expectedId && parsed.id && expectedId !== parsed.id) throw failure('VIDEO_NOT_FOUND', '页面跳转到了其他作品，已停止解析。');
              expectedId = expectedId || parsed.id;
              next = parsed.url;
            } catch (error) {
              settle(error.code ? error : failure('INVALID_URL', '分享链接跳转到不受信任的地址。')); return;
            }
            visit(next, redirects + 1);
            return;
          }
          response.on('error', () => {
            if (!superseded) settle(failure('RESPONSE_TRUNCATED', '网页响应中断，请重试。'));
          });
          if (status === 404 || status === 410) { settle(failure('VIDEO_NOT_FOUND', '视频不存在、已删除或无法公开访问。')); return; }
          if (status === 401 || status === 403) { settle(failure('BROWSER_REQUIRED', '抖音拒绝了公开页面请求，请在抖音页面中打开或登录后重试。')); return; }
          if (status < 200 || status >= 300) { settle(failure('HTTP_ERROR', '抖音页面请求失败（HTTP ' + status + '）。')); return; }
          const lengthHeader = response.headers['content-length'];
          let declared = null;
          if (lengthHeader !== undefined) {
            if (!/^\d+$/.test(String(lengthHeader)) || !Number.isSafeInteger(Number(lengthHeader))) {
              settle(failure('RESPONSE_TRUNCATED', '网页响应长度无效。')); return;
            }
            declared = Number(lengthHeader);
            if (declared > maxBytes) { settle(failure('RESPONSE_TOO_LARGE', '网页响应过大，已停止解析。')); return; }
          }
          let wireBytes = 0;
          let decodedBytes = 0;
          let rawEnded = false;
          let bodyEnded = false;
          const chunks = [];
          const encoding = String(response.headers['content-encoding'] || '').trim().toLowerCase();
          let body = response;
          if (encoding && encoding !== 'identity') {
            if (encoding === 'gzip' || encoding === 'x-gzip') body = zlib.createGunzip();
            else if (encoding === 'deflate') body = zlib.createInflate();
            else if (encoding === 'br' && typeof zlib.createBrotliDecompress === 'function') body = zlib.createBrotliDecompress();
            else { settle(failure('BROWSER_REQUIRED', '网页使用了不支持的内容编码。')); return; }
            activeDecoder = body;
            body.on('error', () => settle(failure('RESPONSE_TRUNCATED', '网页压缩数据无效或不完整。')));
          }
          const complete = () => {
            if (finished || !rawEnded || !bodyEnded) return;
            if (declared !== null && declared !== wireBytes) { settle(failure('RESPONSE_TRUNCATED', '网页响应长度与声明不一致。')); return; }
            settle(null, { body: Buffer.concat(chunks, decodedBytes).toString('utf8'), url, statusCode: status, headers: response.headers });
          };
          response.on('aborted', () => settle(failure('RESPONSE_TRUNCATED', '网页响应提前中断。')));
          response.on('data', (chunk) => {
            wireBytes += chunk.length;
            if (wireBytes > maxBytes) settle(failure('RESPONSE_TOO_LARGE', '网页响应过大，已停止解析。'));
          });
          response.on('end', () => { rawEnded = true; complete(); });
          body.on('data', (chunk) => {
            if (finished) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            decodedBytes += buffer.length;
            if (decodedBytes > maxBytes) { settle(failure('RESPONSE_TOO_LARGE', '解压后的网页响应过大，已停止解析。')); return; }
            chunks.push(buffer);
          });
          body.on('end', () => { bodyEnded = true; complete(); });
          if (body !== response) response.pipe(body);
        });
        activeRequest = req;
        req.on('error', (error) => {
          if (!superseded && !finished) settle(failure('NETWORK_ERROR', '无法连接抖音公开页面：' + stringValue(error && error.message, 160)));
        });
        req.end();
      } catch (error) {
        settle(failure('NETWORK_ERROR', '无法请求抖音公开页面：' + stringValue(error && error.message, 160)));
      }
    }
    visit(initial, 0);
  });
}

function canonicalPage(html) {
  const urls = [];
  const regex = /<(link|meta)\b/gi;
  let match;
  while ((match = regex.exec(html)) && urls.length < 16) {
    const end = html.indexOf('>', regex.lastIndex);
    if (end < 0) break;
    const attrs = attributes(html.slice(regex.lastIndex, end));
    regex.lastIndex = end + 1;
    const candidate = match[1].toLowerCase() === 'link' && /(?:^|\s)canonical(?:\s|$)/i.test(attrs.rel || '') ? attrs.href :
      /^(?:og:url|twitter:url)$/i.test(attrs.property || attrs.name || '') ? attrs.content : '';
    if (!candidate) continue;
    try {
      const parsed = pageUrl(candidate.replace(/&amp;/g, '&'));
      if (parsed.id) urls.push(parsed);
    } catch (_) {}
  }
  if (!urls.length || urls.some((url) => url.id !== urls[0].id)) return null;
  return urls[0];
}

function visibleText(html) {
  const lower = html.toLowerCase();
  let result = '';
  let index = 0;
  while (index < html.length && result.length < 64000) {
    const opening = html.indexOf('<', index);
    if (opening < 0) { result += html.slice(index, index + 64000 - result.length); break; }
    result += html.slice(index, Math.min(opening, index + 64000 - result.length));
    if (result.length >= 64000) break;
    const end = html.indexOf('>', opening + 1);
    if (end < 0) break;
    const hidden = /^\s*(script|style)\b/i.exec(html.slice(opening + 1, Math.min(end, opening + 32)));
    if (hidden) {
      const closing = lower.indexOf('</' + hidden[1].toLowerCase(), end + 1);
      if (closing < 0) break;
      const closingEnd = html.indexOf('>', closing);
      if (closingEnd < 0) break;
      index = closingEnd + 1;
    } else index = end + 1;
    result += ' ';
  }
  return result;
}

function pageFailure(raw) {
  let messages = '';
  walk(extractRoots(raw), (object) => {
    for (const key of ['status_msg', 'statusMsg', 'status_message', 'message', 'error_msg']) {
      const value = own(object, key);
      if (typeof value === 'string' && messages.length < 16000) messages += '\n' + value.slice(0, 1000);
    }
  });
  if (typeof raw === 'string') messages += '\n' + visibleText(raw);
  if (/请先登录|登录后(?:再|可|观看|查看)|未登录|需(?:要)?登录|login required|log in to|please (?:log ?in|sign ?in)/i.test(messages)) return failure('LOGIN_REQUIRED', '此视频需要在抖音页面中登录后查看，请打开抖音页面后重试。');
  if (/视频(?:已|不|被).{0,8}(?:删除|存在|下架)|作品不存在|仅自己可见|私密作品|video not found|aweme.{0,16}not.{0,8}exist/i.test(messages)) return failure('VIDEO_NOT_FOUND', '视频不存在、已删除或无法公开访问。');
  return failure('BROWSER_REQUIRED', '公开页面未提供此视频的可用播放数据，请在抖音页面中打开后重试。');
}

async function fetchVideo(text, options) {
  const opts = options || {};
  const input = parseShareInput(text);
  const timeoutMs = timeoutValue(opts.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let id = input.id;
  let currentUrl = input.url;
  const tried = new Set();
  const errors = [];
  const remaining = () => {
    if (opts.signal && opts.signal.aborted) throw failure('CANCELLED', '解析已取消。');
    const value = deadline - Date.now();
    if (value <= 0) throw failure('TIMEOUT', '解析超时，请稍后重试。');
    return value;
  };
  const get = async (url, desktop) => {
    currentUrl = url;
    const response = await _fetchPage(url, { signal: opts.signal, timeoutMs: remaining(), desktop });
    currentUrl = response.url;
    return response;
  };
  try {
    if (!id) {
      try {
        const response = await get(input.url, false);
        let final = pageUrl(response.url);
        if (!final.id) final = canonicalPage(response.body);
        if (!final || !final.id) throw pageFailure(response.body);
        id = final.id;
        currentUrl = final.url;
        const video = parseVideoData(response.body, { id, sourceUrl: final.url });
        if (video) return video;
        errors.push(pageFailure(response.body));
        tried.add(pageUrl(response.url).url.split('?')[0]);
      } catch (error) {
        if (['CANCELLED', 'TIMEOUT', 'NOT_VIDEO', 'NOT_PUBLIC', 'INVALID_URL', 'REDIRECT_LIMIT'].includes(error.code)) throw error;
        // A short-link redirect may establish the exact ID before the page
        // itself fails. It is then safe to try the other public page variant.
        let final;
        try { final = pageUrl(error.sourceUrl); } catch (_) {}
        if (!final || !final.id) throw error;
        id = final.id;
        currentUrl = final.url;
        tried.add(final.url.split('?')[0]);
        errors.push(error);
      }
    }
    const pages = [
      { url: 'https://www.iesdouyin.com/share/video/' + id + '/', desktop: false },
      { url: 'https://www.douyin.com/video/' + id, desktop: true }
    ];
    for (const page of pages) {
      if (tried.has(page.url)) continue;
      tried.add(page.url);
      try {
        const response = await get(page.url, page.desktop);
        const final = pageUrl(response.url);
        if (final.id && final.id !== id) throw failure('VIDEO_NOT_FOUND', '页面跳转到了其他作品，已停止解析。');
        const video = parseVideoData(response.body, { id, sourceUrl: final.id ? final.url : page.url });
        if (video) return video;
        errors.push(pageFailure(response.body));
      } catch (error) {
        if (['CANCELLED', 'TIMEOUT', 'NOT_VIDEO', 'NOT_PUBLIC', 'INVALID_URL', 'REDIRECT_LIMIT'].includes(error.code)) throw error;
        errors.push(error);
      }
    }
    const priority = ['LOGIN_REQUIRED', 'VIDEO_NOT_FOUND', 'BROWSER_REQUIRED', 'RESPONSE_TOO_LARGE', 'RESPONSE_TRUNCATED', 'HTTP_ERROR', 'NETWORK_ERROR'];
    errors.sort((a, b) => priority.indexOf(a.code) - priority.indexOf(b.code));
    throw errors[0] || failure('BROWSER_REQUIRED', '请在抖音页面中打开此视频后重试。');
  } catch (error) {
    if (!error.code) error = failure('BROWSER_REQUIRED', '无法读取此视频的公开数据。');
    error.sourceUrl = error.sourceUrl || currentUrl;
    if (!id && error.sourceUrl) {
      try { id = pageUrl(error.sourceUrl).id; } catch (_) {}
    }
    if (id) error.videoId = id;
    throw error;
  }
}

module.exports = { parseShareInput, parseVideoData, fetchVideo, isMediaUrl, isCoverUrl, _fetchPage };
