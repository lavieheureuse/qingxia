'use strict';
const app = document.getElementById('app');

if (new URLSearchParams(location.search).has('uninstall')) {
  document.title = '卸载轻匣';
  document.body.classList.add('uninstall-body');
  app.innerHTML = `<main class="uninstall-page"><header class="uninstall-header"><img id="uninstall-icon" alt=""><div><h1>卸载轻匣</h1><p>请选择卸载时如何处理插件和配置</p></div></header><fieldset class="uninstall-options" aria-label="卸载选项"><label class="uninstall-option"><input type="radio" name="uninstall-choice" value="0" checked><span class="uninstall-option-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 9h18"/></svg></span><span class="uninstall-copy"><strong>保留插件和配置 <em>推荐</em></strong><small>卸载轻匣后保留插件及配置，重新安装后可继续使用。</small></span></label><label class="uninstall-option"><input type="radio" name="uninstall-choice" value="2"><span class="uninstall-option-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h16M9 6V4h6v2M6 6l1 14h10l1-14M10 10v6M14 10v6"/></svg></span><span class="uninstall-copy"><strong>全部删除</strong><small>同时删除已导入的插件和轻匣数据，删除后无法恢复。</small></span></label></fieldset><div class="uninstall-actions"><button type="button" id="uninstall-cancel">取消</button><button type="button" class="primary" id="uninstall-confirm">卸载轻匣</button></div></main>`;
  window.toolbox.call('uninstall-icon').then(icon => { document.getElementById('uninstall-icon').src = icon; }).catch(() => {});
  document.getElementById('uninstall-cancel').addEventListener('click', () => window.toolbox.call('uninstall-choice', 3));
  document.getElementById('uninstall-confirm').addEventListener('click', () => window.toolbox.call('uninstall-choice', Number(document.querySelector('input[name="uninstall-choice"]:checked').value)));
  window.addEventListener('keydown', e => { if (e.key === 'Escape') window.toolbox.call('uninstall-choice', 3); });
} else {
const isPanel = new URLSearchParams(location.search).has('panel');
const isPlugin = new URLSearchParams(location.search).has('plugin');
const isPluginMenu = new URLSearchParams(location.search).has('plugin-menu');
const DEFAULT_GITHUB_REPO = 'https://github.com/lavieheureuse/qingxia';
let state, page = 'home', query = '', selected = [], candidate = null, githubDialog = false, githubInput = '', githubLoading = false, githubAdding = false, githubCandidates = [], githubSelected = [], githubError = '', pluginError = '', updateDialog = false, updateBannerDismissed = '', updateState = null, githubCopied = false, settingsCopied = false;
const copyTimers = {};
const call = (action, value) => window.toolbox.call(action, value);
const escapeHtml = x => String(x || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = p => p.icon ? `<img src="${escapeHtml(p.icon)}" alt="">` : '<span class="fallback">工</span>';
const samePlugin = (a, b) => a.pluginId && b.pluginId ? a.pluginId === b.pluginId : a.identity === b.identity;
const alreadyAdded = p => state.plugins.some(existing => samePlugin(existing, p));
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function formatDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}
function renderReleaseNotesHtml(body) {
  const text = String(body || '').trim();
  if (!text) return '<p>该版本未提供详细更新说明，可前往发布页查看变更记录。</p>';
  const lines = text.split(/\r?\n/);
  const parts = [];
  let inList = false;
  const closeList = () => { if (inList) { parts.push('</ul>'); inList = false; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!inList) { parts.push('<ul>'); inList = true; }
      parts.push(`<li>${escapeHtml(bullet[1])}</li>`);
      continue;
    }
    closeList();
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading) parts.push(`<h4>${escapeHtml(heading[1])}</h4>`);
    else parts.push(`<p>${escapeHtml(line)}</p>`);
  }
  closeList();
  return parts.join('');
}
function firstHighlight(body) {
  const lines = String(body || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const pick = lines.find(s => /^[-*]\s+/.test(s)) || lines[0] || '支持查看更新说明并在应用内完成升级';
  return pick.replace(/^[-*#]+\s+/, '');
}
function showUpdatePill(u) {
  return u && ['available', 'downloading', 'downloaded', 'installing'].includes(u.phase);
}
function updatePillText(u) {
  if (!u) return '';
  if (u.phase === 'downloading') return `更新中 ${u.progress || 0}%`;
  if (u.phase === 'downloaded') return `重启安装 v${u.latestVersion}`;
  if (u.phase === 'installing') return '正在升级…';
  return `新版本 v${u.latestVersion}`;
}
function updateDownloadDom(u) {
  const bar = document.getElementById('update-progress');
  const pct = document.getElementById('update-percent');
  const stats = document.getElementById('update-stats');
  const pill = document.querySelector('[data-action="update-open"].update-pill');
  if (bar) bar.value = u.progress || 0;
  if (pct) pct.textContent = `${u.progress || 0}%`;
  if (stats) {
    const total = u.totalBytes ? ` / ${formatBytes(u.totalBytes)}` : '';
    const speed = u.speedBytes ? ` · ${formatBytes(u.speedBytes)}/s` : '';
    stats.textContent = `${formatBytes(u.receivedBytes)}${total}${speed}`;
  }
  if (pill) pill.textContent = updatePillText(u);
}
function markCopied(key) {
  clearTimeout(copyTimers[key]);
  if (key === 'github') githubCopied = true;
  if (key === 'settings') settingsCopied = true;
  render();
  copyTimers[key] = setTimeout(() => {
    if (key === 'github') githubCopied = false;
    if (key === 'settings') settingsCopied = false;
    render();
  }, 1800);
}
async function confirmUpdates(items) { const duplicates = items.filter(alreadyAdded); return !duplicates.length || showDialog({ title: '更新已添加的插件？', message: '以下插件已添加：' + duplicates.map(p => p.name).join('、') + '。更新后会保留面板、运行设置与 plugin-data 中的配置和内核；插件正在运行时请先关闭。', confirmText: '更新并添加', cancelText: '取消' }); }
function showDialog({ title, message, confirmText = '知道了', cancelText, danger = false, checkboxLabel = '', checkboxDefault = false }) {
  return new Promise(resolve => {
    const previous = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'app-dialog';
    dialog.setAttribute('aria-labelledby', 'message-title');
    dialog.setAttribute('aria-describedby', 'message-description');
    const checkboxHtml = checkboxLabel ? `<label class="dialog-checkbox"><input type="checkbox" ${checkboxDefault ? 'checked' : ''}><span>${escapeHtml(checkboxLabel)}</span></label>` : '';
    dialog.innerHTML = `<div class="dialog-heading"><span class="dialog-eyebrow">轻匣</span><h2 id="message-title">${escapeHtml(title)}</h2></div><p id="message-description" class="dialog-description">${escapeHtml(message)}</p>${checkboxHtml}<div class="dialog-actions">${cancelText ? `<button type="button" class="dialog-cancel">${escapeHtml(cancelText)}</button>` : ''}<button type="button" class="dialog-confirm ${danger ? 'danger' : 'primary'}">${escapeHtml(confirmText)}</button></div>`;
    dialog.addEventListener('close', () => {
      const accepted = dialog.returnValue === 'confirm';
      const cb = dialog.querySelector('.dialog-checkbox input');
      const checked = cb ? Boolean(cb.checked) : false;
      dialog.remove();
      if (previous && previous.isConnected) previous.focus();
      resolve(checkboxLabel ? { confirmed: accepted, checked } : accepted);
    }, { once: true });
    dialog.querySelector('.dialog-confirm').addEventListener('click', () => dialog.close('confirm'));
    const cancel = dialog.querySelector('.dialog-cancel');
    if (cancel) cancel.addEventListener('click', () => dialog.close('cancel'));
    document.body.appendChild(dialog);
    dialog.showModal();
    (cancel || dialog.querySelector('.dialog-confirm')).focus();
  });
}
function showError(error) {
  const message = error && error.message ? error.message : '操作未完成，请重试。';
  if (isPlugin || isPluginMenu) { pluginError = message; render(); return; }
  if (githubDialog) { githubError = message; render(); const input = document.getElementById('github-url'); if (input) input.focus(); return; }
  if (state) render();
  void showDialog({ title: '操作未完成', message });
}
function renderUpdateModal(u) {
  if (!u) return '';
  const phase = u.phase || 'idle';
  const ver = escapeHtml(u.latestVersion || state.version);
  const cur = escapeHtml(u.currentVersion || state.version);
  const titles = {
    available: `轻匣 v${ver}`,
    downloading: `正在下载 v${ver}`,
    downloaded: `v${ver} 已就绪`,
    installing: `正在升级 v${ver}`,
    latest: '已是最新版本',
    checking: '正在检查更新',
    error: u.latestVersion ? `轻匣 v${ver}` : '检查更新失败'
  };
  const modeLabel = u.mode === 'portable' ? '免安装版' : u.mode === 'dev' ? '开发模式' : '安装版';
  const metaParts = [modeLabel];
  if (u.assetSize) metaParts.push(formatBytes(u.assetSize));
  const dateText = formatDate(u.publishedAt);
  if (dateText) metaParts.push(dateText);

  let statusHtml = '';
  let actionsHtml = '';
  if (phase === 'downloading') {
    const totalText = u.totalBytes ? ` / ${formatBytes(u.totalBytes)}` : '';
    const speedText = u.speedBytes ? ` · ${formatBytes(u.speedBytes)}/s` : '';
    statusHtml = `<div class="progress-box"><progress id="update-progress" class="update-progress" max="100" value="${Number(u.progress) || 0}"></progress><div class="progress-meta"><strong id="update-percent">${Number(u.progress) || 0}%</strong><span id="update-stats">${escapeHtml(formatBytes(u.receivedBytes) + totalText + speedText)}</span></div></div>`;
    actionsHtml = `<div class="dialog-actions split"><button class="subtle" data-action="update-cancel">取消下载</button><div class="dialog-actions-right"><button data-action="update-close">后台下载</button></div></div>`;
  } else if (phase === 'downloaded') {
    statusHtml = `<div class="ready-box">新版本已下载完成。点击后将安全停止插件后台任务，自动覆盖升级并重启轻匣。</div>${u.error ? `<div class="error-box" role="alert">${escapeHtml(u.error)}</div>` : ''}`;
    actionsHtml = `<div class="dialog-actions"><button data-action="update-close">稍后安装</button><button class="primary" data-action="update-install">立即重启更新</button></div>`;
  } else if (phase === 'installing') {
    statusHtml = `<div class="ready-box">正在停止插件后台任务并启动安装，请稍候…</div>`;
    actionsHtml = `<div class="dialog-actions"><button class="primary" disabled>正在准备更新…</button></div>`;
  } else if (phase === 'error') {
    statusHtml = `<div class="error-box" role="alert">${escapeHtml(u.error || '更新失败，请检查网络连接后重试，或前往发布页手动下载。')}</div>`;
    actionsHtml = `<div class="dialog-actions split"><button class="subtle" data-action="open-releases">打开发布页</button><div class="dialog-actions-right"><button data-action="update-close">关闭</button><button class="primary" data-action="${u.latestVersion ? 'update-download' : 'update-check'}">重试</button></div></div>`;
  } else if (phase === 'checking') {
    statusHtml = `<p class="dialog-hint">正在向 GitHub 查询最新版本，请稍候…</p>`;
    actionsHtml = `<div class="dialog-actions"><button data-action="update-close">关闭</button></div>`;
  } else if (phase === 'latest') {
    statusHtml = `<div class="ready-box">当前 v${cur} 已是最新版本，无需升级。</div>`;
    actionsHtml = `<div class="dialog-actions split"><button class="subtle" data-action="open-releases">打开发布页</button><div class="dialog-actions-right"><button class="primary" data-action="update-close">知道了</button></div></div>`;
  } else if (u.mode === 'dev') {
    statusHtml = `<p class="dialog-hint">当前为源码开发模式，不支持应用内覆盖升级，可前往发布页下载。</p>`;
    actionsHtml = `<div class="dialog-actions"><button data-action="update-close">关闭</button><button class="primary" data-action="open-releases">打开发布页</button></div>`;
  } else {
    statusHtml = `<p class="dialog-hint">更新将保留已添加的插件与全部配置。</p>`;
    actionsHtml = `<div class="dialog-actions split"><button class="subtle" data-action="update-skip">跳过此版本</button><div class="dialog-actions-right"><button data-action="update-close">稍后提醒</button><button class="primary" data-action="update-download">立即更新</button></div></div>`;
  }

  const showNotes = !!u.latestVersion && phase !== 'latest';
  return `<div class="overlay"><section class="dialog update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title"><div class="dialog-heading"><span class="dialog-eyebrow">应用更新</span><h2 id="update-title">${escapeHtml(titles[phase] || `轻匣 v${ver}`)}</h2>${u.latestVersion ? `<div class="update-meta"><span class="version-pill">v${cur} → v${ver}</span><span>${escapeHtml(metaParts.join(' · '))}</span></div>` : ''}</div>${showNotes ? `<div class="notes-label">更新内容</div><div class="release-notes">${renderReleaseNotesHtml(u.notes)}</div>` : ''}${statusHtml}${actionsHtml}</section></div>`;
}
function render() {
  if (!state) return;
  if (isPlugin) { app.innerHTML = `<header class="plugin-bar"><strong>${escapeHtml(state.name)}</strong><button class="plugin-menu-button" data-action="plugin-menu" aria-label="插件设置" title="插件设置">☰</button></header>`; return; }
  if (isPluginMenu) { app.innerHTML = `<div class="plugin-menu">${pluginError ? `<div class="plugin-menu-error" role="alert">${escapeHtml(pluginError)}</div>` : ''}<label class="plugin-menu-item"><input type="checkbox" data-setting="plugin-independent" ${state.independent ? 'checked' : ''}><span><strong>独立窗口</strong><small>点击外部时保持窗口</small></span></label><label class="plugin-menu-item"><input type="checkbox" data-setting="plugin-background" ${state.background ? 'checked' : ''}><span><strong>后台运行</strong><small>关闭插件页面后继续运行</small></span></label><label class="plugin-menu-item"><input type="checkbox" data-setting="plugin-startup" ${state.pluginStartup ? 'checked' : ''}><span><strong>随轻匣启动</strong><small>轻匣启动时自动运行此插件</small></span></label></div>`; return; }
  const list = state.plugins;
  if (isPanel) {
    app.innerHTML = `<main class="popup"><header><strong>超级面板</strong><button data-action="hide" aria-label="关闭">×</button></header><div class="grid">${state.panel.map(id => list.find(p => p.dir === id)).filter(Boolean).map(p => `<button class="tile" data-action="open" data-id="${escapeHtml(p.dir)}">${icon(p)}<span>${escapeHtml(p.name)}</span></button>`).join('')}<button class="tile plus" data-action="manage"><b>＋</b><span>管理面板</span></button></div></main>`; return;
  }
  const activeElement = document.activeElement;
  const focusId = activeElement && (activeElement.id === 'search' || activeElement.id === 'github-url') ? activeElement.id : '';
  const focusStart = focusId ? activeElement.selectionStart : null;
  const focusEnd = focusId ? activeElement.selectionEnd : null;

  const u = updateState || state.appUpdate || null;
  const defaultGithubUrl = state.defaultGithubUrl || DEFAULT_GITHUB_REPO;
  const pillHtml = showUpdatePill(u) ? `<button class="update-pill ${u.phase === 'downloaded' ? 'primary' : ''}" data-action="update-open">${escapeHtml(updatePillText(u))}</button>` : '';
  const header = `<div class="main-titlebar"><span>轻匣</span><label title="勾选后点击外部时保持窗口"><input type="checkbox" data-setting="main-independent" ${state.mainIndependent ? 'checked' : ''}>独立窗口</label></div><header class="bar"><strong class="brand"><img src="${escapeHtml(state.appIcon)}" alt="">轻匣</strong><div><button class="${page === 'home' ? 'is-current' : ''}" data-action="home">我的工具</button><button class="${page === 'panel' ? 'is-current' : ''}" data-action="panel-page">超级面板</button><button class="${page === 'settings' ? 'is-current' : ''}" data-action="settings">设置</button>${pillHtml}</div></header>`;

  let content = '';
  if (page === 'home') {
    const showBanner = u && u.phase === 'available' && updateBannerDismissed !== u.latestVersion;
    const banner = showBanner ? `<div class="update-banner" role="region" aria-label="版本更新提示"><div class="update-banner-copy"><span class="update-badge">发现新版本 v${escapeHtml(u.latestVersion)}</span><div class="update-banner-text">轻匣发布更新<span>${escapeHtml(firstHighlight(u.notes))}</span></div></div><div class="update-banner-actions"><button class="primary btn-sm" data-action="update-open">查看更新</button><button class="btn-close" data-action="update-dismiss-banner" aria-label="稍后提醒">×</button></div></div>` : '';
    content = `<h1>工具箱</h1>${banner}<input id="search" class="search" placeholder="搜索工具" value="${escapeHtml(query)}"><div class="list">${list.filter(p => (p.name + p.description).toLowerCase().includes(query.toLowerCase())).map(p => `<div class="row">${icon(p)}<div class="info"><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.description)}</small></div><button class="subtle" data-action="remove" data-id="${escapeHtml(p.dir)}">移除</button><button class="primary" data-action="open" data-id="${escapeHtml(p.dir)}">打开</button></div>`).join('')}</div><button class="add" data-action="pick">＋　添加工具</button><button class="subtle" data-action="github">GitHub 导入</button>`;
  }
  if (page === 'panel') content = `<h1>超级面板</h1><p class="muted">选择要在超级面板显示的工具，使用上下按钮调整顺序。</p><div class="list">${[...selected.map(id => list.find(p => p.dir === id)).filter(Boolean), ...list.filter(p => !selected.includes(p.dir))].map(p => `<div class="row"><input type="checkbox" aria-label="加入超级面板" data-check="${escapeHtml(p.dir)}" ${selected.includes(p.dir) ? 'checked' : ''}>${icon(p)}<div class="info"><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.description)}</small></div><button data-action="up" data-id="${escapeHtml(p.dir)}">↑</button><button data-action="down" data-id="${escapeHtml(p.dir)}">↓</button></div>`).join('')}</div><button class="primary" data-action="save-panel">完成</button>`;
  if (page === 'settings') {
    const phase = u ? u.phase : 'idle';
    let statusBadge = '';
    if (phase === 'available') statusBadge = `<span class="status-inline">发现新版本 v${escapeHtml(u.latestVersion)}</span>`;
    else if (phase === 'downloading') statusBadge = `<span class="status-inline">下载中 ${Number(u.progress) || 0}%</span>`;
    else if (phase === 'downloaded') statusBadge = `<span class="status-inline">已就绪 v${escapeHtml(u.latestVersion)}</span>`;
    else if (phase === 'latest') statusBadge = `<span class="status-inline">已是最新版本</span>`;
    else if (phase === 'checking') statusBadge = `<span class="status-inline">正在检查…</span>`;
    const updateSubtext = phase === 'error' && u.error ? u.error : `当前版本 v${state.version}，可直接在应用内查看更新说明并升级。`;
    const hasPendingUpdate = ['available', 'downloading', 'downloaded', 'installing'].includes(phase);
    const primaryUpdateBtn = hasPendingUpdate ? `<button class="primary" data-action="update-open">${phase === 'downloaded' ? '立即重启更新' : '查看更新'}</button>` : '';
    content = `<h1>设置</h1><div class="setting"><div><strong>鼠标中键呼出超级面板</strong><small>中键可能与其他软件的操作冲突。</small></div><input type="checkbox" data-setting="middle" ${state.middle ? 'checked' : ''}></div><div class="setting"><div><strong>开机自动启动</strong><small>系统启动时自动运行工具箱。</small></div><input type="checkbox" data-setting="autostart" ${state.autoStart ? 'checked' : ''}></div><div class="setting"><div><strong>插件目录</strong><small>${escapeHtml(state.folder)}</small><small>选择位置后自动创建 qingxia-plugin 文件夹，统一存放插件副本与 plugin-data 数据；更改目录时一并迁移，旧副本移入回收站。</small></div><div class="setting-actions"><button data-action="folder">查看文件夹</button><button data-action="change-folder">更改目录</button><button data-action="clean-orphans">清理旧副本</button></div></div><div class="setting"><div><strong>启动时自动检查更新</strong><small>打开轻匣时在后台检查 GitHub 新版本，有更新时温和提示。</small></div><input type="checkbox" data-setting="auto-check-update" ${state.autoCheckUpdate ? 'checked' : ''}></div><div class="setting"><div><strong>软件更新${statusBadge}</strong><small>${escapeHtml(updateSubtext)}</small></div><div class="setting-actions">${primaryUpdateBtn}<button data-action="update-check" ${phase === 'checking' || phase === 'downloading' || phase === 'installing' ? 'disabled' : ''}>${phase === 'checking' ? '检查中…' : '检查更新'}</button><button data-action="open-releases">发布页</button></div></div><div class="setting"><div><strong>官方插件仓库</strong><small>加载插件时默认填入此地址，无需前往 GitHub 手动复制。</small><code class="setting-repo-url">${escapeHtml(defaultGithubUrl)}</code></div><div class="setting-actions"><button data-action="settings-copy-repo">${settingsCopied ? '已复制' : '复制地址'}</button><button data-action="open-repo">访问仓库</button></div></div>`;
  }

  const hadModal = !!app.querySelector('.overlay');
  let modal = candidate ? `<div class="overlay"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="candidate-title"><div class="dialog-heading"><span class="dialog-eyebrow">工具管理</span><h2 id="candidate-title">添加工具</h2></div><p class="dialog-description">确认插件信息后即可添加到工具箱。</p><div class="plugin-preview">${icon(candidate)}<div class="info"><strong>${escapeHtml(candidate.name)}</strong><small>${escapeHtml(candidate.description)}</small></div></div><p class="dialog-hint">请只添加信任的插件，插件可能访问本地文件和网络。</p><div class="dialog-actions"><button data-action="cancel">取消</button><button class="primary" data-action="add-confirm">添加工具</button></div></section></div>` : '';
  if (githubDialog) {
    const showReset = githubInput.trim() !== defaultGithubUrl;
    const showClear = githubInput.length > 0;
    modal = `<div class="overlay"><section class="dialog github-dialog" role="dialog" aria-modal="true" aria-labelledby="github-title"><div class="dialog-heading"><span class="dialog-eyebrow">工具管理</span><h2 id="github-title">从 GitHub 添加工具</h2></div><p class="dialog-description">已默认填入轻匣官方插件仓库，可直接查找，也可改为其他公开仓库。</p><div class="label-row"><label class="dialog-label" for="github-url">仓库链接</label><div class="label-actions"><button type="button" class="mini-action ${githubCopied ? 'copied' : ''}" data-action="github-copy" ${!githubInput.trim() || githubLoading ? 'disabled' : ''}>${githubCopied ? '已复制' : '复制链接'}</button>${showReset ? `<button type="button" class="mini-action" data-action="github-reset" ${githubLoading ? 'disabled' : ''}>恢复默认</button>` : ''}${showClear ? `<button type="button" class="mini-action" data-action="github-clear-input" ${githubLoading ? 'disabled' : ''}>清空</button>` : ''}</div></div><input id="github-url" class="search" placeholder="https://github.com/用户名/仓库名" value="${escapeHtml(githubInput)}" ${githubError ? 'aria-invalid="true" aria-describedby="github-error"' : ''} ${githubLoading ? 'disabled' : ''}>${githubError ? `<p id="github-error" class="dialog-error" role="alert">${escapeHtml(githubError)}</p>` : ''}<p class="dialog-hint">请只添加信任的插件，插件可能访问本地文件和网络。</p>${githubCandidates.length ? `<p class="github-selection-hint">请选择要添加的插件，可多选</p><div class="github-results">${githubCandidates.map((p, i) => `<label class="github-result"><input type="checkbox" data-github-index="${i}" ${githubSelected.includes(i) ? 'checked' : ''}>${icon(p)}<span><strong>${escapeHtml(p.name)}${alreadyAdded(p) ? ' <em class="github-installed">已添加，可更新</em>' : ''}</strong><small>${escapeHtml(p.description)}</small></span></label>`).join('')}</div>` : ''}<div class="dialog-actions"><button data-action="github-cancel" ${githubLoading ? 'disabled' : ''}>取消</button><button data-action="github-load" ${githubLoading ? 'disabled' : ''}>${githubLoading && !githubAdding ? '正在下载…' : githubCandidates.length ? '重新查找' : '查找插件'}</button>${githubCandidates.length ? `<button class="primary" data-action="github-add" ${githubSelected.length && !githubLoading ? '' : 'disabled'}>${githubAdding ? '正在添加…' : '添加所选（' + githubSelected.length + '）'}</button>` : ''}</div></section></div>`;
  }
  if (updateDialog) modal = renderUpdateModal(u);

  app.innerHTML = `${header}<main class="content">${content}</main><footer>轻匣　v${escapeHtml(state.version)}</footer>${modal}`;
  if (focusId) {
    const restored = document.getElementById(focusId);
    if (restored && !restored.disabled) {
      restored.focus();
      if (focusStart !== null && focusEnd !== null) restored.setSelectionRange(focusStart, focusEnd);
    }
  } else if (modal && !hadModal) {
    const target = app.querySelector('#github-url') || app.querySelector('.update-dialog .primary') || app.querySelector('[data-action="update-close"]') || app.querySelector('[data-action="cancel"]');
    if (target) target.focus();
  }
}
async function handle(action, id) {
  if (action === 'home') page = 'home';
  if (action === 'settings') page = 'settings';
  if (action === 'panel-page' || action === 'manage') { page = 'panel'; selected = [...state.panel]; if (isPanel) { await call('manage'); return; } }
  if (action === 'open') await call('open', id);
  if (action === 'hide') await call('hide');
  if (action === 'plugin-menu') await call('plugin-menu');
  if (action === 'pick') candidate = await call('pick');
  if (action === 'github') { githubDialog = true; githubCandidates = []; githubSelected = []; githubInput = (state && state.defaultGithubUrl) || DEFAULT_GITHUB_REPO; githubError = ''; githubCopied = false; }
  if (action === 'github-cancel') { githubDialog = false; githubCandidates = []; githubSelected = []; githubError = ''; await call('github-clear'); }
  if (action === 'github-copy') { const val = document.getElementById('github-url')?.value.trim() || githubInput.trim(); if (val) { await call('copy-text', val); markCopied('github'); } return; }
  if (action === 'github-reset') { githubInput = (state && state.defaultGithubUrl) || DEFAULT_GITHUB_REPO; githubError = ''; }
  if (action === 'github-clear-input') { githubInput = ''; githubError = ''; }
  if (action === 'github-load') { githubInput = document.getElementById('github-url').value.trim(); githubLoading = true; githubCandidates = []; githubSelected = []; githubError = ''; render(); try { await call('github-clear'); githubCandidates = await call('github', githubInput); } finally { githubLoading = false; render(); } }
  if (action === 'github-add') { if (!githubSelected.length) return; const chosen = githubSelected.map(i => githubCandidates[i]); const replace = chosen.some(alreadyAdded); if (!await confirmUpdates(chosen)) return; githubLoading = true; githubAdding = true; render(); try { state = await call('add-many', { dirs: chosen.map(p => p.dir), replace }); githubDialog = false; githubCandidates = []; githubSelected = []; if (state.warning) void showDialog({ title: '更新完成，清理未完成', message: state.warning }); } finally { githubLoading = false; githubAdding = false; } }
  if (action === 'update-open') { updateDialog = true; }
  if (action === 'update-close') { updateDialog = false; }
  if (action === 'update-dismiss-banner') { if (updateState && updateState.latestVersion) updateBannerDismissed = updateState.latestVersion; }
  if (action === 'update-check') { updateState = await call('update-check'); if (updateState && (updateState.phase === 'available' || updateState.phase === 'latest' || updateState.phase === 'error')) updateDialog = true; }
  if (action === 'update-download') { updateDialog = true; updateState = await call('update-download'); }
  if (action === 'update-cancel') { updateState = await call('update-cancel'); }
  if (action === 'update-install') { updateState = await call('update-install'); }
  if (action === 'update-skip') { const targetVer = updateState ? updateState.latestVersion : ''; updateDialog = false; state = await call('update-skip', targetVer); if (state.appUpdate) updateState = state.appUpdate; }
  if (action === 'open-releases') { await call('open-external', (updateState && updateState.htmlUrl) || state.releasesUrl || `${DEFAULT_GITHUB_REPO}/releases`); }
  if (action === 'open-repo') { await call('open-external', state.defaultGithubUrl || DEFAULT_GITHUB_REPO); }
  if (action === 'settings-copy-repo') { await call('copy-text', state.defaultGithubUrl || DEFAULT_GITHUB_REPO); markCopied('settings'); return; }
  if (action === 'cancel') { candidate = null; await call('github-clear'); }
  if (action === 'add-confirm') { const replace = alreadyAdded(candidate); if (!await confirmUpdates([candidate])) return; state = await call('add', { dir: candidate.dir, replace }); candidate = null; if (state.warning) void showDialog({ title: '更新完成，清理未完成', message: state.warning }); }
  if (action === 'remove') { const plugin = state.plugins.find(item => item.dir === id); const hasData = Boolean(plugin && plugin.dataSubdir); const result = await showDialog({ title: '移除工具？', message: hasData ? `确定从工具箱移除“${plugin.name}”？托管的插件副本将移入回收站。` : `确定从工具箱移除“${plugin ? plugin.name : '该工具'}”？托管的插件副本将移入回收站，你的用户数据会保留。`, checkboxLabel: hasData ? '同时删除该插件的配置、数据与已下载内核（移入回收站，下次导入需重新配置和下载）' : '', checkboxDefault: false, confirmText: '移除工具', cancelText: '取消', danger: true }); const confirmed = hasData ? result.confirmed : result; const removeData = hasData ? result.checked : false; if (!confirmed) return; state = await call('remove', { dir: id, removeData }); if (state.warning) void showDialog({ title: '移除完成，清理未完成', message: state.warning }); }
  if (action === 'save-panel') { state = await call('panel', selected); page = 'home'; }
  if (action === 'folder') await call('folder');
  if (action === 'change-folder') { state = await call('change-folder'); if (state.warning) void showDialog({ title: '迁移完成，清理未完成', message: state.warning }); }
  if (action === 'clean-orphans') { const result = await call('clean-orphans'); const message = !result.removed && !result.failed ? '没有需要清理的旧插件目录。' : result.failed ? `已将 ${result.removed} 个未使用的旧插件目录移入回收站，另有 ${result.failed} 个未能清理，请关闭相关程序后重试。` : `已将 ${result.removed} 个未使用的旧插件目录移入回收站。`; void showDialog({ title: '清理旧副本', message }); }
  if (action === 'up' || action === 'down') { const i = selected.indexOf(id); const j = i + (action === 'up' ? -1 : 1); if (i >= 0 && j >= 0 && j < selected.length) [selected[i], selected[j]] = [selected[j], selected[i]]; }
  render();
}
app.addEventListener('click', e => { const b = e.target.closest('[data-action]'); if (b) handle(b.dataset.action, b.dataset.id).catch(showError); });
app.addEventListener('input', e => { if (e.target.id === 'github-url') { githubInput = e.target.value; githubError = ''; render(); return; } if (e.target.id === 'search') { query = e.target.value; render(); } });
app.addEventListener('change', async e => { try { if (e.target.dataset.githubIndex !== undefined) { const i = Number(e.target.dataset.githubIndex); githubSelected = e.target.checked ? [...githubSelected, i] : githubSelected.filter(x => x !== i); const button = app.querySelector('[data-action=github-add]'); if (button) { button.disabled = !githubSelected.length; button.textContent = '添加所选（' + githubSelected.length + '）'; } } else if (e.target.dataset.check) { const id = e.target.dataset.check; selected = e.target.checked ? [...selected, id] : selected.filter(x => x !== id); render(); } else if (e.target.dataset.setting) { state = await call(e.target.dataset.setting, e.target.checked); pluginError = ''; render(); } } catch (err) { showError(err); } });
window.addEventListener('keydown', e => {
  if (isPluginMenu && e.key === 'Escape') { e.preventDefault(); call('plugin-menu-close').catch(showError); return; }
  if (document.querySelector('dialog[open]')) return;
  const modal = app.querySelector('.overlay [role="dialog"]');
  if (modal && e.key === 'Escape') {
    e.preventDefault();
    if (updateDialog) { if (!updateState || updateState.phase !== 'installing') handle('update-close').catch(showError); return; }
    if (!githubLoading) handle(githubDialog ? 'github-cancel' : 'cancel').catch(showError);
    return;
  }
  if (modal && e.key === 'Tab') { const controls = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled)')]; if (!controls.length) { e.preventDefault(); return; } const first = controls[0], last = controls[controls.length - 1]; if (e.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { e.preventDefault(); first.focus(); } return; }
  if (e.key === 'Escape' && isPanel) call('hide').catch(showError);
});
window.toolbox.onUpdate(s => { state = s; if (s.appUpdate) updateState = s.appUpdate; render(); });
window.toolbox.onNavigate(next => {
  if (next === 'update') { updateDialog = true; render(); return; }
  page = next; selected = [...state.panel]; render();
});
window.toolbox.onNotice(message => showError(new Error(message)));
if (window.toolbox.onAppUpdate) {
  window.toolbox.onAppUpdate(info => {
    const prevPhase = updateState ? updateState.phase : 'idle';
    updateState = info;
    if (info.phase === 'downloading' && prevPhase === 'downloading' && document.getElementById('update-progress')) {
      updateDownloadDom(info);
      return;
    }
    render();
  });
}
call(isPlugin || isPluginMenu ? 'plugin-state' : 'state').then(s => { state = s; if (s.appUpdate) updateState = s.appUpdate; render(); }).catch(err => { app.textContent = '界面加载失败，请重启轻匣后重试。'; if (!isPlugin && !isPluginMenu) showError(err); });

}
