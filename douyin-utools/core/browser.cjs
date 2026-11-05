'use strict';

// Session-backed background parsing. Only an explicit openLogin can show/navigate
// a visible window; parsing never silently converts missing data into a popup.
// Sessions stay inside uTools. No cookie export, challenge solving, or signatures.
const { randomBytes } = require('node:crypto');
const TRUSTED_PAGES = new Set(['douyin.com', 'www.douyin.com', 'm.douyin.com', 'v.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com', 'm.iesdouyin.com']);
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function cancelled() { return failure('CANCELLED', '任务已停止。'); }
function checkSignal(signal) { if (signal && signal.aborted) throw cancelled(); }
function bounded(promise, signal, timeout) {
  return new Promise((resolve, reject) => {
    let complete = false;
    const timer = setTimeout(() => finish(failure('BROWSER_TIMEOUT', '抖音网页响应超时，请稍后重试；若仍无响应，请重新加载插件。')), timeout);
    function abort() { finish(cancelled()); }
    function finish(error, value) {
      if (complete) return;
      complete = true; clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    }
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
    Promise.resolve(promise).then(value => finish(null, value), error => finish(error));
  });
}
function pageId(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' || !TRUSTED_PAGES.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) return null;
    return (url.pathname.match(/^\/(?:share\/)?video\/(\d{5,25})(?:\/|$)/) || [])[1] || (/^\/$/.test(url.pathname) ? url.searchParams.get('modal_id') : null);
  } catch (_) { return null; }
}
function safePage(href) {
  try { const u = new URL(href); return u.protocol === 'https:' && TRUSTED_PAGES.has(u.hostname) && !u.username && !u.password && (!u.port || u.port === '443'); } catch (_) { return false; }
}

