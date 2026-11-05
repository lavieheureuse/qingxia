'use strict';

// Config tooling for the iostool sync-proxy model.
//
// The server (iostool server/frp_config_api.py `proxies_to_toml`) sends a full
// INI text even though the file is named `frpc.toml`; frpc detects the format by
// content (verified locally with frpc 0.71.1). This module therefore only
// parses/validates/installs INI configs — it never generates a config.
//
// File layout under dataDir/run (SPEC-SYNC §4):
//   frpc.toml          applied config (INI content)
//   frpc.toml.bak      previous config kept when a new one is installed
//   frpc.toml.new      staging file for `frpc verify -c`
//   frpc.toml.version  applied version marker used to avoid redundant restarts

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createError, writeFileAtomicSync } = require('./store.cjs');

const FILENAMES = {
  config: 'frpc.toml',
  backup: 'frpc.toml.bak',
  temp: 'frpc.toml.new',
  version: 'frpc.toml.version',
};

const VERIFY_TIMEOUT_MS = 15000;

function configPathFor(runDir) {
  return path.join(runDir, FILENAMES.config);
}

function backupPathFor(runDir) {
  return path.join(runDir, FILENAMES.backup);
}

function tempPathFor(runDir) {
  return path.join(runDir, FILENAMES.temp);
}

function versionPathFor(runDir) {
  return path.join(runDir, FILENAMES.version);
}

function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function splitIniLine(line) {
  const index = line.indexOf('=');
  if (index === -1) return null;
  return { key: line.slice(0, index).trim().toLowerCase(), value: line.slice(index + 1).trim() };
}

function toInteger(value) {
  const number = Number.parseInt(String(value), 10);
  return Number.isInteger(number) ? number : 0;
}

/**
 * parseIni(text) -> { common: {serverAddr, serverPort, token}, proxies: Proxy[] }
 * Best effort: malformed lines are ignored; Proxy.enabled is always true because
 * the server omits disabled proxies from the delivered INI.
 */
function parseIni(text) {
  const common = { serverAddr: '', serverPort: 0, token: '' };
  const proxies = [];
  let current = null;
  const lines = stripBom(String(text === null || text === undefined ? '' : text)).split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      const name = section[1].trim();
      if (name.toLowerCase() === 'common') {
        current = { kind: 'common' };
      } else {
        current = {
          kind: 'proxy',
          proxy: {
            name,
            type: 'tcp',
            localIp: '127.0.0.1',
            localPort: 0,
            remotePort: 0,
            enabled: true,
          },
        };
        proxies.push(current.proxy);
      }
      continue;
    }
    if (!current) continue;
    const pair = splitIniLine(line);
    if (!pair) continue;
    const { key, value } = pair;
    if (current.kind === 'common') {
      if (key === 'server_addr') common.serverAddr = value;
      else if (key === 'server_port') common.serverPort = toInteger(value);
      else if (key === 'token') common.token = value;
      continue;
    }
    const proxy = current.proxy;
    if (key === 'type') proxy.type = value.toLowerCase();
    else if (key === 'local_ip') proxy.localIp = value;
    else if (key === 'local_port') proxy.localPort = toInteger(value);
    else if (key === 'remote_port') proxy.remotePort = toInteger(value);
  }
  return { common, proxies };
}

/** Turn raw `frpc verify` output into a short, friendly Chinese message. */
function friendlyVerifyMessage(raw) {
  let text = String(raw || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!text) return '';
  const unknown = text.match(/json:\s*unknown field\s+"([^"]+)"/i) || text.match(/unknown field\s+"([^"]+)"/i);
  if (unknown) return `配置项未知：${unknown[1]}`;
  // Check the "open <path>: <reason>" form first: the path may itself contain "toml:".
  const open = text.match(/^open\s+(.+?)\s*:\s*(.+)$/im);
  if (open) return `无法读取配置文件：${open[2].trim()}`;
  const toml = text.match(/toml:\s*(?:line\s+\d+(?:,\s*column\s+\d+)?:\s*)?(.+)/i);
  if (toml) return `配置格式错误：${toml[1].trim()}`;
  const ini = text.match(/ini:\s*(?:line\s+\d+:\s*)?(.+)/i);
  if (ini) return `配置格式错误：${ini[1].trim()}`;
  return text.replace(/^frpc:\s*/i, '').split(/\r?\n/).filter(Boolean).join('；').slice(0, 500);
}

