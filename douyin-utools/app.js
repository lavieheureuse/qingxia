(() => {
  'use strict';

  // Host contract: bootstrap, resolve(text), download(id), cancel,
  // chooseDirectory, getHistory, clearHistory, readClipboard, openFile(path),
  // revealFile(path), openLogin(), onState(callback) -> unsubscribe.
  // This view does not fetch, navigate externally, or manufacture host data.
  const $ = (id) => document.getElementById(id);
  const bridge = window.douyin;
  const designPreview = new URLSearchParams(window.location.search).get('design') === '1';
  const phases = new Set(['resolving', 'waiting', 'ready', 'downloading', 'complete', 'error', 'cancelled']);
  const labels = { idle: '等待解析', resolving: '正在解析', waiting: '等待页面', ready: '已解析', downloading: '正在下载', complete: '已保存', error: '未能完成', cancelled: '已停止' };
  const coverDomains = ['douyinpic.com', 'douyinstatic.com', 'ibytedtos.com', 'byteimg.com', 'douyin.com', 'pstatp.com'];
  const state = { initialized: false, host: false, browser: false, phase: 'idle', video: null, result: null, history: [], directory: '', message: '', progress: null, cancelling: false, action: null, resolvedInput: '', sequence: 0 };
  let toastTimer;

  function text(value, max = 1000) {
    return typeof value === 'string' ? value.slice(0, max) : '';
  }
  function messageFrom(error, fallback = '操作未完成，请稍后重试。') {
    return text(error && error.message, 500) || fallback;
  }
  function busy() { return state.phase === 'resolving' || state.phase === 'waiting' || state.phase === 'downloading'; }
  function canCall(name) { return state.host && bridge && typeof bridge[name] === 'function'; }
  function safeCover(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return '';
      return coverDomains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : '';
    } catch (_) { return ''; }
  }
  function bytes(value) {
    if (!Number.isFinite(value) || value < 0) return '';
    if (value < 1024) return `${Math.round(value)} B`;
    if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1073741824) return `${(value / 1048576).toFixed(1)} MB`;
    return `${(value / 1073741824).toFixed(2)} GB`;
  }
  function duration(value) {
    if (!Number.isFinite(value) || value <= 0) return '';
    const total = Math.floor(value);
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, '0')}`;
  }
  function dateLabel(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function notify(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
  }
  function setError(message) {
    state.phase = 'error';
    state.message = message;
    state.progress = null;
    state.cancelling = false;
    render();
  }
  function setInputError(message) {
    $('input-error').textContent = message;
    $('input-error').hidden = !message;
    $('share-input').setAttribute('aria-invalid', message ? 'true' : 'false');
  }
  function makeIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }
  function renderCover(image, fallback, value) {
    const source = safeCover(value);
    image.hidden = true;
    fallback.hidden = false;
    if (!source) { image.removeAttribute('src'); return; }
    image.onload = () => { image.hidden = false; fallback.hidden = true; };
    image.onerror = () => { image.hidden = true; fallback.hidden = false; };
    if (image.getAttribute('src') !== source) image.src = source;
    else if (image.complete && image.naturalWidth > 0) { image.hidden = false; fallback.hidden = true; }
  }
  function renderVideo() {
    const video = state.video;
    $('empty-preview').hidden = !!video;
    $('video-preview').hidden = !video;
    if (!video) return;
    $('video-title').textContent = text(video.title, 1000) || '未提供视频标题';
    $('video-title').title = text(video.title, 1000);
    const author = text(video.author, 200);
    $('video-author').textContent = author;
    $('video-author').hidden = !author;
    renderCover($('video-cover'), $('cover-fallback'), video.cover);
    const facts = [];
    if (duration(video.duration)) facts.push(duration(video.duration));
    if (Number.isFinite(video.width) && Number.isFinite(video.height) && video.width > 0 && video.height > 0) facts.push(`${Math.round(video.width)} × ${Math.round(video.height)}`);
    if (text(video.quality, 60)) facts.push(text(video.quality, 60));
    if (video.watermark === true) facts.push('含水印');
    if (video.watermark === false) facts.push('无水印');
    const nodes = facts.map((fact) => { const node = document.createElement('span'); node.className = 'fact'; node.textContent = fact; return node; });
    $('video-facts').replaceChildren(...nodes);
    const source = text(video.sourceUrl, 2000);
    $('video-source').textContent = source ? `来源：${source}` : '';
    $('video-source').title = source;
    $('video-source').hidden = !source;
    const savedPath = text(state.result && state.result.path, 2000);
    $('saved-path').textContent = savedPath ? `已保存至 ${savedPath}` : '';
    $('saved-path').title = savedPath;
    $('saved-path').hidden = !savedPath;
    const completed = state.phase === 'complete' && !!savedPath;
    $('download-button').hidden = completed;
    $('open-file-button').hidden = !completed;
    $('reveal-button').hidden = !completed;
    $('download-button').disabled = !canCall('download') || busy() || state.cancelling || !video.id;
    $('download-label').textContent = state.phase === 'downloading' ? '正在下载…' : '下载视频';
    $('open-file-button').disabled = !canCall('openFile');
    $('reveal-button').disabled = !canCall('revealFile');
  }
  function renderProgress() {
    const progress = state.progress;
    const visible = state.phase === 'downloading';
    $('download-progress').hidden = !visible;
    $('progress-detail').hidden = true;
    $('download-progress').removeAttribute('value');
    $('download-progress').removeAttribute('aria-valuetext');
    if (!visible || !progress || typeof progress !== 'object') return;
    let percent = Number.isFinite(progress.percent) ? progress.percent : null;
    if (percent === null && Number.isFinite(progress.received) && progress.total > 0) percent = progress.received / progress.total * 100;
    const details = [];
    if (percent !== null) {
      percent = Math.max(0, Math.min(100, percent));
      $('download-progress').value = percent;
      details.push(`${percent.toFixed(1)}%`);
    }
    if (Number.isFinite(progress.received) && progress.received >= 0) details.push(progress.total > 0 ? `${bytes(progress.received)} / ${bytes(progress.total)}` : `已接收 ${bytes(progress.received)}`);
    if (Number.isFinite(progress.speed) && progress.speed > 0) details.push(`${bytes(progress.speed)}/s`);
    $('progress-detail').textContent = details.join(' · ');
    $('progress-detail').hidden = details.length === 0;
    if (details.length) $('download-progress').setAttribute('aria-valuetext', details.join('，'));
  }
  function render() {
    const running = busy();
    $('environment-text').textContent = designPreview ? 'UI 设计预览' : !state.initialized ? '正在连接宿主' : state.host ? 'uTools 已连接' : '界面预览';
    $('environment-badge').classList.toggle('is-connected', state.host);
    $('host-notice').hidden = designPreview || !state.initialized || (state.host && state.browser);
    $('host-notice-text').textContent = designPreview ? '当前为界面设计稿，下载功能将在确认后接入。' : state.host ? '独立引擎不可用，仍可尝试公开链接。请更新 uTools 并安装 Chrome 或 Edge。' : '当前仅为界面预览。请在 uTools 中运行，才能解析与下载视频。';
    $('share-input').disabled = running;
    $('clear-input').disabled = running || !$('share-input').value;
    $('paste-button').disabled = !canCall('readClipboard') || running || state.action === 'paste';
    $('paste-button').title = state.host ? '从剪贴板填入分享文本，不会自动解析' : '请在 uTools 中使用剪贴板';
    $('resolve-button').disabled = !canCall('resolve') || running || !$('share-input').value.trim();
    $('resolve-button').title = !state.host ? '请在 uTools 中解析视频' : !$('share-input').value.trim() ? '先填入视频链接或分享文本' : running ? '当前任务结束后可重新解析' : '解析并预览，不会自动下载';
    $('resolve-label').textContent = state.phase === 'resolving' || state.phase === 'waiting' ? '解析中…' : state.phase === 'error' ? '重新解析' : '解析视频';
    $('input-hint').textContent = !designPreview && !state.host && state.initialized ? '预览模式：解析与下载需要 uTools 宿主。' : running ? '任务进行中。切换记录页不会中断。' : '先解析预览，再由你确认下载。';
    $('phase-badge').textContent = labels[state.phase] || labels.idle;
    $('phase-badge').className = 'phase-badge';
    if (running) $('phase-badge').classList.add('is-busy');
    else if (['ready', 'error', 'complete'].includes(state.phase)) $('phase-badge').classList.add(`is-${state.phase}`);
    $('task-status').hidden = !state.message;
    $('task-status').className = `task-status${state.phase === 'error' ? ' is-error' : state.phase === 'complete' ? ' is-complete' : ''}`;
    $('status-message').textContent = state.message;
    $('status-icon').setAttribute('href', state.phase === 'error' ? '#i-alert' : state.phase === 'complete' ? '#i-check' : '#i-info');
    $('cancel-button').hidden = !running;
    $('cancel-button').disabled = !canCall('cancel') || state.cancelling;
    $('cancel-label').textContent = state.cancelling ? '停止中…' : '停止';
    $('login-button').disabled = !canCall('openLogin') || !state.browser || running;
    $('login-button').title = !state.host ? '请在 uTools 中打开抖音页面' : !state.browser ? '当前宿主的独立引擎不可用' : '仅登录时打开独立窗口；登录后关窗，再解析视频';
    $('login-hint').textContent = designPreview ? '解析受限？可打开抖音页面，登录后再重试。' : !state.host ? '网页与登录功能仅在 uTools 中可用。' : state.phase === 'error' && state.video ? '解析已完成；下载失败原因请看上方提示，不一定与登录有关。' : !state.browser ? '独立引擎不可用，请更新 uTools。' : '优先后台解析，独立引擎读完即退出。';
    $('output-directory').textContent = state.directory || (designPreview ? '下载前可选择本地文件夹' : state.host ? '使用宿主默认下载目录' : '请在 uTools 中选择下载目录');
    $('output-directory').title = state.directory;
    $('choose-directory').disabled = !canCall('chooseDirectory') || running || state.action === 'directory';
    $('choose-directory').title = !state.host ? '请在 uTools 中选择目录' : running ? '任务结束后可更改保存位置' : '选择视频保存目录';
    $('clear-history').disabled = !canCall('clearHistory') || !state.history.length || state.action === 'history';
    $('clear-history').title = state.host ? '只清除记录，不删除本地文件' : '请在 uTools 中管理下载记录';
    $('history-count').textContent = String(state.history.length);
    $('history-count').hidden = !state.history.length;
    $('active-task-banner').hidden = !running;
    $('active-task-text').textContent = state.phase === 'downloading' ? '视频仍在下载，切换页面不会中断。' : '视频仍在解析，切换页面不会中断。';
    renderVideo();
    renderProgress();
  }
  function renderHistory() {
    $('history-empty').hidden = state.history.length > 0;
    $('history-list').replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const item of state.history) {
      if (!item || typeof item !== 'object') continue;
      const li = document.createElement('li');
      li.className = 'history-item';
      const cover = document.createElement('div');
      cover.className = 'history-cover';
      const image = document.createElement('img');
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      image.loading = 'lazy';
      const fallback = makeIcon('film');
      cover.append(image, fallback);
      renderCover(image, fallback, item.cover);
      const info = document.createElement('div');
      info.className = 'history-item-info';
      const title = document.createElement('h3');
      title.className = 'history-title';
      title.textContent = text(item.title, 1000) || '未提供视频标题';
      title.title = title.textContent;
      const meta = document.createElement('p');
      meta.className = 'history-meta';
      for (const value of [text(item.author, 200), dateLabel(item.createdAt), bytes(item.bytes)]) {
        if (!value) continue;
        const span = document.createElement('span');
        span.textContent = value;
        meta.append(span);
      }
      const path = document.createElement('p');
      path.className = 'history-path';
      path.textContent = text(item.path, 2000);
      path.title = path.textContent;
      info.append(title, meta, path);
      const actions = document.createElement('div');
      actions.className = 'history-actions';
      for (const [method, name, icon] of [['openFile', '打开', 'play'], ['revealFile', '文件夹', 'folder']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button button-secondary';
        button.disabled = !canCall(method) || !text(item.path, 2000);
        button.setAttribute('aria-label', `${name}：${title.textContent}`);
        button.append(makeIcon(icon), document.createTextNode(name));
        button.addEventListener('click', () => callFile(method, item.path));
        actions.append(button);
      }
      li.append(cover, info, actions);
      fragment.append(li);
    }
    $('history-list').append(fragment);
  }
  async function refreshHistory() {
    if (!canCall('getHistory')) return;
    try {
      const history = await bridge.getHistory();
      if (Array.isArray(history)) state.history = history.filter((item) => item && typeof item === 'object').slice(0, 500);
      renderHistory();
      render();
    } catch (error) { notify(messageFrom(error, '下载记录读取失败，请重新进入记录页重试。')); }
  }
  function switchTab(name, focus = false) {
    for (const tabName of ['download', 'history']) {
      const active = tabName === name;
      $(`${tabName}-tab`).setAttribute('aria-selected', String(active));
      $(`${tabName}-tab`).tabIndex = active ? 0 : -1;
      $(`${tabName}-tab`).classList.toggle('is-active', active);
      $(`${tabName}-panel`).hidden = !active;
    }
    if (focus) $(`${name}-tab`).focus();
    if (name === 'history') refreshHistory();
  }
  function inputChanged() {
    setInputError('');
    if (!busy()) {
      state.sequence += 1;
      state.phase = 'idle';
      state.video = null;
      state.result = null;
      state.message = '';
      state.progress = null;
    }
    render();
  }
  async function resolveVideo(event) {
    if (event) event.preventDefault();
    if (!canCall('resolve') || busy()) return;
    const input = $('share-input').value.trim();
    if (!input) { setInputError('请先填入抖音视频链接或完整分享文本。'); $('share-input').focus(); return; }
    const sequence = ++state.sequence;
    state.phase = 'resolving';
    state.message = '正在读取视频信息，请稍候。';
    state.video = null;
    state.result = null;
    state.progress = null;
    state.resolvedInput = input;
    setInputError('');
    render();
    try {
      const video = await bridge.resolve(input);
      if (sequence !== state.sequence || state.cancelling || state.phase === 'cancelled') return;
      if (!video || typeof video !== 'object' || !video.id) throw { message: '没有取得可下载的视频，请检查链接后重新解析。' };
      state.video = video;
      state.phase = 'ready';
      state.message = '已取得视频信息。确认内容后，点击下载视频。';
      render();
    } catch (error) {
      if (sequence !== state.sequence || state.phase === 'cancelled') return;
      setError(messageFrom(error, '解析失败，请检查视频链接，或打开抖音登录后重试。'));
    }
  }
  async function downloadVideo() {
    if (!canCall('download') || busy() || !state.video || !state.video.id) return;
    const sequence = ++state.sequence;
    state.phase = 'downloading';
    state.message = '正在下载视频，文件将保存到本地。';
    state.progress = null;
    state.result = null;
    render();
    try {
      const result = await bridge.download(state.video.id);
      if (sequence !== state.sequence || state.cancelling || state.phase === 'cancelled') return;
      if (!result || !text(result.path, 2000)) throw { message: '宿主未返回已保存文件的位置，请查看下载记录。' };
      state.result = result;
      state.phase = 'complete';
      state.message = `视频已保存${bytes(result.bytes) ? `，${bytes(result.bytes)}` : ''}。${text(result.warning, 1000) ? ` ${text(result.warning, 1000)}` : ''}`;
      state.progress = null;
      render();
      refreshHistory();
    } catch (error) {
      if (sequence !== state.sequence || state.phase === 'cancelled') return;
      setError(messageFrom(error, '下载未完成，可以重新下载。'));
    }
  }
  async function cancelTask() {
    if (!canCall('cancel') || !busy() || state.cancelling) return;
    const sequence = state.sequence;
    state.cancelling = true;
    render();
    try {
      const finalState = await bridge.cancel();
      if (sequence !== state.sequence) return;
      state.sequence += 1;
      if (finalState && typeof finalState === 'object' && phases.has(finalState.phase)) {
        // The host owns the outcome: a committed file remains complete even
        // when a stop request races the final write or history update.
        handleState(finalState, true);
      } else {
        // Compatibility with older bridges that returned no state snapshot.
        state.phase = 'cancelled';
        state.message = '任务已停止。你可以修改链接后重新解析。';
        state.progress = null;
      }
    } catch (error) { notify(messageFrom(error, '停止任务失败，请重试。')); }
    finally { state.cancelling = false; render(); }
  }
  async function callFile(method, path) {
    if (!canCall(method) || !text(path, 2000)) return;
    try { await bridge[method](path); }
    catch (error) { notify(messageFrom(error, '无法打开文件，文件可能已被移动或删除。')); }
  }
  function handleState(event, authoritative = false) {
    if (!event || typeof event !== 'object' || !phases.has(event.phase)) return;
    // Cancel's final snapshot is authoritative; ordinary late events must not
    // revive a task whose input has been replaced or whose stop was confirmed.
    if (!authoritative && (state.phase === 'idle' || (state.phase === 'cancelled' && event.phase !== 'cancelled'))) return;
    state.phase = event.phase;
    state.message = text(event.message, 500) || ({ resolving: '正在读取视频信息，请稍候。', waiting: '正在等待抖音页面响应。', ready: '已取得视频信息，确认后即可下载。', downloading: '正在下载视频…', complete: '视频已保存到本地。', error: '任务未完成，请检查链接后重试。', cancelled: '任务已停止。' })[event.phase];
    if (event.video && typeof event.video === 'object') state.video = event.video;
    if (event.result && typeof event.result === 'object') state.result = event.result;
    state.progress = event.phase === 'downloading' && event.progress && typeof event.progress === 'object' ? event.progress : null;
    if (!busy()) state.cancelling = false;
    render();
    if (event.phase === 'complete') refreshHistory();
  }

  $('resolve-form').addEventListener('submit', resolveVideo);
  $('share-input').addEventListener('input', inputChanged);
  $('share-input').addEventListener('blur', () => { if (state.host && !$('share-input').value.trim() && $('share-input').value) setInputError('文本中没有视频链接，请重新粘贴分享内容。'); });
  $('clear-input').addEventListener('click', () => { $('share-input').value = ''; inputChanged(); $('share-input').focus(); });
  $('download-button').addEventListener('click', downloadVideo);
  $('cancel-button').addEventListener('click', cancelTask);
  $('download-tab').addEventListener('click', () => switchTab('download'));
  $('history-tab').addEventListener('click', () => switchTab('history'));
  $('start-download').addEventListener('click', () => { switchTab('download'); $('share-input').focus(); });
  $('return-to-download').addEventListener('click', () => switchTab('download'));
  $('open-file-button').addEventListener('click', () => callFile('openFile', state.result && state.result.path));
  $('reveal-button').addEventListener('click', () => callFile('revealFile', state.result && state.result.path));
  $('paste-button').addEventListener('click', async () => {
    if (!canCall('readClipboard') || busy()) return;
    state.action = 'paste'; render();
    try {
      const clipboard = await bridge.readClipboard();
      if (!text(clipboard, 20000).trim()) { notify('剪贴板中没有文本，请先复制视频分享内容。'); return; }
      $('share-input').value = text(clipboard, 20000);
      inputChanged();
      $('share-input').focus();
      notify('已填入分享文本，点击解析视频继续。');
    } catch (error) { notify(messageFrom(error, '无法读取剪贴板，请手动粘贴。')); }
    finally { state.action = null; render(); }
  });
  $('choose-directory').addEventListener('click', async () => {
    if (!canCall('chooseDirectory') || busy()) return;
    state.action = 'directory'; render();
    try { const path = await bridge.chooseDirectory(); if (text(path, 2000)) { state.directory = path; notify('保存位置已更新。'); } }
    catch (error) { notify(messageFrom(error, '无法选择目录，请重试。')); }
    finally { state.action = null; render(); }
  });
  $('login-button').addEventListener('click', async () => {
    if (!canCall('openLogin') || !state.browser || busy() || state.cancelling) return;
    $('login-button').disabled = true;
    try { const login = await bridge.openLogin(); notify(login && login.closeBeforeParse ? '已打开独立登录窗口。登录一次后请关闭该窗口，再解析视频。' : '已请求打开抖音页面。完成登录后，请点击解析视频重试。'); }
    catch (error) { notify(messageFrom(error, '抖音页面未能打开，请稍后重试。')); }
    finally { render(); }
  });
  $('clear-history').addEventListener('click', () => { if (canCall('clearHistory') && state.history.length) $('clear-history-dialog').showModal(); });
  $('clear-history-dialog').addEventListener('close', async () => {
    if ($('clear-history-dialog').returnValue !== 'confirm' || !canCall('clearHistory')) return;
    state.action = 'history'; render();
    try { await bridge.clearHistory(); state.history = []; renderHistory(); notify('下载记录已清空，本地视频文件未删除。'); }
    catch (error) { notify(messageFrom(error, '记录未能清空，请重试。')); }
    finally { state.action = null; render(); $('clear-history').focus(); }
  });
  document.querySelector('[role="tablist"]').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const selected = $('download-tab').getAttribute('aria-selected') === 'true';
    switchTab(event.key === 'Home' ? 'download' : event.key === 'End' ? 'history' : selected ? 'history' : 'download', true);
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !$('clear-history-dialog').open) { event.preventDefault(); switchTab('download'); resolveVideo(); }
  });
  window.addEventListener('douyin:input', (event) => {
    if (typeof event.detail !== 'string') return;
    $('share-input').value = event.detail.slice(0, 20000);
    inputChanged();
    switchTab('download');
    if (!busy()) $('share-input').focus();
    notify(busy() ? '已填入新文本，当前任务不会中断。结束后请手动解析。' : '已填入分享文本，请点击解析视频。');
  });

  async function initialize() {
    renderHistory();
    if (designPreview || !bridge || typeof bridge.bootstrap !== 'function') {
      state.initialized = true;
      render();
      return;
    }
    try {
      if (typeof bridge.onState === 'function') bridge.onState(handleState);
      const bootstrap = await bridge.bootstrap();
      if (!bootstrap || typeof bootstrap !== 'object') throw { message: '宿主返回的数据不可用，请重新进入插件。' };
      state.host = bootstrap.capabilities && bootstrap.capabilities.host === true;
      state.browser = bootstrap.capabilities && bootstrap.capabilities.browser === true;
      state.directory = text(bootstrap.settings && bootstrap.settings.outputDir, 2000);
      state.history = state.host && Array.isArray(bootstrap.history) ? bootstrap.history.filter((item) => item && typeof item === 'object').slice(0, 500) : [];
      if (text(bootstrap.version, 50)) { $('app-version').textContent = `v${text(bootstrap.version, 50)}`; $('app-version').hidden = false; }
    } catch (error) { notify(messageFrom(error, '宿主连接失败，请重新进入 uTools 插件。')); }
    finally { state.initialized = true; renderHistory(); render(); }
  }
  initialize();
})();