// Serialized by uTools into the page; keep this function self-contained.
function capturePage(mode, expectedId, observationKey, softWaitMs) {
  const probing = mode === 'ready';
  const provenance = mode === 'early' ? 'early' : 'final';
  const hosts = ['douyin.com', 'www.douyin.com', 'm.douyin.com', 'v.douyin.com', 'iesdouyin.com', 'www.iesdouyin.com', 'm.iesdouyin.com'];
  if (location.protocol !== 'https:' || !hosts.includes(location.hostname)) return probing ? true : { kind: 'shiying-page', href: location.href, unsafe: true, diagnostics: { provenance } };
  // A per-run, own-property stopwatch starts AFTER goto, not while navigation is
  // queued. No page/account state is retained. Losing it on navigation ends the
  // wait rather than restarting/extending the deadline on a different document.
  const scoped = typeof observationKey === 'string' && /^__shiying_obs_[a-f0-9]{24}$/.test(observationKey);
  const now = () => typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : Date.now();
  if (scoped && mode === 'early') Object.defineProperty(window, observationKey, { configurable: true,
    value: { started: now(), softMs: Math.max(0, Math.min(8000, Number(softWaitMs) || 0)), probes: 0, stop: 'waiting' } });
  const observation = scoped ? own(window, observationKey) : null;
  function stop(ready, reason = 'ready') {
    if (ready && observation) observation.stop = reason;
    return ready;
  }
  if (probing && scoped) {
    if (!observation) return true;
    observation.probes = Math.min(10000, observation.probes + 1);
    // Ordinary expiry is a successful wait exit so the SAME native run always
    // reaches its final capture. The native wait timeout is only a failsafe.
    if (now() - observation.started >= observation.softMs) return stop(true, 'deadline');
  }
  const limit = 3 * 1024 * 1024;
  const hydration = [];
  let capturedBytes = 0;
  let html = '';
  for (const script of document.scripts) {
    if (capturedBytes >= limit) break;
    const value = script.textContent || '';
    if (/RENDER_DATA|ROUTER_DATA|NEXT_DATA|INITIAL_STATE/i.test(script.id) || /application\/(?:ld\+)?json/i.test(script.type) || /(?:window\.)?(?:_ROUTER_DATA|__INITIAL_STATE__)\s*=/.test(value)) {
      if (value.length <= limit - capturedBytes) {
        capturedBytes += value.length;
        if (probing) hydration.push(value);
        else {
          const content = value.replace(/</g, '\\u003c');
          if (html.length + content.length + 64 < limit) html += '<script type="application/json">' + content + '</script>\n';
        }
      }
    }
  }
  // Clone only bounded own data before serialization: page objects can have
  // getters, custom toJSON, cycles or graphs much larger than the capture budget.
  function boundedData(root, budget) {
    let nodes = 0;
    const seen = new Set();
    function copy(value, depth) {
      if (++nodes > 4000 || depth > 40 || budget <= 0) return undefined;
      if (typeof value === 'string') { if (value.length > budget) return undefined; budget -= value.length + 8; return value; }
      if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) { budget -= 16; return value; }
      if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
      seen.add(value);
      const result = Array.isArray(value) ? [] : Object.create(null);
      for (const key of Object.keys(value).slice(0, 128)) {
        if (key.length > 128 || ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key)) continue;
        budget -= key.length + 8;
        const child = copy(own(value, key), depth + 1);
        if (child !== undefined) result[key] = child;
        if (nodes >= 4000 || budget <= 0) break;
      }
      return result;
    }
    return copy(root, 0);
  }
  const meta = name => { const el = document.querySelector('meta[property="' + name + '"]'); return el ? (el.content || '').slice(0, 2000) : ''; };
  const allVideos = [...document.querySelectorAll('video')];
  const visibleVideos = allVideos.filter(video => {
    const r = video.getBoundingClientRect();
    const style = getComputedStyle(video);
    return r.width > 16 && r.height > 16 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  });
  const media = visibleVideos.slice(0, 3).map(video => ({
    urls: [...new Set([video.currentSrc, video.src, ...[...video.querySelectorAll('source')].map(s => s.src)].filter(Boolean))],
    poster: video.poster, width: video.videoWidth, height: video.videoHeight, duration: Number.isFinite(video.duration) ? video.duration : 0
  }));
  // Modern desktop playback uses blob URLs. Read only the exact visible video's
  // public component prop (not a global store, account data, or network log).
  function own(value, key) {
    if (!value || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
  }
  const shortString = value => typeof value === 'string' && value.length < 16384 ? value : undefined;
  const videoAddressFields = ['play_addr', 'playAddr', 'play_addr_h264', 'play_addr_265', 'playAddrH264', 'playAddrH265', 'download_addr', 'downloadAddr'];
  // Page arrays can carry accessor indices or custom slice/map methods. Project
  // bounded own data only, then use ordinary methods on our fresh local arrays.
  function arrayData(value) {
    const result = [];
    for (let index = 0; index < Math.min(own(value, 'length'), 32); index++) {
      const item = own(value, String(index));
      if (item !== undefined) result.push(item);
    }
    return result;
  }
  const addressString = value => shortString(value) || shortString(own(value, 'src')) || shortString(own(value, 'url')) || shortString(own(value, 'main_url')) || shortString(own(value, 'mainUrl'));
  function address(value) {
    if (typeof value === 'string') return shortString(value);
    if (Array.isArray(value)) return arrayData(value).map(addressString).filter(Boolean);
    if (!value || typeof value !== 'object') return undefined;
    const result = {};
    for (const key of ['url_list', 'urlList', 'urls', 'url', 'src', 'main_url', 'mainUrl', 'width', 'height']) {
      const item = own(value, key);
      if (['width', 'height'].includes(key)) { if (Number.isFinite(item)) result[key] = item; }
      else if (Array.isArray(item)) result[key] = arrayData(item).map(addressString).filter(Boolean);
      else if (shortString(item)) result[key] = item;
    }
    return result;
  }
  function copyVideo(value) {
    const result = {};
    for (const key of ['width', 'height', 'duration', 'duration_sec', 'durationSeconds', 'ratio', 'has_watermark', 'hasWatermark']) {
      const item = own(value, key);
      if (['number', 'boolean'].includes(typeof item) || (typeof item === 'string' && item.length < 64)) result[key] = item;
    }
    for (const key of videoAddressFields.concat(['cover', 'origin_cover', 'originCover', 'dynamic_cover', 'dynamicCover'])) {
      const item = address(own(value, key)); if (item !== undefined) result[key] = item;
    }
    for (const key of ['bit_rate', 'bitRateList']) {
      const list = own(value, key);
      if (Array.isArray(list)) result[key] = arrayData(list).map(entry => {
        const variant = {};
        for (const field of ['width', 'height', 'bit_rate', 'bitRate', 'bitrate', 'gear_name', 'gearName', 'quality_type', 'qualityType']) {
          const item = own(entry, field); if (Number.isFinite(item) || (typeof item === 'string' && item.length < 64)) variant[field] = item;
        }
        for (const field of videoAddressFields) { const item = address(own(entry, field)); if (item !== undefined) variant[field] = item; }
        return variant;
      });
    }
    return result;
  }
  let publicVideo = null;
  let componentMismatch = false;
  let restricted = false;
  const route = location.pathname.match(/^\/(?:share\/)?video\/(\d{5,25})\/?$/);
  const routeId = route ? route[1] : location.pathname === '/' ? new URL(location.href).searchParams.get('modal_id') : null;
  if (routeId && visibleVideos.length === 1) {
    let element = visibleVideos[0];
    for (let level = 0; element && level < 8 && !publicVideo; level++, element = element.parentElement) {
      const key = Object.keys(element).find(name => name.startsWith('__reactFiber$'));
      let fiber = key && own(element, key);
      for (let depth = 0; fiber && depth < 20 && !publicVideo; depth++, fiber = own(fiber, 'return')) {
        const props = own(fiber, 'memoizedProps');
        const item = own(props, 'awemeInfo') || own(props, 'aweme');
        if (!item) continue;
        const componentId = own(item, 'awemeId') || own(item, 'aweme_id');
        if (typeof componentId !== 'string' || componentId !== routeId) {
          if (typeof componentId === 'string' && /^\d{5,25}$/.test(componentId)) componentMismatch = true;
          continue;
        }
        const status = own(item, 'status');
        const restrictedFlag = value => value === true || value === 1;
        const restrictedFields = ['isPrivate', 'is_private', 'isFriendLimit', 'is_friend_limit', 'isChargeVideo', 'is_charge_video', 'isPayVideo', 'is_pay_video', 'isPaidVideo', 'is_paid_video'];
        if (restrictedFields.some(field => restrictedFlag(own(item, field))) || ['is_private', 'isPrivate', 'is_friend_limit', 'isFriendLimit'].some(field => restrictedFlag(own(status, field)))) { restricted = true; break; }
        const video = own(item, 'video') || own(item, 'videoInfo');
        if (!video) continue;
        const author = own(item, 'authorInfo') || own(item, 'author');
        publicVideo = { aweme_id: routeId, aweme_type: own(item, 'awemeType') || own(item, 'aweme_type'),
          desc: String(own(item, 'desc') || own(item, 'itemTitle') || '').slice(0, 2000),
          author: { nickname: String(own(author, 'nickname') || own(author, 'nickName') || '').slice(0, 200) }, video: copyVideo(video) };
      }
    }
  }
  for (const key of ['_ROUTER_DATA', '__INITIAL_STATE__']) {
    try {
      const value = own(window, key);
      if (!value || typeof value !== 'object') continue;
      if (probing) { hydration.push(value); continue; }
      // Never serialize site/account state. Locate exact-target records with an
      // own-data bounded walk, then retain public fields and negative gates only.
      const stack = [{ value, depth: 0 }], seen = new Set(), records = [];
      const flags = ['isPrivate', 'is_private', 'isFriendLimit', 'is_friend_limit', 'isChargeVideo', 'is_charge_video', 'isPayVideo', 'is_pay_video', 'isPaidVideo', 'is_paid_video'];
      while (stack.length && seen.size < 4000) {
        const current = stack.pop(), item = current.value;
        if (!item || typeof item !== 'object' || current.depth > 40 || seen.has(item)) continue;
        seen.add(item);
        const id = own(item, 'aweme_id') || own(item, 'awemeId') || own(item, 'item_id') || own(item, 'id');
        if (typeof id === 'string' && id === routeId && records.length < 128) {
          const projected = { aweme_id: id, status: {} };
          const status = own(item, 'status');
          for (const field of flags) {
            const direct = own(item, field), nested = own(status, field);
            if (typeof direct === 'boolean' || typeof direct === 'number') projected[field] = direct;
            if (typeof nested === 'boolean' || typeof nested === 'number') projected.status[field] = nested;
            if (direct === true || direct === 1 || nested === true || nested === 1) restricted = true;
          }
          for (const field of ['aweme_type', 'awemeType', 'is_live', 'isLive', 'duration']) {
            const scalar = own(item, field);
            if (typeof scalar === 'boolean' || Number.isFinite(scalar) || (typeof scalar === 'string' && scalar.length < 64)) projected[field] = scalar;
          }
          const images = own(item, 'images'), post = own(item, 'image_post_info') || own(item, 'imagePostInfo');
          if ((Array.isArray(images) && images.length) || [own(post, 'images'), own(post, 'image_list')].some(list => Array.isArray(list) && list.length)) projected.images = [{}];
          if (own(item, 'live_room') || own(item, 'liveRoom') || own(item, 'liveRoomInfo')) projected.live_room = {};
          const description = own(item, 'desc') || own(item, 'itemTitle');
          if (typeof description === 'string') projected.desc = description.slice(0, 2000);
          const author = own(item, 'author') || own(item, 'authorInfo') || own(item, 'author_info');
          const nickname = own(author, 'nickname') || own(author, 'nickName');
          if (typeof nickname === 'string') projected.author = { nickname: nickname.slice(0, 200) };
          const video = own(item, 'video') || own(item, 'videoInfo');
          if (video && typeof video === 'object') projected.video = copyVideo(video);
          records.push(projected);
        }
        for (const field of Object.keys(item).slice(0, 128)) {
          const child = own(item, field);
          if (child && typeof child === 'object' && stack.length < 4000) stack.push({ value: child, depth: current.depth + 1 });
        }
      }
      const data = boundedData(records, Math.max(0, limit - html.length - 128));
      if (!data || !data.length) continue;
      const json = JSON.stringify(data).replace(/</g, '\\u003c');
      // application/json works for BOTH globals; no executable assignment syntax.
      if (json.length + html.length + 128 < limit) html += '<script type="application/json">' + json + '</script>\n';
    } catch (_) { /* Unreadable state is not a parsing success. */ }
  }
  if (probing) {
    // wait(func, numericTimeout, ...args) exists in uTools 7.2+. The final Node
    // parser still validates identity, privacy, format and every returned URL.
    if (restricted || (routeId && expectedId && routeId !== expectedId)) return stop(true, 'terminal');
    if (!routeId || !/^\d{5,25}$/.test(routeId)) return false;
    function mediaUrl(value) {
      if (typeof value !== 'string') return false;
      try {
        const u = new URL(value);
        if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
        const domains = ['douyinvod.com', 'douyinvodmp.com', 'bytecdn.cn', 'bytecdn.com', 'ibytedtos.com', 'ibytedtos.cn', 'zjcdn.com', 'ixigua.com', 'byteimg.com'];
        return domains.some(domain => u.hostname === domain || u.hostname.endsWith('.' + domain)) ||
          (['www.douyin.com', 'aweme.snssdk.com'].includes(u.hostname) && /^\/aweme\/v1\/play\/?$/.test(u.pathname));
      } catch (_) { return false; }
    }
    function addresses(value) {
      const pending = [value]; let count = 0;
      while (pending.length && count++ < 256) {
        const item = pending.pop();
        if (mediaUrl(item)) return true;
        if (item && typeof item === 'object') for (const key of Object.keys(item).slice(0, 64)) pending.push(own(item, key));
      }
      return false;
    }
    function usableVideo(value) {
      if (!value || typeof value !== 'object') return false;
      const fields = videoAddressFields;
      if (fields.some(key => addresses(own(value, key)))) return true;
      for (const key of ['bit_rate', 'bitRateList']) {
        const list = own(value, key);
        if (Array.isArray(list) && arrayData(list).some(entry => fields.some(field => addresses(own(entry, field))))) return true;
      }
      return false;
    }
    if (publicVideo && usableVideo(publicVideo.video)) return stop(true);
    if (!componentMismatch && media.length === 1 && media[0].duration > 0 && media[0].width > 0 && media[0].height > 0 && media[0].urls.some(mediaUrl)) return stop(true);
    for (let root of hydration) {
      if (typeof root === 'string') {
        let value = root.trim().replace(/^(?:window\.)?(?:_ROUTER_DATA|__INITIAL_STATE__)\s*=\s*/, '').replace(/;\s*$/, '');
        try { root = JSON.parse(value); }
        catch (_) { try { root = JSON.parse(decodeURIComponent(value)); } catch (_) { continue; } }
      }
      const pending = [root], seen = new Set(); let count = 0;
      while (pending.length && count++ < 4000) {
        const item = pending.pop();
        if (!item || typeof item !== 'object' || seen.has(item)) continue;
        seen.add(item);
        const id = own(item, 'aweme_id') || own(item, 'awemeId') || own(item, 'item_id') || own(item, 'id');
        if (typeof id === 'string' && id === routeId && usableVideo(own(item, 'video') || own(item, 'videoInfo'))) return stop(true);
        for (const key of Object.keys(item).slice(0, 128)) pending.push(own(item, key));
      }
    }
    return false;
  }
  const text = (document.body ? document.body.innerText : '').slice(0, 4000);
  let focused = null;
  try { if (typeof document.hasFocus === 'function') focused = document.hasFocus() === true; } catch (_) { /* Optional diagnostics only. */ }
  const diagnostics = { provenance,
    state: ['loading', 'interactive', 'complete'].includes(document.readyState) ? document.readyState : 'unknown',
    visibility: ['visible', 'hidden', 'prerender'].includes(document.visibilityState) ? document.visibilityState : 'unknown',
    hidden: typeof document.hidden === 'boolean' ? document.hidden : null, focused,
    scripts: Math.min(document.scripts.length, 1000), videos: Math.min(allVideos.length, 100), eligible: Math.min(visibleVideos.length, 100),
    hydration: html.length > 0, component: !!publicVideo,
    elapsedMs: observation ? Math.max(0, Math.min(25000, Math.floor(now() - observation.started))) : null,
    probes: observation ? observation.probes : 0, stop: observation ? observation.stop : scoped ? 'lost' : 'direct' };
  if (scoped && mode === 'final') delete window[observationKey];
  return { kind: 'shiying-page', href: location.href, title: document.title.slice(0, 500), html, media: componentMismatch ? [] : media, publicVideo, restricted,
    ogUrl: meta('og:url'), ogTitle: meta('og:title'), ogImage: meta('og:image'), diagnostics,
    verification: /验证|验证码|完成登录|登录后|扫码登录/.test(text) };
}

