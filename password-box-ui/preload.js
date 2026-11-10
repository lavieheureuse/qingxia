'use strict';
(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const { spawnSync } = require('node:child_process');
  const host = typeof utools !== 'undefined' ? utools : window.utools;
  const directory = path.join(host.getPath('userData'), 'password-box');
  const file = path.join(directory, 'vault.json');
  let key = null, salt = null, protectedKey = null;
  function derive(password, value) { return crypto.scryptSync(password, value, 32); }
  function protectKey(value, decrypt) {
    if (process.platform !== 'win32') throw new Error('免主密码模式需要 Windows 用户账户保护');
    const method = decrypt ? 'Unprotect' : 'Protect';
    const script = `Add-Type -AssemblyName System.Security; $v=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Console]::Out.Write([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::${method}($v,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)))`;
    const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {input:value.toString('base64'),encoding:'utf8',windowsHide:true});
    if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error('无法使用 Windows 用户账户保护密码盒');
    return Buffer.from(result.stdout.trim(), 'base64');
  }
  function save(entries) {
    if (!key || (!salt && !protectedKey)) throw new Error('密码盒尚未解锁');
    if (!Array.isArray(entries)) throw new Error('密码数据格式无效');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(entries), 'utf8'), cipher.final()]);
    const protection = protectedKey ? {version:2,protectedKey:protectedKey.toString('base64')} : {version:1,salt:salt.toString('base64')};
    const data = JSON.stringify({...protection,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:ciphertext.toString('base64')});
    fs.mkdirSync(directory, {recursive:true});
    const temp = path.join(directory, `vault-${crypto.randomUUID()}.tmp`);
    try { fs.writeFileSync(temp, data, {flag:'wx',mode:0o600}); fs.renameSync(temp, file); }
    catch (error) { try { fs.unlinkSync(temp); } catch (_) {} throw new Error(`保存失败，原数据未更改：${error.message}`); }
  }
  window.passwordBox = Object.freeze({
    mode: () => !fs.existsSync(file) ? 'new' : JSON.parse(fs.readFileSync(file, 'utf8')).version === 2 ? 'windows' : 'password',
    createWithoutPassword() {
      if (fs.existsSync(file)) throw new Error('密码盒已存在，不能重新创建');
      key = crypto.randomBytes(32); salt = null;
      try { protectedKey = protectKey(key, false); save([]); } catch (error) { key = null; protectedKey = null; throw error; }
      return [];
    },
    unlock(password) {
      if (!fs.existsSync(file)) {
        if (typeof password !== 'string' || password.length < 8) throw new Error('主密码至少需要 8 个字符');
        salt = crypto.randomBytes(16); key = derive(password, salt);
        try { save([]); } catch (error) { key = null; salt = null; throw error; }
        return [];
      }
      const vault = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (vault.version !== 1 && vault.version !== 2) throw new Error('不支持此密码盒数据格式');
      if (vault.version === 1 && (typeof password !== 'string' || password.length < 8)) throw new Error('主密码至少需要 8 个字符');
      const nextSalt = vault.version === 1 ? Buffer.from(vault.salt, 'base64') : null;
      const nextProtectedKey = vault.version === 2 ? Buffer.from(vault.protectedKey, 'base64') : null;
      const nextKey = nextSalt ? derive(password, nextSalt) : protectKey(nextProtectedKey, true);
      let entries;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', nextKey, Buffer.from(vault.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(vault.tag, 'base64'));
        entries = JSON.parse(Buffer.concat([decipher.update(Buffer.from(vault.data, 'base64')), decipher.final()]).toString('utf8'));
        if (!Array.isArray(entries)) throw new Error('invalid data');
      } catch (_) { throw new Error('主密码错误或密码盒文件已损坏'); }
      key = nextKey; salt = nextSalt; protectedKey = nextProtectedKey;
      return entries;
    },
    save,
    async exportJson(entries) {
      const folders = await host.showOpenDialog({title:'选择 JSON 导出目录',properties:['openDirectory']});
      if (!folders || !folders.length) return false;
      const name = `密码盒-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.json`;
      fs.writeFileSync(path.join(folders[0], name), JSON.stringify({version:1,entries}, null, 2), {encoding:'utf8',flag:'wx',mode:0o600});
      return name;
    },
    async importJson() {
      const files = await host.showOpenDialog({title:'选择密码盒 JSON 文件',properties:['openFile'],filters:[{name:'JSON 文件',extensions:['json']}]});
      if (!files || !files.length) return null;
      if (fs.statSync(files[0]).size > 10 * 1024 * 1024) throw new Error('导入文件不能超过 10 MB');
      const parsed = JSON.parse(fs.readFileSync(files[0], 'utf8').replace(/^\uFEFF/, ''));
      const list = Array.isArray(parsed) ? parsed : parsed && parsed.version === 1 ? parsed.entries : null;
      if (!Array.isArray(list)) throw new Error('JSON 格式无效，请选择密码盒导出的文件');
      const limits = {name:100,account:100,password:2048,group:50,application:250,note:5000};
      return list.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`第 ${index + 1} 条记录格式无效`);
        const result = {};
        for (const [field, limit] of Object.entries(limits)) {
          const value = entry[field] ?? '';
          if (typeof value !== 'string' || value.length > limit) throw new Error(`第 ${index + 1} 条记录的 ${field} 无效`);
          result[field] = value;
        }
        if (!result.name.trim() || !result.password) throw new Error(`第 ${index + 1} 条记录缺少名称或密码`);
        if (entry.favorite != null && typeof entry.favorite !== 'boolean') throw new Error(`第 ${index + 1} 条记录的收藏状态无效`);
        result.favorite = !!entry.favorite;
        return result;
      });
    },
    copy: text => host.copyText(text)
  });
})();
