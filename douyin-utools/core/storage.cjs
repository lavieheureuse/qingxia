'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

class StorageError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'StorageError';
    this.code = code;
  }
}
const fail = (code, message, cause) => new StorageError(code, message, cause);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function safePublicUrl(value, field, optional = false) {
  if (value == null || value === '') {
    if (optional) return '';
    throw fail('INVALID_HISTORY', `${field} 必须是有效的 HTTP(S) 地址`);
  }
  if (typeof value !== 'string') throw fail('INVALID_HISTORY', `${field} 必须是字符串`);
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid');
    return url.href;
  } catch { throw fail('INVALID_HISTORY', `${field} 必须是无内嵌凭据的 HTTP(S) 地址`); }
}

function normalizeHistory(input) {
  if (!isRecord(input)) throw fail('INVALID_HISTORY', '下载历史记录必须是对象');
  const id = input.id == null ? randomUUID() : input.id;
  if (typeof id !== 'string' || !id.trim() || id.length > 200) throw fail('INVALID_HISTORY', '历史记录 id 无效');
  if (typeof input.path !== 'string' || !input.path.trim()) throw fail('INVALID_HISTORY', '历史记录缺少文件路径');
  const bytes = input.bytes == null ? 0 : input.bytes;
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw fail('INVALID_HISTORY', '文件字节数无效');
  for (const field of ['title', 'author']) {
    if (input[field] != null && typeof input[field] !== 'string') throw fail('INVALID_HISTORY', `${field} 必须是字符串`);
  }
  const createdAt = input.createdAt == null ? new Date() : new Date(input.createdAt);
  if (!Number.isFinite(createdAt.getTime())) throw fail('INVALID_HISTORY', '历史记录时间无效');
  // A strict, flat whitelist intentionally excludes cookies, headers and tokens.
  const record = {
    id, title: input.title || '', author: input.author || '', path: input.path,
    bytes, createdAt: createdAt.toISOString(), sourceUrl: safePublicUrl(input.sourceUrl, 'sourceUrl', true),
  };
  if (input.cover != null && input.cover !== '') record.cover = safePublicUrl(input.cover, 'cover');
  return record;
}

function createStore(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw fail('INVALID_ARGUMENT', '本地数据目录无效');
  const directory = path.resolve(dataDir);
  const settingsPath = path.join(directory, 'settings.json');
  const historyPath = path.join(directory, 'history.json');

  function readJson(filename, fallback) {
    let text;
    try { text = fs.readFileSync(filename, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') {
        // Windows may report ENOENT instead of ENOTDIR when dataDir is a file.
        try {
          if (!fs.statSync(directory).isDirectory()) throw fail('STORE_READ_ERROR', '本地数据路径不是目录');
        } catch (directoryError) {
          if (directoryError.code !== 'ENOENT') {
            if (directoryError instanceof StorageError) throw directoryError;
            throw fail('STORE_READ_ERROR', '无法读取本地数据目录', directoryError);
          }
        }
        return fallback;
      }
      throw fail('STORE_READ_ERROR', '无法读取本地数据', error);
    }
    try { return JSON.parse(text); }
    catch (error) { throw fail('STORE_CORRUPT', '本地数据文件损坏；原文件已保留', error); }
  }

  function atomicWrite(filename, value) {
    let temporary;
    let descriptor;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      temporary = path.join(directory, `.${path.basename(filename)}.${randomUUID()}.tmp`);
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, filename);
      temporary = undefined;
    } catch (error) { throw fail('STORE_WRITE_ERROR', '无法原子保存本地数据', error); }
    finally {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
      if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
    }
  }

  function getSettings() {
    const value = readJson(settingsPath, { outputDir: '' });
    if (!isRecord(value) || (value.outputDir != null && typeof value.outputDir !== 'string')) {
      throw fail('STORE_CORRUPT', '本地设置格式损坏；原文件已保留');
    }
    return { outputDir: value.outputDir || '' };
  }

  function saveSettings(input) {
    if (!isRecord(input) || (input.outputDir != null && typeof input.outputDir !== 'string')) {
      throw fail('INVALID_SETTINGS', '保存目录必须是字符串');
    }
    const settings = { outputDir: input.outputDir == null ? getSettings().outputDir : input.outputDir };
    atomicWrite(settingsPath, settings);
    return settings;
  }

  function listHistory() {
    const value = readJson(historyPath, []);
    if (!Array.isArray(value)) throw fail('STORE_CORRUPT', '本地历史格式损坏；原文件已保留');
    try {
      return value.map(normalizeHistory).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (error) { throw fail('STORE_CORRUPT', '本地历史记录格式损坏；原文件已保留', error); }
  }

  function addHistory(input) {
    const record = normalizeHistory(input);
    const history = [record, ...listHistory().filter(entry => entry.id !== record.id)]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    atomicWrite(historyPath, history);
    return record;
  }

  function removeHistory(id) {
    if (typeof id !== 'string' || !id.trim()) throw fail('INVALID_HISTORY', '历史记录 id 无效');
    const history = listHistory().filter(entry => entry.id !== id);
    atomicWrite(historyPath, history);
    return history;
  }

  function clearHistory() {
    atomicWrite(historyPath, []);
    return [];
  }

  return Object.freeze({ getSettings, saveSettings, listHistory, addHistory, removeHistory, clearHistory });
}

module.exports = createStore;
module.exports.createStore = createStore;
module.exports.StorageError = StorageError;