function videoFromSnapshot(snapshot, requestedId, parser) {
  if (!snapshot || snapshot.kind !== 'shiying-page') return null;
  if (!safePage(snapshot.href) || snapshot.unsafe) throw failure('UNSAFE_REDIRECT', '网页跳转到了不支持的站点，已停止解析。');
  const currentId = pageId(snapshot.href);
  const id = requestedId || currentId;
  if (!id || !/^\d{5,25}$/.test(id)) return null;
  // Never read a different recommendation after a user scrolls to another item.
  if (currentId && currentId !== id) throw failure('VIDEO_MISMATCH', '网页已切换到另一个视频，请重新粘贴目标视频链接。');
  const sourceUrl = `https://www.douyin.com/video/${id}`;
  if (snapshot.restricted) throw failure('NOT_PUBLIC', '仅支持公开可访问的视频，不支持私密或好友限定作品。');
  // An incomplete component prop must not mask a usable exact-ID hydration
  // payload. Terminal privacy/type exceptions still propagate, never fall through.
  let candidate = null;
  for (const raw of [snapshot.publicVideo, snapshot.html]) {
    if (!raw) continue;
    const parsed = parser.parseVideoData(raw, { id, sourceUrl });
    if (parsed && String(parsed.id) === id && !candidate) candidate = parsed;
  }
  // Inspect both sources before returning: usable component data must not hide
  // explicit private/album/live evidence in hydration for the same exact target.
  if (candidate) return candidate;
  // DOM fallback is deliberately conservative: exact route, matching OG URL (if any),
  // and exactly one visible native video, not unrelated performance/preload requests.
  if (currentId !== id || !Array.isArray(snapshot.media) || snapshot.media.length !== 1) return null;
  if (snapshot.ogUrl && pageId(snapshot.ogUrl) !== id) return null;
  const media = snapshot.media[0];
  const urls = (media.urls || []).filter(parser.isMediaUrl);
  if (!urls.length || !(media.duration > 0) || !(media.width > 0 && media.height > 0)) return null;
  return { id, title: snapshot.ogTitle || snapshot.title || `抖音视频 ${id}`, author: '',
    cover: [media.poster, snapshot.ogImage].find(parser.isCoverUrl) || '', duration: media.duration,
    width: media.width, height: media.height, quality: `${media.height}p`, sourceUrl, watermark: null, urls };
}

