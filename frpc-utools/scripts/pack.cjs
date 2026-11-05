'use strict';

// 打包成可分发的插件 zip（只用 Node 内置能力写 STORE 方式 zip，无需外部工具）。
// 用法：node scripts/pack.cjs [输出目录]
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'dist'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outFile = path.join(outDir, `frpc-utools-${pkg.version}.zip`);

// 需要进包的文件/目录（顺序即 zip 内顺序）
const INCLUDE = [
  'plugin.json', 'package.json', 'preload.js', 'index.html', 'app.js', 'styles.css', 'logo.png',
  'core', 'README.md'
];
const SKIP = new Set(['.DS_Store', 'Thumbs.db']);

function collect(relative, list) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) throw new Error(`缺少待打包文件：${relative}`);
  const stat = fs.statSync(absolute);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolute).sort()) {
      if (SKIP.has(name)) continue;
      collect(path.posix.join(relative, name), list);
    }
  } else {
    list.push({ relative, absolute, stat });
  }
  return list;
}

const entries = [];
for (const item of INCLUDE) collect(item, entries);

// ---- 最小 ZIP 写入器（STORE） ----
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
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const chunks = [];
const central = [];
let offset = 0;
for (const entry of entries) {
  const nameBuffer = Buffer.from(entry.relative, 'utf8');
  const data = fs.readFileSync(entry.absolute);
  const crc = crc32(data);
  const { time, day } = dosDateTime(entry.stat.mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);         // 版本
  local.writeUInt16LE(0x0800, 6);     // UTF-8 文件名
  local.writeUInt16LE(0, 8);          // STORE
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, nameBuffer, data);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(0, 10);
  cd.writeUInt16LE(time, 12);
  cd.writeUInt16LE(day, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuffer.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(offset, 42);
  central.push(cd, nameBuffer);

  offset += local.length + nameBuffer.length + data.length;
}

const centralBuffer = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralBuffer.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, Buffer.concat([...chunks, centralBuffer, end]));
const size = fs.statSync(outFile).size;
console.log(`已打包 ${entries.length} 个文件 → ${outFile}（${(size / 1024).toFixed(1)} KB）`);
