'use strict';
(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const host = typeof utools !== 'undefined' ? utools : window.utools;
  const directory = path.join(host.getPath('userData'), 'hosts-editor');
  const configPath = path.join(directory, 'environments.json');
  const hostsPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
  const start = '# BEGIN QINGXIA HOSTS ENVIRONMENT';
  const end = '# END QINGXIA HOSTS ENVIRONMENT';
  const keys = ['dev', 'test', 'prod'];
  function readHosts() {
    const bytes = fs.readFileSync(hostsPath);
    const text = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
    return {text:(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? '\ufeff' : '') + text, hash:crypto.createHash('sha256').update(bytes).digest('hex')};
  }
  function validate(text) {
    if (typeof text !== 'string' || text.includes('\0')) throw new Error('配置内容无效');
  }
  function range(text) {
    const lines = text.split(/\r\n|\n|\r/);
    const starts = lines.filter(line => line.trim() === start).length;
    const ends = lines.filter(line => line.trim() === end).length;
    if (!starts && !ends) return null;
    if (starts !== 1 || ends !== 1) throw new Error('环境区段标记不完整或重复，请先检查当前文件');
    const pattern = new RegExp('(^|\\r\\n|\\n|\\r)[ \\t]*' + start + '[ \\t]*(?:\\r\\n|\\n|\\r)[\\s\\S]*?(?:\\r\\n|\\n|\\r)[ \\t]*' + end + '[ \\t]*(?=\\r\\n|\\n|\\r|$)');
    const match = pattern.exec(text);
    if (!match) throw new Error('环境区段标记顺序错误，请先检查当前文件');
    return {from:match.index + match[1].length, to:match.index + match[0].length};
  }
  function config() {
    if (!fs.existsSync(configPath)) return {dev:'',test:'',prod:''};
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    for (const key of keys) validate(data[key]);
    return data;
  }
  function writeHosts(text, expected) {
    validate(text);
    const current = readHosts();
    if (current.hash !== expected) throw new Error('系统 Hosts 已被其他程序修改，请重新读取后再操作');
    fs.mkdirSync(directory, {recursive:true});
    const backup = path.join(directory, `hosts-backup-${crypto.randomUUID()}`);
    fs.writeFileSync(backup, current.text, {encoding:'utf8',flag:'wx'});
    try { fs.writeFileSync(hostsPath, text, 'utf8'); }
    catch (error) { throw new Error(`写入系统 Hosts 失败，请以管理员身份运行轻匣；原文件备份位于 ${backup}。${error.message}`); }
    return readHosts();
  }
  window.hostsEditor = Object.freeze({
    readHosts, config,
    saveConfig(key, text) {
      if (!keys.includes(key)) throw new Error('环境无效');
      validate(text);
      if (text.split(/\r\n|\n|\r/).some(line => [start,end].includes(line.trim()))) throw new Error('环境配置不能包含系统区段标记');
      const data = config(); data[key] = text;
      fs.mkdirSync(directory, {recursive:true});
      const tmp = path.join(directory, `config-${crypto.randomUUID()}.tmp`);
      try { fs.writeFileSync(tmp, JSON.stringify(data, null, 2), {encoding:'utf8',flag:'wx'}); fs.renameSync(tmp, configPath); }
      catch (error) { try { fs.unlinkSync(tmp); } catch (_) {} throw error; }
    },
    saveCurrent(text, expected) { range(text); return writeHosts(text, expected); },
    apply(key, text, expected) {
      if (!keys.includes(key)) throw new Error('环境无效');
      validate(text);
      if (text.split(/\r\n|\n|\r/).some(line => [start,end].includes(line.trim()))) throw new Error('环境配置不能包含系统区段标记');
      const current = readHosts();
      if (current.hash !== expected) throw new Error('系统 Hosts 已被其他程序修改，请重新读取后再操作');
      const eol = current.text.includes('\r\n') ? '\r\n' : '\n';
      const contents = text.replace(/\r\n|\r|\n/g, eol).replace(/(?:\r\n|\r|\n)+$/, '');
      const block = [start, `# ${key}`, ...(contents ? [contents] : []), end].join(eol);
      const section = range(current.text);
      const output = section ? current.text.slice(0,section.from) + block + current.text.slice(section.to) : current.text + (current.text && !/[\r\n]$/.test(current.text) ? eol : '') + block + eol;
      return writeHosts(output, expected);
    }
  });
})();
