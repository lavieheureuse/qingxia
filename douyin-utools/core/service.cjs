'use strict';
const fs = require('node:fs');
const path = require('node:path');

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function cleanError(error, signal) {
  if ((signal && signal.aborted) || (error && ['CANCELLED', 'ABORT_ERR'].includes(error.code)) || (error && error.name === 'AbortError')) return fail('CANCELLED', '任务已停止。');
  // Only public code/message cross the bridge: native causes can contain
  // request objects or signed URLs, even when the top-level message is safe.
  if (error && typeof error.code === 'string' && typeof error.message === 'string') return fail(error.code, error.message.slice(0, 500));
  return fail('OPERATION_FAILED', error && typeof error.message === 'string' ? error.message.slice(0, 500) : '操作失败，请稍后重试。');
}
function publicVideo(video) {
  const result = {};
  for (const key of ['id', 'title', 'author', 'cover', 'duration', 'width', 'height', 'quality', 'sourceUrl', 'watermark']) {
    if (video[key] !== undefined) result[key] = video[key];
  }
  return result;
}
function createService({ store, downloader, parser, browser, host, clipboard, defaultDirectory, version = '0.2.0' }) {
  const listeners = new Set();
  let active = null;
  let resolved = null;
  let lastResult = null;
  let latestTarget = '';
  let snapshot = null;
  const isHost = !!host;
  function emit(event) {
    snapshot = JSON.parse(JSON.stringify(event));
    for (const callback of listeners) { try { callback(JSON.parse(JSON.stringify(snapshot))); } catch (_) { /* A view callback cannot interrupt saving a video. */ } }
  }
  function assertHost() { if (!isHost) throw fail('HOST_REQUIRED', '请在 uTools 中运行此插件。'); }
  function settings() {
    const saved = store.getSettings();
    return { outputDir: saved.outputDir || defaultDirectory };
  }
  async function task(phase, message, work) {
    assertHost();
    if (active) throw fail('BUSY', '已有任务进行中，请等待完成或先停止。');
    const controller = new AbortController();
    let finish;
    const current = { controller, done: new Promise(resolve => { finish = resolve; }) };
    active = current;
    emit({ phase, message });
    try { return await work(controller.signal); }
    catch (error) {
      const normalized = cleanError(error, controller.signal);
      emit({ phase: normalized.code === 'CANCELLED' ? 'cancelled' : 'error', message: normalized.message });
      throw normalized;
    } finally {
      if (active === current) active = null;
      finish();
    }
  }
  function normalizeVideo(video) {
    if (!video || !/^\d{5,25}$/.test(String(video.id))) throw fail('VIDEO_NOT_FOUND', '没有取得可确认的视频编号，请重新解析。');
    const urls = [...new Set((Array.isArray(video.urls) ? video.urls : []).filter(url => typeof url === 'string' && parser.isMediaUrl(url)))];
    if (!urls.length) throw fail('NO_MEDIA', '网页没有提供受支持的原始视频地址，请登录后重试。');
    const clean = { id: String(video.id), title: String(video.title || `抖音视频 ${video.id}`).slice(0, 1000), author: String(video.author || '').slice(0, 200),
      cover: parser.isCoverUrl(video.cover) ? video.cover : '', sourceUrl: `https://www.douyin.com/video/${video.id}`,
      watermark: typeof video.watermark === 'boolean' ? video.watermark : null, urls };
    for (const key of ['duration', 'width', 'height']) if (Number.isFinite(video[key]) && video[key] > 0) clean[key] = video[key];
    if (typeof video.quality === 'string') clean.quality = video.quality.slice(0, 60);
    return clean;
  }
  function validateRecordedFile(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || !/\.(mp4|webm)$/i.test(value)) throw fail('INVALID_FILE', '只能打开本插件已保存的视频文件。');
    const normalize = input => process.platform === 'win32' ? path.resolve(input).toLowerCase() : path.resolve(input);
    const wanted = normalize(value);
    const allowed = [...store.listHistory().map(record => record.path), lastResult && lastResult.path].filter(Boolean).some(file => normalize(file) === wanted);
    if (!allowed) throw fail('INVALID_FILE', '此文件不在插件的本地下载记录中。');
    try {
      const stat = fs.lstatSync(value);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
    } catch (_) { throw fail('FILE_NOT_FOUND', '视频文件不存在，可能已被移动或删除。'); }
    return path.resolve(value);
  }
  const api = {
    async bootstrap() {
      assertHost();
      return { settings: settings(), history: store.listHistory(), capabilities: { host: isHost, browser: !!(browser && browser.available()) }, version };
    },
    async resolve(input) {
      if (typeof input !== 'string' || input.length > 20000) throw fail('INVALID_INPUT', '请输入不超过 20000 字符的抖音视频分享文本。');
      const requested = parser.parseShareInput(input); // Validate before any HTTP request or opening a window.
      return task('resolving', '正在读取公开分享页面中的视频信息…', async signal => {
        resolved = null; lastResult = null;
        let expectedId = requested.id;
        latestTarget = expectedId ? `https://www.douyin.com/video/${expectedId}` : requested.url;
        let video;
        try { video = await parser.fetchVideo(input, { signal, timeoutMs: 15000 }); }
        catch (error) {
          const normalized = cleanError(error, signal);
          if (['CANCELLED', 'INVALID_URL', 'INVALID_INPUT', 'NOT_VIDEO', 'NOT_PUBLIC', 'VIDEO_MISMATCH', 'UNSAFE_REDIRECT'].includes(normalized.code)) throw normalized;
          if (!browser || !browser.available()) throw normalized;
          // fetchVideo may establish the exact identity before a page challenge.
          // Do not throw that information away and repeat an unreliable shortlink
          // redirect in the browser. Never trust arbitrary error URLs or cookies.
          const discoveredId = error && typeof error.videoId === 'string' && error.videoId === error.videoId.trim() && /^\d{5,25}$/.test(error.videoId) ? error.videoId : null;
          if (expectedId && discoveredId && expectedId !== discoveredId) throw fail('VIDEO_MISMATCH', '短链解析得到的视频编号与目标不一致，已停止。');
          expectedId = expectedId || discoveredId;
          latestTarget = expectedId ? `https://www.douyin.com/video/${expectedId}` : requested.url;
          emit({ phase: 'resolving', message: expectedId ? '已确认目标视频编号，正在后台直接读取作品页…' : '公开页面未返回可用视频，正在尝试后台网页解析…' });
          video = await browser.resolve(latestTarget, { signal, onState: emit });
        }
        if (signal.aborted) throw fail('CANCELLED', '任务已停止。');
        if (expectedId && String(video && video.id) !== String(expectedId)) throw fail('VIDEO_MISMATCH', '返回的视频编号与分享链接不一致，已停止。');
        resolved = normalizeVideo(video);
        latestTarget = resolved.sourceUrl;
        const result = publicVideo(resolved);
        emit({ phase: 'ready', message: '已取得视频信息。确认内容后，点击下载视频。', video: result });
        return result;
      });
    },
    async download(id) {
      return task('downloading', '正在连接视频地址，按真实接收字节显示进度…', async signal => {
        if (!resolved || String(id) !== resolved.id) throw fail('RESOLVE_REQUIRED', '请先解析并确认当前视频，不支持直接传入下载地址。');
        const video = resolved;
        const directory = settings().outputDir;
        if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw fail('INVALID_DIRECTORY', '请先选择有效的本地下载目录。');
        const result = await downloader.downloadMedia({ urls: video.urls.slice(), outputDir: directory, filename: `${video.title} [${video.id}]`,
          referer: 'https://www.douyin.com/', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', signal,
          onProgress(progress) { if (!signal.aborted) emit({ phase: 'downloading', message: '正在下载到本地，关闭主界面不会主动取消。', progress, video: publicVideo(video) }); } });
        // A validated, committed file is a success even if cancellation arrives after rename.
        lastResult = { path: result.path, bytes: result.bytes, mime: result.mime };
        let warning = '';
        try { store.addHistory({ id: `${video.id}-${Date.now()}`, title: video.title, author: video.author, cover: video.cover, path: result.path,
          bytes: result.bytes, createdAt: new Date().toISOString(), sourceUrl: video.sourceUrl }); }
        catch (_) { warning = '（文件已保存，但本地记录写入失败，请记下保存路径。）'; }
        emit({ phase: 'complete', message: `视频已校验并保存到本地。${warning}`, video: publicVideo(video), result: lastResult });
        return { ...lastResult, warning };
      });
    },
    async cancel() {
      if (active) {
        const current = active;
        current.controller.abort();
        await current.done;
      }
      return snapshot ? JSON.parse(JSON.stringify(snapshot)) : null;
    },
    async chooseDirectory() {
      assertHost();
      if (active) throw fail('BUSY', '请等待当前任务结束后更改目录。');
      if (typeof host.showOpenDialog !== 'function') throw fail('DIALOG_UNAVAILABLE', '当前 uTools 没有可用的目录选择器。');
      const paths = await host.showOpenDialog({ title: '选择视频保存文件夹', defaultPath: settings().outputDir, properties: ['openDirectory', 'createDirectory'] });
      if (!paths || !paths.length) return null;
      const directory = paths[0];
      if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw fail('INVALID_DIRECTORY', '请选择一个本地文件夹。');
      try { if (!fs.statSync(directory).isDirectory()) throw new Error('not directory'); fs.accessSync(directory, fs.constants.W_OK); }
      catch (_) { throw fail('INVALID_DIRECTORY', '该文件夹不存在或不可写，请选择其他位置。'); }
      store.saveSettings({ outputDir: directory });
      return directory;
    },
    async getHistory() { assertHost(); return store.listHistory(); },
    async clearHistory() { assertHost(); store.clearHistory(); return []; },
    async openFile(value) {
      assertHost(); const file = validateRecordedFile(value);
      if (typeof host.shellOpenPath !== 'function') throw fail('OPEN_UNAVAILABLE', '当前 uTools 不支持打开本地文件。');
      const error = await host.shellOpenPath(file);
      if (typeof error === 'string' && error) throw fail('OPEN_FAILED', '无法打开视频，请检查系统默认播放器。');
    },
    async revealFile(value) {
      assertHost(); const file = validateRecordedFile(value);
      if (typeof host.shellShowItemInFolder !== 'function') throw fail('OPEN_UNAVAILABLE', '当前 uTools 不支持定位本地文件。');
      await host.shellShowItemInFolder(file);
    },
    async openLogin() {
      assertHost();
      if (active) throw fail('BUSY', '任务进行中，请在已经打开的抖音网页完成验证，或先停止任务再打开网页。');
      if (!browser || !browser.available()) throw fail('BROWSER_UNAVAILABLE', '独立引擎不可用，请更新 uTools 并安装 Chrome 或 Edge。');
      // Establish the intended URL without automatically parsing or downloading.
      if (typeof browser.setTarget === 'function' && latestTarget) browser.setTarget(latestTarget);
      return browser.openLogin();
    },
    async readClipboard() {
      assertHost();
      if (!clipboard || typeof clipboard.readText !== 'function') throw fail('CLIPBOARD_UNAVAILABLE', '无法读取剪贴板，请直接手动粘贴。');
      return String(clipboard.readText() || '').slice(0, 20000);
    },
    onState(callback) {
      if (typeof callback !== 'function') throw fail('INVALID_CALLBACK', '状态监听器必须是函数。');
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
  return Object.freeze(api);
}
module.exports = { createService, publicVideo };
