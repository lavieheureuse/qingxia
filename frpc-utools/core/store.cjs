'use strict';

// Settings storage for the frpc uTools plugin (v2 sync-proxy model).
//
// Design notes:
// - Zero npm dependencies; Node built-ins only.
// - All text files are UTF-8 without BOM.
// - Writes are atomic: `<file>.<pid>.<rand>.tmp` then rename over the target.
// - The iostool pcToken is obfuscated on disk with a `utf8:base64` prefix.
//   This is NOT encryption: it only stops a casual reader from seeing the token.
// - settings.json shape (SPEC-SYNC §4, version 2):
//   {version:2, connection:{apiBase,pcId,pcTokenEnc}, frpc:{path,version,source},
//    autoSync:{enabled,intervalSec}, ui:{autoScroll}}

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SETTINGS_VERSION = 2;
const SECRET_PREFIX = 'utf8:';
const DEFAULT_API_BASE = 'http://103.47.80.133';
const DEFAULT_PC_ID = 'pc-home';
const DEFAULT_INTERVAL_SEC = 45;
const INTERVAL_MIN_SEC = 1;
const INTERVAL_MAX_SEC = 3600;

/** Build an Error carrying a plugin error code (VALIDATION/UNAUTHORIZED/...). */
function createError(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  if (extra && typeof extra === 'object') {
    for (const key of Object.keys(extra)) {
      if (key === 'code' || key === 'message') continue;
      error[key] = extra[key];
    }
    if (extra.cause) error.cause = extra.cause;
  }
  return error;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value, fallback) {
  return typeof value === 'string' ? value : (fallback === undefined ? '' : fallback);
}

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeInterval(value) {
  const interval = Number(value);
  if (!Number.isInteger(interval) || interval < INTERVAL_MIN_SEC || interval > INTERVAL_MAX_SEC) {
    return DEFAULT_INTERVAL_SEC;
  }
  return interval;
}

function randomSecret(bytes) {
  return crypto.randomBytes(bytes || 18).toString('base64url');
}

/** Obfuscate a secret for on-disk storage. Not encryption. */
function encodeSecret(value) {
  const text = asString(value, '');
  if (!text) return '';
  return SECRET_PREFIX + Buffer.from(text, 'utf8').toString('base64');
}

/** Reverse encodeSecret; tolerates legacy plaintext values. Not encryption. */
function decodeSecret(value) {
  if (typeof value !== 'string' || !value) return '';
  if (!value.startsWith(SECRET_PREFIX)) return value;
  try {
    return Buffer.from(value.slice(SECRET_PREFIX.length), 'base64').toString('utf8');
  } catch (_) {
    return '';
  }
}

function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function normalizeApiBase(value) {
  const text = asString(value).trim();
  if (!text) return DEFAULT_API_BASE;
  return text.replace(/\/+$/, '');
}

function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    connection: { apiBase: DEFAULT_API_BASE, pcId: DEFAULT_PC_ID, pcToken: '' },
    frpc: { path: '', version: '', source: 'downloaded' },
    autoSync: { enabled: false, intervalSec: DEFAULT_INTERVAL_SEC },
    ui: { autoScroll: true },
  };
}

/** Fill missing fields and coerce invalid values so a damaged file can never crash the plugin. */
function normalizeSettings(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const connection = isPlainObject(source.connection) ? source.connection : {};
  // v2 keeps the obfuscated token in `pcTokenEnc`; accept plaintext `pcToken` defensively.
  const token = connection.pcTokenEnc !== undefined
    ? decodeSecret(connection.pcTokenEnc)
    : asString(connection.pcToken);
  const frpc = isPlainObject(source.frpc) ? source.frpc : {};
  const frpcPath = asString(frpc.path);
  const autoSync = isPlainObject(source.autoSync) ? source.autoSync : {};
  return {
    version: SETTINGS_VERSION,
    connection: {
      apiBase: normalizeApiBase(connection.apiBase),
      pcId: asString(connection.pcId).trim() || DEFAULT_PC_ID,
      pcToken: token,
    },
    frpc: {
      path: frpcPath,
      version: asString(frpc.version),
      source: frpc.source === 'custom' || frpc.source === 'downloaded'
        ? frpc.source
        : (frpcPath ? 'custom' : 'downloaded'),
    },
    autoSync: {
      enabled: asBoolean(autoSync.enabled, false),
      intervalSec: normalizeInterval(autoSync.intervalSec),
    },
    ui: { autoScroll: !isPlainObject(source.ui) || source.ui.autoScroll !== false },
  };
}

