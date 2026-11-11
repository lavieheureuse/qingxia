'use strict';
(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const { execFile, spawn } = require('node:child_process');
  const { promisify } = require('node:util');
  const exec = promisify(execFile);
  const host = typeof utools !== 'undefined' ? utools : window.utools;
  const dir = path.join(host.getPath('userData'), 'application-proxy');
  const configFile = path.join(dir, 'config.json');
  const profileFile = path.join(dir, 'active.pbprofile');
  const stateFile = path.join(dir, 'process.json');
  const binary = path.join(__dirname, 'bin', 'ProxyBridge_CLI.exe');
  const hashes = {'ProxyBridge_CLI.exe':'dcfffb8515603db5fd3b52674c52cce29ebe6f048d726587595d99aa2e219c0a','ProxyBridgeCore.dll':'1996d5564a6c6f9b58a25e64781acbc07720cbac530e2706ce4a58f20ea18d14','WinDivert.dll':'c1e060ee19444a259b2162f8af0f3fe8c4428a1c6f694dce20de194ac8d7d9a2','WinDivert64.sys':'8da085332782708d8767bcace5327a6ec7283c17cfb85e40b03cd2323a90ddc2'};
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const quote = s => "'" + String(s).replace(/'/g, "''") + "'";
  const encode = s => Buffer.from(s, 'utf16le').toString('base64');
  async function powershell(script) { return (await exec(ps, ['-NoProfile','-NonInteractive','-EncodedCommand',encode(script)], {windowsHide:true, timeout:120000})).stdout.trim(); }
  function ensure() { fs.mkdirSync(dir, {recursive:true}); }
  function read(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
  function write(file, value) { ensure(); const temp = file + '.' + crypto.randomUUID() + '.tmp'; try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), {encoding:'utf8', flag:'wx'}); fs.renameSync(temp, file); } finally { try { fs.unlinkSync(temp); } catch (_) {} } }
  function secret(value, decrypt) {
    const operation = decrypt ? 'Unprotect' : 'Protect';
    const input = decrypt ? '[Convert]::FromBase64String([Console]::In.ReadToEnd())' : '[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())';
    const output = decrypt ? '[Text.Encoding]::UTF8.GetString($result)' : '[Convert]::ToBase64String($result)';
    const script = `Add-Type -AssemblyName System.Security; $bytes=${input}; $result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); ${output}`;
    return new Promise((resolve,reject)=>{const child=spawn(ps,['-NoProfile','-NonInteractive','-EncodedCommand',encode(script)],{windowsHide:true}); let out='',err=''; child.stdout.on('data',x=>out+=x); child.stderr.on('data',x=>err+=x); child.on('error',reject); child.on('close',code=>code===0 ? resolve(out.trim()) : reject(new Error('密码保护失败：'+err.slice(0,200)))); child.stdin.end(value,'utf8');});
  }
  async function config() { const c=read(configFile, {servers:[], rules:[], defaultServer:''}); for(const s of c.servers) { s.password=s.passwordProtected ? await secret(s.passwordProtected,true) : ''; delete s.passwordProtected; } return c; }
  function verify() { for (const [name, hash] of Object.entries(hashes)) if (crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'bin',name))).digest('hex') !== hash) throw new Error('内置核心文件校验失败，请重新导入插件'); }
  function validate(c) {
    if (!c || !Array.isArray(c.servers) || !Array.isArray(c.rules) || c.servers.length > 32 || c.rules.length > 256 || (c.autoStart !== undefined && typeof c.autoStart !== 'boolean')) throw new Error('配置格式无效');
    const ids = new Set();
    for (const s of c.servers) { if (!s.id || ids.has(s.id) || !['socks5','http'].includes(s.type) || !s.name || !s.host || /[\0\r\n]/.test(s.host) || !Number.isInteger(Number(s.port)) || +s.port < 1 || +s.port > 65535 || [s.name,s.host,s.username||'',s.password||''].some(x => typeof x !== 'string' || x.length > 255)) throw new Error('代理服务器配置无效'); ids.add(s.id); }
    if (c.defaultServer && !ids.has(c.defaultServer)) throw new Error('默认代理服务器不存在');
    for (const r of c.rules) { if (!r.id || !r.process || typeof r.process !== 'string' || r.process.length > 1024 || /[\0\r\n]/.test(r.process) || !['PROXY','DIRECT','BLOCK'].includes(r.action) || !['TCP','UDP','BOTH'].includes(r.protocol) || (r.action === 'PROXY' && !ids.has(r.server)) || [r.hosts,r.ports].some(x => typeof x !== 'string' || x.length > 1024 || /[\0\r\n]/.test(x))) throw new Error('应用规则配置无效'); }
  }
  async function status() {
    const saved = read(stateFile, null);
    if (!saved) return {running:false};
    if (!Number.isInteger(saved.pid) || !/^\d+$/.test(saved.ticks)) throw new Error('运行状态文件损坏，请检查代理进程');
    const result = await powershell(`$ErrorActionPreference='Stop'; try { $p=Get-Process -Id ${saved.pid} -ErrorAction SilentlyContinue; if (-not $p) { 'stopped' } elseif ($p.ProcessName -eq 'ProxyBridge_CLI' -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq ${quote(saved.ticks)}) { 'running' } else { 'stopped' } } catch { [Console]::Error.WriteLine($_); exit 2 }`);
    if (result === 'running') return {running:true};
    if (result !== 'stopped') throw new Error('无法确认代理进程状态，请检查权限');
    try { fs.unlinkSync(stateFile); } catch (_) {} try { fs.unlinkSync(profileFile); } catch (_) {}
    return {running:false};
  }
  async function start() {
    if ((await status()).running) throw new Error('代理进程已经运行');
    verify(); const c = await config(); validate(c);
    if (!c.rules.some(r=>r.enabled)) throw new Error('请至少启用一条规则');
    const ids = new Map(c.servers.map((s,i)=>[s.id,i+1]));
    const profile = {Version:'1.0',IsTrafficLoggingEnabled:false,ProxyConfigs:c.servers.map(s=>({Id:ids.get(s.id),Type:s.type,Host:s.host,Port:String(s.port),Username:s.username||'',Password:s.password||''})),ProxyRules:c.rules.map(r=>({ProcessName:r.process,TargetHosts:r.hosts||'*',TargetPorts:r.ports||'*',Protocol:r.protocol,Action:r.action,IsEnabled:!!r.enabled,LocalhostViaProxy:false,ProxyConfigId:ids.get(r.server)||0}))};
    write(profileFile, profile);
    try {
      const output = await powershell(`$ErrorActionPreference='Stop'; $p=Start-Process -FilePath ${quote(binary)} -ArgumentList ${quote('--profile "'+profileFile+'"')} -Verb RunAs -WindowStyle Hidden -PassThru; Start-Sleep -Seconds 2; $p.Refresh(); if ($p.HasExited) { throw '代理核心启动后退出，请检查是否有其他代理核心运行或驱动不可用' }; '{0}|{1}' -f $p.Id,$p.StartTime.ToUniversalTime().Ticks`);
      const match = output.match(/^(\d+)\|(\d+)$/); if (!match) throw new Error('无法确认代理进程状态');
      try { write(stateFile,{pid:Number(match[1]),ticks:match[2]}); } catch (error) { throw new Error(`代理进程已启动（PID ${match[1]}），但状态保存失败；请手动结束该进程。${error.message}`); } return {running:true};
    } catch (e) { if (!String(e.message).includes('代理进程已启动')) { try { fs.unlinkSync(profileFile); } catch (_) {} } throw new Error('启动失败或管理员授权被取消。请检查是否有其他代理核心运行。'+(e.stderr ? ' '+String(e.stderr).slice(0,300) : ' '+e.message)); }
  }
  async function stop() {
    if (!(await status()).running) return {running:false};
    const s = read(stateFile,null);
    const action = `$p=Get-Process -Id ${s.pid} -ErrorAction SilentlyContinue; if (-not $p) { exit 0 }; if ($p.ProcessName -ne 'ProxyBridge_CLI' -or $p.StartTime.ToUniversalTime().Ticks.ToString() -ne ${quote(s.ticks)}) { exit 3 }; Stop-Process -Id ${s.pid} -Force -ErrorAction Stop`;
    const result = await powershell(`$ErrorActionPreference='Stop'; $p=Start-Process -FilePath ${quote(ps)} -ArgumentList ${quote('-NoProfile -NonInteractive -EncodedCommand '+encode(action))} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; $p.ExitCode`);
    if (result !== '0') throw new Error('停止代理失败，请检查管理员授权');
    return status();
  }
  let transition = Promise.resolve(), exiting = false;
  function runTransition(action) { const next = transition.catch(() => {}).then(async () => { if (host.setPluginBusy) host.setPluginBusy(true); try { return await action(); } finally { if (host.setPluginBusy) host.setPluginBusy(false); } }); transition = next; return next; }
  const supportsExit = typeof host.onPluginExit === 'function';
  if (supportsExit) host.onPluginExit(async () => { exiting = true; try { return await runTransition(stop); } catch (error) { exiting = false; throw error; } });
  if (typeof host.onPluginExitCancelled === 'function') host.onPluginExitCancelled(() => { exiting = false; });
  window.applicationProxy = Object.freeze({config,status,supportsExit,start:()=>runTransition(()=>{ if (exiting) throw new Error('插件正在退出'); return start(); }),stop:()=>runTransition(stop),setAutoStart:enabled=>runTransition(()=>{ if (exiting) throw new Error('插件正在退出'); if (typeof enabled !== 'boolean') throw new Error('自动启动设置无效'); const saved=read(configFile, {servers:[], rules:[], defaultServer:''}); if (!Array.isArray(saved.servers) || !Array.isArray(saved.rules)) throw new Error('配置格式无效'); saved.autoStart=enabled; write(configFile,saved); }),save:c=>runTransition(async()=>{ if (exiting) throw new Error('插件正在退出'); if ((await status()).running) throw new Error('请先停止代理，再修改配置'); validate(c); const saved=JSON.parse(JSON.stringify(c)); for(const s of saved.servers) { s.passwordProtected=s.password ? await secret(s.password,false) : ''; delete s.password; } write(configFile,saved); }),async pick(){const paths=await host.showOpenDialog({properties:['openFile'],filters:[{name:'应用程序',extensions:['exe']}]}); return paths && paths[0];}});
})();