function createBrowserResolver(host, { parser, runTimeoutMs = 25000, backgroundWaitMs = 8000 } = {}) {
  let browserId = null;
  let pending = false;
  let lastUrl = 'https://www.douyin.com/';
  function available() {
    try { return !!(host && host.ubrowser && typeof host.ubrowser.goto === 'function' && typeof host.ubrowser.evaluate === 'function'); } catch (_) { return false; }
  }
  function remember(result) {
    const entries = Array.isArray(result) ? result : [result];
    for (const item of entries) if (item && Number.isInteger(item.id) && safePage(item.url)) { browserId = item.id; }
    if (browserId === null && host && typeof host.getIdleUBrowsers === 'function') {
      try {
        const wanted = pageId(lastUrl);
        const opened = host.getIdleUBrowsers().filter(w => safePage(w.url) && (w.url === lastUrl || (wanted && pageId(w.url) === wanted)));
        if (opened.length === 1) { browserId = opened[0].id; }
      } catch (_) { /* Older hosts need not support listing browser windows. */ }
    }
  }
  function reusable(wanted) {
    if (browserId === null) return false;
    const matches = url => safePage(url) && (!wanted || pageId(url) === wanted);
    if (typeof host.getIdleUBrowsers !== 'function') return false;
    try { return host.getIdleUBrowsers().some(w => w.id === browserId && matches(w.url)); } catch (_) { return false; }
  }
  async function run(build, signal, mode = 'hidden', existingId) {
    checkSignal(signal);
    // Guard BEFORE constructing the eagerly queued native commands.
    if (pending) throw failure('BROWSER_BUSY', '抖音网页仍在处理上一个请求，请稍后重试。');
    if (mode === 'existing' && !Number.isInteger(existingId)) throw failure('BROWSER_REQUIRED', '目标网页已关闭，未创建新窗口。');
    pending = true;
    let work;
    try {
      const options = { width: 1060, height: 760, show: mode === 'visible', title: '拾影 · 抖音网页', center: true };
      const target = mode === 'existing' ? existingId : mode === 'visible' && reusable() ? browserId : options;
      work = Promise.resolve(build().run(target));
    } catch (error) { pending = false; throw error; }
    const tracked = work.then(value => { if (mode === 'visible') remember(value); return value; }, error => { if (mode === 'visible' && error && error.data) remember(error.data); throw error; }).finally(() => { pending = false; });
    // Stopping observation cannot abort a native queue. Retain this lock through
    // late completion/rejection, and never turn a failure into visible navigation.
    return bounded(tracked, signal, runTimeoutMs);
  }
  function pageFromResult(result, provenance) {
    const list = Array.isArray(result) ? result.flat(2) : [result];
    return list.filter(item => item && item.kind === 'shiying-page' && (!provenance || item.diagnostics && item.diagnostics.provenance === provenance)).pop() || null;
  }
  function notReady(snapshot, code = 'BACKGROUND_NOT_READY') {
    let page = 'none';
    if (snapshot && safePage(snapshot.href)) {
      const url = new URL(snapshot.href);
      page = pageId(snapshot.href) ? 'video' : /^\/user\//.test(url.pathname) ? 'profile' : url.hostname === 'v.douyin.com' ? 'short' : 'other';
    }
    const d = snapshot && snapshot.diagnostics || {};
    const count = (value, max) => Number.isInteger(value) && value >= 0 && value <= max ? value : null;
    const flag = value => typeof value === 'boolean' ? value : null;
    const diagnostics = { provenance: code === 'BACKGROUND_WAIT_FAILED' ? 'early' : 'final', page,
      state: ['loading', 'interactive', 'complete'].includes(d.state) ? d.state : 'unknown',
      visibility: ['visible', 'hidden', 'prerender'].includes(d.visibility) ? d.visibility : 'unknown',
      hidden: flag(d.hidden), focused: flag(d.focused), scripts: count(d.scripts, 1000), videos: count(d.videos, 100), eligible: count(d.eligible, 100),
      hydration: d.hydration === true, component: d.component === true, elapsedMs: count(d.elapsedMs, 25000), probes: count(d.probes, 10000),
      stop: ['waiting', 'ready', 'deadline', 'terminal', 'lost', 'direct'].includes(d.stop) ? d.stop : 'unknown' };
    const show = value => value === null ? '未知' : String(value);
    const observed = diagnostics.provenance === 'early' ? '原生等待失败；仅早期观察，非结束时页面' : '最终观察';
    const label = { none: '未返回页面', video: '作品页', profile: '个人主页', short: '短链页', other: '非作品页' }[page];
    const detail = `；文档 ${diagnostics.state}/${diagnostics.visibility}；隐藏 ${show(diagnostics.hidden)} / 焦点 ${show(diagnostics.focused)}；脚本 ${show(diagnostics.scripts)}；视频节点 ${show(diagnostics.videos)} / 候选 ${show(diagnostics.eligible)}；公开数据 ${diagnostics.hydration || diagnostics.component ? '有' : '无'}；经过 ${show(diagnostics.elapsedMs)}ms / 探测 ${show(diagnostics.probes)}；退出 ${diagnostics.stop}`;
    return Object.assign(failure(code, `后台未取得目标视频 [${code}]（${observed}；${label}${detail}）。没有自动打开网页；此提示不代表登录失效。`), { diagnostics });
  }
  function terminal(error) { return pending || ['CANCELLED', 'BROWSER_TIMEOUT', 'BROWSER_BUSY', 'INVALID_URL', 'UNSAFE_REDIRECT', 'VIDEO_MISMATCH', 'NOT_PUBLIC', 'NOT_VIDEO'].includes(error && error.code); }
  async function resolve(input, { signal, onState } = {}) {
    if (!available()) throw failure('BROWSER_UNAVAILABLE', '当前 uTools 不支持内置浏览器，请更新 uTools 后重试。');
    checkSignal(signal);
    if (pending) throw failure('BROWSER_BUSY', '抖音网页仍在处理上一个请求，请稍后重试。');
    const requested = parser.parseShareInput(input);
    const wanted = requested.id || requested.videoId;
    lastUrl = wanted ? `https://www.douyin.com/video/${wanted}` : requested.url;
    // An explicit user-opened exact target may be read, but never navigated or
    // recreated. run(id) only: losing the window cannot fall back to show:true.
    if (wanted && reusable(wanted)) {
      const existingId = browserId;
      try {
        const snapshot = pageFromResult(await run(() => host.ubrowser.evaluate(capturePage), signal, 'existing', existingId));
        checkSignal(signal);
        const video = videoFromSnapshot(snapshot, wanted, parser);
        if (video) return video;
      } catch (error) { checkSignal(signal); if (terminal(error)) throw error; }
    }
    let supported = false;
    try { supported = typeof host.ubrowser.wait === 'function'; } catch (_) { /* Report the capability, not native exception contents. */ }
    if (!supported) throw failure('BACKGROUND_UNSUPPORTED', '当前宿主缺少后台等待接口 [BACKGROUND_UNSUPPORTED]。没有自动打开网页，也未要求重新登录。');
    if (onState) onState({ phase: 'resolving', message: '正在后台直达目标作品并等待视频数据就绪，沿用此插件的登录会话…' });
    let snapshot;
    const softWaitMs = Number.isFinite(backgroundWaitMs) ? Math.max(0, Math.min(8000, Math.floor(backgroundWaitMs))) : 8000;
    const observationKey = '__shiying_obs_' + randomBytes(12).toString('hex');
    try {
      // Hidden windows die when run finishes. Soft expiry returns true, ensuring
      // FINAL capture in this same queue; native wait errors contain EARLY data
      // only. Default budget: goto <=12s + failsafe 10s leaves 3s under outer25s.
      const result = await run(() => host.ubrowser.goto(lastUrl, {}, 12000).evaluate(capturePage, 'early', wanted || null, observationKey, softWaitMs)
        .wait(capturePage, softWaitMs + 2000, 'ready', wanted || null, observationKey, softWaitMs)
        .evaluate(capturePage, 'final', wanted || null, observationKey, softWaitMs), signal);
      checkSignal(signal);
      snapshot = pageFromResult(result, 'final');
    } catch (error) {
      checkSignal(signal);
      if (terminal(error)) throw error;
      // Callback failure/native failsafe skips final evaluate. Validate early
      // data for terminal safety only: it is neither final evidence nor success.
      snapshot = pageFromResult(error && error.data);
      if (snapshot) videoFromSnapshot(snapshot, wanted, parser);
      throw notReady(snapshot, 'BACKGROUND_WAIT_FAILED');
    }
    const video = videoFromSnapshot(snapshot, wanted, parser);
    if (video) return video;
    throw notReady(snapshot);
  }
  async function openLogin() {
    if (!available()) throw failure('BROWSER_UNAVAILABLE', '当前 uTools 没有可用的内置浏览器。');
    await run(() => host.ubrowser.goto(lastUrl, {}, 20000), undefined, 'visible');
    return true;
  }
  function setTarget(url) { if (!safePage(url)) throw failure('INVALID_URL', '只支持抖音官方网页。'); lastUrl = url; }
  return { available, resolve, openLogin, setTarget };
}
module.exports = { createBrowserResolver, capturePage, videoFromSnapshot, pageId, safePage };
