'use strict';
(() => {
  const api = window.hostsEditor;
  const names = {current:'当前文件',dev:'开发环境',test:'测试环境',prod:'生产环境'};
  const content = document.getElementById('content');
  const title = document.getElementById('title');
  const hint = document.getElementById('hint');
  const status = document.getElementById('status');
  const dirty = document.getElementById('dirty');
  const save = document.getElementById('save');
  const apply = document.getElementById('apply');
  const refresh = document.getElementById('refresh');
  let view = 'current', saved = '', snapshot = null, environments = null;
  function message(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
  function changed() { return content.value !== saved; }
  function updateDirty() { dirty.textContent = changed() ? '有未保存的修改' : ''; }
  function load(next) {
    if (changed() && !confirm('当前内容尚未保存，切换后修改将丢失。继续吗？')) return;
    try {
      if (next === 'current') snapshot = api.readHosts();
      else environments = api.config();
      view = next;
      content.value = next === 'current' ? snapshot.text.replace(/^\ufeff/, '') : environments[next];
      saved = content.value;
      title.textContent = names[next];
      hint.textContent = next === 'current' ? '查看和编辑系统 Hosts。请将公共配置写在环境标记之外；标记内的内容会在切换环境时替换。' : '编辑此环境的配置；应用时会替换当前环境区段，保留公共配置。';
      save.textContent = next === 'current' ? '保存当前文件' : '保存配置';
      save.classList.toggle('primary', next === 'current');
      refresh.hidden = next !== 'current'; apply.hidden = next === 'current';
      document.querySelectorAll('nav button').forEach(button => { button.classList.toggle('selected', button.dataset.view === next); button.setAttribute('aria-current', button.dataset.view === next ? 'page' : 'false'); });
      message(''); updateDirty();
    } catch (error) { message(error.message, true); }
  }
  document.querySelectorAll('nav button').forEach(button => button.addEventListener('click', () => { if (button.dataset.view !== view) load(button.dataset.view); }));
  content.addEventListener('input', updateDirty);
  refresh.addEventListener('click', () => load('current'));
  save.addEventListener('click', () => {
    try {
      if (view === 'current') {
        const bom = snapshot.text.startsWith('\ufeff') ? '\ufeff' : '';
        const eol = snapshot.text.includes('\r\n') ? '\r\n' : '\n';
        snapshot = api.saveCurrent(bom + content.value.replace(/\n/g, eol), snapshot.hash);
      } else api.saveConfig(view, content.value);
      saved = content.value; updateDirty(); message('保存成功');
    } catch (error) { message(error.message, true); }
  });
  apply.addEventListener('click', () => {
    try {
      if (!snapshot) throw new Error('无法读取系统 Hosts，请先检查当前文件');
      api.saveConfig(view, content.value);
      saved = content.value; updateDirty();
      snapshot = api.apply(view, content.value, snapshot.hash);
      message('环境配置已应用，公共配置已保留');
    } catch (error) { message(error.message, true); }
  });
  window.addEventListener('beforeunload', event => { if (changed()) { event.preventDefault(); event.returnValue = ''; } });
  content.value = ''; saved = ''; load('current');
})();
