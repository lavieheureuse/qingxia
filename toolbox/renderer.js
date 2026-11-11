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
let state, page = 'home', query = '', selected = [], candidate = null, githubDialog = false, githubInput = '', githubLoading = false, githubAdding = false, githubCandidates = [], githubSelected = [], githubError = '', pluginError = '';
const call = (action, value) => window.toolbox.call(action, value);
const escapeHtml = x => String(x || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = p => p.icon ? `<img src="${escapeHtml(p.icon)}" alt="">` : '<span class="fallback">工</span>';
function showDialog({ title, message, confirmText = '知道了', cancelText, danger = false }) {
  return new Promise(resolve => {
    const previous = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'app-dialog';
    dialog.setAttribute('aria-labelledby', 'message-title');
    dialog.setAttribute('aria-describedby', 'message-description');
    dialog.innerHTML = `<div class="dialog-heading"><span class="dialog-eyebrow">轻匣</span><h2 id="message-title">${escapeHtml(title)}</h2></div><p id="message-description" class="dialog-description">${escapeHtml(message)}</p><div class="dialog-actions">${cancelText ? `<button type="button" class="dialog-cancel">${escapeHtml(cancelText)}</button>` : ''}<button type="button" class="dialog-confirm ${danger ? 'danger' : 'primary'}">${escapeHtml(confirmText)}</button></div>`;
    dialog.addEventListener('close', () => { const accepted = dialog.returnValue === 'confirm'; dialog.remove(); if (previous && previous.isConnected) previous.focus(); resolve(accepted); }, { once: true });
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
function render() {
  if (!state) return;
  if (isPlugin) { app.innerHTML = `<header class="plugin-bar"><strong>${escapeHtml(state.name)}</strong><button class="plugin-menu-button" data-action="plugin-menu" aria-label="插件设置" title="插件设置">☰</button></header>`; return; }
  if (isPluginMenu) { app.innerHTML = `<div class="plugin-menu">${pluginError ? `<div class="plugin-menu-error" role="alert">${escapeHtml(pluginError)}</div>` : ''}<label class="plugin-menu-item"><input type="checkbox" data-setting="plugin-independent" ${state.independent ? 'checked' : ''}><span><strong>独立窗口</strong><small>点击外部时保持窗口</small></span></label><label class="plugin-menu-item"><input type="checkbox" data-setting="plugin-background" ${state.background ? 'checked' : ''}><span><strong>后台运行</strong><small>关闭插件页面后继续运行</small></span></label><label class="plugin-menu-item"><input type="checkbox" data-setting="plugin-startup" ${state.pluginStartup ? 'checked' : ''}><span><strong>随轻匣启动</strong><small>轻匣启动时自动运行此插件</small></span></label></div>`; return; }
  const list = state.plugins;
  if (isPanel) {
    app.innerHTML = `<main class="popup"><header><strong>超级面板</strong><button data-action="hide" aria-label="关闭">×</button></header><div class="grid">${state.panel.map(id => list.find(p => p.dir === id)).filter(Boolean).map(p => `<button class="tile" data-action="open" data-id="${escapeHtml(p.dir)}">${icon(p)}<span>${escapeHtml(p.name)}</span></button>`).join('')}<button class="tile plus" data-action="manage"><b>＋</b><span>管理面板</span></button></div></main>`; return;
  }
  const header = `<header class="bar"><strong class="brand"><img src="${escapeHtml(state.appIcon)}" alt="">轻匣</strong><div><button data-action="home">我的工具</button><button data-action="panel-page">超级面板</button><button data-action="settings">设置</button></div></header>`;
  let content = '';
  if (page === 'home') content = `<h1>工具箱</h1><input id="search" class="search" placeholder="搜索工具" value="${escapeHtml(query)}"><div class="list">${list.filter(p => (p.name + p.description).toLowerCase().includes(query.toLowerCase())).map(p => `<div class="row">${icon(p)}<div class="info"><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.description)}</small></div><button class="subtle" data-action="remove" data-id="${escapeHtml(p.dir)}">移除</button><button class="primary" data-action="open" data-id="${escapeHtml(p.dir)}">打开</button></div>`).join('')}</div><button class="add" data-action="pick">＋　添加工具</button><button class="subtle" data-action="github">GitHub 导入</button>`;
  if (page === 'panel') content = `<h1>超级面板</h1><p class="muted">选择要在超级面板显示的工具，使用上下按钮调整顺序。</p><div class="list">${[...selected.map(id => list.find(p => p.dir === id)).filter(Boolean), ...list.filter(p => !selected.includes(p.dir))].map(p => `<div class="row"><input type="checkbox" aria-label="加入超级面板" data-check="${escapeHtml(p.dir)}" ${selected.includes(p.dir) ? 'checked' : ''}>${icon(p)}<div class="info"><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.description)}</small></div><button data-action="up" data-id="${escapeHtml(p.dir)}">↑</button><button data-action="down" data-id="${escapeHtml(p.dir)}">↓</button></div>`).join('')}</div><button class="primary" data-action="save-panel">完成</button>`;
  if (page === 'settings') content = `<h1>设置</h1><div class="setting"><div><strong>鼠标中键呼出超级面板</strong><small>中键可能与其他软件的操作冲突。</small></div><input type="checkbox" data-setting="middle" ${state.middle ? 'checked' : ''}></div><div class="setting"><div><strong>开机自动启动</strong><small>系统启动时自动运行工具箱。</small></div><input type="checkbox" data-setting="autostart" ${state.autoStart ? 'checked' : ''}></div><div class="setting"><div><strong>插件目录</strong><small>${escapeHtml(state.folder)}</small><small>更改时会迁移已添加的插件，旧插件文件将移入回收站。</small></div><div class="setting-actions"><button data-action="folder">查看文件夹</button><button data-action="change-folder">更改目录</button></div></div><p class="muted">版本 ${escapeHtml(state.version)}</p>`;
  const hadModal = !!app.querySelector('.overlay');
  let modal = candidate ? `<div class="overlay"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="candidate-title"><div class="dialog-heading"><span class="dialog-eyebrow">工具管理</span><h2 id="candidate-title">添加工具</h2></div><p class="dialog-description">确认插件信息后即可添加到工具箱。</p><div class="plugin-preview">${icon(candidate)}<div class="info"><strong>${escapeHtml(candidate.name)}</strong><small>${escapeHtml(candidate.description)}</small></div></div><p class="dialog-hint">请只添加信任的插件，插件可能访问本地文件和网络。</p><div class="dialog-actions"><button data-action="cancel">取消</button><button class="primary" data-action="add-confirm">添加工具</button></div></section></div>` : '';
  if (githubDialog) modal = `<div class="overlay"><section class="dialog github-dialog" role="dialog" aria-modal="true" aria-labelledby="github-title"><div class="dialog-heading"><span class="dialog-eyebrow">工具管理</span><h2 id="github-title">从 GitHub 添加工具</h2></div><p class="dialog-description">输入公开仓库首页链接，下载后选择插件。</p><label class="dialog-label" for="github-url">仓库链接</label><input id="github-url" class="search" placeholder="https://github.com/用户名/仓库名" value="${escapeHtml(githubInput)}" ${githubError ? 'aria-invalid="true" aria-describedby="github-error"' : ''} ${githubLoading ? 'disabled' : ''}>${githubError ? `<p id="github-error" class="dialog-error" role="alert">${escapeHtml(githubError)}</p>` : ''}<p class="dialog-hint">请只添加信任的插件，插件可能访问本地文件和网络。</p>${githubCandidates.length ? `<p class="github-selection-hint">请选择要添加的插件，可多选</p><div class="github-results">${githubCandidates.map((p, i) => `<label class="github-result"><input type="checkbox" data-github-index="${i}" ${githubSelected.includes(i) ? 'checked' : ''}>${icon(p)}<span><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.description)}</small></span></label>`).join('')}</div>` : ''}<div class="dialog-actions"><button data-action="github-cancel" ${githubLoading ? 'disabled' : ''}>取消</button><button data-action="github-load" ${githubLoading ? 'disabled' : ''}>${githubLoading && !githubAdding ? '正在下载…' : githubCandidates.length ? '重新查找' : '查找插件'}</button>${githubCandidates.length ? `<button class="primary" data-action="github-add" ${githubSelected.length && !githubLoading ? '' : 'disabled'}>${githubAdding ? '正在添加…' : '添加所选（' + githubSelected.length + '）'}</button>` : ''}</div></section></div>`;
  app.innerHTML = `${header}<main class="content">${content}</main><footer>轻匣　v${escapeHtml(state.version)}</footer>${modal}`;
  if (modal && !hadModal) { const target = app.querySelector('#github-url') || app.querySelector('[data-action="cancel"]'); if (target) target.focus(); }
}
async function handle(action, id) {
  if (action === 'home') page = 'home';
  if (action === 'settings') page = 'settings';
  if (action === 'panel-page' || action === 'manage') { page = 'panel'; selected = [...state.panel]; if (isPanel) { await call('manage'); return; } }
  if (action === 'open') await call('open', id);
  if (action === 'hide') await call('hide');
  if (action === 'plugin-menu') await call('plugin-menu');
  if (action === 'pick') candidate = await call('pick');
  if (action === 'github') { githubDialog = true; githubCandidates = []; githubSelected = []; githubInput = ''; githubError = ''; }
  if (action === 'github-cancel') { githubDialog = false; githubCandidates = []; githubSelected = []; githubError = ''; await call('github-clear'); }
  if (action === 'github-load') { githubInput = document.getElementById('github-url').value.trim(); githubLoading = true; githubCandidates = []; githubSelected = []; githubError = ''; render(); try { await call('github-clear'); githubCandidates = await call('github', githubInput); } finally { githubLoading = false; render(); } }
  if (action === 'github-add') { if (!githubSelected.length) return; githubLoading = true; githubAdding = true; render(); try { state = await call('add-many', githubSelected.map(i => githubCandidates[i].dir)); githubDialog = false; githubCandidates = []; githubSelected = []; } finally { githubLoading = false; githubAdding = false; } }
  if (action === 'cancel') { candidate = null; await call('github-clear'); }
  if (action === 'add-confirm') { state = await call('add', candidate.dir); candidate = null; }
  if (action === 'remove') { const plugin = state.plugins.find(item => item.dir === id); if (!await showDialog({ title: '移除工具？', message: `确定从工具箱移除“${plugin ? plugin.name : '该工具'}”？插件文件和数据会保留。`, confirmText: '移除工具', cancelText: '取消', danger: true })) return; state = await call('remove', id); }
  if (action === 'save-panel') { state = await call('panel', selected); page = 'home'; }
  if (action === 'folder') await call('folder');
  if (action === 'change-folder') { state = await call('change-folder'); if (state.warning) void showDialog({ title: '迁移完成，清理未完成', message: state.warning }); }
  if (action === 'up' || action === 'down') { const i = selected.indexOf(id); const j = i + (action === 'up' ? -1 : 1); if (i >= 0 && j >= 0 && j < selected.length) [selected[i], selected[j]] = [selected[j], selected[i]]; }
  render();
}
app.addEventListener('click', e => { const b = e.target.closest('[data-action]'); if (b) handle(b.dataset.action, b.dataset.id).catch(showError); });
app.addEventListener('input', e => { if (e.target.id === 'github-url') { githubInput = e.target.value; if (githubError) { githubError = ''; e.target.removeAttribute('aria-invalid'); e.target.removeAttribute('aria-describedby'); const error = document.getElementById('github-error'); if (error) error.remove(); } } if (e.target.id === 'search') { query = e.target.value; const pos = e.target.selectionStart; render(); const input = document.getElementById('search'); input.focus(); input.setSelectionRange(pos, pos); } });
app.addEventListener('change', async e => { try { if (e.target.dataset.githubIndex !== undefined) { const i = Number(e.target.dataset.githubIndex); githubSelected = e.target.checked ? [...githubSelected, i] : githubSelected.filter(x => x !== i); const button = app.querySelector('[data-action=github-add]'); if (button) { button.disabled = !githubSelected.length; button.textContent = '添加所选（' + githubSelected.length + '）'; } } else if (e.target.dataset.check) { const id = e.target.dataset.check; selected = e.target.checked ? [...selected, id] : selected.filter(x => x !== id); render(); } else if (e.target.dataset.setting) { state = await call(e.target.dataset.setting, e.target.checked); pluginError = ''; render(); } } catch (err) { showError(err); } });
window.addEventListener('keydown', e => {
  if (isPluginMenu && e.key === 'Escape') { e.preventDefault(); call('plugin-menu-close').catch(showError); return; }
  if (document.querySelector('dialog[open]')) return;
  const modal = app.querySelector('.overlay [role="dialog"]');
  if (modal && e.key === 'Escape') { e.preventDefault(); if (!githubLoading) handle(githubDialog ? 'github-cancel' : 'cancel').catch(showError); return; }
  if (modal && e.key === 'Tab') { const controls = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled)')]; if (!controls.length) { e.preventDefault(); return; } const first = controls[0], last = controls[controls.length - 1]; if (e.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { e.preventDefault(); first.focus(); } return; }
  if (e.key === 'Escape' && isPanel) call('hide').catch(showError);
});
window.toolbox.onUpdate(s => { state = s; render(); });
window.toolbox.onNavigate(next => { page = next; selected = [...state.panel]; render(); });
window.toolbox.onNotice(message => showError(new Error(message)));
call(isPlugin || isPluginMenu ? 'plugin-state' : 'state').then(s => { state = s; render(); }).catch(err => { app.textContent = '界面加载失败，请重启轻匣后重试。'; if (!isPlugin && !isPluginMenu) showError(err); });

}