/**
 * verifyConfig(configPath, exePath, {timeout}) -> Promise<{ok, message, raw}>
 * Runs `frpc verify -c <path>` offline. Never logs the config content.
 */
function verifyConfig(configPath, exePath, options) {
  const opts = options || {};
  const timeout = Number.isInteger(opts.timeout) ? opts.timeout : VERIFY_TIMEOUT_MS;
  return new Promise((resolve) => {
    if (!exePath) {
      resolve({ ok: false, message: '尚未安装 frpc，无法校验配置', raw: '' });
      return;
    }
    execFile(exePath, ['verify', '-c', configPath], { timeout, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      const raw = `${stdout || ''}\n${stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!error) {
        resolve({ ok: true, message: '配置校验通过', raw });
        return;
      }
      if (error.code === 'ENOENT') {
        resolve({ ok: false, message: `找不到 frpc 可执行文件：${exePath}`, raw });
        return;
      }
      if (error.killed || error.signal) {
        resolve({ ok: false, message: '配置校验超时（15 秒），请稍后重试', raw });
        return;
      }
      const friendly = friendlyVerifyMessage(raw);
      resolve({ ok: false, message: friendly || `配置校验失败（退出码 ${error.code}）`, raw });
    });
  });
}

// ---------------------------------------------------------------------------
// config file operations (all atomic / UTF-8 without BOM)
// ---------------------------------------------------------------------------

function readText(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch (_) { return null; }
}

function readConfigFile(runDir) {
  return readText(configPathFor(runDir));
}

/** Write the staging file used for `frpc verify`; returns its path. */
function writeTempConfig(runDir, text) {
  const target = tempPathFor(runDir);
  writeFileAtomicSync(target, String(text));
  return target;
}

function removeTempConfig(runDir) {
  try { fs.rmSync(tempPathFor(runDir), { force: true }); } catch (_) { /* ignore */ }
}

/**
 * Backup the current config (if any) and atomically replace it with the new text.
 * Returns { configPath, backupPath } where backupPath is null when there was no old config.
 */
function installConfig(runDir, text) {
  fs.mkdirSync(runDir, { recursive: true });
  const configPath = configPathFor(runDir);
  let backupPath = null;
  if (fs.existsSync(configPath)) {
    const previous = fs.readFileSync(configPath);
    backupPath = backupPathFor(runDir);
    writeFileAtomicSync(backupPath, previous);
  }
  writeFileAtomicSync(configPath, String(text));
  removeTempConfig(runDir);
  return { configPath, backupPath };
}

function readAppliedVersion(runDir) {
  const text = readText(versionPathFor(runDir));
  if (text === null) return null;
  const version = Number.parseInt(text.trim(), 10);
  return Number.isInteger(version) && version >= 0 ? version : null;
}

function writeAppliedVersion(runDir, version) {
  writeFileAtomicSync(versionPathFor(runDir), String(version));
}

function clearAppliedVersion(runDir) {
  try { fs.rmSync(versionPathFor(runDir), { force: true }); } catch (_) { /* ignore */ }
}

module.exports = {
  FILENAMES,
  configPathFor,
  backupPathFor,
  tempPathFor,
  versionPathFor,
  parseIni,
  friendlyVerifyMessage,
  verifyConfig,
  readText,
  readConfigFile,
  writeTempConfig,
  removeTempConfig,
  installConfig,
  readAppliedVersion,
  writeAppliedVersion,
  clearAppliedVersion,
};
