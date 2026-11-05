'use strict';
// Cross-platform, dependency-free STORE ZIP writer. This is a source ZIP, NOT a .upx.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const output = path.join(root, 'dist', `shiying-utools-${version}-source.zip`);
const entries = [];
function scan(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (['dist', 'node_modules', '.git'].includes(entry.name)) continue;
    const full = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Refusing symlink: ' + full);
    if (entry.isDirectory()) scan(full);
    else if (entry.isFile()) entries.push({ name: 'douyin-utools/' + path.relative(root, full).split(path.sep).join('/'), data: fs.readFileSync(full) });
  }
}
scan(root);
if (entries.length >= 65535) throw new Error('ZIP64 not supported');
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const chunks = [], central = []; let offset = 0;
for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
  const name = Buffer.from(entry.name, 'utf8'), crc = crc32(entry.data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(entry.data.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
  const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0800, 8);
  record.writeUInt16LE(33, 14); record.writeUInt32LE(crc, 16); record.writeUInt32LE(entry.data.length, 20); record.writeUInt32LE(entry.data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
  chunks.push(local, name, entry.data); central.push(record, name); offset += local.length + name.length + entry.data.length;
}
const dirSize = central.reduce((sum, data) => sum + data.length, 0);
const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dirSize, 12); end.writeUInt32LE(offset, 16);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, Buffer.concat([...chunks, ...central, end]));
console.log(`${output}\n${entries.length} files; ${fs.statSync(output).size} bytes. Source ZIP — import plugin.json through uTools developer tools.`);
