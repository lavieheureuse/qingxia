'use strict';

// Minimal ZIP reader (no npm dependencies) good enough for GitHub release zips.
//
// Supported: stored (0) and deflate (8) entries, central directory parsing,
// CRC-32 verification, safe extraction (no absolute / `..` paths), ZIP64 rejected
// with a clear error (frp release archives are well under 4 GiB).
//
// API:
//   readZipFile(zipPath) -> archive
//   readBuffer(buffer)   -> archive
//   listEntries(archive) -> [{ name, method, crc32, compressedSize, size, isDirectory }]
//   findEntry(archive, matcher) -> entry | null
//   extractEntry(archive, entryOrName) -> Buffer
//   extractToDirectory(archive, targetDir, { filter }) -> [{ name, path, size }]

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createError } = require('./store.cjs');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT = 0xffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipError(message) {
  return createError('INTERNAL', message, { zip: true });
}

function findEndOfCentralDirectory(buffer) {
  if (buffer.length < EOCD_MIN_SIZE) throw zipError('不是有效的 ZIP 文件（文件过小）');
  const minOffset = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === SIG_EOCD) {
      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + EOCD_MIN_SIZE + commentLength === buffer.length) return offset;
    }
  }
  throw zipError('不是有效的 ZIP 文件（找不到目录信息）');
}

function readBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw zipError('ZIP 数据必须是 Buffer');
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    const locatorOffset = eocdOffset - 20;
    if (locatorOffset >= 0 && buffer.readUInt32LE(locatorOffset) === SIG_ZIP64_LOCATOR) {
      throw zipError('暂不支持 ZIP64 格式的压缩包');
    }
  }
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw zipError('暂不支持分卷 ZIP 压缩包');
  }
  if (centralOffset + centralSize > buffer.length) throw zipError('ZIP 目录信息损坏');

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > buffer.length) throw zipError('ZIP 目录项损坏');
    if (buffer.readUInt32LE(cursor) !== SIG_CENTRAL) throw zipError('ZIP 目录项签名无效');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) throw zipError('ZIP 目录项名称损坏');
    const name = buffer.toString('utf8', nameStart, nameEnd).replace(/\\/g, '/');
    if (flags & 0x1) throw zipError(`暂不支持解压加密文件：${name}`);
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw zipError(`不支持的压缩方法 ${method}：${name}`);
    }
    entries.push({
      name,
      method,
      crc32: crc,
      compressedSize,
      size,
      localHeaderOffset,
      isDirectory: name.endsWith('/'),
    });
    cursor = nameEnd + extraLength + commentLength;
  }
  return { entries, buffer, size: buffer.length };
}

function readZipFile(zipPath) {
  let buffer;
  try {
    buffer = fs.readFileSync(zipPath);
  } catch (error) {
    throw createError('INTERNAL', `无法读取 ZIP 文件：${error.message}`, { cause: error });
  }
  return readBuffer(buffer);
}

function listEntries(archive) {
  return archive.entries.map((entry) => ({
    name: entry.name,
    method: entry.method,
    crc32: entry.crc32,
    compressedSize: entry.compressedSize,
    size: entry.size,
    isDirectory: entry.isDirectory,
  }));
}

function matchEntry(entry, matcher) {
  if (matcher === undefined || matcher === null) return false;
  if (typeof matcher === 'function') return !!matcher(entry);
  if (matcher instanceof RegExp) return matcher.test(entry.name);
  const needle = String(matcher).replace(/\\/g, '/');
  if (entry.name === needle) return true;
  return path.posix.basename(entry.name) === needle;
}

/** Find the first entry matching a name / basename / RegExp / predicate. */
function findEntry(archive, matcher) {
  if (!archive || !Array.isArray(archive.entries)) throw zipError('ZIP 归档未正确解析');
  return archive.entries.find((entry) => matchEntry(entry, matcher)) || null;
}

function readEntryData(archive, entry, options) {
  const opts = options || {};
  const buffer = archive.buffer;
  const localOffset = entry.localHeaderOffset;
  if (localOffset + 30 > buffer.length) throw zipError(`ZIP 本地文件头损坏：${entry.name}`);
  if (buffer.readUInt32LE(localOffset) !== SIG_LOCAL) throw zipError(`ZIP 本地文件头签名无效：${entry.name}`);
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart > buffer.length || dataEnd > buffer.length) {
    throw zipError(`ZIP 数据超出文件范围：${entry.name}`);
  }
  const compressed = buffer.subarray(dataStart, dataEnd);
  let data;
  if (entry.method === METHOD_STORED) {
    data = Buffer.from(compressed);
  } else {
    try {
      data = zlib.inflateRawSync(compressed);
    } catch (error) {
      throw zipError(`解压失败：${entry.name}（${error.message}）`);
    }
  }
  if (data.length !== entry.size) {
    throw zipError(`解压后大小不匹配：${entry.name}（期望 ${entry.size}，实际 ${data.length}）`);
  }
  if (!opts.skipCrc && crc32(data) !== entry.crc32) {
    throw zipError(`CRC 校验失败：${entry.name}`);
  }
  return data;
}

function extractEntry(archive, entryOrName, options) {
  const entry = typeof entryOrName === 'string'
    ? findEntry(archive, entryOrName)
    : entryOrName;
  if (!entry) throw zipError(`压缩包中未找到：${entryOrName}`);
  return readEntryData(archive, entry, options);
}

function safeTargetPath(targetDir, entryName) {
  const normalized = String(entryName).replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw zipError(`压缩包内路径非法（绝对路径）：${entryName}`);
  }
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw zipError(`压缩包内路径非法（包含上级目录）：${entryName}`);
  }
  const root = path.resolve(targetDir);
  const target = path.resolve(root, ...parts);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw zipError(`压缩包内路径非法（越出目标目录）：${entryName}`);
  }
  return target;
}

/** Extract all file entries into targetDir; returns [{ name, path, size }]. */
function extractToDirectory(archive, targetDir, options) {
  const opts = options || {};
  const root = path.resolve(targetDir);
  fs.mkdirSync(root, { recursive: true });
  const written = [];
  for (const entry of archive.entries) {
    if (entry.isDirectory) continue;
    if (opts.filter && !opts.filter(entry)) continue;
    const target = safeTargetPath(root, entry.name);
    const data = readEntryData(archive, entry, opts);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    written.push({ name: entry.name, path: target, size: data.length });
  }
  return written;
}

module.exports = {
  crc32,
  readBuffer,
  readZipFile,
  listEntries,
  findEntry,
  extractEntry,
  extractToDirectory,
  METHOD_STORED,
  METHOD_DEFLATE,
};