/** Serialize settings for disk: token obfuscated, stable JSON formatting. */
function serializeSettings(settings) {
  const normalized = normalizeSettings(settings);
  const onDisk = {
    version: SETTINGS_VERSION,
    connection: {
      apiBase: normalized.connection.apiBase,
      pcId: normalized.connection.pcId,
      pcTokenEnc: encodeSecret(normalized.connection.pcToken),
    },
    frpc: normalized.frpc,
    autoSync: normalized.autoSync,
    ui: normalized.ui,
  };
  return JSON.stringify(onDisk, null, 2) + '\n';
}

/** Atomically write a UTF-8 file (no BOM): tmp file + fsync + rename. */
function writeFileAtomicSync(filePath, data, options) {
  const target = path.resolve(filePath);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const encoding = options && options.encoding ? options.encoding : 'utf8';
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), encoding);
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'w');
    fs.writeSync(fd, payload, 0, payload.length, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, target);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
    try { fs.rmSync(tempPath, { force: true }); } catch (_) { /* ignore */ }
    throw error;
  }
  return target;
}

/**
 * createStore(dataDir) -> { dataDir, settingsPath, read(), write(settings), reset() }
 * read() always returns fully normalized settings; a missing settings.json gets
 * defaults persisted, and a corrupt one is backed up as
 * `settings.json.broken-<timestamp>` before defaults are written.
 */
function createStore(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw createError('INTERNAL', '设置存储需要有效的数据目录');
  }
  const root = path.resolve(dataDir);
  const settingsPath = path.join(root, 'settings.json');

  function backupBroken(rawText) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${settingsPath}.broken-${stamp}`;
    try {
      if (rawText !== undefined && rawText !== null) fs.writeFileSync(backupPath, rawText, 'utf8');
      else fs.renameSync(settingsPath, backupPath);
    } catch (_) { /* A failed backup must never crash startup. */ }
    return backupPath;
  }

  function persistDefaults() {
    const settings = defaultSettings();
    try {
      writeFileAtomicSync(settingsPath, serializeSettings(settings));
    } catch (error) {
      throw createError('INTERNAL', `无法写入设置文件：${error.message}`, { cause: error });
    }
    return settings;
  }

  function read() {
    let rawText;
    try {
      rawText = fs.readFileSync(settingsPath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return persistDefaults();
      throw createError('INTERNAL', `无法读取设置文件：${error.message}`, { cause: error });
    }
    let parsed;
    try {
      parsed = JSON.parse(stripBom(rawText));
    } catch (_) {
      backupBroken(rawText);
      return persistDefaults();
    }
    if (!isPlainObject(parsed)) {
      backupBroken(rawText);
      return persistDefaults();
    }
    return normalizeSettings(parsed);
  }

  function write(settings) {
    const normalized = normalizeSettings(settings);
    try {
      writeFileAtomicSync(settingsPath, serializeSettings(normalized));
    } catch (error) {
      throw createError('INTERNAL', `无法写入设置文件：${error.message}`, { cause: error });
    }
    return normalized;
  }

  function reset() {
    try { fs.rmSync(settingsPath, { force: true }); } catch (_) { /* ignore */ }
    return persistDefaults();
  }

  return { dataDir: root, settingsPath, read, write, reset };
}

module.exports = {
  SETTINGS_VERSION,
  SECRET_PREFIX,
  DEFAULT_API_BASE,
  DEFAULT_PC_ID,
  DEFAULT_INTERVAL_SEC,
  INTERVAL_MIN_SEC,
  INTERVAL_MAX_SEC,
  createError,
  createStore,
  defaultSettings,
  normalizeSettings,
  encodeSecret,
  decodeSecret,
  serializeSettings,
  writeFileAtomicSync,
  isPlainObject,
  randomSecret,
};
