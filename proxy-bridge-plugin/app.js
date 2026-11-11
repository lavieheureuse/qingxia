'use strict';
const $ = selector => document.querySelector(selector);
const api = window.applicationProxy;
let data = {servers:[],rules:[],defaultServer:''};
let running = false;
let editingServer = null;
let editingRule = null;
let busy = false;
const text = value => { const element = document.createElement('span'); element.textContent = value; return element.innerHTML; };
const serverName = id => { const server = data.servers.find(item => item.id === id); return server ? `${server.name} · ${server.type.toUpperCase()} ${server.host}:${server.port}` : '未选择'; };
function message(value, ok = false) { const dialog=document.querySelector('dialog[open]'); const box=dialog ? dialog.querySelector('.dialog-message') : $('#notice'); box.textContent=value; box.className=ok?'notice ok':'notice'; box.hidden=!value; }
function selectPage(name) { document.querySelectorAll('.page').forEach(page => { page.hidden = page.id !== name; }); document.querySelectorAll('.nav').forEach(button => button.classList.toggle('active', button.dataset.page === name)); }
function options(selected) { return '<option value="">请选择代理服务器</option>' + data.servers.map(s => `<option value="${text(s.id)}" ${s.id === selected ? 'selected' : ''}>${text(serverName(s.id))}</option>`).join(''); }
function render() {
  $('#status-title').textContent = running ? '代理进程运行中' : '代理已停止';
  $('#status-detail').textContent = running ? '代理进程已启动，请验证代理连接。' : '尚未启动应用代理';
  $('#toggle').textContent = running ? '停止代理' : '启动代理';
  $('#toggle').disabled = busy;
  $('#auto-start').checked = data.autoStart === true;
  $('#auto-start').disabled = busy;
  $('#default-server').innerHTML = options(data.defaultServer);
  $('#default-server').disabled = running;
  $('#add-rule').disabled = running; $('#rules-add').disabled = running; $('#add-server').disabled = running;
  $('#rules-empty').hidden = data.rules.length > 0;
  const label = {PROXY:'使用代理',DIRECT:'直接连接',BLOCK:'阻止连接'};
  $('#rules-list').innerHTML = data.rules.map(r => `<tr><td><input type="checkbox" aria-label="启用 ${text(r.process)}" data-enable-rule="${text(r.id)}" ${r.enabled?'checked':''} ${running?'disabled':''}></td><td>${text(r.process)}</td><td>${label[r.action]}</td><td>${r.action === 'PROXY' ? text(serverName(r.server)) : '—'}</td><td><button data-edit-rule="${text(r.id)}" ${running?'disabled':''}>编辑</button><button data-delete-rule="${text(r.id)}" ${running?'disabled':''}>删除</button></td></tr>`).join('');
  $('#rules-full').innerHTML = data.rules.length ? data.rules.map(r => `<div class="rule-row"><div><strong>${text(r.process)}</strong><p>${label[r.action]} · ${r.enabled?'已启用':'已停用'}${r.action === 'PROXY' ? ' · '+text(serverName(r.server)) : ''}</p></div><button class="link" data-edit-rule="${text(r.id)}" ${running?'disabled':''}>编辑</button><button class="link" data-delete-rule="${text(r.id)}" ${running?'disabled':''}>删除</button></div>`).join('') : '<p class="empty">还没有应用规则。</p>';
  $('#servers-list').innerHTML = data.servers.map(s => `<div class="server-row"><div><strong>${text(s.name)}</strong><p>${text(s.type.toUpperCase())} · ${text(s.host)}:${text(s.port)}</p></div><button class="link" data-edit-server="${text(s.id)}" ${running?'disabled':''}>编辑</button><button class="link" data-delete-server="${text(s.id)}" ${running?'disabled':''}>删除</button></div>`).join('');
  $('#servers-list').hidden = data.servers.length === 0; $('#servers-empty').hidden = data.servers.length !== 0;
}
async function save(next) { await api.save(next); data = next; render(); }
function copyData() { return JSON.parse(JSON.stringify(data)); }
function confirmDelete(description) { return new Promise(resolve=>{const dialog=$('#confirm-dialog'); $('#confirm-text').textContent=description; dialog.returnValue=''; dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true}); dialog.showModal();}); }
function serverDialog(id) { editingServer = id || null; const s = data.servers.find(x=>x.id===id) || {name:'',host:'',port:'',type:'socks5',username:'',password:''}; const f = $('#server-form'); f.reset(); for (const key of ['name','host','port','type','username','password']) f.elements[key].value = s[key] || ''; $('#server-heading').textContent = id ? '编辑代理服务器' : '添加代理服务器'; $('#server-dialog').showModal(); }
function ruleDialog(id) { editingRule = id || null; const r = data.rules.find(x=>x.id===id) || {process:'',action:'PROXY',server:data.defaultServer,hosts:'*',ports:'*',protocol:'BOTH',enabled:true}; const f = $('#rule-form'); f.reset(); f.elements.server.innerHTML = options(r.server); for (const key of ['process','action','server','hosts','ports','protocol']) f.elements[key].value = r[key] || ''; $('#rule-heading').textContent = id ? '编辑应用规则' : '添加应用规则'; $('#rule-dialog').showModal(); }
document.addEventListener('click', async event => {
  const b = event.target.closest('button'); if (!b) return;
  try {
    if (b.dataset.page || b.dataset.open) selectPage(b.dataset.page || b.dataset.open);
    if (b.classList.contains('cancel')) b.closest('dialog').close();
    if (b.id === 'add-server') serverDialog();
    if (b.id === 'add-rule' || b.id === 'rules-add') ruleDialog();
    if (b.dataset.editServer) serverDialog(b.dataset.editServer);
    if (b.dataset.editRule) ruleDialog(b.dataset.editRule);
    if (b.dataset.deleteServer) { const id=b.dataset.deleteServer; if (data.rules.some(r=>r.server===id && r.action==='PROXY')) throw new Error('该服务器仍被规则使用，请先修改相关规则'); if (!(await confirmDelete('确定删除此代理服务器？'))) return; const next=copyData(); next.servers=next.servers.filter(s=>s.id!==id); if (next.defaultServer===id) next.defaultServer=next.servers[0]?.id || ''; await save(next); }
    if (b.dataset.deleteRule) { const id=b.dataset.deleteRule; if (!(await confirmDelete('确定删除此规则？'))) return; const next=copyData(); next.rules=next.rules.filter(r=>r.id!==id); await save(next); }
    if (b.id === 'browse') { const chosen=await api.pick(); if(chosen) $('#rule-form').elements.process.value=chosen; }
    if (b.id === 'toggle') { busy=true; render(); message(running?'正在停止代理…':'正在启动代理，请允许管理员授权…',true); try { const result=running ? await api.stop() : await api.start(); running=result.running; message(running ? '核心进程已启动，请验证应用流量。' : '代理已停止。',true); } finally { busy=false; render(); } }
  } catch(e) { message(e.message || String(e)); }
});
$('#default-server').addEventListener('change',async e=>{try {const next=copyData(); next.defaultServer=e.target.value; await save(next);} catch(error){message(error.message);render();}});
$('#auto-start').addEventListener('change',async e=>{busy=true; const enabled=e.target.checked; render(); try {await api.setAutoStart(enabled); data.autoStart=enabled; message(enabled?'已开启，插件下次启动时会尝试启动代理。':'已关闭自动启动。',true);} catch(error){message(error.message);} finally {busy=false;render();}});
$('#rules-list').addEventListener('change',async e=>{if(!e.target.dataset.enableRule)return; try {const next=copyData(); const rule=next.rules.find(r=>r.id===e.target.dataset.enableRule); rule.enabled=e.target.checked; await save(next);} catch(error){message(error.message);render();}});
$('#server-form').addEventListener('submit',async e=>{e.preventDefault(); try {const f=e.currentTarget.elements; const server={id:editingServer||crypto.randomUUID(),name:f.name.value.trim(),type:f.type.value,host:f.host.value.trim()||'127.0.0.1',port:f.port.value,username:f.username.value,password:f.password.value}; const next=copyData(); if(editingServer) next.servers=next.servers.map(s=>s.id===editingServer?server:s); else next.servers.push(server); if(!next.defaultServer)next.defaultServer=server.id; await save(next); $('#server-dialog').close(); message('代理服务器已保存。',true);} catch(error){message(error.message);}});
$('#rule-form').addEventListener('submit',async e=>{e.preventDefault(); try {const f=e.currentTarget.elements; const previous=data.rules.find(r=>r.id===editingRule); const rule={id:editingRule||crypto.randomUUID(),process:f.process.value.trim(),action:f.action.value,server:f.server.value,hosts:f.hosts.value.trim()||'*',ports:f.ports.value.trim()||'*',protocol:f.protocol.value,enabled:previous ? previous.enabled : true}; const next=copyData(); if(editingRule)next.rules=next.rules.map(r=>r.id===editingRule?rule:r); else next.rules.push(rule); await save(next); $('#rule-dialog').close(); message('应用规则已保存。',true);} catch(error){message(error.message);}});
document.querySelectorAll('dialog form').forEach(form=>{const el=document.createElement('p'); el.className='notice dialog-message'; el.setAttribute('role','status'); el.hidden=true; form.insertBefore(el,form.querySelector('.dialog-actions'));});
(async()=>{try { if(!api)throw new Error('请在轻匣中打开插件'); data=await api.config(); running=(await api.status()).running; render(); if(data.autoStart && !running){busy=true;render();message('正在自动启动代理，请允许管理员授权…',true);try{running=(await api.start()).running;message('代理已自动启动，请验证代理连接。',true);}catch(error){message('自动启动失败：'+error.message);}finally{busy=false;render();}} if(!api.supportsExit) message('当前轻匣版本不支持自动清理后台进程；关闭插件或退出轻匣前，请先手动停止代理。'); setInterval(async()=>{if(busy)return;try{const state=await api.status();if(state.running!==running){running=state.running;render();message(running?'代理进程运行中。':'代理进程已停止。');}}catch(e){message('无法确认代理状态：'+e.message);}},5000); } catch(e){message(e.message||String(e));render();$('#toggle').disabled=true;} })();
