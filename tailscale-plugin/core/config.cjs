'use strict';

// 配置校验、URL 安全校验、原子读写与 DPAPI 凭据存储。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_SOCKET = '\\\\.\\pipe\\ProtectedPrefix\\Administrators\\QingxiaTailscale\\tailscaled';
const DEFAULT_TUN = 'Tailscale';

const DEFAULT_CONFIG = Object.freeze({
  customBinaryDir: '',
  autoConnect: false,
  hostname: '',
  loginServer: '',
  acceptDns: true,
  udpPort: 0,
  noLogsNoSupport: true,
  saveAuthKey: false,
  hasSavedAuthKey: false,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function createConfigError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function normalizeConfig(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const portNum = src.udpPort === '' || src.udpPort === undefined || src.udpPort === null
    ? 0
    : Number(src.udpPort);
  return {
    customBinaryDir: asString(src.customBinaryDir).trim(),
    autoConnect: asBoolean(src.autoConnect, false),
    hostname: asString(src.hostname).trim(),
    loginServer: asString(src.loginServer).trim().replace(/\/+$/, ''),
    acceptDns: asBoolean(src.acceptDns, true),
    udpPort: Number.isFinite(portNum) ? portNum : NaN,
    noLogsNoSupport: asBoolean(src.noLogsNoSupport, true),
    saveAuthKey: asBoolean(src.saveAuthKey, false),
    hasSavedAuthKey: asBoolean(src.hasSavedAuthKey, false),
  };
}

function validateConfig(raw) {
  const cfg = normalizeConfig(raw);
  if (cfg.customBinaryDir) {
    if (/[\0\r\n]/.test(cfg.customBinaryDir) || !path.isAbsolute(cfg.customBinaryDir)) {
      throw createConfigError('INVALID_CONFIG', '本地内核目录必须是有效的绝对路径');
    }
  }
  if (cfg.hostname) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(cfg.hostname)) {
      throw createConfigError('INVALID_CONFIG', '主机名仅支持字母、数字与连字符（1~63 字符，且以字母或数字开头）');
    }
  }
  if (cfg.loginServer) {
    if (/[\0\r\n\s]/.test(cfg.loginServer)) {
      throw createConfigError('INVALID_CONFIG', '控制服务器地址包含非法空白或控制字符');
    }
    let parsed;
    try {
      parsed = new URL(cfg.loginServer);
    } catch (_) {
      throw createConfigError('INVALID_CONFIG', '控制服务器地址格式无效');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
      throw createConfigError('INVALID_CONFIG', '控制服务器地址必须为不含凭据的 https:// 地址');
    }
  }
  if (!Number.isInteger(cfg.udpPort) || cfg.udpPort < 0 || cfg.udpPort > 65535) {
    throw createConfigError('INVALID_CONFIG', 'UDP 监听端口必须为 0（自动）或 1~65535 的整数');
  }
  return cfg;
}

function validateAuthKeyInput(authKey) {
  if (authKey === undefined || authKey === null || authKey === '') return '';
  if (typeof authKey !== 'string') {
    throw createConfigError('INVALID_AUTH_KEY', 'Auth Key 格式无效');
  }
  const trimmed = authKey.trim();
  if (!trimmed) return '';
  if (trimmed.length > 512 || /[\0\r\n\s"'`&|;<>^%$]/.test(trimmed)) {
    throw createConfigError('INVALID_AUTH_KEY', 'Auth Key 包含非法空白或特殊字符');
  }
  return trimmed;
}

/**
 * 严格校验浏览器授权链接，仅允许 https 协议且匹配官方或已配置控制服务器域名。
 * @param {string} rawUrl
 * @param {string} [loginServer]
 */
function validateAuthUrl(rawUrl, loginServer = '') {
  if (typeof rawUrl !== 'string') {
    throw createConfigError('INVALID_AUTH_URL', '授权链接无效');
  }
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048 || /[\0\r\n\s"'`&|;<>^%$]/.test(trimmed)) {
    throw createConfigError('INVALID_AUTH_URL', '授权链接包含非法字符');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_) {
    throw createConfigError('INVALID_AUTH_URL', '授权链接格式无效');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
    throw createConfigError('INVALID_AUTH_URL', '仅允许打开安全的 https:// 授权链接');
  }
  const host = parsed.hostname.toLowerCase();
  const isOfficial = host === 'login.tailscale.com' || host.endsWith('.tailscale.com');
  let matchesCustom = false;
  if (loginServer) {
    try {
      const custom = new URL(loginServer);
      if (custom.protocol === 'https:' && custom.host.toLowerCase() === parsed.host.toLowerCase()) {
        matchesCustom = true;
      }
    } catch (_) {
      /* ignore invalid loginServer */
    }
  }
  if (!isOfficial && !matchesCustom) {
    throw createConfigError('INVALID_AUTH_URL', `拒绝打开未受信任的授权域名：${parsed.hostname}`);
  }
  return parsed.toString();
}

function readJsonSafe(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeJsonAtomicSync(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temp, filePath);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch (_) {
      /* ignore cleanup */
    }
  }
}

function createStore({ dataDir, protectSecret, unprotectSecret }) {
  if (!dataDir) throw new Error('dataDir 不能为空');
  const configPath = path.join(dataDir, 'config.json');

  async function load({ includeSecret = false } = {}) {
    const raw = readJsonSafe(configPath, {});
    const cfg = validateConfig(raw);
    const hasSavedAuthKey = typeof raw.authKeyProtected === 'string' && raw.authKeyProtected.length > 0;
    const publicConfig = Object.assign({}, cfg, { hasSavedAuthKey });
    if (!includeSecret) return { config: publicConfig, authKey: '' };
    let authKey = '';
    if (cfg.saveAuthKey && hasSavedAuthKey) {
      authKey = await unprotectSecret(raw.authKeyProtected);
    }
    return { config: publicConfig, authKey };
  }

  async function save(patch = {}) {
    const prevRaw = readJsonSafe(configPath, {});
    const prevCfg = validateConfig(prevRaw);
    const nextCfg = validateConfig(Object.assign({}, prevCfg, patch));

    let nextProtected = typeof prevRaw.authKeyProtected === 'string' ? prevRaw.authKeyProtected : '';
    if (patch.clearAuthKey === true || !nextCfg.saveAuthKey) {
      nextProtected = '';
    } else if (typeof patch.authKey === 'string') {
      const cleanKey = validateAuthKeyInput(patch.authKey);
      if (cleanKey) {
        nextProtected = await protectSecret(cleanKey);
      }
    }

    const persisted = {
      customBinaryDir: nextCfg.customBinaryDir,
      autoConnect: nextCfg.autoConnect,
      hostname: nextCfg.hostname,
      loginServer: nextCfg.loginServer,
      acceptDns: nextCfg.acceptDns,
      udpPort: nextCfg.udpPort,
      noLogsNoSupport: nextCfg.noLogsNoSupport,
      saveAuthKey: nextCfg.saveAuthKey,
      authKeyProtected: nextProtected,
    };
    writeJsonAtomicSync(configPath, persisted);
    return Object.assign({}, nextCfg, { hasSavedAuthKey: Boolean(nextProtected) });
  }

  return {
    configPath,
    load,
    save,
  };
}

module.exports = {
  DEFAULT_SOCKET,
  DEFAULT_TUN,
  DEFAULT_CONFIG,
  normalizeConfig,
  validateConfig,
  validateAuthKeyInput,
  validateAuthUrl,
  readJsonSafe,
  writeJsonAtomicSync,
  createStore,
};
