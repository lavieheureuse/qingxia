'use strict';
let entries = [];
let editing = null, selected = null, shown = new Set(), group = '';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function toast(message) { const node = $('#toast'); node.textContent = message; node.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 2200); }
function askConfirm(title, subtitle, description, action, danger = false, notice = false) {
  const dialog = $('#confirm-dialog'); $('#confirm-title').textContent = title; $('#confirm-subtitle').textContent = subtitle; $('#confirm-description').textContent = description;
  const accept = $('#confirm-accept'); accept.textContent = action; accept.classList.toggle('danger-confirm', danger); $('#confirm-cancel').hidden = notice;
  return new Promise(resolve => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), {once:true});
    dialog.showModal(); (notice ? accept : $('#confirm-cancel')).focus();
  });
}
$('#confirm-close').onclick = $('#confirm-cancel').onclick = () => $('#confirm-dialog').close('cancel');
$('#confirm-accept').onclick = () => $('#confirm-dialog').close('confirm');
function render() {
  const groups = [...new Set(entries.map(x => x.group).filter(Boolean))].sort();
  if (group && !groups.includes(group)) group = '';
  $('#group-label').textContent = group || '全部分组';
  $('#group-options').innerHTML = ['', ...groups].map(x => `<button type="button" data-group="${esc(x)}" class="${x === group ? 'active' : ''}" aria-pressed="${x === group}">${esc(x || '全部分组')}</button>`).join('');
  const query = $('#search').value.trim().toLowerCase();
  const list = entries.filter(x => (!group || x.group === group) && [x.name,x.account,x.group,x.application,x.note].some(v => String(v || '').toLowerCase().includes(query)));
  $('#rows').innerHTML = list.map((x, i) => `<tr class="${selected === x.id ? 'selected' : ''}"><td><span class="index">${i+1}</span></td><td><div class="name">${esc(x.name)}</div><div class="account"><span class="account-value" title="${esc(x.account || '未填写')}">账号：${esc(x.account || '未填写')}</span>${x.account ? `<button class="account-copy" data-action="copy-account" data-id="${x.id}" aria-label="复制账号">复制</button>` : ''}</div></td><td><span class="secret">${shown.has(x.id) ? esc(x.password) : '••••••••••••'}</span><button class="copy" data-action="copy" data-id="${x.id}">复制密码</button></td><td>${x.group ? `<span class="tag">${esc(x.group)}</span>` : '—'}</td><td><div class="actions"><button data-action="show" data-id="${x.id}">${shown.has(x.id) ? '隐藏' : '查看'}</button><button data-action="edit" data-id="${x.id}">编辑</button><button data-action="favorite" data-id="${x.id}">${x.favorite ? '已收藏' : '收藏'}</button><button class="danger" data-action="delete" data-id="${x.id}">删除</button></div></td></tr>`).join('');
  $('#empty').hidden = list.length > 0;
  $('#empty-title').textContent = entries.length ? '没有找到匹配的密码' : '还没有保存密码';
  $('#empty-description').textContent = entries.length ? '试试其他关键词或切换分组。' : '添加账号信息，让常用密码更容易找到。';
  $('#empty-add').hidden = entries.length > 0;
}
function openEditor(entry) {
  editing = entry?.id ?? null; $('#form').reset(); $('#form-title').textContent = entry ? '编辑密码' : '添加密码';
  $('#form-error').textContent = '';
  for (const key of ['name','account','password','group','application','note']) $('#form').elements[key].value = entry?.[key] || '';
  $('#form').elements.favorite.checked = !!entry?.favorite; $('#form').elements.password.type = 'password'; $('#toggle-password').textContent = '显示'; setEditGroupsOpen(false); $('#editor').showModal();
}
function setEditGroupsOpen(open) {
  const groups = [...new Set(entries.map(x => x.group).filter(Boolean))].sort();
  $('#edit-group-options').innerHTML = groups.length ? groups.map(x => `<button type="button" data-value="${esc(x)}">${esc(x)}</button>`).join('') : '<span class="group-empty">暂无分组，可直接输入新名称</span>';
  $('#edit-group-options').hidden = !open; $('#edit-group-toggle').setAttribute('aria-expanded', String(open));
}
$('#edit-group-toggle').onclick = () => setEditGroupsOpen($('#edit-group-options').hidden);
$('#edit-group-options').onclick = event => { const button = event.target.closest('[data-value]'); if (!button) return; $('#edit-group-input').value = button.dataset.value; setEditGroupsOpen(false); $('#edit-group-input').focus(); };
document.addEventListener('click', event => { if (!event.target.closest('.edit-group')) setEditGroupsOpen(false); });
$('.edit-group').addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#edit-group-options').hidden) { event.preventDefault(); event.stopPropagation(); setEditGroupsOpen(false); $('#edit-group-toggle').focus(); } });
$('#add').onclick = $('#empty-add').onclick = () => openEditor();
$('#close').onclick = $('#cancel').onclick = () => $('#editor').close();
$('#search').oninput = render;
function setGroupOpen(open) { $('#group-options').hidden = !open; $('#group-toggle').setAttribute('aria-expanded', String(open)); }
$('#group-toggle').onclick = () => setGroupOpen($('#group-options').hidden);
$('#group-options').onclick = event => { const button = event.target.closest('[data-group]'); if (!button) return; group = button.dataset.group; setGroupOpen(false); render(); $('#group-toggle').focus(); };
document.addEventListener('click', event => { if (!$('#group').contains(event.target)) setGroupOpen(false); });
$('#group').addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#group-options').hidden) { event.preventDefault(); setGroupOpen(false); $('#group-toggle').focus(); } });
$('#about').onclick = () => toast('密码数据加密保存在本机。');
$('#export').onclick = () => { $('#export-count').textContent = `将导出 ${entries.length} 条密码记录`; $('#export-dialog').showModal(); };
$('#export-close').onclick = $('#export-cancel').onclick = () => $('#export-dialog').close();
$('#export-confirm').onclick = async () => {
  $('#export-dialog').close();
  try { const name = await window.passwordBox.exportJson(entries); if (name) toast(`已导出：${name}`); }
  catch (error) { askConfirm('导出失败', '操作未完成', error.message, '知道了', false, true); }
};
$('#import').onclick = async () => {
  try {
    const imported = await window.passwordBox.importJson(); if (!imported) return;
    if (!imported.length) { toast('文件中没有密码记录'); return; }
    if (!await askConfirm('导入密码', '从 JSON 文件添加密码记录', `将导入 ${imported.length} 条记录，现有记录会保留。`, '确认导入')) return;
    let nextId = entries.reduce((max, x) => Math.max(max, Number(x.id) || 0), Date.now());
    const next = [...imported.map(x => ({...x,id:++nextId})), ...entries];
    window.passwordBox.save(next); entries = next; render(); toast(`已导入 ${imported.length} 条记录`);
  } catch (error) { askConfirm('导入失败', '操作未完成', error.message, '知道了', false, true); }
};
$('#toggle-password').onclick = () => { const input = $('#form').elements.password; input.type = input.type === 'password' ? 'text' : 'password'; $('#toggle-password').textContent = input.type === 'password' ? '显示' : '隐藏'; };
$('#generate').onclick = () => { const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%'; const values = new Uint32Array(16); crypto.getRandomValues(values); $('#form').elements.password.value = Array.from(values, x => chars[x % chars.length]).join(''); };
$('#form').noValidate = true;
$('#form').onsubmit = event => { event.preventDefault(); const form = event.currentTarget; const name = form.elements.name.value.trim(); if (!name || !form.elements.password.value) { $('#form-error').textContent = !name ? '请输入名称' : '请输入密码'; (!name ? form.elements.name : form.elements.password).focus(); return; } const entry = {id:editing ?? Date.now(),name,account:form.elements.account.value.trim(),password:form.elements.password.value,group:form.elements.group.value.trim(),application:form.elements.application.value.trim(),note:form.elements.note.value.trim(),favorite:form.elements.favorite.checked}; const next = editing === null ? [entry,...entries] : entries.map(x => x.id === editing ? entry : x); try { window.passwordBox.save(next); } catch (error) { askConfirm('保存失败', '请检查后重试', error.message, '知道了', false, true); return; } entries = next; selected = entry.id; shown.delete(entry.id); $('#editor').close(); render(); toast('已保存'); };
$('#form').addEventListener('input', () => { $('#form-error').textContent = ''; });
$('#rows').onclick = async event => {
  const button = event.target.closest('button[data-action]'); if (!button) return;
  const id = Number(button.dataset.id); const entry = entries.find(x => x.id === id); if (!entry) return;
  selected = id; const action = button.dataset.action;
  if (action === 'edit') return openEditor(entry);
  if (action === 'show') shown.has(id) ? shown.delete(id) : shown.add(id);
  if (action === 'delete' && !await askConfirm('删除密码', '请确认要删除的记录', `确定删除“${entry.name}”？删除后无法恢复。`, '删除', true)) return;
  if (action === 'favorite' || action === 'delete') {
    const next = action === 'delete' ? entries.filter(x => x.id !== id) : entries.map(x => x.id === id ? {...x, favorite: !x.favorite} : x);
    try { window.passwordBox.save(next); entries = next; if (action === 'delete') shown.delete(id); } catch (error) { askConfirm('操作失败', '请检查后重试', error.message, '知道了', false, true); }
  }
  if (action === 'copy' || action === 'copy-account') { try { window.passwordBox.copy(action === 'copy' ? entry.password : entry.account); toast(action === 'copy' ? '密码已复制' : '账号已复制'); } catch (_) { toast('复制失败'); } }
  render();
};
try {
  if (!window.passwordBox) throw new Error('请通过个人工具箱打开密码盒插件。');
  const mode = window.passwordBox.mode();
  const exists = mode !== 'new';
  if (mode === 'windows') { entries = window.passwordBox.unlock(); render(); }
  else {
  $('#unlock-title').textContent = exists ? '解锁密码盒' : '创建密码盒';
  $('#unlock-hint').textContent = exists ? '请输入主密码，访问保存在本机的密码。' : '主密码可选；不设置时使用 Windows 账户保护本机数据。';
  $('#confirm-label').hidden = exists;
  $('#skip-password').hidden = exists;
  $('#unlock-button').textContent = exists ? '解锁' : '创建';
  $('#skip-password').onclick = () => { try { entries = window.passwordBox.createWithoutPassword(); $('#unlock').close(); render(); } catch (error) { $('#unlock-error').textContent = error.message; } };
  $('#unlock-form').noValidate = true;
  $('#unlock-form').onsubmit = event => {
    event.preventDefault(); const form = event.currentTarget; const password = form.elements.master.value;
    if (password.length < 8) { $('#unlock-error').textContent = '主密码至少需要 8 个字符'; form.elements.master.focus(); return; }
    if (!exists && password !== form.elements.confirmation.value) { $('#unlock-error').textContent = '两次输入的主密码不一致'; return; }
    try { entries = window.passwordBox.unlock(password); form.reset(); $('#unlock').close(); render(); }
    catch (error) { $('#unlock-error').textContent = error.message; }
  };
  $('#unlock').addEventListener('cancel', event => event.preventDefault());
  $('#unlock').showModal();
  }
} catch (error) { document.body.textContent = error.message; }
